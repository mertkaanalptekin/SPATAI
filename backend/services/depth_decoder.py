"""Dataset A: Street View native planar depth (base64url + zlib plane buffer).

Binary layout (little endian)::

    [0:8]   header  <BHHHB : header_size, num_planes, width, height, offset
    [offset : offset + W*H]                   uint8  pixel -> plane index (0 = sky / infinity)
    [offset + W*H : offset + W*H + 16*N]      float32 (N, 4) rows of [nx, ny, nz, d]

Raycasting frame (the native Street View convention, aligned to the panorama pixels):
``theta = (1 - u) * 2pi - pi/2``, ``phi = (1 - v) * pi`` and
``r = (sin(phi) cos(theta), sin(phi) sin(theta), cos(phi))`` i.e. x = right, y = forward
(panorama centre column), z = down. Distance along the ray is ``d / (r . n)``.
"""

from __future__ import annotations

import base64
import struct
import zlib
from dataclasses import dataclass
from functools import lru_cache

import numpy as np
from numpy.typing import NDArray

HEADER_FMT = "<BHHHB"
HEADER_SIZE = struct.calcsize(HEADER_FMT)  # 8 bytes


@dataclass(frozen=True)
class PlanarDepthMap:
    width: int
    height: int
    plane_indices: NDArray[np.uint8]  # (H, W)
    planes: NDArray[np.float32]  # (N, 4) [nx, ny, nz, d]


def _b64url_decode(s: str) -> bytes:
    s = s.strip().replace("-", "+").replace("_", "/")
    s += "=" * (-len(s) % 4)
    return base64.b64decode(s)


def encode_depth_buffer(plane_indices: NDArray[np.uint8], planes: NDArray[np.floating]) -> str:
    """Inverse of :meth:`StreetViewDepthDecoder.parse` (used by tests and the synthetic scene)."""
    plane_indices = np.ascontiguousarray(plane_indices, dtype=np.uint8)
    planes = np.ascontiguousarray(planes, dtype="<f4").reshape(-1, 4)
    h, w = plane_indices.shape
    if planes.shape[0] > 0xFFFF:
        raise ValueError("too many planes")
    header = struct.pack(HEADER_FMT, HEADER_SIZE, planes.shape[0], w, h, HEADER_SIZE)
    raw = header + plane_indices.tobytes() + planes.tobytes()
    return base64.urlsafe_b64encode(zlib.compress(raw, 9)).decode("ascii").rstrip("=")


@lru_cache(maxsize=8)
def sv_ray_directions(width: int, height: int) -> NDArray[np.float32]:
    """Unit rays (H, W, 3) in the Street View depth frame (x right, y forward, z down)."""
    u = (np.arange(width, dtype=np.float64) + 0.5) / width
    v = (np.arange(height, dtype=np.float64) + 0.5) / height
    theta = (1.0 - u) * 2.0 * np.pi - np.pi / 2.0
    phi = (1.0 - v) * np.pi
    sin_phi = np.sin(phi)[:, None]
    rays = np.empty((height, width, 3), dtype=np.float32)
    rays[..., 0] = sin_phi * np.cos(theta)[None, :]
    rays[..., 1] = sin_phi * np.sin(theta)[None, :]
    rays[..., 2] = np.broadcast_to(np.cos(phi)[:, None], (height, width))
    rays.setflags(write=False)
    return rays


class StreetViewDepthDecoder:
    def __init__(self, min_depth_m: float = 0.5, max_depth_m: float = 250.0, eps: float = 1e-5) -> None:
        self.min_depth_m = min_depth_m
        self.max_depth_m = max_depth_m
        self.eps = eps

    @staticmethod
    def parse(depth_b64: str) -> PlanarDepthMap:
        data = zlib.decompress(_b64url_decode(depth_b64))
        if len(data) < HEADER_SIZE:
            raise ValueError("depth buffer too short")
        _header_size, num_planes, width, height, offset = struct.unpack(HEADER_FMT, data[:HEADER_SIZE])
        n_pixels = width * height
        need = offset + n_pixels + num_planes * 16
        if len(data) < need:
            raise ValueError(f"depth buffer truncated: {len(data)} < {need} bytes")
        plane_indices = np.frombuffer(data, dtype=np.uint8, count=n_pixels, offset=offset).reshape(height, width)
        planes = np.frombuffer(data, dtype="<f4", count=num_planes * 4, offset=offset + n_pixels).reshape(
            num_planes, 4
        )
        if num_planes and int(plane_indices.max()) >= num_planes:
            raise ValueError("plane index out of range")
        return PlanarDepthMap(width, height, plane_indices.copy(), planes.astype(np.float32))

    def raycast(self, pdm: PlanarDepthMap) -> NDArray[np.float32]:
        """Vectorised ray/plane intersection -> radial distance in metres (NaN = invalid / sky)."""
        rays = sv_ray_directions(pdm.width, pdm.height)
        if pdm.planes.shape[0] == 0:
            return np.full((pdm.height, pdm.width), np.nan, dtype=np.float32)
        idx = pdm.plane_indices
        normals = pdm.planes[idx, :3]  # (H, W, 3)
        d = pdm.planes[idx, 3]
        denom = np.einsum("hwc,hwc->hw", rays, normals)
        with np.errstate(divide="ignore", invalid="ignore"):
            # Plane normal orientation is not consistent in the wild; the reference decoders use |d / r.n|.
            dist = np.abs(d / denom)
        invalid = (idx == 0) | (np.abs(denom) <= self.eps) | ~np.isfinite(dist)
        invalid |= (dist < self.min_depth_m) | (dist > self.max_depth_m)
        dist = dist.astype(np.float32)
        dist[invalid] = np.nan
        return dist

    def decode(self, depth_b64: str) -> tuple[NDArray[np.float32], NDArray[np.uint8]]:
        pdm = self.parse(depth_b64)
        return self.raycast(pdm), pdm.plane_indices
