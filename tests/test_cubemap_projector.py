import numpy as np
import pytest

from backend.models.schemas import CameraGeometryMode
from backend.services.cubemap_projector import (
    CUBE_FACES,
    CubemapConverter,
    equirect_rays,
    faces_for_mode,
    focal_35mm,
)

EW, EH = 1024, 512


def _lon_lat_pano():
    lon = ((np.arange(EW) + 0.5) / EW - 0.5) * 360.0
    lat = (0.5 - (np.arange(EH) + 0.5) / EH) * 180.0
    lo, la = np.meshgrid(lon, lat)
    return np.stack([lo, la], -1).astype(np.float32)


def test_focal_length():
    assert focal_35mm(90.0) == pytest.approx(18.0)
    c = CubemapConverter(256)
    assert c.focal_px == pytest.approx(128.0)
    assert c.focal_35mm == pytest.approx(18.0)


def test_output_shape_rgb():
    rgb = np.random.default_rng(0).integers(0, 255, (EH, EW, 3), dtype=np.uint8)
    out = CubemapConverter(128).project(rgb, "front")
    assert out.shape == (128, 128, 3) and out.dtype == np.uint8


@pytest.mark.parametrize("face,lon", [("front", 0), ("right", 90), ("back", 180), ("left", -90)])
def test_face_centres_map_to_longitudes(face, lon):
    S = 64
    c = CubemapConverter(S)
    map_x, map_y, _ = c.maps(EW, EH, CUBE_FACES[face])
    # the optical axis lies between the 4 central pixels
    cx = map_x[S // 2 - 1 : S // 2 + 1, S // 2 - 1 : S // 2 + 1].astype(np.float64)
    cy = map_y[S // 2 - 1 : S // 2 + 1, S // 2 - 1 : S // 2 + 1].mean()
    got_lon = ((cx + 0.5) / EW - 0.5) * 360.0
    got_lon = np.rad2deg(np.angle(np.exp(1j * np.deg2rad(got_lon)).mean()))
    assert ((got_lon - lon + 180) % 360) - 180 == pytest.approx(0, abs=1e-3)
    assert cy == pytest.approx(EH / 2 - 0.5, abs=1e-3)  # horizon


def test_up_down_faces():
    S = 64
    c = CubemapConverter(S)
    ll = _lon_lat_pano()
    up = c.project(ll, "up", "nearest")
    down = c.project(ll, "down", "nearest")
    assert up[S // 2, S // 2, 1] > 85
    assert down[S // 2, S // 2, 1] < -85


def test_fov_edges():
    S = 128
    ll = _lon_lat_pano()
    f = CubemapConverter(S).project(ll, "front", "linear")
    # horizontal edges of a 90 deg face lie at +-45 deg longitude
    assert f[S // 2, 0, 0] == pytest.approx(-45, abs=0.6)
    assert f[S // 2, -1, 0] == pytest.approx(45, abs=0.6)
    assert f[0, S // 2, 1] == pytest.approx(45, abs=0.6)


def test_zdepth_conversion():
    S = 64
    c = CubemapConverter(S)
    rng = np.full((EH, EW), 10.0, np.float32)
    z = c.project_range_to_zdepth(rng, "front")
    assert z[S // 2, S // 2] == pytest.approx(10.0, rel=1e-3)
    assert z[0, 0] == pytest.approx(10.0 / np.sqrt(3), rel=0.03)


def test_roundtrip_faces_to_equirect():
    S = 256
    c = CubemapConverter(S)
    rays = equirect_rays(EW // 4, EH // 4)
    faces = {n: c.face_rays(CUBE_FACES[n]) for n in CUBE_FACES}
    back = c.faces_to_equirect(faces, EW // 4, EH // 4, "linear")
    assert np.isfinite(back).all()
    np.testing.assert_allclose(back, rays, atol=0.02)


def test_modes():
    assert [f.name for f in faces_for_mode(CameraGeometryMode.CUBEMAP_4)] == ["front", "right", "back", "left"]
    assert len(faces_for_mode(CameraGeometryMode.CUBEMAP_6)) == 6
    assert len(faces_for_mode(CameraGeometryMode.RING_8)) == 8
    assert faces_for_mode(CameraGeometryMode.EQUIRECTANGULAR) == []
