"""Proximity rules for the exhibition (docs/PROXIMITY_RULES.md P2-P9).

Pure functions only; js/proximity.js ports them (tests/test_js_parity.py checks
they agree) and adds the ArtworkGuard state machine that the page runs.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from spatai.exhibition import FloorPlan
from spatai.geometry import EPSILON, Location
from spatai.metrics import INF, walk
from spatai.world import World

PERSONAL_SPACE_M = 1.0
ARTWORK_DISTANCE_M = 1.0
STAFF_STANDOFF_M = 1.3
STEP_BACK_TO_M = 1.6
ARRIVED_SLACK_M = 0.4
RESOLVED_SLACK_M = 0.15
REPLAN_AFTER_S = 2.0

XY = tuple[float, float]


def _xy(loc: Location) -> XY:
    w = loc.to_world()
    return (w.x, w.y)


def world_velocity(loc: Location, velocity: tuple[float, float]) -> XY:
    """A velocity given in the frame of `loc`, turned into world axes."""
    r = math.radians(loc.frame.world_rotation())
    c, s = math.cos(r), math.sin(r)
    vx, vy = velocity
    return (vx * c - vy * s, vx * s + vy * c)


def closing_speed(me: XY, v: XY, other: XY) -> float:
    """Component of velocity `v` (at `me`) towards `other`; 0 when they coincide."""
    dx, dy = other[0] - me[0], other[1] - me[1]
    d = math.sqrt(dx * dx + dy * dy)
    if d <= EPSILON:
        return 0.0
    return (v[0] * dx + v[1] * dy) / d


def yields(me_id: str, me: XY, me_v: XY, other_id: str, other: XY, other_v: XY,
           limit: float = PERSONAL_SPACE_M) -> bool:
    """P2-P3: must `me` stop for `other`?"""
    dx, dy = other[0] - me[0], other[1] - me[1]
    if math.sqrt(dx * dx + dy * dy) >= limit - EPSILON:
        return False
    mine, theirs = closing_speed(me, me_v, other), closing_speed(other, other_v, me)
    if mine <= EPSILON:
        return False
    if abs(mine - theirs) <= EPSILON:
        return me_id > other_id
    return mine > theirs


@dataclass(frozen=True)
class Conflict:
    stopper: str
    other: str
    distance: float


def personal_space_conflicts(world: World, exempt: frozenset[str] = frozenset()) -> list[Conflict]:
    """P2-P5 over every pair of agents, using each one's current velocity as its intent."""
    agents = [v for v in world.visitors.values() if v.user_id not in exempt]
    pos = {v.user_id: _xy(v.position) for v in agents}
    vel = {v.user_id: world_velocity(v.position, v.velocity) for v in agents}
    out = []
    for i, a in enumerate(agents):
        for b in agents[i + 1:]:
            for me, other in ((a, b), (b, a)):
                if yields(me.user_id, pos[me.user_id], vel[me.user_id], other.user_id, pos[other.user_id], vel[other.user_id]):
                    out.append(Conflict(me.user_id, other.user_id, me.position.distance_to(other.position)))
    return out


@dataclass(frozen=True)
class Breach:
    visitor: str
    artwork: str
    distance: float


def artwork_breaches(plan: FloorPlan, world: World) -> list[Breach]:
    """P6: visitors (not staff) closer than 1 m to an artwork; the nearest artwork per visitor."""
    out = []
    for v in world.visitors.values():
        if v.role != "visitor":
            continue
        ranked = sorted((v.position.distance_to(loc), name) for name, loc in plan.artworks.items())
        if ranked and ranked[0][0] < ARTWORK_DISTANCE_M - EPSILON:
            out.append(Breach(v.user_id, ranked[0][1], ranked[0][0]))
    return out


def nearest_staff(plan: FloorPlan, world: World, location: Location, exclude=frozenset()) -> str | None:
    """P7: the free staff member with the shortest walk to `location`; ties by ID."""
    ranked = []
    for v in world.visitors.values():
        if v.role == "staff" and v.user_id not in exclude:
            d = walk(plan, v.position, location, "staff").value
            if d != INF:
                ranked.append((d, v.user_id))
    return min(ranked)[1] if ranked else None


def approach_point(plan: FloorPlan, staff: Location, visitor: Location, standoff: float = STAFF_STANDOFF_M) -> Location:
    """P7: the point `standoff` metres from the visitor on the side the staff member arrives from."""
    route = walk(plan, staff, visitor, "staff")
    v = _xy(visitor)
    prev = route.path[-2] if len(route.path) >= 2 else _xy(staff)
    dx, dy = prev[0] - v[0], prev[1] - v[1]
    d = math.sqrt(dx * dx + dy * dy)
    if d <= EPSILON:
        return Location(*v)
    k = min(standoff, d) / d
    return Location(v[0] + dx * k, v[1] + dy * k)


def step_back_point(plan: FloorPlan, artwork: str, visitor: Location, to: float = STEP_BACK_TO_M) -> Location:
    """P8: `to` metres from the artwork along the line from the artwork through the visitor."""
    a = _xy(plan.artworks[artwork])
    v = _xy(visitor)
    dx, dy = v[0] - a[0], v[1] - a[1]
    d = math.sqrt(dx * dx + dy * dy)
    if d <= EPSILON:
        c = _xy(plan.centre(plan.artwork_hall[artwork]))
        dx, dy = c[0] - a[0], c[1] - a[1]
        d = math.sqrt(dx * dx + dy * dy) or 1.0
    return Location(a[0] + dx / d * to, a[1] + dy / d * to)
