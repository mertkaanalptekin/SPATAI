"""Distance metrics on the exhibition floor plan (docs/SIMULATION_METRICS.md R7-R14).

- euclidean:  d_E, straight line in metres (R7)
- walk:       W, shortest walk through rooms and doors in metres (R8, support only)
- seq:        d_seq, directed valve-graph quasimetric in steps (R9, Case II)
- task:       d_L, walk pinned to the exhibits L in metres (R10, Case III)

Everything here is mirrored by js/metrics.js; tests/test_js_parity.py checks
the two agree. Keep the arithmetic (plain sqrt, tie-breaks) in step.
"""

from __future__ import annotations

import heapq
import itertools
import math
from dataclasses import dataclass

from spatai.exhibition import CHECKOUT, ENTRANCE, HALLS, FloorPlan
from spatai.geometry import EPSILON, Location
from spatai.world import World

INF = math.inf
NEAR = 0.2
FAR = 0.5
METRICS = ("euclidean", "seq", "task")
METRIC_LABELS = {"euclidean": "Euclidean", "seq": "d_seq", "task": "d_L"}
METRIC_UNITS = {"euclidean": "m", "seq": "steps", "task": "m"}
REFERENCE_NODES = (ENTRANCE, *HALLS, CHECKOUT)

XY = tuple[float, float]


def _xy(loc: Location) -> XY:
    w = loc.to_world()
    return (w.x, w.y)


def _dist(p: XY, q: XY) -> float:
    dx, dy = q[0] - p[0], q[1] - p[1]
    return math.sqrt(dx * dx + dy * dy)


@dataclass(frozen=True)
class Measure:
    value: float
    path: tuple[XY, ...]
    """Polyline in world coordinates, for drawing."""
    nodes: tuple[str, ...] = ()
    """d_seq: the sequence nodes visited. d_L: the exhibit order."""
    approx: bool = False
    """d_seq: an end point was in the corridor and was snapped to the nearest hall."""


# ---------------------------------------------------------------------------
# R7 Euclidean
# ---------------------------------------------------------------------------

def euclidean(a: Location, b: Location) -> Measure:
    return Measure(a.distance_to(b), (_xy(a), _xy(b)))


# ---------------------------------------------------------------------------
# R8 walking distance (Dijkstra over doors)
# ---------------------------------------------------------------------------

def _dijkstra(start: str, target: str, neighbours) -> tuple[float, list[str]]:
    """Shortest path; ties go to the lexicographically smaller (distance, node) heap entry."""
    best = {start: 0.0}
    prev: dict[str, str] = {}
    heap = [(0.0, start)]
    done = set()
    while heap:
        d, node = heapq.heappop(heap)
        if node in done:
            continue
        done.add(node)
        if node == target:
            break
        for nxt, w in neighbours(node):
            nd = d + w
            if nd < best.get(nxt, INF) - EPSILON:
                best[nxt] = nd
                prev[nxt] = node
                heapq.heappush(heap, (nd, nxt))
    if target not in best:
        return INF, []
    path, node = [target], target
    while node != start:
        node = prev[node]
        path.append(node)
    return best[target], path[::-1]


def walk(plan: FloorPlan, a: Location, b: Location, role: str = "visitor") -> Measure:
    ra, rb = plan.room_at(a), plan.room_at(b)
    if ra is None or rb is None:
        return Measure(INF, ())
    pa, pb = _xy(a), _xy(b)
    if ra == rb:
        return Measure(_dist(pa, pb), (pa, pb))
    doors = {d.door_id: d for d in plan.doors.values() if role == "staff" or not d.staff_only}
    start, end = "@a", "@b"

    def neighbours(node: str):
        if node == start:
            return [(d.door_id, _dist(pa, d.point)) for d in doors.values() if ra in d.rooms]
        door = doors[node]
        out = [(o.door_id, _dist(door.point, o.point)) for o in doors.values()
               if o.door_id != node and set(o.rooms) & set(door.rooms)]
        if rb in door.rooms:
            out.append((end, _dist(door.point, pb)))
        return out

    total, nodes = _dijkstra(start, end, neighbours)
    if total == INF:
        return Measure(INF, ())
    return Measure(total, (pa, *(doors[n].point for n in nodes[1:-1]), pb))


# ---------------------------------------------------------------------------
# R9 sequence quasimetric
# ---------------------------------------------------------------------------

def seq_node(plan: FloorPlan, location: Location) -> tuple[str | None, bool]:
    """The sequence node of a location, and whether it was snapped from the corridor."""
    room = plan.room_at(location)
    if room is None:
        return None, False
    node = plan.room_node[room]
    if node is not None:
        return node, False
    ranked = sorted((location.distance_to(plan.centre(h)), h) for h in HALLS)
    return ranked[0][1], True


def seq_edges(plan: FloorPlan, role: str = "visitor", strict: bool = False):
    return [e for e in plan.seq_edges
            if (e.kind != "staff" or role == "staff") and (e.kind != "reset" or not strict)]


def seq_between(plan: FloorPlan, src: str, dst: str, role: str = "visitor", strict: bool = False):
    """d_seq between two sequence nodes: (steps, nodes, edges used)."""
    edges = seq_edges(plan, role, strict)
    out: dict[str, list] = {}
    for e in edges:
        out.setdefault(e.src, []).append(e)
    if src == dst:
        return 0.0, [src], []
    total, nodes = _dijkstra(src, dst, lambda n: [(e.dst, e.weight) for e in out.get(n, [])])
    if total == INF:
        return INF, [], []
    used = []
    for u, v in zip(nodes, nodes[1:]):
        used.append(min((e for e in out[u] if e.dst == v), key=lambda e: (e.weight, e.kind != "forward")))
    return total, nodes, used


def seq(plan: FloorPlan, a: Location, b: Location, role: str = "visitor", strict: bool = False) -> Measure:
    na, approx_a = seq_node(plan, a)
    nb, approx_b = seq_node(plan, b)
    if na is None or nb is None:
        return Measure(INF, ())
    total, nodes, used = seq_between(plan, na, nb, role, strict)
    if total == INF:
        return Measure(INF, (), (na, nb), approx_a or approx_b)
    path = [_xy(a)]
    for e in used:
        path += [plan.doors[d].point for d in e.via]
        path.append(_xy(plan.centre(e.dst)))
    path[-1] = _xy(b) if used else path[-1]
    if not used:
        path.append(_xy(b))
    return Measure(total, tuple(path), tuple(nodes), approx_a or approx_b)


# ---------------------------------------------------------------------------
# R10 task-constrained distance
# ---------------------------------------------------------------------------

def task(plan: FloorPlan, a: Location, b: Location, role: str = "visitor") -> Measure:
    names = list(plan.exhibits)
    pts = [plan.exhibits[n] for n in names]
    best: Measure | None = None
    for order in itertools.permutations(range(len(pts))):
        stops = [a, *(pts[i] for i in order), b]
        total, path = 0.0, []
        for p, q in zip(stops, stops[1:]):
            leg = walk(plan, p, q, role)
            total += leg.value
            if total == INF:
                break
            path += leg.path if not path else leg.path[1:]
        if total < (best.value if best else INF) - EPSILON:
            best = Measure(total, tuple(path), tuple(names[i] for i in order))
    return best or Measure(INF, ())


# ---------------------------------------------------------------------------
# R12 normalisation, R13 occupancy, R14 discrepancies
# ---------------------------------------------------------------------------

def measure(plan: FloorPlan, metric: str, a: Location, b: Location,
            role: str = "visitor", strict: bool = False) -> Measure:
    if metric == "euclidean":
        return euclidean(a, b)
    if metric == "seq":
        return seq(plan, a, b, role, strict)
    if metric == "task":
        return task(plan, a, b, role)
    raise ValueError(f"unknown metric {metric!r}")


def reference_ranges(plan: FloorPlan) -> dict[str, tuple[float, float]]:
    """Min and max of each metric over ordered pairs of reference nodes (visitor, resets on)."""
    pts = [plan.centre(n) for n in REFERENCE_NODES]
    out = {}
    for m in METRICS:
        vals = [measure(plan, m, a, b).value for a in pts for b in pts]
        finite = [v for v in vals if v != INF]
        out[m] = (min(finite), max(finite))
    return out


def normalize(value: float, rng: tuple[float, float]) -> float:
    if value == INF:
        return 1.0
    lo, hi = rng
    if hi - lo <= EPSILON:
        return 0.0
    return min(1.0, max(0.0, (value - lo) / (hi - lo)))


@dataclass(frozen=True)
class Discrepancy:
    user_id: str
    near_metric: str
    far_metric: str
    near_value: float
    far_value: float
    near_norm: float
    far_norm: float


def visitor_profile(plan: FloorPlan, world: World, user_id: str, target: Location,
                    ranges: dict[str, tuple[float, float]], strict: bool = False) -> dict[str, tuple[float, float]]:
    """metric -> (raw, normalised) distance from the visitor to the target, in the visitor's role."""
    v = world.visitors[user_id]
    out = {}
    for m in METRICS:
        raw = measure(plan, m, v.position, target, v.role, strict).value
        out[m] = (raw, normalize(raw, ranges[m]))
    return out


def occupancy(plan: FloorPlan, world: World, target: Location, ranges, strict: bool = False) -> dict[str, list[str]]:
    """R13: visitors inferred near the target under each metric."""
    near = {m: [] for m in METRICS}
    for uid in world.visitors:
        prof = visitor_profile(plan, world, uid, target, ranges, strict)
        for m in METRICS:
            if prof[m][1] <= NEAR + EPSILON:
                near[m].append(uid)
    return near


def discrepancies(plan: FloorPlan, world: World, target: Location, ranges, strict: bool = False) -> list[Discrepancy]:
    """R14: near by one metric, far by another."""
    out = []
    for uid in world.visitors:
        prof = visitor_profile(plan, world, uid, target, ranges, strict)
        for m1 in METRICS:
            for m2 in METRICS:
                if m1 != m2 and prof[m1][1] <= NEAR + EPSILON and prof[m2][1] >= FAR - EPSILON:
                    out.append(Discrepancy(uid, m1, m2, prof[m1][0], prof[m2][0], prof[m1][1], prof[m2][1]))
    return out


def axiom_report(plan: FloorPlan) -> dict[str, object]:
    """R11: which metric axioms hold over the reference nodes (visitor, resets on)."""
    nodes = REFERENCE_NODES
    pts = {n: plan.centre(n) for n in nodes}
    d = {(a, b): seq_between(plan, a, b)[0] for a in nodes for b in nodes}
    p = {(a, b): task(plan, pts[a], pts[b]).value for a in nodes for b in nodes}
    return {
        "seq_asymmetric_pairs": sum(1 for a in nodes for b in nodes if a < b and d[a, b] != d[b, a]),
        "seq_self_zero": all(d[a, a] == 0 for a in nodes),
        "seq_triangle": all(d[a, c] <= d[a, b] + d[b, c] + EPSILON for a in nodes for b in nodes for c in nodes),
        "task_self_positive": all(p[a, a] > 0 for a in nodes),
        "task_symmetric": all(abs(p[a, b] - p[b, a]) <= 1e-6 for a in nodes for b in nodes),
        "task_small_self_distance": all(p[a, a] <= p[a, b] + EPSILON for a in nodes for b in nodes),
    }
