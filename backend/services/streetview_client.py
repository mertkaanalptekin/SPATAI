"""Panorama providers: Google Map Tiles (Street View), Mapillary, local uploads and a synthetic demo.

Each provider turns candidate sample points into deduplicated :class:`PanoMetadata` nodes and
fetches full equirectangular RGB (+ planar depth when the provider has it).

Licensing: Google Maps Platform terms restrict creating 3D models / derived datasets from Street
View content; check your agreement before using ``google`` for reconstruction. Mapillary imagery
is CC-BY-SA 4.0 and may be used for derived 3D works with attribution.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Protocol

import cv2
import httpx
import numpy as np
from numpy.typing import NDArray
from scipy.spatial import cKDTree

from backend.config import Settings
from backend.models.schemas import PanoMetadata, PanoSource
from backend.services.geo import LocalENU
from backend.services.synthetic_scene import CAMERA_HEIGHT, STREET_END, pano_heading, render_pano
from backend.services.tile_stitcher import ensure_2to1, stitch_tiles, tile_grid

log = logging.getLogger(__name__)
GOOGLE_BASE = "https://tile.googleapis.com/v1"


@dataclass
class FetchedPano:
    rgb: NDArray[np.uint8]
    depth_b64: Optional[str] = None
    oracle_range: Optional[NDArray[np.float32]] = None


class PanoProvider(Protocol):
    source: PanoSource

    async def resolve(
        self, points: list[tuple[float, float]], step_m: float, origin: tuple[float, float]
    ) -> list[PanoMetadata]: ...

    async def fetch(self, meta: PanoMetadata, zoom: int) -> FetchedPano: ...


# --------------------------------------------------------------------------- Google Map Tiles API
class GoogleTilesProvider:
    source = PanoSource.GOOGLE

    def __init__(self, settings: Settings) -> None:
        self.key = settings.google_maps_api_key
        self._session: Optional[tuple[str, float]] = None
        self._lock = asyncio.Lock()

    async def _session_token(self, client: httpx.AsyncClient) -> str:
        async with self._lock:
            if self._session and self._session[1] > time.time() + 60:
                return self._session[0]
            r = await client.post(
                f"{GOOGLE_BASE}/createSession",
                params={"key": self.key},
                json={"mapType": "streetview", "language": "en-US", "region": "US"},
            )
            r.raise_for_status()
            js = r.json()
            self._session = (js["session"], float(js.get("expiry", time.time() + 3600)))
            return self._session[0]

    async def resolve(self, points, step_m, origin):
        radius = int(max(10, min(50, step_m)))
        async with httpx.AsyncClient(timeout=30, http2=True) as client:
            session = await self._session_token(client)
            ids: list[str] = []
            for i in range(0, len(points), 100):
                chunk = points[i : i + 100]
                r = await client.post(
                    f"{GOOGLE_BASE}/streetview/panoIds",
                    params={"session": session, "key": self.key},
                    json={"locations": [{"lat": la, "lng": lo} for la, lo in chunk], "radius": radius},
                )
                r.raise_for_status()
                ids.extend(p for p in r.json().get("panoIds", []) if p)
            unique = list(dict.fromkeys(ids))
            sem = asyncio.Semaphore(8)

            async def meta(pid: str) -> Optional[PanoMetadata]:
                async with sem:
                    r = await client.get(
                        f"{GOOGLE_BASE}/streetview/metadata", params={"session": session, "key": self.key, "panoId": pid}
                    )
                if r.status_code != 200:
                    return None
                m = r.json()
                return PanoMetadata(
                    pano_id=m.get("panoId", pid),
                    lat=m["lat"],
                    lon=m["lng"],
                    heading=float(m.get("heading", 0.0)) % 360.0,
                    pitch=float(m.get("tilt", 90.0)) - 90.0,
                    roll=float(m.get("roll", 0.0)),
                    capture_date=m.get("date"),
                    source=PanoSource.GOOGLE,
                    image_width=m.get("imageWidth"),
                    image_height=m.get("imageHeight"),
                    tile_size=m.get("tileWidth", 512),
                    copyright=m.get("copyright"),
                )

            metas = await asyncio.gather(*(meta(p) for p in unique))
        return [m for m in metas if m is not None]

    async def fetch(self, meta, zoom):
        tile = meta.tile_size or 512
        cols, rows, wz, hz, z = tile_grid(meta.image_width or 16384, meta.image_height or 8192, tile, zoom)
        async with httpx.AsyncClient(timeout=30, http2=True) as client:
            session = await self._session_token(client)

            async def get(x: int, y: int) -> Optional[bytes]:
                for attempt in range(3):
                    try:
                        r = await client.get(
                            f"{GOOGLE_BASE}/streetview/tiles/{z}/{x}/{y}",
                            params={"session": session, "key": self.key, "panoId": meta.pano_id},
                        )
                        if r.status_code == 200:
                            return r.content
                        if r.status_code in (400, 404):
                            return None
                    except httpx.HTTPError:
                        pass
                    await asyncio.sleep(0.4 * (attempt + 1))
                return None

            rgb = await stitch_tiles(get, cols, rows, tile, wz, hz)
        # Map Tiles API does not expose depth; a planar buffer can still be attached via upload
        return FetchedPano(rgb, meta.raw_depth_b64)


# --------------------------------------------------------------------------- Mapillary (CC-BY-SA)
class MapillaryProvider:
    source = PanoSource.MAPILLARY

    def __init__(self, settings: Settings) -> None:
        self.token = settings.mapillary_access_token

    async def resolve(self, points, step_m, origin):
        lats = np.array([p[0] for p in points])
        lons = np.array([p[1] for p in points])
        pad = 0.0003
        s, n, w, e = lats.min() - pad, lats.max() + pad, lons.min() - pad, lons.max() + pad
        cell = 0.005
        boxes = [
            (x, y, min(x + cell, e), min(y + cell, n))
            for x in np.arange(w, e, cell)
            for y in np.arange(s, n, cell)
        ]
        fields = "id,computed_geometry,geometry,computed_compass_angle,compass_angle,captured_at,thumb_original_url,camera_type"
        found: dict[str, dict] = {}
        async with httpx.AsyncClient(timeout=60) as client:
            for b in boxes:
                r = await client.get(
                    "https://graph.mapillary.com/images",
                    params={
                        "access_token": self.token, "fields": fields, "is_pano": "true", "limit": 2000,
                        "bbox": ",".join(f"{v:.6f}" for v in b),
                    },
                )
                r.raise_for_status()
                for img in r.json().get("data", []):
                    found[img["id"]] = img
        if not found:
            return []
        imgs = list(found.values())
        geo = [(i.get("computed_geometry") or i["geometry"])["coordinates"] for i in imgs]
        enu = LocalENU(*origin)
        pe, pn = enu.to_en([g[1] for g in geo], [g[0] for g in geo])
        se, sn = enu.to_en(lats, lons)
        tree = cKDTree(np.c_[pe, pn])
        dist, idx = tree.query(np.c_[se, sn], distance_upper_bound=max(15.0, step_m))
        chosen = list(dict.fromkeys(int(i) for d, i in zip(dist, idx) if np.isfinite(d)))
        out = []
        for i in chosen:
            img = imgs[i]
            lon, lat = geo[i]
            ts = img.get("captured_at")
            out.append(
                PanoMetadata(
                    pano_id=f"mly_{img['id']}",
                    lat=lat,
                    lon=lon,
                    heading=float(img.get("computed_compass_angle") or img.get("compass_angle") or 0.0) % 360.0,
                    capture_date=time.strftime("%Y-%m-%d", time.gmtime(ts / 1000)) if ts else None,
                    source=PanoSource.MAPILLARY,
                    image_url=img.get("thumb_original_url"),
                    copyright="Mapillary contributors, CC-BY-SA 4.0",
                )
            )
        return out

    async def fetch(self, meta, zoom):
        url = meta.image_url
        async with httpx.AsyncClient(timeout=120, follow_redirects=True) as client:
            if not url:
                r = await client.get(
                    f"https://graph.mapillary.com/{meta.pano_id.removeprefix('mly_')}",
                    params={"access_token": self.token, "fields": "thumb_original_url"},
                )
                r.raise_for_status()
                url = r.json()["thumb_original_url"]
            r = await client.get(url)
            r.raise_for_status()
        bgr = cv2.imdecode(np.frombuffer(r.content, np.uint8), cv2.IMREAD_COLOR)
        if bgr is None:
            raise RuntimeError("could not decode Mapillary image")
        rgb = ensure_2to1(bgr[..., ::-1])
        max_w = 512 * 2**zoom
        if rgb.shape[1] > max_w:
            rgb = cv2.resize(rgb, (max_w, max_w // 2), interpolation=cv2.INTER_AREA)
        return FetchedPano(rgb, meta.raw_depth_b64)


# --------------------------------------------------------------------------- local uploads
class LocalProvider:
    source = PanoSource.LOCAL

    def __init__(self, upload_dir: Path) -> None:
        self.upload_dir = Path(upload_dir)
        self.upload_dir.mkdir(parents=True, exist_ok=True)

    def path_for(self, pano_id: str) -> Path:
        return self.upload_dir / f"{pano_id}.jpg"

    async def resolve(self, points, step_m, origin):
        return []

    async def fetch(self, meta, zoom):
        bgr = cv2.imread(str(self.path_for(meta.pano_id)), cv2.IMREAD_COLOR)
        if bgr is None:
            raise FileNotFoundError(meta.pano_id)
        return FetchedPano(ensure_2to1(bgr[..., ::-1]), meta.raw_depth_b64)


# --------------------------------------------------------------------------- synthetic demo street
class SyntheticProvider:
    """A north-south street canyon through the AOI centroid; ids encode origin + along-street offset."""

    source = PanoSource.SYNTHETIC

    @staticmethod
    def make_id(lat0: float, lon0: float, n: float) -> str:
        return f"synth_{lat0:.6f}_{lon0:.6f}_{n:+.1f}"

    @staticmethod
    def parse_id(pano_id: str) -> tuple[float, float, float]:
        _, lat0, lon0, n = pano_id.split("_")
        return float(lat0), float(lon0), float(n)

    def meta_for(self, lat0: float, lon0: float, n: float) -> PanoMetadata:
        lat, lon = LocalENU(lat0, lon0).to_latlon(0.0, n)
        return PanoMetadata(
            pano_id=self.make_id(lat0, lon0, n),
            lat=float(lat),
            lon=float(lon),
            alt=CAMERA_HEIGHT,
            alt_source="synthetic flat ground",
            heading=pano_heading(n),
            capture_date="synthetic",
            source=PanoSource.SYNTHETIC,
            image_width=2048,
            image_height=1024,
            copyright="GeoPano3D procedural scene",
        )

    async def resolve(self, points, step_m, origin):
        lat0, lon0 = round(origin[0], 6), round(origin[1], 6)
        enu = LocalENU(lat0, lon0)
        _, n = enu.to_en([p[0] for p in points], [p[1] for p in points])
        snapped = np.unique(np.round(np.asarray(n) / step_m) * step_m)
        snapped = snapped[np.abs(snapped) < STREET_END - 10]
        if snapped.size == 0:
            snapped = np.array([0.0])
        return [self.meta_for(lat0, lon0, float(v)) for v in snapped]

    async def fetch(self, meta, zoom):
        _, _, n = self.parse_id(meta.pano_id)
        width = int(min(2048, max(1024, 256 * 2**zoom)))
        pano = await asyncio.to_thread(render_pano, n, width)
        return FetchedPano(pano.rgb, pano.depth_b64, pano.oracle_range)


def choose_source(requested: PanoSource, settings: Settings) -> PanoSource:
    if requested != PanoSource.AUTO:
        return requested
    if settings.google_maps_api_key:
        return PanoSource.GOOGLE
    if settings.mapillary_access_token:
        return PanoSource.MAPILLARY
    return PanoSource.SYNTHETIC
