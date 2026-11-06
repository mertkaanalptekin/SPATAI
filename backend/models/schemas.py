"""Pydantic v2 request/response and node schemas for every pipeline stage."""

from __future__ import annotations

from enum import Enum
from typing import Dict, List, Literal, Optional, Tuple

from pydantic import BaseModel, Field


class SamplingMode(str, Enum):
    ROAD_NETWORK = "road"
    GRID = "grid"


class PanoSource(str, Enum):
    AUTO = "auto"
    GOOGLE = "google"
    MAPILLARY = "mapillary"
    SYNTHETIC = "synthetic"
    LOCAL = "local"


class TargetSoftware(str, Enum):
    METASHAPE = "metashape"
    REALITY_CAPTURE = "realitycapture"
    BOTH = "both"


class CameraGeometryMode(str, Enum):
    CUBEMAP_4 = "cubemap4"  # front, right, back, left (recommended)
    CUBEMAP_6 = "cubemap6"  # + zenith (up) and nadir (down)
    RING_8 = "ring8"  # 8 horizontal 90° views every 45° -> 50 % overlap inside a station
    EQUIRECTANGULAR = "equirectangular"


class PosePrior(str, Enum):
    INITIAL = "initial"  # recommended: Street View GNSS is only ~1-5 m accurate
    LOCKED = "locked"
    EXACT = "exact"


class ReferenceMode(str, Enum):
    PLANAR = "planar"  # Dataset A available: Street View planar depth
    GROUND_PRIOR = "ground_prior"  # metric scale from known camera height over the road plane


LayerType = Literal["rgb", "sv_depth", "ai_depth", "fused_depth", "discrepancy", "confidence", "mask"]


class AOIRequest(BaseModel):
    polygon_latlon: List[Tuple[float, float]] = Field(..., min_length=3)
    step_meters: float = Field(default=8.0, ge=3.0, le=50.0)
    sampling_mode: SamplingMode = SamplingMode.ROAD_NETWORK
    source: PanoSource = PanoSource.AUTO
    max_nodes: int = Field(default=200, ge=1, le=2000)
    fill_altitude_from_dem: bool = True


class PanoMetadata(BaseModel):
    pano_id: str
    lat: float
    lon: float
    alt: float = 0.0  # orthometric metres of the camera centre
    heading: float = 0.0  # degrees clockwise from North [0, 360) at the panorama centre column
    pitch: float = 0.0  # degrees [-90, 90]
    roll: float = 0.0  # degrees [-180, 180]
    capture_date: Optional[str] = None
    raw_depth_b64: Optional[str] = None
    source: PanoSource = PanoSource.SYNTHETIC
    image_width: Optional[int] = None
    image_height: Optional[int] = None
    tile_size: Optional[int] = None
    image_url: Optional[str] = None
    copyright: Optional[str] = None
    alt_source: Optional[str] = None
    rmse_m: Optional[float] = None


class SampleResponse(BaseModel):
    nodes: List[PanoMetadata]
    candidate_points: int
    sampling_mode_used: SamplingMode
    source_used: PanoSource
    warnings: List[str] = []


class DepthValidationMetrics(BaseModel):
    scale_factor: float
    shift_m: float
    rmse_m: float
    mae_m: float
    abs_rel: float
    inlier_ratio_pct: float
    valid_surface_pct: float
    alignment_space: str = "depth"
    joint_pixels: int = 0


class ProcessOptions(BaseModel):
    tau_m: Optional[float] = Field(default=None, ge=0.05, le=10.0)
    alpha: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    ai_mode: Optional[Literal["panorama", "cubemap"]] = None
    zoom: Optional[int] = Field(default=None, ge=1, le=5)


class ProcessResponse(BaseModel):
    pano: PanoMetadata
    metrics: DepthValidationMetrics
    reference_mode: ReferenceMode
    ai_backend: str
    width: int
    height: int
    rgb_width: int
    rgb_height: int
    timings_s: Dict[str, float]


class RevalidateRequest(BaseModel):
    tau_m: float = Field(default=0.85, ge=0.05, le=10.0)
    alpha: float = Field(default=0.75, ge=0.0, le=1.0)


class ExportRequest(BaseModel):
    project_name: str = Field(default="geopano3d_project", pattern=r"^[A-Za-z0-9_\-]{1,64}$")
    pano_ids: List[str] = Field(..., min_length=1)
    target: TargetSoftware = TargetSoftware.BOTH
    geometry: CameraGeometryMode = CameraGeometryMode.CUBEMAP_4
    face_size: int = Field(default=1024, ge=256, le=4096)
    include_depth: bool = True
    include_masks: bool = True
    include_dem: bool = True
    pose_prior: PosePrior = PosePrior.INITIAL
    accuracy_xy_m: float = 3.0
    accuracy_z_m: float = 5.0
    accuracy_ypr_deg: float = 2.0
    jpeg_quality: int = Field(default=95, ge=50, le=100)


class JobStatus(BaseModel):
    job_id: str
    state: Literal["queued", "running", "done", "error"]
    progress: float = 0.0
    message: str = ""
    download_url: Optional[str] = None
    manifest: Optional[dict] = None


class DemRequest(BaseModel):
    polygon_latlon: List[Tuple[float, float]] = Field(..., min_length=3)
    buffer_m: float = Field(default=50.0, ge=0.0, le=2000.0)
    source: Literal["auto", "terrarium", "opentopography"] = "auto"


class DemResponse(BaseModel):
    source: str
    resolution_m: float
    width: int
    height: int
    bounds: Tuple[float, float, float, float]  # south, west, north, east
    min_m: float
    max_m: float
    vertical_datum: str
    hillshade_png_b64: str
