"""Exploration: a visitor's senses, its own map, and routes built from it (docs/EXPLORATION.md).

Every function here is pure and deterministic; js/exploration.js ports them and
tests/test_js_parity.py checks the two agree. The page drives them (phases, runs, drawing).

The building is cut into CELL x CELL cells. Cell (i, j) covers
x in [x0 + i*CELL, x0 + (i+1)*CELL) and y in [y0 + j*CELL, ...); its index is j*nx + i.
"""

from __future__ import annotations

import heapq
import math
from dataclasses import dataclass, field

from spatai.geometry import Location

XY = tuple[float, float]

CELL = 0.5                          # E3
VISION_RANGE = 6.0                  # E2
VISION_HALF_ANGLE = math.radians(60)
NEAR_SENSE = 1.0
ARTWORK_KEEPOUT = 1.2               # E4
TURN_COST = 2.0                     # E5, metres per unit of (1 - cos turn)
INTERESTS = 3                       # E8
VIEW_DISTANCE = 1.5                 # E9
NOVELTY = 0.5                       # E8, score factor per earlier visit
SQRT2 = math.sqrt(2)


@dataclass
class Walls:
    """The true walls on the cell grid, for one role (the staff door is closed to visitors)."""

    x0: float
    y0: float
    nx: int
    ny: int
    block_e: bytearray              # 1 if the edge between cell (i, j) and (i+1, j) is a wall
    block_n: bytearray              # 1 if the edge between cell (i, j) and (i, j+1) is a wall
    room: list                      # room name of each cell
    door_edges: dict                # door id -> [(cell a, cell b), ...] open edges of that door

    def index(self, i: int, j: int) -> int:
        return j * self.nx + i

    def cell_of(self, p: XY) -> int:
        i = min(self.nx - 1, max(0, math.floor((p[0] - self.x0) / CELL)))
        j = min(self.ny - 1, max(0, math.floor((p[1] - self.y0) / CELL)))
        return j * self.nx + i

    def centre(self, k: int) -> XY:
        return (self.x0 + (k % self.nx + 0.5) * CELL, self.y0 + (k // self.nx + 0.5) * CELL)

    def open_between(self, a: int, b: int) -> bool:
        """Whether 4-neighbours a and b are joined by an open edge."""
        if b == a + 1:
            return not self.block_e[a]
        if b == a - 1:
            return not self.block_e[b]
        if b == a + self.nx:
            return not self.block_n[a]
        if b == a - self.nx:
            return not self.block_n[b]
        raise ValueError("not 4-neighbours")


def build_walls(plan, role: str = "visitor") -> Walls:
    """E2-E3: a wall between two cells in different rooms, except across a door's opening."""
    xs = [r.x_min for r in plan.rooms.values()] + [r.x_max for r in plan.rooms.values()]
    ys = [r.y_min for r in plan.rooms.values()] + [r.y_max for r in plan.rooms.values()]
    x0, y0 = min(xs), min(ys)
    nx, ny = round((max(xs) - x0) / CELL), round((max(ys) - y0) / CELL)
    room = []
    for j in range(ny):
        for i in range(nx):
            room.append(plan.room_at(Location(x0 + (i + 0.5) * CELL, y0 + (j + 0.5) * CELL)))
    from spatai.exhibition import DOOR_WIDTH

    doors = [d for d in plan.doors.values() if role == "staff" or not d.staff_only]

    def door_at(ra, rb, wx, wy, vertical):
        for d in doors:
            if set(d.rooms) != {ra, rb}:
                continue
            px, py = d.point
            if vertical and px == wx and abs(wy - py) < DOOR_WIDTH / 2:
                return d.door_id
            if not vertical and py == wy and abs(wx - px) < DOOR_WIDTH / 2:
                return d.door_id
        return None

    block_e, block_n = bytearray(nx * ny), bytearray(nx * ny)
    door_edges: dict[str, list] = {}
    for j in range(ny):
        for i in range(nx):
            k = j * nx + i
            for vertical in (True, False):
                if vertical:
                    if i == nx - 1:
                        block_e[k] = 1
                        continue
                    b, wx, wy = k + 1, x0 + (i + 1) * CELL, y0 + (j + 0.5) * CELL
                else:
                    if j == ny - 1:
                        block_n[k] = 1
                        continue
                    b, wx, wy = k + nx, x0 + (i + 0.5) * CELL, y0 + (j + 1) * CELL
                ra, rb = room[k], room[b]
                if ra == rb:
                    continue
                door = door_at(ra, rb, wx, wy, vertical) if ra and rb else None
                if door is None:
                    (block_e if vertical else block_n)[k] = 1
                else:
                    door_edges.setdefault(door, []).append((k, b))
    return Walls(x0, y0, nx, ny, block_e, block_n, room, door_edges)


# --- sight ---------------------------------------------------------------------------------

def _trace(walls: Walls, p: XY, q: XY, cell_ok=None) -> bool:
    """Walk the cells the segment p -> q crosses (Amanatides-Woo).

    False if it crosses a wall, or enters a cell `cell_ok` rejects. At an exact grid corner
    both ways round must be open.
    """
    nx = walls.nx
    i = min(nx - 1, max(0, math.floor((p[0] - walls.x0) / CELL)))
    j = min(walls.ny - 1, max(0, math.floor((p[1] - walls.y0) / CELL)))
    target = walls.cell_of(q)
    ti, tj = target % nx, target // nx
    dx, dy = q[0] - p[0], q[1] - p[1]
    sx = 1 if dx > 0 else -1
    sy = 1 if dy > 0 else -1
    if dx != 0:
        t_dx = CELL / abs(dx)
        t_mx = ((walls.x0 + (i + (1 if dx > 0 else 0)) * CELL) - p[0]) / dx
    else:
        t_dx = t_mx = math.inf
    if dy != 0:
        t_dy = CELL / abs(dy)
        t_my = ((walls.y0 + (j + (1 if dy > 0 else 0)) * CELL) - p[1]) / dy
    else:
        t_dy = t_my = math.inf

    def blocked_x(ci, cj, s):        # edge from (ci, cj) to (ci + s, cj)
        k = cj * nx + ci
        return walls.block_e[k] if s > 0 else (ci == 0 or walls.block_e[k - 1])

    def blocked_y(ci, cj, s):
        k = cj * nx + ci
        return walls.block_n[k] if s > 0 else (cj == 0 or walls.block_n[k - nx])

    for _ in range(abs(ti - i) + abs(tj - j) + 2):
        if i == ti and j == tj:
            return True
        if t_mx < t_my:
            if blocked_x(i, j, sx):
                return False
            i += sx
            t_mx += t_dx
        elif t_my < t_mx:
            if blocked_y(i, j, sy):
                return False
            j += sy
            t_my += t_dy
        else:
            if (blocked_x(i, j, sx) or blocked_y(i, j, sy)
                    or blocked_y(i + sx, j, sy) or blocked_x(i, j + sy, sx)):
                return False
            if cell_ok and not (cell_ok(j * nx + i + sx) and cell_ok((j + sy) * nx + i)):
                return False
            i += sx
            j += sy
            t_mx += t_dx
            t_my += t_dy
        if cell_ok and not cell_ok(j * nx + i):
            return False
    return i == ti and j == tj


def visible_cells(walls: Walls, pos: XY, gaze: float) -> list[int]:
    """E2: cells whose centre is within the vision cone, or the near sense, and in line of sight."""
    nx, ny = walls.nx, walls.ny
    here = walls.cell_of(pos)
    ci, cj = here % nx, here // nx
    reach = math.ceil(VISION_RANGE / CELL) + 1
    gx, gy = math.cos(gaze), math.sin(gaze)
    cos_half = math.cos(VISION_HALF_ANGLE)
    out = []
    for j in range(max(0, cj - reach), min(ny - 1, cj + reach) + 1):
        for i in range(max(0, ci - reach), min(nx - 1, ci + reach) + 1):
            k = j * nx + i
            if k == here:
                out.append(k)
                continue
            cx, cy = walls.x0 + (i + 0.5) * CELL, walls.y0 + (j + 0.5) * CELL
            dx, dy = cx - pos[0], cy - pos[1]
            d = math.sqrt(dx * dx + dy * dy)
            if d > VISION_RANGE:
                continue
            if d > NEAR_SENSE and dx * gx + dy * gy < d * cos_half:
                continue
            if _trace(walls, pos, (cx, cy)):
                out.append(k)
    # E2: the cells next to the agent through an open edge are always sensed.
    for b in _neighbours4(walls, here):
        if walls.open_between(here, b) and b not in out:
            out.append(b)
    out.sort()
    return out


def _neighbours4(walls: Walls, k: int) -> list[int]:
    i, j = k % walls.nx, k // walls.nx
    out = []
    if i + 1 < walls.nx:
        out.append(k + 1)
    if i > 0:
        out.append(k - 1)
    if j + 1 < walls.ny:
        out.append(k + walls.nx)
    if j > 0:
        out.append(k - walls.nx)
    return out


# --- the map -------------------------------------------------------------------------------

@dataclass
class CognitiveMap:
    """E3: what one agent knows. It starts empty (E1)."""

    size: int
    seen: bytearray = None
    rooms: list = field(default_factory=list)          # in order of discovery
    doors: list = field(default_factory=list)
    view_time: dict = field(default_factory=dict)      # entity id -> seconds in view
    seen_count: int = 0

    def __post_init__(self):
        if self.seen is None:
            self.seen = bytearray(self.size)


def new_map(walls: Walls) -> CognitiveMap:
    return CognitiveMap(walls.nx * walls.ny)


def observe(walls: Walls, cmap: CognitiveMap, pos: XY, gaze: float, entities: dict, dt: float = 0.25) -> dict:
    """E2-E3: look once. Marks the visible cells as seen and reports what is new.

    `entities` maps an ID to its (x, y); an entity is in view when its cell is visible.
    """
    vis = visible_cells(walls, pos, gaze)
    new = [k for k in vis if not cmap.seen[k]]
    for k in new:
        cmap.seen[k] = 1
    cmap.seen_count += len(new)
    rooms = []
    for k in new:
        r = walls.room[k]
        if r and r not in cmap.rooms and r not in rooms:
            rooms.append(r)
    cmap.rooms.extend(rooms)
    doors = []
    for door_id, edges in walls.door_edges.items():
        if door_id not in cmap.doors and any(cmap.seen[a] and cmap.seen[b] for a, b in edges):
            doors.append(door_id)
    cmap.doors.extend(doors)
    visset = set(vis)
    in_view = sorted(e for e, p in entities.items() if walls.cell_of(p) in visset)
    spotted = [e for e in in_view if e not in cmap.view_time]
    for e in in_view:
        cmap.view_time[e] = cmap.view_time.get(e, 0.0) + dt
    return {"new": new, "rooms": rooms, "doors": doors, "in_view": in_view, "spotted": spotted}


def coverage(cmap: CognitiveMap) -> float:
    return cmap.seen_count / cmap.size


# --- moving on one's own map ---------------------------------------------------------------

def keepout(walls: Walls, cmap: CognitiveMap, artworks: dict) -> bytearray:
    """E4: cells within ARTWORK_KEEPOUT of an artwork the agent has spotted."""
    out = bytearray(walls.nx * walls.ny)
    r = math.ceil(ARTWORK_KEEPOUT / CELL) + 1
    for e in sorted(artworks):
        if e not in cmap.view_time:
            continue
        ax, ay = artworks[e]
        c = walls.cell_of((ax, ay))
        ci, cj = c % walls.nx, c // walls.nx
        for j in range(max(0, cj - r), min(walls.ny - 1, cj + r) + 1):
            for i in range(max(0, ci - r), min(walls.nx - 1, ci + r) + 1):
                cx, cy = walls.x0 + (i + 0.5) * CELL, walls.y0 + (j + 0.5) * CELL
                if math.sqrt((cx - ax) ** 2 + (cy - ay) ** 2) < ARTWORK_KEEPOUT:
                    out[j * walls.nx + i] = 1
    return out


def _steps(walls: Walls, cmap: CognitiveMap, blocked: bytearray, k: int):
    """8-connected moves through seen, unblocked cells; a diagonal needs all four edges open.

    A blocked cell can be left but not entered, so an agent inside a keep-out walks out.
    """
    nx, ny = walls.nx, walls.ny
    i, j = k % nx, k // nx
    inside = blocked[k]
    ok = lambda c: cmap.seen[c] and (inside or not blocked[c])
    out = []
    for di, dj in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        a, b = i + di, j + dj
        if 0 <= a < nx and 0 <= b < ny:
            c = b * nx + a
            if ok(c) and walls.open_between(k, c):
                out.append((c, CELL))
    for di, dj in ((1, 1), (-1, 1), (1, -1), (-1, -1)):
        a, b = i + di, j + dj
        if not (0 <= a < nx and 0 <= b < ny):
            continue
        c, side_x, side_y = b * nx + a, j * nx + a, b * nx + i
        if (ok(c) and ok(side_x) and ok(side_y)
                and walls.open_between(k, side_x) and walls.open_between(side_x, c)
                and walls.open_between(k, side_y) and walls.open_between(side_y, c)):
            out.append((c, CELL * SQRT2))
    return out


def distances(walls: Walls, cmap: CognitiveMap, start: int, blocked: bytearray):
    """Dijkstra from `start` over the agent's own map. Returns (dist, prev) lists."""
    n = walls.nx * walls.ny
    dist, prev = [math.inf] * n, [-1] * n
    dist[start] = 0.0
    heap = [(0.0, start)]
    while heap:
        d, k = heapq.heappop(heap)
        if d > dist[k]:
            continue
        for c, w in _steps(walls, cmap, blocked, k):
            nd = d + w
            if nd < dist[c]:
                dist[c], prev[c] = nd, k
                heapq.heappush(heap, (nd, c))
    return dist, prev


def frontiers(walls: Walls, cmap: CognitiveMap, blocked: bytearray) -> list[int]:
    """E5: seen, unblocked cells with an open edge to an unknown cell."""
    out = []
    for k in range(walls.nx * walls.ny):
        if not cmap.seen[k] or blocked[k]:
            continue
        if any(not cmap.seen[b] and walls.open_between(k, b) for b in _neighbours4(walls, k)):
            out.append(k)
    return out


def next_frontier(walls: Walls, cmap: CognitiveMap, pos: XY, heading: float, blocked: bytearray):
    """E5: the reachable frontier with the lowest path length plus turning cost, or None."""
    start = walls.cell_of(pos)
    dist, _ = distances(walls, cmap, start, blocked)
    hx, hy = math.cos(heading), math.sin(heading)
    best = None
    for k in frontiers(walls, cmap, blocked):
        if dist[k] == math.inf:
            continue
        cx, cy = walls.centre(k)
        dx, dy = cx - pos[0], cy - pos[1]
        d = math.sqrt(dx * dx + dy * dy)
        cos_turn = (dx * hx + dy * hy) / d if d > 1e-9 else 1.0
        cost = dist[k] + TURN_COST * (1 - cos_turn)
        if best is None or cost < best[1]:
            best = (k, cost)
    return best


def path_cells(walls: Walls, cmap: CognitiveMap, pos: XY, goal: int, blocked: bytearray):
    """Cells from the agent's cell to `goal` on its own map, and the length, or None."""
    start = walls.cell_of(pos)
    dist, prev = distances(walls, cmap, start, blocked)
    if dist[goal] == math.inf:
        return None
    cells = [goal]
    while cells[-1] != start:
        cells.append(prev[cells[-1]])
    cells.reverse()
    return cells, dist[goal]


def smooth(walls: Walls, cmap: CognitiveMap, pos: XY, cells: list[int], blocked: bytearray) -> list[XY]:
    """E4: replace runs of cells by straight legs that stay in seen, unblocked cells."""
    ok = lambda c: bool(cmap.seen[c]) and not blocked[c]
    out, anchor, i, n = [], pos, 0, len(cells)
    while i < n - 1:
        j = i + 1
        while j + 1 < n and _trace(walls, anchor, walls.centre(cells[j + 1]), ok):
            j += 1
        anchor = walls.centre(cells[j])
        out.append(anchor)
        i = j
    return out


def viewpoint(walls: Walls, cmap: CognitiveMap, blocked: bytearray, art: XY, origin: XY):
    """E9: a seen, unblocked spot VIEW_DISTANCE from an artwork, in its room, nearest `origin`."""
    room = walls.room[walls.cell_of(art)]
    best = None
    for k in range(8):
        a = k * math.pi / 4
        p = (art[0] + VIEW_DISTANCE * math.cos(a), art[1] + VIEW_DISTANCE * math.sin(a))
        c = walls.cell_of(p)
        if not cmap.seen[c] or blocked[c] or walls.room[c] != room:
            continue
        d = math.sqrt((p[0] - origin[0]) ** 2 + (p[1] - origin[1]) ** 2)
        if best is None or d < best[1]:
            best = (p, d)
    return best and best[0]


# --- interests and routes ------------------------------------------------------------------

def choose_interests(view_time: dict, taste: dict, visits: dict, k: int = INTERESTS) -> list:
    """E8: the k entities with the highest view time x taste x NOVELTY^visits (ties by ID)."""
    scored = []
    for e, t in view_time.items():
        if t <= 0:
            continue
        scored.append((-(t * taste.get(e, 1.0) * NOVELTY ** visits.get(e, 0)), e))
    scored.sort()
    return [e for _, e in scored[:k]]


def order_route(dist: list[list[float]]) -> tuple[list[int], float]:
    """E8: the visiting order of stops 1..n-2, from 0 to n-1, with the least total length.

    Permutations are tried in lexicographic order and only a strictly shorter one replaces
    the best, so ties go to the first.
    """
    n = len(dist)
    stops = list(range(1, n - 1))
    best, best_len = list(stops), math.inf

    def rec(prefix, rest, length, last):
        nonlocal best, best_len
        if length >= best_len:
            return
        if not rest:
            total = length + dist[last][n - 1]
            if total < best_len:
                best, best_len = list(prefix), total
            return
        for idx, s in enumerate(rest):
            rec(prefix + [s], rest[:idx] + rest[idx + 1:], length + dist[last][s], s)

    rec([], stops, 0.0, 0)
    return best, best_len
