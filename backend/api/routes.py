"""REST + WebSocket endpoints."""

from __future__ import annotations

import asyncio
import base64
import json
from typing import Literal, Optional

import cv2
from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response

from backend.models.schemas import (
    AOIRequest,
    DemRequest,
    DemResponse,
    ExportRequest,
    JobStatus,
    LayerType,
    PanoMetadata,
    PanoSource,
    ProcessOptions,
    ProcessResponse,
    RevalidateRequest,
    SampleResponse,
)
from backend.services.cubemap_projector import CUBE_FACES
from backend.services.exporters import preview_files
from backend.services.pipeline import Pipeline, ProcessedPano

router = APIRouter(prefix="/api")
FaceName = Literal["front", "right", "back", "left", "up", "down"]
PNG = "image/png"


def _pipe(request: Request) -> Pipeline:
    return request.app.state.pipeline


def _response(pp: ProcessedPano) -> ProcessResponse:
    h, w = pp.result.mask.shape
    return ProcessResponse(
        pano=pp.meta, metrics=pp.result.metrics, reference_mode=pp.ref_mode, ai_backend=pp.ai_backend,
        width=w, height=h, rgb_width=pp.rgb.shape[1], rgb_height=pp.rgb.shape[0],
        timings_s={k: round(v, 3) for k, v in pp.timings.items()},
    )


async def _cached(pipe: Pipeline, pano_id: str) -> ProcessedPano:
    try:
        return pipe.cache[pano_id] if pano_id in pipe.cache else await pipe.process(pano_id)
    except KeyError:
        raise HTTPException(404, f"unknown pano_id {pano_id}")


@router.get("/health")
async def health(request: Request) -> dict:
    pipe = _pipe(request)
    s = pipe.s
    return {
        "status": "ok",
        "ai_depth": pipe.estimator.info(),
        "sources": {
            "google": bool(s.google_maps_api_key),
            "mapillary": bool(s.mapillary_access_token),
            "synthetic": True,
            "local": True,
        },
        "dem": {"source": s.dem_source, "opentopography_key": bool(s.opentopography_api_key)},
        "ai_depth_mode": s.ai_depth_mode,
        "cached_panos": list(pipe.cache.keys()),
    }


@router.post("/aoi/sample", response_model=SampleResponse)
async def sample(req: AOIRequest, request: Request) -> SampleResponse:
    try:
        return await _pipe(request).sample(req)
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@router.get("/nodes", response_model=list[PanoMetadata])
async def nodes(request: Request) -> list[PanoMetadata]:
    return list(_pipe(request).nodes.values())


@router.post("/pano/upload", response_model=PanoMetadata)
async def upload(
    request: Request,
    image: UploadFile = File(..., description="equirectangular 2:1 JPEG/PNG"),
    lat: float = Form(...),
    lon: float = Form(...),
    heading: float = Form(0.0),
    alt: Optional[float] = Form(None),
    pano_id: Optional[str] = Form(None),
    raw_depth_b64: Optional[str] = Form(None, description="optional Street View planar depth buffer"),
) -> PanoMetadata:
    pipe = _pipe(request)
    data = await image.read()
    probe = cv2.imdecode(__import__("numpy").frombuffer(data, "uint8"), cv2.IMREAD_REDUCED_COLOR_8)
    if probe is None:
        raise HTTPException(400, "image could not be decoded")
    pid = pano_id or f"local_{abs(hash((lat, lon, len(data)))) % 10**10}"
    meta = PanoMetadata(pano_id=pid, lat=lat, lon=lon, heading=heading % 360, source=PanoSource.LOCAL,
                        raw_depth_b64=raw_depth_b64, alt=alt or 0.0, alt_source="user" if alt is not None else None)
    if alt is None:
        try:
            await pipe._fill_altitudes([meta])
        except Exception:
            pass
    return pipe.register_local(meta, data)


@router.post("/pano/{pano_id}/process", response_model=ProcessResponse)
async def process(pano_id: str, request: Request, opts: Optional[ProcessOptions] = None) -> ProcessResponse:
    try:
        pp = await _pipe(request).process(pano_id, opts)
    except KeyError:
        raise HTTPException(404, f"unknown pano_id {pano_id}")
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    return _response(pp)


@router.post("/pano/{pano_id}/revalidate", response_model=ProcessResponse)
async def revalidate(pano_id: str, body: RevalidateRequest, request: Request) -> ProcessResponse:
    pipe = _pipe(request)
    await _cached(pipe, pano_id)
    pp = await asyncio.to_thread(pipe.revalidate, pano_id, body.tau_m, body.alpha)
    return _response(pp)


@router.get("/pano/{pano_id}/layers/{layer_type}")
async def layer(pano_id: str, layer_type: LayerType, request: Request, width: Optional[int] = None) -> Response:
    pipe = _pipe(request)
    pp = await _cached(pipe, pano_id)
    png = await asyncio.to_thread(pipe.layer_png, pp, layer_type, width)
    return Response(png, media_type=PNG, headers={"Cache-Control": "no-store"})


@router.get("/pano/{pano_id}/arrays")
async def arrays(pano_id: str, request: Request, width: int = 512) -> Response:
    """float32 little-endian planes [sv, ai_metric, fused, discrepancy, mask] of shape (5, H, W)."""
    pipe = _pipe(request)
    pp = await _cached(pipe, pano_id)
    data, w, h = pipe.arrays_bin(pp, width)
    return Response(data, media_type="application/octet-stream",
                    headers={"X-Width": str(w), "X-Height": str(h), "X-Planes": "sv,ai,fused,discrepancy,mask",
                             "Access-Control-Expose-Headers": "X-Width, X-Height, X-Planes"})


@router.get("/pano/{pano_id}/cubemap/{face}")
async def cubemap(pano_id: str, face: FaceName, request: Request, layer: LayerType = "rgb", size: int = 512) -> Response:
    if face not in CUBE_FACES:
        raise HTTPException(404)
    pipe = _pipe(request)
    pp = await _cached(pipe, pano_id)
    png = await asyncio.to_thread(pipe.cubemap_png, pp, face, layer, max(64, min(size, 2048)))
    return Response(png, media_type=PNG, headers={"Cache-Control": "no-store"})


@router.post("/export/preview")
async def export_preview(req: ExportRequest, request: Request) -> dict[str, str]:
    pipe = _pipe(request)
    try:
        metas = [pipe.get_node(p) for p in req.pano_ids]
    except KeyError as exc:
        raise HTTPException(404, f"unknown pano_id {exc}")
    rmse = {m.pano_id: m.rmse_m for m in metas if m.rmse_m is not None}
    return preview_files(req, metas, rmse)


@router.post("/export/package", response_model=JobStatus)
async def export_package(req: ExportRequest, request: Request) -> JobStatus:
    pipe = _pipe(request)
    for p in req.pano_ids:
        try:
            pipe.get_node(p)
        except KeyError:
            raise HTTPException(404, f"unknown pano_id {p}")
    return pipe.start_export(req)


@router.get("/jobs/{job_id}", response_model=JobStatus)
async def job(job_id: str, request: Request) -> JobStatus:
    j = _pipe(request).jobs.get(job_id)
    if j is None:
        raise HTTPException(404)
    return j


@router.websocket("/ws/jobs/{job_id}")
async def job_ws(ws: WebSocket, job_id: str) -> None:
    await ws.accept()
    pipe: Pipeline = ws.app.state.pipeline
    try:
        while True:
            j = pipe.jobs.get(job_id)
            if j is None:
                await ws.send_text(json.dumps({"error": "unknown job"}))
                break
            await ws.send_text(j.model_dump_json())
            if j.state in ("done", "error"):
                break
            await asyncio.sleep(0.4)
    except WebSocketDisconnect:
        return
    await ws.close()


@router.get("/export/download/{job_id}")
async def download(job_id: str, request: Request) -> FileResponse:
    pipe = _pipe(request)
    path = pipe.job_files.get(job_id)
    if path is None or not path.exists():
        raise HTTPException(404)
    return FileResponse(path, media_type="application/zip", filename=path.name)


@router.post("/dem", response_model=DemResponse)
async def dem(req: DemRequest, request: Request) -> DemResponse:
    try:
        d = await _pipe(request).dem_for(req)
    except Exception as exc:
        raise HTTPException(502, f"DEM fetch failed: {exc}")
    ok, buf = cv2.imencode(".png", d.hillshade())
    import numpy as np

    return DemResponse(
        source=d.source, resolution_m=round(d.resolution_m, 3), width=d.width, height=d.height, bounds=d.bounds,
        min_m=float(np.nanmin(d.data)), max_m=float(np.nanmax(d.data)), vertical_datum=d.vertical_datum,
        hillshade_png_b64=base64.b64encode(buf.tobytes()).decode(),
    )
