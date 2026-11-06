"""Runtime configuration (environment variables / .env)."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    google_maps_api_key: str = ""
    mapillary_access_token: str = ""
    overpass_api_url: str = "https://overpass-api.de/api/interpreter"

    ai_depth_backend: Literal["auto", "transformers", "mock"] = "auto"
    ai_depth_model_id: str = "depth-anything/Depth-Anything-V2-Small-hf"
    ai_depth_mode: Literal["panorama", "cubemap"] = "cubemap"

    default_discrepancy_threshold_m: float = 0.85
    default_fusion_alpha: float = 0.75
    max_depth_m: float = 250.0
    camera_height_m: float = 2.5

    default_cubemap_face_size: int = 1024
    pano_zoom: int = 4
    depth_work_width: int = 1024
    export_work_dir: Path = Path("./exports")
    result_cache_size: int = 12

    dem_source: Literal["auto", "terrarium", "opentopography"] = "auto"
    opentopography_api_key: str = ""
    terrarium_url: str = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"

    cors_origins: list[str] = ["*"]


@lru_cache
def get_settings() -> Settings:
    return Settings()
