"""World registry and spatial queries.

Every visitor, display, zone and place is registered under an ID that is unique
across all four kinds, so `locate()` and `position_in()` accept any of them.
Zone membership is derived from location: a visitor is in the zone that
`zone_at()` returns for their position.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from functools import cmp_to_key

from spatai.geometry import EPSILON, Location, ReferenceFrame, normalize_angle
from spatai.model import Place, SmartDisplay, SpatialZone, Visitor

Entity = Visitor | SmartDisplay | SpatialZone | Place

FRONT_HALF_ANGLE = 45.0
"""Within this many degrees of a display's facing direction counts as "in front"."""


def _by_distance_then_id(a: tuple[float, str], b: tuple[float, str]) -> int:
    """Order (distance, id) pairs; distances within EPSILON count as a tie, broken by id."""
    if abs(a[0] - b[0]) > EPSILON:
        return -1 if a[0] < b[0] else 1
    return (a[1] > b[1]) - (a[1] < b[1])


@dataclass(frozen=True)
class Description:
    place: Place | None
    nearest_display: SmartDisplay | None
    distance: float | None
    direction: str | None
    """"front", "behind", "left", "right" or "at", relative to the display's facing."""

    def __str__(self) -> str:
        where = f"In {self.place.name}" if self.place else "Outside any known place"
        if self.nearest_display is None:
            return f"{where}; no displays"
        d = self.nearest_display.display_id
        if self.direction == "at":
            return f"{where}, at {d}"
        rel = {"front": "in front of", "behind": "behind", "left": "left of", "right": "right of"}
        return f"{where}, {self.distance:.1f} m {rel[self.direction]} {d}"


@dataclass
class World:
    visitors: dict[str, Visitor] = field(default_factory=dict)
    displays: dict[str, SmartDisplay] = field(default_factory=dict)
    zones: dict[str, SpatialZone] = field(default_factory=dict)
    places: dict[str, Place] = field(default_factory=dict)

    # -- registration -------------------------------------------------------

    def _check_new(self, obj_id: str) -> None:
        if obj_id in self.visitors or obj_id in self.displays or obj_id in self.zones or obj_id in self.places:
            raise ValueError(f"ID already registered: {obj_id!r}")

    def add_visitor(self, visitor: Visitor) -> Visitor:
        self._check_new(visitor.user_id)
        self.visitors[visitor.user_id] = visitor
        return visitor

    def add_display(self, display: SmartDisplay, zone_id: str | None = None) -> SmartDisplay:
        """Register a display; with `zone_id`, that zone also controls it."""
        zone = self.zones[zone_id] if zone_id is not None else None
        self._check_new(display.display_id)
        self.displays[display.display_id] = display
        if zone is not None:
            zone.control(display)
        return display

    def add_zone(self, zone: SpatialZone) -> SpatialZone:
        self._check_new(zone.zone_id)
        self.zones[zone.zone_id] = zone
        return zone

    def add_place(self, place: Place) -> Place:
        self._check_new(place.name)
        if place.parent is not None and self.places.get(place.parent.name) is not place.parent:
            raise ValueError(f"Parent place {place.parent.name!r} is not registered")
        self.places[place.name] = place
        return place

    def remove(self, obj_id: str) -> Entity:
        """Unregister an object; a removed display is also dropped from its zone."""
        registry = next((r for r in (self.visitors, self.displays, self.zones, self.places) if obj_id in r), None)
        if registry is None:
            raise KeyError(obj_id)
        obj = registry[obj_id]
        if isinstance(obj, Place) and any(p.parent is obj for p in self.places.values()):
            raise ValueError(f"Place {obj_id!r} still has child places")
        del registry[obj_id]
        if isinstance(obj, SmartDisplay):
            for zone in self.zones.values():
                zone.display_ids.discard(obj_id)
        return obj

    def get(self, obj_id: str) -> Entity:
        for registry in (self.visitors, self.displays, self.zones, self.places):
            if obj_id in registry:
                return registry[obj_id]
        raise KeyError(obj_id)

    # -- queries ------------------------------------------------------------

    def locate(self, obj_id: str) -> Location:
        """Where an object is: its position, or the centre of a zone or place."""
        obj = self.get(obj_id)
        if isinstance(obj, (Visitor, SmartDisplay)):
            return obj.position
        if isinstance(obj, SpatialZone):
            return obj.boundary.centroid()
        return obj.region.centroid()

    def occupants_at(self, location: Location, radius: float) -> list[Visitor]:
        """Visitors within `radius` metres (inclusive) of `location`, nearest first."""
        if radius < 0:
            raise ValueError(f"radius must be >= 0, got {radius}")
        hits = [(location.distance_to(v.position), v.user_id) for v in self.visitors.values()]
        hits = sorted((h for h in hits if h[0] <= radius + EPSILON), key=cmp_to_key(_by_distance_then_id))
        return [self.visitors[user_id] for _, user_id in hits]

    def zone_at(self, location: Location) -> SpatialZone | None:
        """The zone whose boundary contains `location`; the smallest wins if zones overlap."""
        hits = [z for z in self.zones.values() if z.boundary.contains(location)]
        return min(hits, key=lambda z: (z.boundary.area, z.zone_id), default=None)

    def position_in(self, obj_id: str, frame: ReferenceFrame) -> Location:
        """`locate(obj_id)` expressed in `frame`."""
        return self.locate(obj_id).in_frame(frame)

    def place_at(self, location: Location) -> Place | None:
        """The most specific place containing `location`: deepest nesting, then smallest area."""
        hits = [p for p in self.places.values() if p.region.contains(location)]
        return min(hits, key=lambda p: (-p.depth(), p.region.area, p.name), default=None)

    def nearest_display(self, location: Location) -> SmartDisplay | None:
        ranked = sorted(
            ((location.distance_to(d.position), d.display_id) for d in self.displays.values()),
            key=cmp_to_key(_by_distance_then_id),
        )
        return self.displays[ranked[0][1]] if ranked else None

    def describe(self, location: Location) -> Description:
        """Most specific containing place, nearest display, and where `location` lies relative to it."""
        place = self.place_at(location)
        display = self.nearest_display(location)
        if display is None:
            return Description(place, None, None, None)
        dist = display.position.distance_to(location)
        return Description(place, display, dist, relative_direction(display, location))

    # -- zone membership ------------------------------------------------------

    def occupants_of(self, zone_id: str) -> list[Visitor]:
        """Visitors whose location falls in this zone (per `zone_at`)."""
        zone = self.zones[zone_id]
        return [v for v in self.visitors.values() if self.zone_at(v.position) is zone]

    def occupancy(self, zone_id: str) -> int:
        return len(self.occupants_of(zone_id))


def relative_direction(display: SmartDisplay, location: Location) -> str:
    """Where `location` lies relative to the way `display` faces."""
    if display.position.distance_to(location) <= EPSILON:
        return "at"
    angle = normalize_angle(display.position.bearing_to(location) - display.world_orientation())
    if abs(angle) <= FRONT_HALF_ANGLE + EPSILON:
        return "front"
    if abs(angle) >= 180.0 - FRONT_HALF_ANGLE - EPSILON:
        return "behind"
    return "left" if angle > 0 else "right"
