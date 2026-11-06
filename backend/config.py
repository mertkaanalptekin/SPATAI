"""Runtime configuration (environment variables / .env)."""

from __future__ import annotations

import os
import re
from functools import lru_cache
from pathlib import Path
from typing import Literal, Mapping

from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[1]
# The .env file lives next to the project (or wherever GEOPANO3D_ENV_FILE points, e.g. a Docker volume),
# independent of the directory the server is started from.
ENV_FILE = Path(os.environ.get("GEOPANO3D_ENV_FILE", ROOT / ".env"))

# settings that can be edited from the UI (Settings panel -> PUT /api/settings)
EDITABLE_SECRETS = ("google_maps_api_key", "mapillary_access_token", "opentopography_api_key")
EDITABLE_OPTIONS = ("ai_depth_backend", "ai_depth_mode", "dem_source", "pano_zoom", "default_cubemap_face_size",
                    "depth_work_width", "camera_height_m", "default_discrepancy_threshold_m", "default_fusion_alpha")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ENV_FILE, env_file_encoding="utf-8", extra="ignore")

    settings_file: Path = ENV_FILE
    allow_remote_settings: bool = False  # Settings API is loopback-only unless enabled (Docker)

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
    export_work_dir: Path = ROOT / "exports"
    result_cache_size: int = 12

    dem_source: Literal["auto", "terrarium", "opentopography"] = "auto"
    opentopography_api_key: str = ""
    terrarium_url: str = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"

    cors_origins: list[str] = ["*"]


@lru_cache
def get_settings() -> Settings:
    return Settings()


def update_env_file(path: Path, updates: Mapping[str, str]) -> None:
    """Set ``KEY=value`` lines in a .env file, keeping comments, order and unrelated keys."""
    path = Path(path)
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    pending = {k.upper(): v for k, v in updates.items()}
    out = []
    for line in lines:
        m = re.match(r"\s*([A-Za-z_][A-Za-z0-9_]*)\s*=", line)
        key = m.group(1).upper() if m else None
        if key in pending:
            out.append(f"{key}={pending.pop(key)}")
        else:
            out.append(line)
    out += [f"{k}={v}" for k, v in pending.items()]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(out) + "\n", encoding="utf-8")
