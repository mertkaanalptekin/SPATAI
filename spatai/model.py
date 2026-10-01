"""Entities, attributes and relationships of the spatial AI semantic model."""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from enum import Enum

Position = tuple[float, ...]
"""A point in space, in metres. Typically (x, y) or (x, y, z)."""

DEFAULT_LOOP_MEDIA = "default_loop"
INTERACTIVE_MEDIA = "interactive"


class PowerState(str, Enum):
    OFF = "OFF"
    ON = "ON"


def distance(a: Position, b: Position) -> float:
    """Euclidean distance in metres between two positions of equal dimension."""
    if len(a) != len(b):
        raise ValueError(f"Position dimensions differ: {a!r} vs {b!r}")
    return math.dist(a, b)


@dataclass
class Visitor:
    user_id: str
    position: Position
    velocity: tuple[float, ...] = (0.0, 0.0)
    dwell_time: float = 0.0
    """Seconds spent in the current zone."""


@dataclass
class SmartDisplay:
    display_id: str
    position: Position
    """Needed by the proximity rule (Display.Position)."""
    current_media: str = DEFAULT_LOOP_MEDIA
    volume_level: int = 50
    """0-100."""
    power_state: PowerState = PowerState.OFF
    status: str = "idle"

    def __post_init__(self) -> None:
        if not 0 <= self.volume_level <= 100:
            raise ValueError(f"volume_level must be 0-100, got {self.volume_level}")


@dataclass
class SpatialZone:
    zone_id: str
    ambient_light: float = 0.0
    """Lux."""
    visitors: dict[str, Visitor] = field(default_factory=dict)
    displays: dict[str, SmartDisplay] = field(default_factory=dict)

    @property
    def occupancy(self) -> int:
        """Number of visitors currently in the zone."""
        return len(self.visitors)

    def enter(self, visitor: Visitor) -> None:
        """Relationship: Visitor *enters* Spatial Zone."""
        self.visitors[visitor.user_id] = visitor

    def leave(self, user_id: str) -> Visitor | None:
        return self.visitors.pop(user_id, None)

    def control(self, display: SmartDisplay) -> None:
        """Relationship: Spatial Zone *controls* Smart Display."""
        self.displays[display.display_id] = display
