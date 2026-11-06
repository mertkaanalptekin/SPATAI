"""Dataset B: monocular depth (Depth Anything V2) with automatic device selection.

Backends
--------
* ``transformers`` - Hugging Face ``AutoModelForDepthEstimation`` on CUDA / MPS / CPU. Relative
  models output affine-invariant *disparity*; ``*Metric*`` models output metric depth.
* ``mock`` - deterministic fallback (no torch needed) so the app and tests always run:
  - with an *oracle* range (synthetic scenes) it returns the true disparity under an unknown affine
    transform + noise, exactly mimicking what a relative-depth network gives;
  - otherwise a geometric prior from the viewing rays (road plane below the horizon, facade
    cylinder above, sky by colour).
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from typing import Literal, Optional

import cv2
import numpy as np
from numpy.typing import NDArray

log = logging.getLogger(__name__)

OutputKind = Literal["disparity", "depth"]


@dataclass
class DepthPrediction:
    values: NDArray[np.float32]  # (H, W)
    kind: OutputKind


def _torch_device() -> str:
    import torch

    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def torch_available() -> bool:
    try:
        import torch  # noqa: F401
        import transformers  # noqa: F401

        return True
    except Exception:
        return False


class AIDepthEstimator:
    def __init__(self, backend: str = "auto", model_id: str = "depth-anything/Depth-Anything-V2-Small-hf") -> None:
        if backend == "auto":
            backend = "transformers" if torch_available() else "mock"
        self.backend = backend
        self.model_id = model_id
        self._model = None
        self._processor = None
        self._device = "cpu"
        self._lock = threading.Lock()
        self.load_error: Optional[str] = None

    @property
    def is_metric(self) -> bool:
        return self.backend == "transformers" and "metric" in self.model_id.lower()

    def info(self) -> dict:
        return {
            "backend": self.backend,
            "model_id": self.model_id if self.backend == "transformers" else "geometric/oracle fallback",
            "device": self._device if self._model is not None else (_torch_device() if self.backend == "transformers" else "cpu"),
            "loaded": self._model is not None or self.backend == "mock",
            "load_error": self.load_error,
        }

    def _ensure_model(self) -> None:
        if self._model is not None:
            return
        with self._lock:
            if self._model is not None:
                return
            from transformers import AutoImageProcessor, AutoModelForDepthEstimation

            self._device = _torch_device()
            log.info("loading %s on %s", self.model_id, self._device)
            self._processor = AutoImageProcessor.from_pretrained(self.model_id)
            self._model = AutoModelForDepthEstimation.from_pretrained(self.model_id).to(self._device).eval()

    def predict(
        self,
        rgb: NDArray[np.uint8],
        rays: Optional[NDArray[np.float32]] = None,
        oracle_range: Optional[NDArray[np.float32]] = None,
    ) -> DepthPrediction:
        """``rays``: unit view rays (H, W, 3) in a y-up frame; ``oracle_range``: true range in the
        image's own depth convention (radial for panoramas, z-depth for pinhole faces)."""
        if self.backend == "transformers":
            try:
                return self._predict_hf(rgb)
            except Exception as exc:  # model download / OOM -> degrade gracefully
                self.load_error = str(exc)
                log.exception("Depth Anything inference failed, using fallback")
        return self._predict_mock(rgb, rays, oracle_range)

    def _predict_hf(self, rgb: NDArray[np.uint8]) -> DepthPrediction:
        import torch
        from PIL import Image

        self._ensure_model()
        h, w = rgb.shape[:2]
        inputs = self._processor(images=Image.fromarray(rgb), return_tensors="pt").to(self._device)
        with torch.inference_mode():
            pred = self._model(**inputs).predicted_depth
        pred = torch.nn.functional.interpolate(pred.unsqueeze(1), size=(h, w), mode="bicubic", align_corners=False)
        out = pred.squeeze().float().cpu().numpy().astype(np.float32)
        return DepthPrediction(out, "depth" if self.is_metric else "disparity")

    @staticmethod
    def _predict_mock(
        rgb: NDArray[np.uint8],
        rays: Optional[NDArray[np.float32]],
        oracle_range: Optional[NDArray[np.float32]],
    ) -> DepthPrediction:
        h, w = rgb.shape[:2]
        if oracle_range is not None:
            rng_m = oracle_range
            if rng_m.shape != (h, w):
                rng_m = cv2.resize(rng_m, (w, h), interpolation=cv2.INTER_NEAREST)
            inv = np.where(np.isfinite(rng_m), 1.0 / np.maximum(rng_m, 0.3), 0.0)
            noise = np.random.default_rng(int(rgb[:: max(1, h // 8), :: max(1, w // 8)].sum()) % 2**31)
            disp = 37.0 * inv + 0.0 + noise.normal(0, 0.003, inv.shape)  # unknown scale, zero sky
            disp = cv2.GaussianBlur(disp.astype(np.float32), (3, 3), 0)
            return DepthPrediction(np.maximum(disp, 0).astype(np.float32), "disparity")

        if rays is None:
            from backend.services.cubemap_projector import equirect_rays

            rays = equirect_rays(w, h)
        up = rays[..., 1]
        horiz = np.sqrt(np.maximum(1 - up**2, 1e-6))
        with np.errstate(divide="ignore"):
            ground = np.where(up < -0.02, 2.5 / -up, np.inf)
            facade = np.where(up > -0.5, 12.0 / horiz, np.inf)
        depth = np.minimum(ground, np.where(up * 12.0 / horiz < 15.0, facade, np.inf))
        hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV).astype(np.float32)
        sky = (up > 0.05) & (hsv[..., 0] > 85) & (hsv[..., 0] < 135) & (hsv[..., 2] > 120)
        depth = np.where(sky, np.inf, depth)
        disp = np.where(np.isfinite(depth), 1.0 / depth, 0.0).astype(np.float32)
        return DepthPrediction(disp, "disparity")
