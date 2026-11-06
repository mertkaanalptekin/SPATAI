import base64
import struct
import zlib

import numpy as np
import pytest

from backend.services.depth_decoder import (
    HEADER_SIZE,
    StreetViewDepthDecoder,
    encode_depth_buffer,
    sv_ray_directions,
)

W, H = 64, 32


def _scene():
    """Ground plane 2.5 m below camera (lower half) and a wall 10 m to the right (upper half)."""
    idx = np.zeros((H, W), np.uint8)
    idx[H // 2 :, :] = 1  # ground: z(down) = 2.5
    rays = sv_ray_directions(W, H)
    upper = (np.arange(H) < H // 2)[:, None] & (rays[..., 0] > 0.2)
    idx[upper] = 2  # wall: x = 10
    planes = np.array([[0, 0, 0, 0], [0, 0, 1, 2.5], [1, 0, 0, 10.0]], np.float32)
    return idx, planes


def test_header_roundtrip():
    idx, planes = _scene()
    b64 = encode_depth_buffer(idx, planes)
    s = b64.replace("-", "+").replace("_", "/")
    raw = zlib.decompress(base64.b64decode(s + "=" * (-len(s) % 4)))
    hs, n, w, h, off = struct.unpack("<BHHHB", raw[:8])
    assert (hs, n, w, h, off) == (HEADER_SIZE, 3, W, H, 8)
    pdm = StreetViewDepthDecoder.parse(b64)
    np.testing.assert_array_equal(pdm.plane_indices, idx)
    np.testing.assert_allclose(pdm.planes, planes)


def test_rays_are_unit_and_oriented():
    r = sv_ray_directions(W, H)
    np.testing.assert_allclose(np.linalg.norm(r, axis=-1), 1.0, atol=1e-6)
    # centre column looks forward (+y); top row looks up (z is down -> negative)
    assert r[H // 2, W // 2, 1] > 0.99
    assert r[0, W // 2, 2] < -0.99
    # column at u = 0.75 looks right (+x)
    assert r[H // 2, int(0.75 * W), 0] > 0.99


def test_raycast_matches_analytic():
    idx, planes = _scene()
    dec = StreetViewDepthDecoder()
    depth, pidx = dec.decode(encode_depth_buffer(idx, planes))
    r = sv_ray_directions(W, H)
    expected = np.full((H, W), np.nan)
    g = idx == 1
    expected[g] = 2.5 / r[..., 2][g]
    wl = idx == 2
    expected[wl] = 10.0 / r[..., 0][wl]
    expected[(expected < 0.5) | (expected > 250)] = np.nan
    np.testing.assert_allclose(depth, expected, atol=1e-3, equal_nan=True)
    assert np.isnan(depth[idx == 0]).all()
    np.testing.assert_array_equal(pidx, idx)
    # straight down: exactly camera height
    assert depth[-1, :].min() == pytest.approx(2.5, abs=0.01)


def test_range_limits_and_degenerate_denominator():
    idx = np.ones((H, W), np.uint8)
    planes = np.array([[0, 0, 0, 0], [0, 0, 1, 2.5]], np.float32)
    depth, _ = StreetViewDepthDecoder(max_depth_m=50).decode(encode_depth_buffer(idx, planes))
    # rays near the horizon / upper hemisphere never produce ranges outside [0.5, 50]
    finite = depth[np.isfinite(depth)]
    assert finite.min() >= 0.5 and finite.max() <= 50


def test_truncated_buffer_raises():
    idx, planes = _scene()
    raw = struct.pack("<BHHHB", 8, 3, W, H, 8) + idx.tobytes()  # planes missing
    b64 = base64.urlsafe_b64encode(zlib.compress(raw)).decode()
    with pytest.raises(ValueError):
        StreetViewDepthDecoder.parse(b64)
