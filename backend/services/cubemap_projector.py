"""Equirectangular -> rectilinear pinhole views (cubemap faces / horizontal rings) and back.

Conventions
-----------
* Equirectangular column ``x`` -> longitude ``lon = ((x + 0.5) / W - 0.5) * 2pi`` relative to the
  panorama heading (0 at the centre column, +90 deg to the right = clockwise seen from above).
  Row ``y`` -> latitude ``lat = (0.5 - (y + 0.5) / H) * pi``.
* Camera frame of a face: x right, y up, z forward. ``R = R_y(yaw) @ R_x(pitch)`` maps camera
  rays to the panorama frame where ``lon = atan2(w_x, w_z)`` and ``lat = asin(w_y)``.
* Focal length: ``f_px = 0.5 * S / tan(FOV / 2)``; 35 mm-equivalent ``f35 = 18 mm`` at 90 deg.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from typing import Literal, Mapping

import cv2
import numpy as np
from numpy.typing import NDArray

from backend.models.schemas import CameraGeometryMode

Interp = Literal["linear", "nearest"]


@dataclass(frozen=True)
class FaceSpec:
    name: str
    yaw_deg: float  # relative to the panorama heading, clockwise
    pitch_deg: float  # + = up


CUBE_FACES: dict[str, FaceSpec] = {
    "front": FaceSpec("front", 0.0, 0.0),
    "right": FaceSpec("right", 90.0, 0.0),
    "back": FaceSpec("back", 180.0, 0.0),
    "left": FaceSpec("left", 270.0, 0.0),
    "up": FaceSpec("up", 0.0, 90.0),
    "down": FaceSpec("down", 0.0, -90.0),
}


def faces_for_mode(mode: CameraGeometryMode) -> list[FaceSpec]:
    if mode == CameraGeometryMode.CUBEMAP_4:
        return [CUBE_FACES[k] for k in ("front", "right", "back", "left")]
    if mode == CameraGeometryMode.CUBEMAP_6:
        return list(CUBE_FACES.values())
    if mode == CameraGeometryMode.RING_8:
        return [FaceSpec(f"h{int(a):03d}", float(a), 0.0) for a in range(0, 360, 45)]
    return []


def rotation_matrix(yaw_deg: float, pitch_deg: float) -> NDArray[np.float64]:
    """Camera -> panorama frame rotation ``R_y(yaw) @ R_x(pitch)``."""
    y, p = np.deg2rad(yaw_deg), np.deg2rad(pitch_deg)
    ry = np.array([[np.cos(y), 0, np.sin(y)], [0, 1, 0], [-np.sin(y), 0, np.cos(y)]])
    rx = np.array([[1, 0, 0], [0, np.cos(p), np.sin(p)], [0, -np.sin(p), np.cos(p)]])
    return ry @ rx


def focal_35mm(fov_deg: float) -> float:
    return 36.0 / (2.0 * np.tan(np.deg2rad(fov_deg) / 2.0))


@lru_cache(maxsize=64)
def _face_maps(eq_w: int, eq_h: int, size: int, fov_deg: float, yaw: float, pitch: float):
    f = 0.5 * size / np.tan(np.deg2rad(fov_deg) / 2.0)
    c = np.arange(size, dtype=np.float64) - size / 2.0 + 0.5
    u, v = np.meshgrid(c, c)
    d = np.stack([u, -v, np.full_like(u, f)], axis=-1)
    d /= np.linalg.norm(d, axis=-1, keepdims=True)
    w = d @ rotation_matrix(yaw, pitch).T
    lon = np.arctan2(w[..., 0], w[..., 2])
    lat = np.arcsin(np.clip(w[..., 1], -1.0, 1.0))
    map_x = ((lon / (2 * np.pi) + 0.5) * eq_w - 0.5).astype(np.float32)
    map_y = ((0.5 - lat / np.pi) * eq_h - 0.5).astype(np.float32)
    cos_axis = (f / np.sqrt(u**2 + v**2 + f**2)).astype(np.float32)  # range -> z-depth factor
    for a in (map_x, map_y, cos_axis):
        a.setflags(write=False)
    return map_x, map_y, cos_axis


def equirect_rays(width: int, height: int) -> NDArray[np.float32]:
    """Unit rays (H, W, 3) in the panorama frame (x right, y up, z forward)."""
    lon = ((np.arange(width) + 0.5) / width - 0.5) * 2 * np.pi
    lat = (0.5 - (np.arange(height) + 0.5) / height) * np.pi
    lon, lat = np.meshgrid(lon, lat)
    return np.stack(
        [np.cos(lat) * np.sin(lon), np.sin(lat), np.cos(lat) * np.cos(lon)], axis=-1
    ).astype(np.float32)


class CubemapConverter:
    def __init__(self, face_size: int = 1024, fov_deg: float = 90.0) -> None:
        self.face_size = int(face_size)
        self.fov_deg = float(fov_deg)

    @property
    def focal_px(self) -> float:
        return 0.5 * self.face_size / np.tan(np.deg2rad(self.fov_deg) / 2.0)

    @property
    def focal_35mm(self) -> float:
        return focal_35mm(self.fov_deg)

    def maps(self, eq_w: int, eq_h: int, face: FaceSpec):
        return _face_maps(eq_w, eq_h, self.face_size, self.fov_deg, face.yaw_deg, face.pitch_deg)

    def face_rays(self, face: FaceSpec) -> NDArray[np.float32]:
        """Camera rays of a face expressed in the panorama frame (H, W, 3)."""
        c = np.arange(self.face_size, dtype=np.float64) - self.face_size / 2.0 + 0.5
        u, v = np.meshgrid(c, c)
        d = np.stack([u, -v, np.full_like(u, self.focal_px)], axis=-1)
        d /= np.linalg.norm(d, axis=-1, keepdims=True)
        return (d @ rotation_matrix(face.yaw_deg, face.pitch_deg).T).astype(np.float32)

    def project(self, equirect: NDArray, face: FaceSpec | str, interpolation: Interp = "linear") -> NDArray:
        if isinstance(face, str):
            face = CUBE_FACES[face]
        h, w = equirect.shape[:2]
        map_x, map_y, _ = self.maps(w, h, face)
        flag = cv2.INTER_LINEAR if interpolation == "linear" else cv2.INTER_NEAREST
        src = equirect
        if src.dtype == np.bool_:
            src = src.astype(np.uint8)
        return cv2.remap(src, map_x, map_y, flag, borderMode=cv2.BORDER_WRAP)

    def project_range_to_zdepth(self, range_equirect: NDArray[np.float32], face: FaceSpec | str) -> NDArray[np.float32]:
        """Project a radial range map and convert it to pinhole z-depth (what MVS tools expect)."""
        if isinstance(face, str):
            face = CUBE_FACES[face]
        r = self.project(range_equirect, face, "nearest")
        _, _, cos_axis = self.maps(range_equirect.shape[1], range_equirect.shape[0], face)
        return (r * cos_axis).astype(np.float32)

    def project_all(
        self, equirect: NDArray, faces: list[FaceSpec], interpolation: Interp = "linear"
    ) -> dict[str, NDArray]:
        return {f.name: self.project(equirect, f, interpolation) for f in faces}

    def faces_to_equirect(
        self,
        faces: Mapping[str, NDArray],
        width: int,
        height: int,
        interpolation: Interp = "linear",
        fill: float = np.nan,
    ) -> NDArray:
        """Inverse mapping: stitch pinhole faces (keys in ``CUBE_FACES``) back into a panorama."""
        rays = equirect_rays(width, height).astype(np.float64)
        sample = next(iter(faces.values()))
        out_shape = (height, width) + sample.shape[2:]
        out = np.full(out_shape, fill, dtype=np.float32 if np.isnan(fill) else sample.dtype)
        best = np.full((height, width), -np.inf)
        flag = cv2.INTER_LINEAR if interpolation == "linear" else cv2.INTER_NEAREST
        f = self.focal_px
        half = self.face_size / 2.0
        for name, img in faces.items():
            spec = CUBE_FACES[name]
            cam = rays @ rotation_matrix(spec.yaw_deg, spec.pitch_deg)  # world -> camera (R^T)
            cz = cam[..., 2]
            with np.errstate(divide="ignore", invalid="ignore"):
                px = f * cam[..., 0] / cz + half - 0.5
                py = -f * cam[..., 1] / cz + half - 0.5
            inside = (cz > 1e-6) & (px >= -0.5) & (px <= self.face_size - 0.5) & (py >= -0.5) & (py <= self.face_size - 0.5)
            take = inside & (cz > best)
            if not take.any():
                continue
            vals = cv2.remap(
                img, np.where(take, px, -1).astype(np.float32), np.where(take, py, -1).astype(np.float32),
                flag, borderMode=cv2.BORDER_REPLICATE,
            )
            out[take] = vals[take]
            best[take] = cz[take]
        return out
