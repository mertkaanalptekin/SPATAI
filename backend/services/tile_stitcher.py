"""Concurrent 360 deg tile download + equirectangular assembly."""

from __future__ import annotations

import asyncio
import math
from typing import Awaitable, Callable, Optional

import cv2
import numpy as np
from numpy.typing import NDArray

TileFetcher = Callable[[int, int], Awaitable[Optional[bytes]]]


def tile_grid(image_width: int, image_height: int, tile_size: int, zoom: int) -> tuple[int, int, int, int, int]:
    """Return (cols, rows, width_z, height_z, zoom_used) for a panorama at ``zoom``.

    The full-resolution image is reached at ``max_zoom = ceil(log2(image_width / tile_size))``; each
    lower zoom halves both dimensions. (16384 px panos: 2^z x 2^(z-1) tiles; legacy 13312 px
    panos: 7 x 4 at z=3, 13 x 7 at z=4, 26 x 13 at z=5.)
    """
    max_zoom = max(0, math.ceil(math.log2(max(1, image_width) / tile_size)))
    zoom = max(0, min(zoom, max_zoom))
    f = 2 ** (max_zoom - zoom)
    wz, hz = max(1, image_width // f), max(1, image_height // f)
    return math.ceil(wz / tile_size), math.ceil(hz / tile_size), wz, hz, zoom


async def stitch_tiles(
    fetch: TileFetcher,
    cols: int,
    rows: int,
    tile_size: int,
    crop_w: int,
    crop_h: int,
    concurrency: int = 16,
) -> NDArray[np.uint8]:
    sem = asyncio.Semaphore(concurrency)
    canvas = np.zeros((rows * tile_size, cols * tile_size, 3), np.uint8)

    async def one(x: int, y: int) -> None:
        async with sem:
            data = await fetch(x, y)
        if not data:
            return
        bgr = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        if bgr is None:
            return
        th, tw = bgr.shape[:2]
        if (th, tw) != (tile_size, tile_size):
            bgr = cv2.resize(bgr, (tile_size, tile_size), interpolation=cv2.INTER_AREA)
        canvas[y * tile_size : (y + 1) * tile_size, x * tile_size : (x + 1) * tile_size] = bgr[..., ::-1]

    await asyncio.gather(*(one(x, y) for y in range(rows) for x in range(cols)))
    img = canvas[:crop_h, :crop_w]
    return ensure_2to1(img)


def ensure_2to1(img: NDArray[np.uint8]) -> NDArray[np.uint8]:
    h, w = img.shape[:2]
    if w == 2 * h:
        return np.ascontiguousarray(img)
    return cv2.resize(img, (w, w // 2), interpolation=cv2.INTER_AREA)
