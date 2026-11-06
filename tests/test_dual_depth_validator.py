import numpy as np
import pytest

from backend.services.dual_depth_validator import DualDepthValidator, ground_plane_prior

H, W = 256, 512
S_TRUE, T_TRUE = 12.5, 1.4


def _synthetic(rng):
    yy, xx = np.mgrid[0:H, 0:W]
    d_sv = (5.0 + 30.0 * (xx / W) + 10.0 * (yy / H)).astype(np.float32)  # 5 .. 45 m planar walls
    d_sv[:20, :] = np.nan  # sky rows
    true = np.nan_to_num(d_sv, nan=300.0)
    # moving vehicle: 3.5 m from the camera, invisible in the static planar model
    car = (yy > 150) & (yy < 200) & (xx > 200) & (xx < 280)
    true = np.where(car, 3.5, true)
    d_ai_raw = ((true - T_TRUE) / S_TRUE).astype(np.float32)
    d_ai_raw += rng.normal(0, 0.004, d_ai_raw.shape).astype(np.float32)
    # some gross outliers (reflections)
    out = rng.random(d_ai_raw.shape) < 0.03
    d_ai_raw[out] *= rng.uniform(0.3, 2.0, out.sum()).astype(np.float32)
    return d_sv, d_ai_raw, car


def test_recovers_scale_and_shift_and_masks_vehicle():
    rng = np.random.default_rng(42)
    d_sv, d_ai_raw, car = _synthetic(rng)
    v = DualDepthValidator(tau_m=0.85, alpha=0.75)
    res = v.validate(d_sv, d_ai_raw)
    assert res.metrics.scale_factor == pytest.approx(S_TRUE, rel=0.01)
    assert res.metrics.shift_m == pytest.approx(T_TRUE, abs=0.15)
    # vehicle is masked, static walls survive, sky masked
    inner_car = np.zeros_like(car)
    inner_car[160:190, 210:270] = True
    assert (res.mask[inner_car] == 0).all()
    wall = np.zeros_like(car)
    wall[40:120, 20:180] = True
    assert (res.mask[wall] == 255).mean() > 0.9
    assert (res.mask[:20] == 0).all()
    assert np.isnan(res.fused[res.mask == 0]).all()
    # fused = alpha * ai + (1 - alpha) * sv on verified pixels
    m = (res.mask == 255) & (np.nan_to_num(res.discrepancy, nan=99) <= 0.85)
    np.testing.assert_allclose(
        res.fused[m], 0.75 * res.d_ai_metric[m] + 0.25 * res.d_sv[m], rtol=1e-5
    )
    assert res.metrics.inlier_ratio_pct > 85
    assert 0 <= res.confidence.min() and res.confidence.max() <= 1


def test_nearest_upsampling_of_low_res_reference():
    rng = np.random.default_rng(1)
    d_sv, d_ai_raw, _ = _synthetic(rng)
    low = d_sv[::4, ::4]
    res = DualDepthValidator().validate(low, d_ai_raw)
    assert res.d_sv.shape == (H, W)
    # nearest neighbour must not create values outside the original set
    vals = set(np.unique(low[np.isfinite(low)]).tolist())
    assert set(np.unique(res.d_sv[np.isfinite(res.d_sv)]).tolist()) <= vals


def test_disparity_space_alignment():
    rng = np.random.default_rng(7)
    d_sv, _, _ = _synthetic(rng)
    true = np.nan_to_num(d_sv, nan=1e6)
    disp = (1.0 / true - 0.002) / 0.05  # 1/D = 0.05 * disp + 0.002
    res = DualDepthValidator(space="disparity").validate(d_sv, disp.astype(np.float32))
    assert res.metrics.scale_factor == pytest.approx(0.05, rel=0.01)
    assert res.metrics.shift_m == pytest.approx(0.002, abs=2e-4)
    assert res.metrics.rmse_m < 0.05


def test_ground_prior():
    g = ground_plane_prior(64, 32, camera_height_m=2.5)
    assert np.isnan(g[:16]).all()
    assert g[-1, 0] == pytest.approx(2.5 / np.sin(np.deg2rad(90 - 180 * 0.5 / 32)), rel=1e-4)


def test_metrics_nan_serialises_as_null():
    from backend.models.schemas import DepthValidationMetrics

    m = DepthValidationMetrics(scale_factor=1, shift_m=0, rmse_m=float("nan"), mae_m=float("nan"),
                               abs_rel=float("nan"), inlier_ratio_pct=0, valid_surface_pct=0)
    assert m.rmse_m is None and '"rmse_m":null' in m.model_dump_json()


def test_no_overlap_does_not_crash():
    d_sv = np.full((32, 64), np.nan, np.float32)
    res = DualDepthValidator().validate(d_sv, np.ones((32, 64), np.float32))
    assert res.metrics.rmse_m is None and (res.mask == 0).all()
