"""Dual-depth cross-validation: metric Dataset A  x  relative Dataset B -> metrics, mask, fused depth.

Alignment can run in two spaces:

* ``"depth"``     - ``D_ref ~ s * D_ai + t``            (spec default, AI output already depth-like)
* ``"disparity"`` - ``1 / D_ref ~ s * disp_ai + t``     (Depth Anything V2 *relative* models are
  affine-invariant in inverse depth, so this is the mathematically correct space for them)

The robust estimator is a vectorised RANSAC on a 2-parameter affine model followed by an
IQR-trimmed least-squares refinement. RANSAC residuals are measured as *relative depth error*
so the same threshold works in both spaces.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Optional

import cv2
import numpy as np
from numpy.typing import NDArray

from backend.models.schemas import DepthValidationMetrics

AlignmentSpace = Literal["depth", "disparity"]


@dataclass
class AlignmentResult:
    scale: float
    shift: float
    inliers: NDArray[np.bool_]  # same shape as the input valid mask
    space: AlignmentSpace


@dataclass
class ValidationResult:
    d_sv: NDArray[np.float32]
    d_ai_raw: NDArray[np.float32]
    d_ai_metric: NDArray[np.float32]
    discrepancy: NDArray[np.float32]
    confidence: NDArray[np.float32]
    mask: NDArray[np.uint8]
    fused: NDArray[np.float32]
    joint_valid: NDArray[np.bool_]
    sky: NDArray[np.bool_]
    metrics: DepthValidationMetrics
    alignment: AlignmentResult
    extras: dict = field(default_factory=dict)


class DualDepthValidator:
    def __init__(
        self,
        tau_m: float = 0.85,
        alpha: float = 0.75,
        d_max: float = 250.0,
        d_min: float = 1.0,
        space: AlignmentSpace = "depth",
        ransac_iters: int = 256,
        ransac_rel_thresh: float = 0.08,
        ransac_subsample: int = 6000,
        mask_on_discrepancy: bool = True,
        keep_unverified: bool = False,
        morph_kernel: int = 5,
        seed: int = 0,
    ) -> None:
        self.tau_m = float(tau_m)
        self.alpha = float(alpha)
        self.d_max = float(d_max)
        self.d_min = float(d_min)
        self.space: AlignmentSpace = space
        self.ransac_iters = ransac_iters
        self.ransac_rel_thresh = ransac_rel_thresh
        self.ransac_subsample = ransac_subsample
        self.mask_on_discrepancy = mask_on_discrepancy
        self.keep_unverified = keep_unverified
        self.morph_kernel = morph_kernel
        self.seed = seed

    # ------------------------------------------------------------------ alignment
    def _predict(self, s: NDArray | float, t: NDArray | float, x: NDArray) -> NDArray:
        """Predicted metric depth from AI values for (broadcastable) parameters."""
        if self.space == "depth":
            return s * x + t
        with np.errstate(divide="ignore", invalid="ignore"):
            inv = s * x + t
            return np.where(inv > 1.0 / (self.d_max * 4.0), 1.0 / inv, np.inf)

    def _lstsq(self, x: NDArray, y_ref: NDArray) -> tuple[float, float]:
        target = y_ref if self.space == "depth" else 1.0 / y_ref
        a = np.stack([x, np.ones_like(x)], axis=1)
        if self.space == "disparity":
            # weight by depth^2 so the fit minimises (approximately) depth error rather than inverse error
            w = y_ref
            a = a * w[:, None]
            target = target * w
        (s, t), *_ = np.linalg.lstsq(a.astype(np.float64), target.astype(np.float64), rcond=None)
        return float(s), float(t)

    def align(self, d_ref: NDArray, d_ai: NDArray, valid: NDArray[np.bool_]) -> AlignmentResult:
        x_all = d_ai[valid].astype(np.float64)
        y_all = d_ref[valid].astype(np.float64)
        n = x_all.size
        inliers_full = np.zeros_like(valid)
        if n < 10:
            return AlignmentResult(1.0, 0.0, inliers_full, self.space)

        rng = np.random.default_rng(self.seed)
        sub = rng.choice(n, size=min(n, self.ransac_subsample), replace=False)
        xs, ys = x_all[sub], y_all[sub]
        ys_t = ys if self.space == "depth" else 1.0 / ys

        # vectorised RANSAC: K minimal 2-point hypotheses evaluated at once
        k = self.ransac_iters
        pairs = rng.integers(0, xs.size, size=(k, 2))
        x1, x2 = xs[pairs[:, 0]], xs[pairs[:, 1]]
        y1, y2 = ys_t[pairs[:, 0]], ys_t[pairs[:, 1]]
        dx = x2 - x1
        ok = np.abs(dx) > 1e-9
        s = np.where(ok, (y2 - y1) / np.where(ok, dx, 1.0), np.nan)
        t = y1 - s * x1
        if self.space == "depth":
            ok &= s > 0
        else:
            ok &= s != 0
        pred = self._predict(s[:, None], t[:, None], xs[None, :])
        rel = np.abs(pred - ys[None, :]) / ys[None, :]
        counts = np.where(ok, (rel < self.ransac_rel_thresh).sum(axis=1), -1)
        best = int(np.argmax(counts))
        if counts[best] < 2:
            s_b, t_b = self._lstsq(x_all, y_all)
        else:
            s_b, t_b = float(s[best]), float(t[best])

        # refine: inliers on the full set -> LSQ -> IQR trim -> LSQ
        for _ in range(3):
            pred_all = self._predict(s_b, t_b, x_all)
            rel_all = np.abs(pred_all - y_all) / y_all
            inl = rel_all < self.ransac_rel_thresh
            if inl.sum() < 10:
                break
            s_b, t_b = self._lstsq(x_all[inl], y_all[inl])
        pred_all = self._predict(s_b, t_b, x_all)
        res = pred_all - y_all
        inl = np.abs(res) / y_all < self.ransac_rel_thresh
        if inl.sum() >= 10:
            q1, q3 = np.percentile(res[inl], [25, 75])
            iqr = q3 - q1
            inl &= (res >= q1 - 1.5 * iqr) & (res <= q3 + 1.5 * iqr)
            if inl.sum() >= 10:
                s_b, t_b = self._lstsq(x_all[inl], y_all[inl])
        inliers_full[valid] = inl
        return AlignmentResult(s_b, t_b, inliers_full, self.space)

    def to_metric(self, d_ai: NDArray, scale: float, shift: float) -> NDArray[np.float32]:
        pred = self._predict(scale, shift, d_ai.astype(np.float64))
        pred = np.where(np.isfinite(pred), pred, self.d_max)
        return np.clip(pred, 0.5, self.d_max).astype(np.float32)

    # ------------------------------------------------------------------ main entry
    def validate(
        self,
        d_sv: NDArray[np.floating],
        d_ai_raw: NDArray[np.floating],
        sky: Optional[NDArray[np.bool_]] = None,
        alignment: Optional[AlignmentResult] = None,
    ) -> ValidationResult:
        d_ai_raw = d_ai_raw.astype(np.float32)
        h, w = d_ai_raw.shape
        d_sv = d_sv.astype(np.float32)
        if d_sv.shape != (h, w):
            # nearest neighbour: never interpolate across NaN sky boundaries
            d_sv = cv2.resize(d_sv, (w, h), interpolation=cv2.INTER_NEAREST)
        if sky is not None and sky.shape != (h, w):
            sky = cv2.resize(sky.astype(np.uint8), (w, h), interpolation=cv2.INTER_NEAREST).astype(bool)

        sv_ok = np.isfinite(d_sv) & (d_sv > self.d_min) & (d_sv < self.d_max)
        ai_ok = np.isfinite(d_ai_raw) & (d_ai_raw > 1e-4)
        joint = sv_ok & ai_ok

        if alignment is None:
            alignment = self.align(d_sv, d_ai_raw, joint)
        d_ai_metric = self.to_metric(d_ai_raw, alignment.scale, alignment.shift)
        if sky is None:
            sky = ~ai_ok | (d_ai_metric >= self.d_max * 0.999)
        sky = sky & ~joint if sky is not None else np.zeros((h, w), bool)

        with np.errstate(invalid="ignore"):
            delta = np.abs(d_sv - d_ai_metric).astype(np.float32)
        delta[~joint] = np.nan
        conf = np.exp(-(np.nan_to_num(delta, nan=np.inf) ** 2) / (2.0 * self.tau_m**2)).astype(np.float32)

        verified = joint & (delta <= self.tau_m) if self.mask_on_discrepancy else joint.copy()
        keep = verified.copy()
        if self.keep_unverified:
            keep |= ai_ok & ~sv_ok & ~sky
        mask = np.where(keep, 255, 0).astype(np.uint8)
        if self.morph_kernel > 1:
            kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (self.morph_kernel, self.morph_kernel))
            mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
            mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
        mask[sky] = 0

        fused = np.full((h, w), np.nan, dtype=np.float32)
        m = mask == 255
        both = m & sv_ok
        fused[both] = self.alpha * d_ai_metric[both] + (1.0 - self.alpha) * d_sv[both]
        only_ai = m & ~sv_ok
        fused[only_ai] = d_ai_metric[only_ai]

        if joint.any():
            err = d_ai_metric[joint] - d_sv[joint]
            rmse = float(np.sqrt(np.mean(err**2)))
            mae = float(np.mean(np.abs(err)))
            abs_rel = float(np.mean(np.abs(err) / d_sv[joint]))
            inlier_ratio = float(100.0 * (joint & (delta <= self.tau_m)).sum() / joint.sum())
        else:
            rmse = mae = abs_rel = float("nan")
            inlier_ratio = 0.0
        metrics = DepthValidationMetrics(
            scale_factor=alignment.scale,
            shift_m=alignment.shift,
            rmse_m=rmse,
            mae_m=mae,
            abs_rel=abs_rel,
            inlier_ratio_pct=inlier_ratio,
            valid_surface_pct=float(100.0 * m.mean()),
            alignment_space=alignment.space,
            joint_pixels=int(joint.sum()),
        )
        return ValidationResult(
            d_sv=d_sv,
            d_ai_raw=d_ai_raw,
            d_ai_metric=d_ai_metric,
            discrepancy=delta,
            confidence=conf,
            mask=mask,
            fused=fused,
            joint_valid=joint,
            sky=sky,
            metrics=metrics,
            alignment=alignment,
        )


def ground_plane_prior(
    width: int, height: int, camera_height_m: float = 2.5, max_depth_m: float = 250.0, min_depression_deg: float = 3.0
) -> NDArray[np.float32]:
    """Metric range to a flat road plane ``camera_height_m`` below the camera (NaN above the horizon).

    Used as the metric reference when no Street View planar depth is available: RANSAC then picks
    the road pixels as inliers, so scale (and shift) are recovered from the known camera height.
    """
    v = (np.arange(height, dtype=np.float64) + 0.5) / height
    lat = (0.5 - v) * np.pi
    with np.errstate(divide="ignore"):
        dist = camera_height_m / np.sin(-lat)
    dist[lat > -np.deg2rad(min_depression_deg)] = np.nan
    dist[dist > max_depth_m] = np.nan
    return np.broadcast_to(dist[:, None], (height, width)).astype(np.float32)
