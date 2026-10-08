"""Reference frames, locations and regions.

All angles are in degrees, counter-clockwise, with 0 along the frame's +x axis.
Distances are in metres. Boundary checks are inclusive, with a small tolerance
so points on an edge still count after a rotation introduces float error.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

EPSILON = 1e-9


def _rotate(x: float, y: float, degrees: float) -> tuple[float, float]:
    r = math.radians(degrees)
    c, s = math.cos(r), math.sin(r)
    return x * c - y * s, x * s + y * c


def normalize_angle(degrees: float) -> float:
    """Map an angle onto (-180, 180]."""
    a = math.fmod(degrees, 360.0)
    if a <= -180.0:
        a += 360.0
    elif a > 180.0:
        a -= 360.0
    return a


@dataclass(eq=False)
class ReferenceFrame:
    """A 2D coordinate frame placed inside a parent frame.

    `origin` is where this frame's (0, 0) sits, in the parent's coordinates, and
    `rotation` is how far this frame's +x axis is turned from the parent's.
    A frame with no parent is defined directly in world coordinates.
    Frames compare by identity.
    """

    frame_id: str
    origin: tuple[float, float] = (0.0, 0.0)
    rotation: float = 0.0
    parent: ReferenceFrame | None = field(default=None, repr=False)

    def to_parent(self, x: float, y: float) -> tuple[float, float]:
        rx, ry = _rotate(x, y, self.rotation)
        return rx + self.origin[0], ry + self.origin[1]

    def from_parent(self, x: float, y: float) -> tuple[float, float]:
        return _rotate(x - self.origin[0], y - self.origin[1], -self.rotation)

    def to_world(self, x: float, y: float) -> tuple[float, float]:
        frame: ReferenceFrame | None = self
        while frame is not None:
            x, y = frame.to_parent(x, y)
            frame = frame.parent
        return x, y

    def from_world(self, x: float, y: float) -> tuple[float, float]:
        for frame in reversed(self.ancestry()):
            x, y = frame.from_parent(x, y)
        return x, y

    def world_rotation(self) -> float:
        """This frame's +x heading, in world degrees."""
        return sum(f.rotation for f in self.ancestry())

    def ancestry(self) -> list[ReferenceFrame]:
        """This frame followed by its parents, innermost first."""
        chain: list[ReferenceFrame] = []
        frame: ReferenceFrame | None = self
        while frame is not None:
            if frame in chain:
                raise ValueError(f"Reference frame cycle at {frame.frame_id!r}")
            chain.append(frame)
            frame = frame.parent
        return chain


WORLD_FRAME = ReferenceFrame("world")


@dataclass(frozen=True)
class Location:
    """A point (x, y) expressed in a reference frame."""

    x: float
    y: float
    frame: ReferenceFrame = WORLD_FRAME

    def to_world(self) -> Location:
        return Location(*self.frame.to_world(self.x, self.y), WORLD_FRAME)

    def in_frame(self, frame: ReferenceFrame) -> Location:
        if frame is self.frame:
            return self
        w = self.to_world()
        return Location(*frame.from_world(w.x, w.y), frame)

    def distance_to(self, other: Location) -> float:
        a, b = self.to_world(), other.to_world()
        return math.hypot(b.x - a.x, b.y - a.y)

    def bearing_to(self, other: Location) -> float:
        """World heading in degrees from this location towards `other`."""
        a, b = self.to_world(), other.to_world()
        return math.degrees(math.atan2(b.y - a.y, b.x - a.x))


@dataclass(frozen=True)
class Circle:
    center: Location
    radius: float

    def __post_init__(self) -> None:
        if self.radius < 0:
            raise ValueError(f"radius must be >= 0, got {self.radius}")

    @property
    def area(self) -> float:
        return math.pi * self.radius**2

    def centroid(self) -> Location:
        return self.center

    def contains(self, location: Location) -> bool:
        return self.center.distance_to(location) <= self.radius + EPSILON


@dataclass(frozen=True)
class Rect:
    """An axis-aligned rectangle in `frame`; rotate the frame to rotate the rectangle."""

    x_min: float
    y_min: float
    x_max: float
    y_max: float
    frame: ReferenceFrame = WORLD_FRAME

    def __post_init__(self) -> None:
        if self.x_min > self.x_max or self.y_min > self.y_max:
            raise ValueError(f"Rect min corner must not exceed max corner: {self!r}")

    @property
    def area(self) -> float:
        return (self.x_max - self.x_min) * (self.y_max - self.y_min)

    def centroid(self) -> Location:
        return Location((self.x_min + self.x_max) / 2, (self.y_min + self.y_max) / 2, self.frame)

    def contains(self, location: Location) -> bool:
        p = location.in_frame(self.frame)
        return (
            self.x_min - EPSILON <= p.x <= self.x_max + EPSILON
            and self.y_min - EPSILON <= p.y <= self.y_max + EPSILON
        )


Region = Circle | Rect
