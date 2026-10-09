"""Entities and attributes of the spatial AI semantic model."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

from spatai.geometry import Location, Rect, Region

DEFAULT_LOOP_MEDIA = "default_loop"
INTERACTIVE_MEDIA = "interactive"


class PowerState(str, Enum):
    OFF = "OFF"
    ON = "ON"


@dataclass
class Visitor:
    user_id: str
    position: Location
    velocity: tuple[float, float] = (0.0, 0.0)
    """Metres per second, in the frame of `position`."""
    dwell_time: float = 0.0
    """Seconds spent in the current zone."""


@dataclass
class SmartDisplay:
    display_id: str
    position: Location
    orientation: float = 0.0
    """Direction the screen faces, in degrees within the frame of `position`."""
    current_media: str = DEFAULT_LOOP_MEDIA
    volume_level: int = 50
    """0-100."""
    power_state: PowerState = PowerState.OFF
    status: str = "idle"

    def __post_init__(self) -> None:
        if not 0 <= self.volume_level <= 100:
            raise ValueError(f"volume_level must be 0-100, got {self.volume_level}")

    def world_orientation(self) -> float:
        return self.orientation + self.position.frame.world_rotation()


@dataclass
class SpatialZone:
    zone_id: str
    boundary: Rect
    ambient_light: float = 0.0
    """Lux."""
    display_ids: set[str] = field(default_factory=set)

    def control(self, display: SmartDisplay) -> None:
        """Relationship: Spatial Zone *controls* Smart Display."""
        self.display_ids.add(display.display_id)


@dataclass
class Place:
    """A named region, optionally nested inside a larger place."""

    name: str
    region: Region
    parent: Place | None = field(default=None, repr=False)

    def depth(self) -> int:
        d, p = 0, self.parent
        while p is not None:
            d, p = d + 1, p.parent
            if d > 10_000:
                raise ValueError(f"Place parent cycle at {self.name!r}")
        return d
