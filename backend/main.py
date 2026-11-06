"""FastAPI entrypoint:  uvicorn backend.main:app --reload"""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from backend.api.routes import router
from backend.config import Settings, get_settings
from backend.services.pipeline import Pipeline

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    app = FastAPI(title="GeoPano3D", version="1.0.0",
                  description="Street-level 360° + DEM photogrammetry pipeline for Metashape & RealityCapture")
    app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_methods=["*"], allow_headers=["*"],
                       expose_headers=["X-Width", "X-Height", "X-Planes"])
    app.state.pipeline = Pipeline(settings)
    app.include_router(router)
    dist = Path(__file__).resolve().parents[1] / "frontend" / "dist"
    if dist.exists():  # serve the built UI from the same origin
        app.mount("/", StaticFiles(directory=dist, html=True), name="ui")
    return app


app = create_app()
