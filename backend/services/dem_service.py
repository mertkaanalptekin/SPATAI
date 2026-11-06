"""Digital Elevation Model acquisition, reprojection and export.

Sources (best available is chosen automatically with ``source="auto"``):

* **OpenTopography** (needs ``OPENTOPOGRAPHY_API_KEY``): USGS 3DEP 1 m -> 10 m in the USA,
  then Copernicus GLO-30 worldwide. GeoTIFFs in any CRS are reprojected to EPSG:4326.
* **AWS Terrain Tiles / Terrarium** (no key): zoom 15 (~4.8 m * cos(lat) per pixel), a composite of
  3DEP, national LiDAR DTMs, SRTM, GMTED... Always available, used as fallback.
* **Local GeoTIFF** via :func:`read_geotiff` (any CRS; e.g. a 0.5-1 m national LiDAR DTM).

All rasters are normalised to a north-up EPSG:4326 float32 grid (:class:`DemRaster`). Heights
are orthometric (geoid / EGM96-like), which is what the Metashape script assumes (EPSG::9707).
"""

from __future__ import annotations

import asyncio
import io
import logging
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import cv2
import httpx
import numpy as np
import tifffile
from numpy.typing import ArrayLike, NDArray
from pyproj import CRS, Transformer

from backend.config import Settings
from backend.services.geo import EARTH_R, LocalENU

log = logging.getLogger(__name__)

M_PER_DEG_LAT = 110_574.0


@dataclass
class DemRaster:
    data: NDArray[np.float32]  # (H, W) north-up, NaN = nodata
    west: float
    north: float
    dlon: float  # degrees per pixel (> 0)
    dlat: float  # degrees per pixel (> 0)
    source: str
    vertical_datum: str = "EGM96 geoid (orthometric)"

    @property
    def height(self) -> int:
        return int(self.data.shape[0])

    @property
    def width(self) -> int:
        return int(self.data.shape[1])

    @property
    def bounds(self) -> tuple[float, float, float, float]:
        """south, west, north, east"""
        return (self.north - self.height * self.dlat, self.west, self.north, self.west + self.width * self.dlon)

    @property
    def resolution_m(self) -> float:
        lat_c = self.north - self.height * self.dlat / 2
        return float(min(self.dlat * M_PER_DEG_LAT, self.dlon * M_PER_DEG_LAT * math.cos(math.radians(lat_c))))

    def sample(self, lat: ArrayLike, lon: ArrayLike) -> NDArray[np.float64]:
        """Bilinear elevation lookup (NaN outside)."""
        lat = np.atleast_1d(np.asarray(lat, float))
        lon = np.atleast_1d(np.asarray(lon, float))
        px = ((lon - self.west) / self.dlon - 0.5).astype(np.float32).reshape(1, -1)
        py = ((self.north - lat) / self.dlat - 0.5).astype(np.float32).reshape(1, -1)
        out = cv2.remap(self.data, px, py, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=np.nan)
        return out.reshape(-1).astype(np.float64)

    def hillshade(self, azimuth: float = 315.0, altitude: float = 45.0) -> NDArray[np.uint8]:
        z = np.nan_to_num(self.data, nan=float(np.nanmean(self.data)) if np.isfinite(self.data).any() else 0.0)
        lat_c = math.radians(self.north - self.height * self.dlat / 2)
        dy_m = self.dlat * M_PER_DEG_LAT
        dx_m = self.dlon * M_PER_DEG_LAT * math.cos(lat_c)
        gy, gx = np.gradient(z.astype(np.float64), dy_m, dx_m)
        slope = np.arctan(np.hypot(gx, gy))
        aspect = np.arctan2(-gx, gy)
        az, alt = math.radians(azimuth), math.radians(altitude)
        hs = np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect)
        return np.clip(hs * 255, 0, 255).astype(np.uint8)


# ---------------------------------------------------------------------- GeoTIFF I/O
def write_geotiff(path: Path, dem: DemRaster, nodata: float = -9999.0) -> Path:
    data = np.where(np.isfinite(dem.data), dem.data, nodata).astype(np.float32)
    geokeys = (1, 1, 0, 4, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326, 2054, 0, 1, 9102)
    tifffile.imwrite(
        path,
        data,
        compression="zlib",
        extratags=[
            (33550, "d", 3, (dem.dlon, dem.dlat, 0.0), False),
            (33922, "d", 6, (0.0, 0.0, 0.0, dem.west, dem.north, 0.0), False),
            (34735, "H", len(geokeys), geokeys, False),
            (42113, "s", 0, f"{nodata:g}", False),
        ],
    )
    return path


def _parse_geokeys(values) -> dict[int, int]:
    vals = list(values)
    n = vals[3]
    out: dict[int, int] = {}
    for i in range(n):
        key, loc, _count, val = vals[4 + 4 * i : 8 + 4 * i]
        if loc == 0:
            out[key] = val
    return out


def read_geotiff(src: bytes | str | Path, source: str = "geotiff", max_pixels: int = 25_000_000) -> DemRaster:
    """Read a single-band GeoTIFF in any EPSG CRS and return it as an EPSG:4326 DemRaster."""
    fh = io.BytesIO(src) if isinstance(src, (bytes, bytearray)) else src
    with tifffile.TiffFile(fh) as tif:
        page = tif.pages[0]
        arr = page.asarray()
        tags = page.tags
        sx, sy, _ = tags["ModelPixelScaleTag"].value
        tie = tags["ModelTiepointTag"].value
        geokeys = _parse_geokeys(tags["GeoKeyDirectoryTag"].value)
        nodata_tag = tags.get("GDAL_NODATA") or tags.get(42113)
        nodata = float(str(nodata_tag.value).strip("\x00 ")) if nodata_tag is not None else None
    if arr.ndim == 3:
        arr = arr[..., 0] if arr.shape[-1] < arr.shape[0] else arr[0]
    data = arr.astype(np.float32)
    if nodata is not None:
        data[data == nodata] = np.nan
    data[data < -1000] = np.nan
    pixel_is_point = geokeys.get(1025, 1) == 2
    x0 = tie[3] - tie[0] * sx - (sx / 2 if pixel_is_point else 0)
    y0 = tie[4] + tie[1] * sy + (sy / 2 if pixel_is_point else 0)
    epsg = geokeys.get(3072) or geokeys.get(2048) or 4326
    if epsg in (4326, 4269, 4258):  # geographic (WGS84 / NAD83 / ETRS89 ~ same at DEM accuracy)
        return DemRaster(data, float(x0), float(y0), float(sx), float(sy), source)

    # projected CRS -> resample onto a lat/lon grid with ~ the same ground resolution
    h, w = data.shape
    to_ll = Transformer.from_crs(CRS.from_epsg(epsg), CRS.from_epsg(4326), always_xy=True)
    to_src = Transformer.from_crs(CRS.from_epsg(4326), CRS.from_epsg(epsg), always_xy=True)
    cx = np.array([x0, x0 + w * sx, x0, x0 + w * sx])
    cy = np.array([y0, y0, y0 - h * sy, y0 - h * sy])
    lons, lats = to_ll.transform(cx, cy)
    west, east, south, north = lons.min(), lons.max(), lats.min(), lats.max()
    lat_c = math.radians((north + south) / 2)
    dlat = sy / M_PER_DEG_LAT
    dlon = sx / (M_PER_DEG_LAT * math.cos(lat_c))
    ow, oh = int(math.ceil((east - west) / dlon)), int(math.ceil((north - south) / dlat))
    if ow * oh > max_pixels:
        f = math.sqrt(ow * oh / max_pixels)
        dlon, dlat, ow, oh = dlon * f, dlat * f, int(ow / f), int(oh / f)
    glon = west + (np.arange(ow) + 0.5) * dlon
    glat = north - (np.arange(oh) + 0.5) * dlat
    glon, glat = np.meshgrid(glon, glat)
    gx, gy = to_src.transform(glon, glat)
    map_x = ((gx - x0) / sx - 0.5).astype(np.float32)
    map_y = ((y0 - gy) / sy - 0.5).astype(np.float32)
    out = cv2.remap(data, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=np.nan)
    return DemRaster(out, float(west), float(north), float(dlon), float(dlat), f"{source} (EPSG:{epsg} -> 4326)")


def dem_to_obj(path: Path, dem: DemRaster, lat0: float, lon0: float, max_dim: int = 600) -> Path:
    """Triangulated terrain mesh in a local ENU frame (metres, origin lat0/lon0, z = orthometric)."""
    step = max(1, int(math.ceil(max(dem.height, dem.width) / max_dim)))
    z = dem.data[::step, ::step]
    h, w = z.shape
    lat = dem.north - (np.arange(0, dem.height, step) + 0.5) * dem.dlat
    lon = dem.west + (np.arange(0, dem.width, step) + 0.5) * dem.dlon
    lon_g, lat_g = np.meshgrid(lon, lat)
    e, n = LocalENU(lat0, lon0).to_en(lat_g, lon_g)
    zf = np.nan_to_num(z, nan=float(np.nanmin(z)) if np.isfinite(z).any() else 0.0)
    verts = np.stack([e.ravel(), n.ravel(), zf.ravel()], axis=1)
    idx = np.arange(h * w).reshape(h, w) + 1
    a, b, c, d = idx[:-1, :-1].ravel(), idx[:-1, 1:].ravel(), idx[1:, :-1].ravel(), idx[1:, 1:].ravel()
    faces = np.concatenate([np.stack([a, c, b], 1), np.stack([b, c, d], 1)])
    with open(path, "w", encoding="ascii") as fh:
        fh.write(f"# GeoPano3D terrain mesh, local ENU metres, origin lat={lat0:.8f} lon={lon0:.8f}\n")
        fh.write(f"# source: {dem.source}, vertical datum: {dem.vertical_datum}\n")
        np.savetxt(fh, verts, fmt="v %.3f %.3f %.3f")
        np.savetxt(fh, faces, fmt="f %d %d %d")
    return path


# ---------------------------------------------------------------------- download service
def _lonlat_to_tile_px(lon: NDArray, lat: NDArray, z: int, tile: int = 256) -> tuple[NDArray, NDArray]:
    n = (2**z) * tile
    lat_r = np.deg2rad(np.clip(lat, -85.05112878, 85.05112878))
    x = (lon + 180.0) / 360.0 * n
    y = (1.0 - np.log(np.tan(lat_r) + 1.0 / np.cos(lat_r)) / np.pi) / 2.0 * n
    return x, y


def expand_bounds(south: float, west: float, north: float, east: float, buffer_m: float):
    dlat = buffer_m / M_PER_DEG_LAT
    dlon = buffer_m / (M_PER_DEG_LAT * max(0.01, math.cos(math.radians((south + north) / 2))))
    return south - dlat, west - dlon, north + dlat, east + dlon


class DemService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._cache: dict[tuple, DemRaster] = {}

    async def fetch(
        self, south: float, west: float, north: float, east: float, source: str = "auto"
    ) -> DemRaster:
        key = (round(south, 6), round(west, 6), round(north, 6), round(east, 6), source)
        if key in self._cache:
            return self._cache[key]
        source = self.settings.dem_source if source == "auto" else source
        dem: Optional[DemRaster] = None
        if source in ("auto", "opentopography") and self.settings.opentopography_api_key:
            try:
                dem = await self._opentopography(south, west, north, east)
            except Exception as exc:  # network / quota -> fall back
                log.warning("OpenTopography failed (%s), falling back to Terrarium", exc)
        if dem is None:
            dem = await self._terrarium(south, west, north, east)
        self._cache[key] = dem
        return dem

    async def _opentopography(self, south: float, west: float, north: float, east: float) -> DemRaster:
        key = self.settings.opentopography_api_key
        box = {"south": south, "north": north, "west": west, "east": east, "API_Key": key}
        attempts: list[tuple[str, dict]] = []
        if 18 < south < 72 and -180 < west < -60:  # USA incl. Alaska: 3DEP lidar
            for ds in ("USGS1m", "USGS10m"):
                attempts.append(("https://portal.opentopography.org/API/usgsdem", {"datasetName": ds, **box}))
        attempts.append(
            ("https://portal.opentopography.org/API/globaldem", {"demtype": "COP30", "outputFormat": "GTiff", **box})
        )
        async with httpx.AsyncClient(timeout=120) as client:
            last: Exception | None = None
            for url, params in attempts:
                try:
                    r = await client.get(url, params=params)
                    r.raise_for_status()
                    if not r.content.startswith((b"II*\x00", b"MM\x00*", b"II+\x00")):
                        raise ValueError(r.text[:200])
                    name = params.get("datasetName") or params.get("demtype")
                    dem = read_geotiff(r.content, source=f"OpenTopography {name}")
                    if np.isfinite(dem.data).mean() > 0.5:
                        return dem
                except Exception as exc:
                    last = exc
            raise RuntimeError(f"OpenTopography: no dataset succeeded ({last})")

    async def _terrarium(
        self, south: float, west: float, north: float, east: float, max_tiles: int = 64
    ) -> DemRaster:
        z = 15
        while True:
            x0, y0 = _lonlat_to_tile_px(np.array([west]), np.array([north]), z)
            x1, y1 = _lonlat_to_tile_px(np.array([east]), np.array([south]), z)
            tx0, ty0 = int(x0[0] // 256), int(y0[0] // 256)
            tx1, ty1 = int(x1[0] // 256), int(y1[0] // 256)
            if (tx1 - tx0 + 1) * (ty1 - ty0 + 1) <= max_tiles or z <= 8:
                break
            z -= 1
        sem = asyncio.Semaphore(16)
        mosaic = np.full(((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256), np.nan, np.float32)

        async def get(client: httpx.AsyncClient, tx: int, ty: int) -> None:
            url = self.settings.terrarium_url.format(z=z, x=tx, y=ty)
            async with sem:
                for attempt in range(3):
                    try:
                        r = await client.get(url)
                        if r.status_code == 404:
                            return
                        r.raise_for_status()
                        break
                    except httpx.HTTPError:
                        if attempt == 2:
                            return
                        await asyncio.sleep(0.5 * (attempt + 1))
            bgr = cv2.imdecode(np.frombuffer(r.content, np.uint8), cv2.IMREAD_COLOR)
            if bgr is None:
                return
            rgb = bgr[..., ::-1].astype(np.float32)
            elev = rgb[..., 0] * 256.0 + rgb[..., 1] + rgb[..., 2] / 256.0 - 32768.0
            oy, ox = (ty - ty0) * 256, (tx - tx0) * 256
            mosaic[oy : oy + 256, ox : ox + 256] = elev

        async with httpx.AsyncClient(timeout=30, http2=True) as client:
            await asyncio.gather(
                *(get(client, tx, ty) for tx in range(tx0, tx1 + 1) for ty in range(ty0, ty1 + 1))
            )

        lat_c = math.radians((south + north) / 2)
        res_m = 2 * math.pi * EARTH_R * math.cos(lat_c) / (2**z * 256)
        dlat = res_m / M_PER_DEG_LAT
        dlon = res_m / (M_PER_DEG_LAT * math.cos(lat_c))
        ow = max(2, int(math.ceil((east - west) / dlon)))
        oh = max(2, int(math.ceil((north - south) / dlat)))
        glon = west + (np.arange(ow) + 0.5) * dlon
        glat = north - (np.arange(oh) + 0.5) * dlat
        glon, glat = np.meshgrid(glon, glat)
        px, py = _lonlat_to_tile_px(glon, glat, z)
        map_x = (px - tx0 * 256 - 0.5).astype(np.float32)
        map_y = (py - ty0 * 256 - 0.5).astype(np.float32)
        out = cv2.remap(mosaic, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=np.nan)
        return DemRaster(out, west, north, dlon, dlat, f"AWS Terrain Tiles (Terrarium z{z})")
