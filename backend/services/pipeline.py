"""Pipeline orchestration: node registry, per-panorama processing cache, layers, export jobs."""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator, Optional

import cv2
import numpy as np
from numpy.typing import NDArray

from backend.config import Settings
from backend.models.schemas import (
    AOIRequest,
    DemRequest,
    ExportRequest,
    JobStatus,
    PanoMetadata,
    PanoSource,
    ProcessOptions,
    ReferenceMode,
    SampleResponse,
)
from backend.services.ai_depth_estimator import AIDepthEstimator
from backend.services.aoi_sampler import AOISampler
from backend.services.cubemap_projector import CUBE_FACES, CubemapConverter, equirect_rays
from backend.services.dem_service import DemRaster, DemService, expand_bounds
from backend.services.depth_decoder import StreetViewDepthDecoder
from backend.services.dual_depth_validator import (
    AlignmentResult,
    DualDepthValidator,
    ValidationResult,
    ground_plane_prior,
)
from backend.services.exporters import ExportItem, PhotogrammetryPackager
from backend.services.streetview_client import (
    GoogleTilesProvider,
    LocalProvider,
    MapillaryProvider,
    PanoProvider,
    SyntheticProvider,
    choose_source,
)

log = logging.getLogger(__name__)


@dataclass
class ProcessedPano:
    meta: PanoMetadata
    rgb: NDArray[np.uint8]  # full resolution
    rgb_work: NDArray[np.uint8]
    d_ref: NDArray[np.float32]  # work resolution, radial metres
    sky_ref: Optional[NDArray[np.bool_]]
    ref_mode: ReferenceMode
    ai_values: NDArray[np.float32]  # raw (panorama mode) or per-face metric (cubemap mode)
    ai_kind: str  # "disparity" | "depth" | "metric-per-face"
    ai_backend: str
    alignment: Optional[AlignmentResult]
    face_alignment: dict[str, tuple[float, float]]
    result: ValidationResult
    tau: float
    alpha: float
    timings: dict[str, float] = field(default_factory=dict)


class Pipeline:
    def __init__(self, settings: Settings) -> None:
        self.s = settings
        self.nodes: dict[str, PanoMetadata] = {}
        self.cache: OrderedDict[str, ProcessedPano] = OrderedDict()
        self._locks: dict[str, asyncio.Lock] = {}
        self.decoder = StreetViewDepthDecoder(max_depth_m=settings.max_depth_m)
        self.estimator = AIDepthEstimator(settings.ai_depth_backend, settings.ai_depth_model_id)
        self.sampler = AOISampler(settings.overpass_api_url)
        self.dem = DemService(settings)
        self.local = LocalProvider(Path(settings.export_work_dir) / "uploads")
        self.providers: dict[PanoSource, PanoProvider] = {
            PanoSource.SYNTHETIC: SyntheticProvider(),
            PanoSource.LOCAL: self.local,
        }
        if settings.google_maps_api_key:
            self.providers[PanoSource.GOOGLE] = GoogleTilesProvider(settings)
        if settings.mapillary_access_token:
            self.providers[PanoSource.MAPILLARY] = MapillaryProvider(settings)
        self.packager = PhotogrammetryPackager(Path(settings.export_work_dir))
        self.jobs: dict[str, JobStatus] = {}
        self.job_files: dict[str, Path] = {}

    # ------------------------------------------------------------------ nodes
    def get_node(self, pano_id: str) -> PanoMetadata:
        if pano_id in self.nodes:
            return self.nodes[pano_id]
        if pano_id.startswith("synth_"):
            lat0, lon0, n = SyntheticProvider.parse_id(pano_id)
            meta = SyntheticProvider().meta_for(lat0, lon0, n)
            self.nodes[pano_id] = meta
            return meta
        raise KeyError(pano_id)

    async def sample(self, req: AOIRequest) -> SampleResponse:
        source = choose_source(req.source, self.s)
        provider = self.providers.get(source)
        if provider is None:
            raise ValueError(f"source '{source.value}' is not configured (missing API key?)")
        points, mode, warnings = await self.sampler.sample(req)
        if not points:
            return SampleResponse(nodes=[], candidate_points=0, sampling_mode_used=mode, source_used=source,
                                  warnings=warnings + ["AOI produced no sample points."])
        origin = self.sampler.centroid(req)
        nodes = await provider.resolve(points, req.step_meters, origin)
        nodes = list({n.pano_id: n for n in nodes}.values())[: req.max_nodes]
        if req.fill_altitude_from_dem and nodes and source != PanoSource.SYNTHETIC:
            try:
                await self._fill_altitudes(nodes)
            except Exception as exc:
                warnings.append(f"DEM altitude fill failed: {exc}")
        for n in nodes:
            self.nodes[n.pano_id] = n
        return SampleResponse(nodes=nodes, candidate_points=len(points), sampling_mode_used=mode,
                              source_used=source, warnings=warnings)

    async def _fill_altitudes(self, nodes: list[PanoMetadata]) -> None:
        lats = [n.lat for n in nodes]
        lons = [n.lon for n in nodes]
        dem = await self.dem.fetch(*expand_bounds(min(lats), min(lons), max(lats), max(lons), 60.0))
        z = dem.sample(lats, lons)
        for n, g in zip(nodes, z):
            if np.isfinite(g):
                n.alt = float(g) + self.s.camera_height_m
                n.alt_source = f"{dem.source} + {self.s.camera_height_m} m camera height"

    def register_local(self, meta: PanoMetadata, image_bytes: bytes) -> PanoMetadata:
        self.local.path_for(meta.pano_id).write_bytes(image_bytes)
        meta.source = PanoSource.LOCAL
        self.nodes[meta.pano_id] = meta
        self.cache.pop(meta.pano_id, None)
        return meta

    # ------------------------------------------------------------------ processing
    def _validator(self, mode: ReferenceMode, space: str, tau: float, alpha: float) -> DualDepthValidator:
        planar = mode == ReferenceMode.PLANAR
        return DualDepthValidator(
            tau_m=tau,
            alpha=alpha,
            d_max=self.s.max_depth_m,
            space=space,  # type: ignore[arg-type]
            mask_on_discrepancy=planar,
            keep_unverified=not planar,
        )

    async def process(self, pano_id: str, opts: Optional[ProcessOptions] = None) -> ProcessedPano:
        opts = opts or ProcessOptions()
        lock = self._locks.setdefault(pano_id, asyncio.Lock())
        async with lock:
            cached = self.cache.get(pano_id)
            if cached is not None and opts.ai_mode is None and opts.zoom is None:
                self.cache.move_to_end(pano_id)
                if opts.tau_m is not None or opts.alpha is not None:
                    return self.revalidate(pano_id, opts.tau_m or cached.tau, opts.alpha if opts.alpha is not None else cached.alpha)
                return cached
            meta = self.get_node(pano_id)
            provider = self.providers.get(meta.source)
            if provider is None:
                raise ValueError(f"source '{meta.source.value}' not configured")
            t0 = time.perf_counter()
            fetched = await provider.fetch(meta, opts.zoom or self.s.pano_zoom)
            t1 = time.perf_counter()
            pp = await asyncio.to_thread(
                self._compute, meta, fetched.rgb, fetched.depth_b64 or meta.raw_depth_b64, fetched.oracle_range,
                opts.ai_mode or self.s.ai_depth_mode,
                opts.tau_m or self.s.default_discrepancy_threshold_m,
                opts.alpha if opts.alpha is not None else self.s.default_fusion_alpha,
            )
            pp.timings = {"fetch": t1 - t0, **pp.timings, "total": time.perf_counter() - t0}
            meta.rmse_m = _finite_or_none(pp.result.metrics.rmse_m)
            self.cache[pano_id] = pp
            while len(self.cache) > self.s.result_cache_size:
                self.cache.popitem(last=False)
            return pp

    def _compute(
        self,
        meta: PanoMetadata,
        rgb: NDArray[np.uint8],
        depth_b64: Optional[str],
        oracle: Optional[NDArray[np.float32]],
        ai_mode: str,
        tau: float,
        alpha: float,
    ) -> ProcessedPano:
        timings: dict[str, float] = {}
        t = time.perf_counter()
        W = self.s.depth_work_width
        H = W // 2
        rgb_work = cv2.resize(rgb, (W, H), interpolation=cv2.INTER_AREA)
        oracle_work = cv2.resize(oracle, (W, H), interpolation=cv2.INTER_NEAREST) if oracle is not None else None

        sky_ref = None
        if depth_b64:
            d_sv, plane_idx = self.decoder.decode(depth_b64)
            d_ref = cv2.resize(d_sv, (W, H), interpolation=cv2.INTER_NEAREST)
            sky_ref = cv2.resize(plane_idx, (W, H), interpolation=cv2.INTER_NEAREST) == 0
            mode = ReferenceMode.PLANAR
        else:
            d_ref = ground_plane_prior(W, H, self.s.camera_height_m, self.s.max_depth_m)
            mode = ReferenceMode.GROUND_PRIOR
        timings["dataset_a"] = time.perf_counter() - t

        t = time.perf_counter()
        face_alignment: dict[str, tuple[float, float]] = {}
        if ai_mode == "panorama":
            pred = self.estimator.predict(rgb_work, equirect_rays(W, H), oracle_work)
            ai_values, ai_kind = pred.values, pred.kind
            validator = self._validator(mode, pred.kind, tau, alpha)
            timings["dataset_b"] = time.perf_counter() - t
            t = time.perf_counter()
            res = validator.validate(d_ref, ai_values, sky=sky_ref)
            alignment = res.alignment
        else:
            ai_values, face_alignment, kind = self._per_face_metric(rgb, d_ref, oracle_work, mode, tau, alpha)
            ai_kind = f"{kind}/per-face"
            timings["dataset_b"] = time.perf_counter() - t
            t = time.perf_counter()
            validator = self._validator(mode, "depth", tau, alpha)
            alignment = AlignmentResult(1.0, 0.0, np.zeros((H, W), bool), "depth")
            res = validator.validate(d_ref, ai_values, sky=sky_ref, alignment=alignment)
            _apply_face_alignment_metrics(res, face_alignment, kind)
        timings["validation"] = time.perf_counter() - t
        return ProcessedPano(
            meta=meta, rgb=rgb, rgb_work=rgb_work, d_ref=d_ref, sky_ref=sky_ref, ref_mode=mode,
            ai_values=ai_values, ai_kind=ai_kind, ai_backend=self.estimator.backend, alignment=alignment,
            face_alignment=face_alignment, result=res, tau=tau, alpha=alpha, timings=timings,
        )

    def _per_face_metric(self, rgb, d_ref, oracle_work, mode, tau, alpha):
        """Run monocular depth on undistorted 90 deg faces, align each face, stitch metric range."""
        H, W = d_ref.shape
        conv = CubemapConverter(face_size=max(256, min(768, W // 3)))
        metric_faces: dict[str, NDArray[np.float32]] = {}
        params: dict[str, tuple[float, float, int]] = {}
        preds = {}
        kind = "disparity"
        for name, spec in CUBE_FACES.items():
            face_rgb = conv.project(rgb, spec, "linear")
            _, _, cos_axis = conv.maps(W, H, spec)
            ref_z = conv.project_range_to_zdepth(d_ref, spec)
            orc_z = conv.project_range_to_zdepth(oracle_work, spec) if oracle_work is not None else None
            pred = self.estimator.predict(face_rgb, conv.face_rays(spec), orc_z)
            kind = pred.kind
            v = self._validator(mode, pred.kind, tau, alpha)
            valid = np.isfinite(ref_z) & (ref_z > 1.0) & (ref_z < self.s.max_depth_m) & (pred.values > 1e-4)
            al = v.align(ref_z, pred.values, valid)
            preds[name] = (pred, cos_axis, v)
            params[name] = (al.scale, al.shift, int(al.inliers.sum()))
        good = {k: p for k, p in params.items() if p[2] >= 300}
        fallback = max(params.values(), key=lambda p: p[2])
        face_alignment = {}
        for name, (pred, cos_axis, v) in preds.items():
            s, t_, _ = good.get(name, fallback)
            face_alignment[name] = (s, t_)
            z = v.to_metric(pred.values, s, t_)
            rng = z / np.maximum(cos_axis, 1e-3)
            sky = z >= self.s.max_depth_m * 0.999
            rng = np.where(sky, self.s.max_depth_m, np.minimum(rng, self.s.max_depth_m)).astype(np.float32)
            metric_faces[name] = rng
        stitched = conv.faces_to_equirect(metric_faces, W, H, "nearest")
        stitched = np.where(np.isfinite(stitched), stitched, self.s.max_depth_m).astype(np.float32)
        return stitched, face_alignment, kind

    def revalidate(self, pano_id: str, tau: float, alpha: float) -> ProcessedPano:
        pp = self.cache[pano_id]
        if pp.ai_kind.endswith("per-face"):
            v = self._validator(pp.ref_mode, "depth", tau, alpha)
            res = v.validate(pp.d_ref, pp.ai_values, sky=pp.sky_ref, alignment=pp.alignment)
            _apply_face_alignment_metrics(res, pp.face_alignment, pp.ai_kind.split("/")[0])
        else:
            v = self._validator(pp.ref_mode, pp.ai_kind, tau, alpha)
            res = v.validate(pp.d_ref, pp.ai_values, sky=pp.sky_ref, alignment=pp.alignment)
        pp.result, pp.tau, pp.alpha = res, tau, alpha
        pp.meta.rmse_m = _finite_or_none(res.metrics.rmse_m)
        return pp

    # ------------------------------------------------------------------ visualisation
    def layer_png(self, pp: ProcessedPano, layer: str, width: Optional[int] = None) -> bytes:
        img = render_layer(pp, layer)
        if width and img.shape[1] != width:
            interp = cv2.INTER_AREA if layer == "rgb" else cv2.INTER_NEAREST
            img = cv2.resize(img, (width, width * img.shape[0] // img.shape[1]), interpolation=interp)
        return _png(img)

    def cubemap_png(self, pp: ProcessedPano, face: str, layer: str, size: int = 512) -> bytes:
        conv = CubemapConverter(size)
        if layer == "rgb":
            img = conv.project(pp.rgb, face, "linear")
        else:
            img = conv.project(render_layer(pp, layer), face, "nearest")
        return _png(img)

    def arrays_bin(self, pp: ProcessedPano, width: int = 512) -> tuple[bytes, int, int]:
        r = pp.result
        H, W = r.d_sv.shape
        step = max(1, W // width)
        planes = [r.d_sv, r.d_ai_metric, r.fused, r.discrepancy, r.mask.astype(np.float32)]
        stack = np.stack([p[::step, ::step] for p in planes]).astype("<f4")
        return stack.tobytes(), stack.shape[2], stack.shape[1]

    # ------------------------------------------------------------------ DEM
    async def dem_for(self, req: DemRequest) -> DemRaster:
        lats = [p[0] for p in req.polygon_latlon]
        lons = [p[1] for p in req.polygon_latlon]
        return await self.dem.fetch(*expand_bounds(min(lats), min(lons), max(lats), max(lons), req.buffer_m), req.source)

    # ------------------------------------------------------------------ export jobs
    def start_export(self, req: ExportRequest) -> JobStatus:
        job = JobStatus(job_id=uuid.uuid4().hex[:12], state="queued")
        self.jobs[job.job_id] = job
        asyncio.get_running_loop().create_task(self._run_export(job, req))
        return job

    async def _run_export(self, job: JobStatus, req: ExportRequest) -> None:
        loop = asyncio.get_running_loop()
        job.state = "running"
        try:
            metas = [self.get_node(pid) for pid in req.pano_ids]
            dem = None
            if req.include_dem:
                job.message = "fetching DEM"
                try:
                    lats = [m.lat for m in metas]
                    lons = [m.lon for m in metas]
                    dem = await self.dem.fetch(*expand_bounds(min(lats), min(lons), max(lats), max(lons), 150.0))
                except Exception as exc:
                    log.warning("DEM for export failed: %s", exc)
                    job.message = f"DEM unavailable ({exc}); continuing"

            def items() -> Iterator[ExportItem]:
                for m in metas:
                    pp = asyncio.run_coroutine_threadsafe(self.process(m.pano_id), loop).result()
                    r = pp.result
                    yield ExportItem(m, pp.rgb, r.fused if req.include_depth else None,
                                     r.mask if req.include_masks else None, _finite_or_none(r.metrics.rmse_m))

            def progress(f: float, msg: str) -> None:
                job.progress = round(f, 4)
                job.message = msg

            center = (float(np.mean([m.lat for m in metas])), float(np.mean([m.lon for m in metas])))
            zip_path, manifest = await asyncio.to_thread(
                self.packager.build, req, items(), dem, progress, center, len(metas)
            )
            self.job_files[job.job_id] = zip_path
            job.download_url = f"/api/export/download/{job.job_id}"
            job.manifest = {"images": len(manifest["images"]), "utm_epsg": manifest["export"]["utm_epsg"],
                            "dem": manifest["dem"], "zip_mb": round(zip_path.stat().st_size / 1e6, 2)}
            job.state, job.progress, job.message = "done", 1.0, "ready"
        except Exception as exc:
            log.exception("export failed")
            job.state, job.message = "error", f"{type(exc).__name__}: {exc}"


def _apply_face_alignment_metrics(res: ValidationResult, fa: dict[str, tuple[float, float]], kind: str) -> None:
    horiz = [fa[k] for k in ("front", "right", "back", "left") if k in fa] or list(fa.values())
    res.metrics.scale_factor = float(np.median([p[0] for p in horiz]))
    res.metrics.shift_m = float(np.median([p[1] for p in horiz]))
    res.metrics.alignment_space = f"{kind} (per-face, median of 4 horizontal faces)"


def _finite_or_none(x: Optional[float]) -> Optional[float]:
    return float(x) if x is not None and np.isfinite(x) else None


def _png(img: NDArray) -> bytes:
    if img.ndim == 3 and img.shape[2] == 3:
        img = img[..., ::-1]
    elif img.ndim == 3 and img.shape[2] == 4:
        img = img[..., [2, 1, 0, 3]]
    ok, buf = cv2.imencode(".png", img, [cv2.IMWRITE_PNG_COMPRESSION, 3])
    if not ok:
        raise RuntimeError("PNG encoding failed")
    return buf.tobytes()


def colorize_depth(d: NDArray[np.float32], d_min: float = 1.0, d_max: float = 120.0) -> NDArray[np.uint8]:
    """Log-scaled turbo colour map, RGBA with transparent NaNs."""
    valid = np.isfinite(d)
    x = np.log(np.clip(np.nan_to_num(d, nan=d_max), d_min, d_max) / d_min) / np.log(d_max / d_min)
    rgb = cv2.applyColorMap((255 - x * 255).astype(np.uint8), cv2.COLORMAP_TURBO)[..., ::-1]
    return np.dstack([rgb, np.where(valid, 255, 0).astype(np.uint8)])


def render_layer(pp: ProcessedPano, layer: str) -> NDArray[np.uint8]:
    r = pp.result
    if layer == "rgb":
        return pp.rgb_work
    if layer == "sv_depth":
        return colorize_depth(r.d_sv)
    if layer == "ai_depth":
        return colorize_depth(np.where(r.d_ai_metric >= pp.result.d_ai_metric.max() * 0.999, np.nan, r.d_ai_metric))
    if layer == "fused_depth":
        return colorize_depth(r.fused)
    if layer == "discrepancy":
        x = np.clip(np.nan_to_num(r.discrepancy, nan=0) / (2 * pp.tau), 0, 1)
        rgb = cv2.applyColorMap((x * 255).astype(np.uint8), cv2.COLORMAP_INFERNO)[..., ::-1]
        return np.dstack([rgb, np.where(np.isfinite(r.discrepancy), 255, 0).astype(np.uint8)])
    if layer == "confidence":
        rgb = cv2.applyColorMap((r.confidence * 255).astype(np.uint8), cv2.COLORMAP_VIRIDIS)[..., ::-1]
        return np.dstack([rgb, np.where(r.joint_valid, 255, 0).astype(np.uint8)])
    if layer == "mask":
        return np.dstack([r.mask] * 3)
    raise KeyError(layer)
