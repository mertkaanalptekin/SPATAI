"""AOI sampling: points every ``step_meters`` along OSM roads (Overpass) or on a metric grid."""

from __future__ import annotations

import logging

import httpx
import numpy as np
from shapely.geometry import LineString, MultiLineString, Point, Polygon
import shapely
from shapely.ops import unary_union

from backend.models.schemas import AOIRequest, SamplingMode
from backend.services.geo import UTMFrame

log = logging.getLogger(__name__)
HIGHWAY_RE = "^(primary|secondary|tertiary|residential|unclassified|pedestrian|living_street|service)$"


def _to_utm(geom, utm: UTMFrame):
    return shapely.transform(geom, lambda c: np.column_stack(utm.to_xy(c[:, 0], c[:, 1])))


class AOISampler:
    def __init__(self, overpass_url: str, timeout_s: float = 45.0) -> None:
        self.overpass_url = overpass_url
        self.timeout_s = timeout_s

    @staticmethod
    def _polygons(req: AOIRequest) -> tuple[Polygon, Polygon, UTMFrame]:
        poly_ll = Polygon([(lon, lat) for lat, lon in req.polygon_latlon])
        if not poly_ll.is_valid:
            poly_ll = poly_ll.buffer(0)
        c = poly_ll.centroid
        utm = UTMFrame.for_point(c.y, c.x)
        poly_m = _to_utm(poly_ll, utm)
        return poly_ll, poly_m, utm

    @staticmethod
    def centroid(req: AOIRequest) -> tuple[float, float]:
        poly = Polygon([(lon, lat) for lat, lon in req.polygon_latlon])
        return poly.centroid.y, poly.centroid.x

    def grid_points(self, req: AOIRequest) -> list[tuple[float, float]]:
        _, poly_m, utm = self._polygons(req)
        minx, miny, maxx, maxy = poly_m.bounds
        s = req.step_meters
        xs = np.arange(minx + s / 2, maxx, s)
        ys = np.arange(miny + s / 2, maxy, s)
        gx, gy = np.meshgrid(xs, ys)
        gx, gy = gx.ravel(), gy.ravel()
        from shapely import contains_xy

        inside = contains_xy(poly_m, gx, gy)
        lon, lat = utm.to_lonlat(gx[inside], gy[inside])
        return list(zip(np.atleast_1d(lat).tolist(), np.atleast_1d(lon).tolist()))

    async def fetch_roads(self, poly_ll: Polygon) -> list[LineString]:
        s, w, n, e = poly_ll.bounds[1], poly_ll.bounds[0], poly_ll.bounds[3], poly_ll.bounds[2]
        q = f'[out:json][timeout:40];way["highway"~"{HIGHWAY_RE}"]({s},{w},{n},{e});out geom;'
        async with httpx.AsyncClient(timeout=self.timeout_s) as client:
            r = await client.post(self.overpass_url, data={"data": q}, headers={"User-Agent": "GeoPano3D/1.0"})
            r.raise_for_status()
        lines = []
        for el in r.json().get("elements", []):
            geom = el.get("geometry") or []
            if len(geom) >= 2:
                lines.append(LineString([(g["lon"], g["lat"]) for g in geom]))
        return lines

    def road_points_from_lines(self, req: AOIRequest, lines_ll: list[LineString]) -> list[tuple[float, float]]:
        _, poly_m, utm = self._polygons(req)
        merged = unary_union([_to_utm(ln, utm) for ln in lines_ll])
        clipped = merged.intersection(poly_m)
        parts = list(clipped.geoms) if hasattr(clipped, "geoms") else [clipped]
        xs: list[float] = []
        ys: list[float] = []
        for part in parts:
            if not isinstance(part, (LineString, MultiLineString)) or part.length == 0:
                continue
            for seg in getattr(part, "geoms", [part]):
                d = np.arange(0.0, seg.length + 1e-9, req.step_meters)
                pts = [seg.interpolate(v) for v in d]
                xs += [p.x for p in pts]
                ys += [p.y for p in pts]
        if not xs:
            return []
        # thin points closer than half a step (road junctions / overlapping ways)
        from scipy.spatial import cKDTree

        xy = np.c_[xs, ys]
        keep = np.ones(len(xy), bool)
        tree = cKDTree(xy)
        for i, j in sorted(tree.query_pairs(req.step_meters * 0.5)):
            if keep[i] and keep[j]:
                keep[j] = False
        lon, lat = utm.to_lonlat(xy[keep, 0], xy[keep, 1])
        return list(zip(np.atleast_1d(lat).tolist(), np.atleast_1d(lon).tolist()))

    async def sample(self, req: AOIRequest) -> tuple[list[tuple[float, float]], SamplingMode, list[str]]:
        warnings: list[str] = []
        if req.sampling_mode == SamplingMode.ROAD_NETWORK:
            try:
                poly_ll, _, _ = self._polygons(req)
                lines = await self.fetch_roads(poly_ll)
                pts = self.road_points_from_lines(req, lines)
                if pts:
                    return pts[: req.max_nodes * 4], SamplingMode.ROAD_NETWORK, warnings
                warnings.append("No OSM roads found in the AOI; fell back to grid sampling.")
            except Exception as exc:
                log.warning("Overpass failed: %s", exc)
                warnings.append(f"Overpass unavailable ({type(exc).__name__}); fell back to grid sampling.")
        return self.grid_points(req)[: req.max_nodes * 4], SamplingMode.GRID, warnings
