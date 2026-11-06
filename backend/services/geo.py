"""Small geodesy helpers: auto UTM zone, local ENU frame, haversine."""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

import numpy as np
from numpy.typing import ArrayLike, NDArray
from pyproj import CRS, Transformer

EARTH_R = 6_371_008.8


def utm_epsg(lat: float, lon: float) -> int:
    zone = int((lon + 180.0) // 6.0) % 60 + 1
    return (32600 if lat >= 0 else 32700) + zone


@lru_cache(maxsize=32)
def _transformers(epsg: int) -> tuple[Transformer, Transformer]:
    fwd = Transformer.from_crs(CRS.from_epsg(4326), CRS.from_epsg(epsg), always_xy=True)
    inv = Transformer.from_crs(CRS.from_epsg(epsg), CRS.from_epsg(4326), always_xy=True)
    return fwd, inv


@dataclass(frozen=True)
class UTMFrame:
    epsg: int

    @classmethod
    def for_point(cls, lat: float, lon: float) -> "UTMFrame":
        return cls(utm_epsg(lat, lon))

    def to_xy(self, lon: ArrayLike, lat: ArrayLike) -> tuple[NDArray, NDArray]:
        x, y = _transformers(self.epsg)[0].transform(np.asarray(lon, float), np.asarray(lat, float))
        return np.asarray(x), np.asarray(y)

    def to_lonlat(self, x: ArrayLike, y: ArrayLike) -> tuple[NDArray, NDArray]:
        lon, lat = _transformers(self.epsg)[1].transform(np.asarray(x, float), np.asarray(y, float))
        return np.asarray(lon), np.asarray(lat)


@dataclass(frozen=True)
class LocalENU:
    """Equirectangular tangent-plane approximation (sub-centimetre over a few km)."""

    lat0: float
    lon0: float

    def to_en(self, lat: ArrayLike, lon: ArrayLike) -> tuple[NDArray, NDArray]:
        lat = np.asarray(lat, float)
        lon = np.asarray(lon, float)
        e = np.deg2rad(lon - self.lon0) * EARTH_R * np.cos(np.deg2rad(self.lat0))
        n = np.deg2rad(lat - self.lat0) * EARTH_R
        return e, n

    def to_latlon(self, e: ArrayLike, n: ArrayLike) -> tuple[NDArray, NDArray]:
        lat = self.lat0 + np.rad2deg(np.asarray(n, float) / EARTH_R)
        lon = self.lon0 + np.rad2deg(np.asarray(e, float) / (EARTH_R * np.cos(np.deg2rad(self.lat0))))
        return lat, lon


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = np.deg2rad(lat1), np.deg2rad(lat2)
    dp, dl = p2 - p1, np.deg2rad(lon2 - lon1)
    a = np.sin(dp / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return float(2 * EARTH_R * np.arcsin(np.sqrt(a)))
