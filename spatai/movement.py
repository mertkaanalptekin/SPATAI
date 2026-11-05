"""Prepositions of movement: toward, away from, around (docs/MOVEMENT_PREPOSITIONS.md M1-M5).

classify() is a pure function; js/movement.js ports it (tests/test_js_parity.py checks
they agree) and adds MovementTracker, which samples agents and emits the M6 events.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

XY = tuple[float, float]

REACH = {"screen": 6.0, "artwork": 5.0, "agent": 4.0}   # M1
SAMPLE_HZ = 4                                            # M2
WINDOW_S = 3.0
MIN_PATH = 0.3                                           # M4
AROUND_SWEEP = math.radians(45)
MIN_RADIAL = 0.3
RADIAL_SHARE = 0.4
MIN_STEP = 0.02
MIN_DIST = 0.3
PREPOSITIONS = ("around", "toward", "away")              # M5 priority order


@dataclass(frozen=True)
class Relation:
    preposition: str            # "toward" | "away" | "around"
    direction: str | None       # "anticlockwise" | "clockwise" for around, else None
    path: float
    radial: float
    sweep: float                # radians, anticlockwise positive
    turn: float                 # radians
    distance: float             # mean distance over the window


def _measures(agent: list[XY], entity: list[XY]):
    n = len(agent)
    path = radial = sweep = turn = 0.0
    prev_step = None
    for i in range(n - 1):
        ax, ay = agent[i + 1][0] - agent[i][0], agent[i + 1][1] - agent[i][1]
        step = math.sqrt(ax * ax + ay * ay)
        path += step
        rx, ry = entity[i][0] - agent[i][0], entity[i][1] - agent[i][1]
        d = math.sqrt(rx * rx + ry * ry)
        if d > 1e-9:
            radial += (ax * rx + ay * ry) / d
            # (agent - entity) x step, so anticlockwise around the entity is positive
            sweep += (-rx * ay + ry * ax) / d / max(d, MIN_DIST)
        if step > MIN_STEP:
            if prev_step is not None:
                px, py = prev_step
                turn += math.atan2(px * ay - py * ax, px * ax + py * ay)
            prev_step = (ax, ay)
    dists = [math.sqrt((entity[i][0] - agent[i][0]) ** 2 + (entity[i][1] - agent[i][1]) ** 2) for i in range(n)]
    return path, radial, sweep, turn, sum(dists) / n


def classify(agent: list[XY], entity: list[XY], reach: float) -> Relation | None:
    """M3-M4. `agent` and `entity` are position samples over the same window, oldest first."""
    if len(agent) < 3 or len(agent) != len(entity):
        return None
    path, radial, sweep, turn, mean_d = _measures(agent, entity)
    if path < MIN_PATH or mean_d > reach:
        return None
    if (abs(sweep) >= AROUND_SWEEP and sweep * turn > 0 and abs(turn) >= 0.5 * abs(sweep)
            and abs(radial) <= 0.5 * path):
        return Relation("around", "anticlockwise" if sweep > 0 else "clockwise", path, radial, sweep, turn, mean_d)
    if radial >= RADIAL_SHARE * path and radial >= MIN_RADIAL:
        return Relation("toward", None, path, radial, sweep, turn, mean_d)
    if -radial >= RADIAL_SHARE * path and -radial >= MIN_RADIAL:
        return Relation("away", None, path, radial, sweep, turn, mean_d)
    return None


def primary(relations: list[tuple[str, Relation]]) -> tuple[str, Relation] | None:
    """M5: around before toward before away, then nearest, then entity ID."""
    if not relations:
        return None
    return min(relations, key=lambda er: (PREPOSITIONS.index(er[1].preposition), er[1].distance, er[0]))
