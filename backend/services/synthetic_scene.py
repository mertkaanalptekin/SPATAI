"""Procedural street-canyon panoramas with exact ground truth.

Used as the zero-configuration demo source and for end-to-end tests: every panorama comes with

* an RGB equirectangular image whose texture is a deterministic function of *world* coordinates
  (so features are consistent between neighbouring panoramas and SfM can actually match them),
* a Street View-format planar depth buffer (Dataset A, static scene only),
* the true radial range including transient objects (cars / pedestrians) -> "oracle" Dataset B.

World frame: local ENU (metres) around ``(lat0, lon0)``; the street runs north-south along
``e = 0``; facades at ``e = +-STREET_HALF_WIDTH``; camera height 2.5 m.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

from backend.services.cubemap_projector import equirect_rays
from backend.services.depth_decoder import encode_depth_buffer

STREET_HALF_WIDTH = 8.0
STREET_END = 150.0
CAMERA_HEIGHT = 2.5
SEGMENT = 10.0


def _hash(a: NDArray, b: NDArray | float) -> NDArray:
    with np.errstate(invalid="ignore"):
        v = np.sin(a * 12.9898 + b * 78.233) * 43758.5453
    return v - np.floor(v)


def _building_height(n: NDArray, side: float) -> NDArray:
    k = np.floor(n / SEGMENT)
    return 9.0 + 15.0 * _hash(k, side * 3.1 + 0.7)


@dataclass
class SyntheticPano:
    rgb: NDArray[np.uint8]
    depth_b64: str
    oracle_range: NDArray[np.float32]  # (H, W) incl. dynamic objects, NaN = sky


def pano_heading(n: float) -> float:
    return float((_hash(np.array(n), 4.2) - 0.5) * 8.0) % 360.0  # small realistic yaw jitter


def _world_rays(width: int, height: int, heading_deg: float) -> NDArray[np.float32]:
    r = equirect_rays(width, height)  # x right, y up, z forward
    h = np.deg2rad(heading_deg)
    fwd = np.array([np.sin(h), np.cos(h), 0.0], np.float32)
    right = np.array([np.cos(h), -np.sin(h), 0.0], np.float32)
    up = np.array([0.0, 0.0, 1.0], np.float32)
    return r[..., 0:1] * right + r[..., 1:2] * up + r[..., 2:3] * fwd


def _plane_hit(o: NDArray, d: NDArray, axis: int, value: float) -> NDArray:
    with np.errstate(divide="ignore", invalid="ignore"):
        t = (value - o[axis]) / d[..., axis]
    return np.where(t > 1e-4, t, np.inf)


def _trace(cam: NDArray, d: NDArray, dynamic: list[tuple[NDArray, NDArray]]) -> tuple[NDArray, NDArray, NDArray]:
    """Return (t, primitive id, hit point). ids: 0 sky, 1 ground, 2 west, 3 east, 4 north, 5 south, 6+ dynamic."""
    shp = d.shape[:2]
    best_t = np.full(shp, np.inf, np.float32)
    best_id = np.zeros(shp, np.uint8)

    def consider(t: NDArray, pid: int, bound) -> None:
        nonlocal best_t, best_id
        p = cam + t[..., None] * d
        ok = np.isfinite(t) & (t < best_t) & bound(p)
        best_t = np.where(ok, t, best_t)
        best_id = np.where(ok, pid, best_id).astype(np.uint8)

    W = STREET_HALF_WIDTH
    consider(_plane_hit(cam, d, 2, 0.0), 1, lambda p: np.abs(p[..., 1]) <= STREET_END * 3)
    consider(_plane_hit(cam, d, 0, -W), 2, lambda p: (p[..., 2] >= 0) & (p[..., 2] <= _building_height(p[..., 1], -1)))
    consider(_plane_hit(cam, d, 0, W), 3, lambda p: (p[..., 2] >= 0) & (p[..., 2] <= _building_height(p[..., 1], 1)))
    consider(_plane_hit(cam, d, 1, STREET_END), 4, lambda p: (p[..., 2] >= 0) & (p[..., 2] <= 22.0))
    consider(_plane_hit(cam, d, 1, -STREET_END), 5, lambda p: (p[..., 2] >= 0) & (p[..., 2] <= 18.0))
    for k, (lo, hi) in enumerate(dynamic):
        with np.errstate(divide="ignore", invalid="ignore"):
            t1 = (lo - cam) / d
            t2 = (hi - cam) / d
        tmin = np.nanmax(np.minimum(t1, t2), axis=-1)
        tmax = np.nanmin(np.maximum(t1, t2), axis=-1)
        t = np.where((tmax >= tmin) & (tmin > 1e-4), tmin, np.inf).astype(np.float32)
        consider(t, 6 + k, lambda p: np.ones(p.shape[:-1], bool))
    hit = cam + np.where(np.isfinite(best_t), best_t, 0)[..., None] * d
    return best_t, best_id, hit


def _shade(pid: NDArray, p: NDArray, d: NDArray) -> NDArray[np.float32]:
    e, n, z = p[..., 0], p[..., 1], p[..., 2]
    img = np.zeros(pid.shape + (3,), np.float32)

    # sky: gradient + soft clouds
    elev = np.clip(d[..., 2], 0, 1)
    az = np.arctan2(d[..., 0], d[..., 1])
    clouds = np.clip(np.sin(az * 7 + elev * 9) * np.sin(az * 3 - elev * 15) * 0.5 + 0.1, 0, 1) * (1 - elev)
    sky = np.stack([0.55 - 0.3 * elev, 0.72 - 0.25 * elev, 0.95 - 0.1 * elev], -1) + clouds[..., None] * 0.35
    img = np.where((pid == 0)[..., None], sky, img)

    # ground: asphalt / sidewalk / lane dashes
    fine = _hash(np.floor(e * 9), np.floor(n * 9))
    coarse = _hash(np.floor(e * 1.3) + 11, np.floor(n * 1.3))
    asphalt = 0.30 + 0.10 * fine + 0.05 * coarse
    side = np.abs(e) > 5.5
    tiles = ((np.mod(e, 0.6) < 0.04) | (np.mod(n, 0.6) < 0.04)).astype(np.float32)
    g = np.where(side, 0.62 + 0.08 * fine - 0.25 * tiles, asphalt)
    dash = (np.abs(e) < 0.12) & (np.mod(n, 6.0) < 3.0)
    curb = (np.abs(np.abs(e) - 5.5) < 0.15)
    g = np.where(dash | curb, 0.9, g)
    ground = np.stack([g, g * 0.98, g * 0.95], -1)
    img = np.where((pid == 1)[..., None], ground, img)

    # facades (west/east along n, end walls along e)
    is_fac = (pid >= 2) & (pid <= 5)
    along = np.where(pid <= 3, n, e)
    sidek = np.where(pid == 2, -1.0, np.where(pid == 3, 1.0, pid * 2.0))
    k = np.floor(along / SEGMENT)
    hue = _hash(k, sidek)
    base = np.stack([0.55 + 0.35 * hue, 0.45 + 0.25 * _hash(k + 3, sidek), 0.35 + 0.2 * _hash(k + 7, sidek)], -1)
    win = (np.mod(along, 2.5) / 2.5 > 0.25) & (np.mod(along, 2.5) / 2.5 < 0.75) & (np.mod(z, 3.2) / 3.2 > 0.3) & (
        np.mod(z, 3.2) / 3.2 < 0.85) & (z > 3.2)
    shop = (z < 2.6) & (z > 0.3) & (np.mod(along, SEGMENT) > 2.0) & (np.mod(along, SEGMENT) < 8.0)
    tex = 0.1 * _hash(np.floor(along * 6), np.floor(z * 6))[..., None] - 0.05
    glass = np.stack([0.12 + 0.2 * _hash(np.floor(along / 2.5), np.floor(z / 3.2))] * 2 + [
        0.25 + 0.2 * _hash(np.floor(along / 2.5) + 1, np.floor(z / 3.2))], -1)
    shopc = np.stack([0.15 + 0.5 * hue, 0.12 + 0.1 * hue, 0.1 + 0.05 * hue], -1)
    fac = np.where(win[..., None], glass, np.where(shop[..., None], shopc, base + tex))
    cornice = np.abs(np.mod(z, 3.2) - 0.1) < 0.12
    fac = np.where(cornice[..., None], fac * 0.7, fac)
    img = np.where(is_fac[..., None], fac, img)

    # dynamic objects
    car = np.stack([0.75 + 0.1 * _hash(np.floor(z * 8), 0), 0.08 + 0 * z, 0.1 + 0 * z], -1)
    car = np.where(((z > 0.9) & (z < 1.35))[..., None], np.stack([0.2 + 0 * z, 0.25 + 0 * z, 0.3 + 0 * z], -1), car)
    img = np.where((pid == 6)[..., None], car, img)
    img = np.where((pid >= 7)[..., None], np.stack([0.1 + 0 * z, 0.15 + 0 * z, 0.45 + 0 * z], -1), img)

    # distance haze
    return np.clip(img, 0, 1)


def _dynamic_objects(n_cam: float) -> list[tuple[NDArray, NDArray]]:
    off = 5.0 + 6.0 * float(_hash(np.array(n_cam), 9.1))
    lane = 2.0 if _hash(np.array(n_cam), 2.2) > 0.5 else -3.8
    car = (np.array([lane, n_cam + off - 2.2, 0.0], np.float32), np.array([lane + 1.8, n_cam + off + 2.2, 1.5], np.float32))
    ped_n = n_cam - 4.0 - 4.0 * float(_hash(np.array(n_cam), 5.5))
    ped = (np.array([-6.6, ped_n - 0.3, 0.0], np.float32), np.array([-6.0, ped_n + 0.3, 1.8], np.float32))
    return [car, ped]


def sv_planes_for_camera(cam: NDArray, heading_deg: float) -> NDArray[np.float32]:
    """Static scene planes expressed in the Street View depth frame of a camera."""
    h = np.deg2rad(heading_deg)
    right = np.array([np.cos(h), -np.sin(h), 0.0])
    fwd = np.array([np.sin(h), np.cos(h), 0.0])
    down = np.array([0.0, 0.0, -1.0])
    m = np.stack([right, fwd, down])
    world = [  # (normal, d) with n . p = d
        (np.array([0.0, 0.0, 1.0]), 0.0),
        (np.array([1.0, 0.0, 0.0]), -STREET_HALF_WIDTH),
        (np.array([1.0, 0.0, 0.0]), STREET_HALF_WIDTH),
        (np.array([0.0, 1.0, 0.0]), STREET_END),
        (np.array([0.0, 1.0, 0.0]), -STREET_END),
    ]
    planes = [np.zeros(4)]
    for nw, dw in world:
        nl = m @ nw
        dl = dw - nw @ cam
        if dl < 0:
            nl, dl = -nl, -dl
        planes.append(np.concatenate([nl, [dl]]))
    return np.asarray(planes, np.float32)


def render_pano(n_cam: float, width: int = 2048, sv_width: int = 512) -> SyntheticPano:
    heading = pano_heading(n_cam)
    cam = np.array([0.0, n_cam, CAMERA_HEIGHT], np.float32)
    dyn = _dynamic_objects(n_cam)

    height = width // 2
    d = _world_rays(width, height, heading)
    t, pid, hit = _trace(cam, d, dyn)
    rgb = _shade(pid, hit, d)
    rng = np.random.default_rng(int(abs(n_cam) * 1000) % (2**31))
    rgb = rgb + rng.normal(0, 0.012, rgb.shape).astype(np.float32)
    rgb8 = (np.clip(rgb, 0, 1) * 255).astype(np.uint8)
    oracle = np.where(pid == 0, np.nan, t).astype(np.float32)

    # Dataset A: static planes only, native 512 x 256 resolution
    ds = _world_rays(sv_width, sv_width // 2, heading)
    _, pid_s, _ = _trace(cam, ds, [])
    planes = sv_planes_for_camera(cam.astype(np.float64), heading)
    return SyntheticPano(rgb8, encode_depth_buffer(pid_s.astype(np.uint8), planes), oracle)
