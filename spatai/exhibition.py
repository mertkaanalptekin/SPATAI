"""The 10-hall exhibition from docs/SIMULATION_METRICS.md (R1-R6, R9, R15).

A folded snake plan: Gallery 1-5 run west to east along the south row, a central
corridor carries the fold, and Gallery 6-10 run back east to west along the
north row to the Checkout. Doors are gaps in the partition walls; the
sequence graph is the directed "valve" graph that d_seq measures on.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from spatai.geometry import Circle, Location, Rect, ReferenceFrame
from spatai.model import Place, SmartDisplay, SpatialZone, Visitor
from spatai.world import World

ENTRANCE = "Entrance"
CHECKOUT = "Checkout"
CORRIDOR = "Central Corridor"
RESET_PASSAGE = "Reset Passage"
HALLS = tuple(f"Gallery {i}" for i in range(1, 11))
DOOR_WIDTH = 1.2  # metres


@dataclass(frozen=True)
class Door:
    door_id: str
    rooms: tuple[str, str]
    point: tuple[float, float]
    staff_only: bool = False


@dataclass(frozen=True)
class SeqEdge:
    """A directed edge of the valve graph (R9)."""

    src: str
    dst: str
    weight: float
    kind: str
    """"forward", "shortcut", "staff" or "reset"."""
    via: tuple[str, ...]
    """Door IDs the edge passes through, in order (used to draw it)."""
    label: str = ""


@dataclass
class FloorPlan:
    rooms: dict[str, Rect]
    doors: dict[str, Door]
    seq_nodes: tuple[str, ...]
    seq_edges: tuple[SeqEdge, ...]
    room_node: dict[str, str | None]
    """Room -> sequence node; None means "use the nearest hall" (the corridor)."""
    exhibits: dict[str, Location]
    exhibit_hall: dict[str, str] = field(default_factory=dict)

    def room_at(self, location: Location) -> str | None:
        """The first room (in plan order) containing `location`; door points lie on two rooms."""
        for name, rect in self.rooms.items():
            if rect.contains(location):
                return name
        return None

    def doors_of(self, room: str, role: str = "visitor") -> list[Door]:
        return [d for d in self.doors.values() if room in d.rooms and (role == "staff" or not d.staff_only)]

    def centre(self, room: str) -> Location:
        return self.rooms[room].centroid()

    @property
    def shortcuts(self) -> list[SeqEdge]:
        """S1-S3 (R5): the staff door counts once although it has an edge each way."""
        seen, out = set(), []
        for e in self.seq_edges:
            if e.kind in ("shortcut", "staff") and e.label not in seen:
                seen.add(e.label)
                out.append(e)
        return out


def _rooms() -> dict[str, Rect]:
    rooms = {ENTRANCE: Rect(0, 0, 4, 8)}
    for i in range(5):  # Gallery 1-5, south row, west to east
        rooms[HALLS[i]] = Rect(4 + 8 * i, 0, 12 + 8 * i, 8)
    rooms[CORRIDOR] = Rect(4, 8, 44, 11)
    for i in range(5):  # Gallery 6-10, north row, east to west
        rooms[HALLS[5 + i]] = Rect(36 - 8 * i, 11, 44 - 8 * i, 19)
    rooms[CHECKOUT] = Rect(0, 11, 4, 19)
    rooms[RESET_PASSAGE] = Rect(0, 8, 4, 11)
    return rooms


def _doors() -> dict[str, Door]:
    g = HALLS
    spec = [
        ("entry", (ENTRANCE, g[0]), (4, 4), False),
        ("g1-g2", (g[0], g[1]), (12, 2.5), False),
        ("staff-g1-g2", (g[0], g[1]), (12, 6), True),
        ("g2-g3", (g[1], g[2]), (20, 4), False),
        ("g3-g4", (g[2], g[3]), (28, 4), False),
        ("g4-g5", (g[3], g[4]), (36, 4), False),
        ("g5-cor", (g[4], CORRIDOR), (40, 8), False),
        ("cor-g6", (CORRIDOR, g[5]), (40, 11), False),
        ("g6-g7", (g[5], g[6]), (36, 15), False),
        ("g7-g8", (g[6], g[7]), (28, 15), False),
        ("g8-g9", (g[7], g[8]), (20, 15), False),
        ("g9-g10", (g[8], g[9]), (12, 15), False),
        ("exit", (g[9], CHECKOUT), (4, 15), False),
        ("reset-n", (CHECKOUT, RESET_PASSAGE), (2, 11), False),
        ("reset-s", (RESET_PASSAGE, ENTRANCE), (2, 8), False),
        ("g4-cor", (g[3], CORRIDOR), (32, 8), False),
        ("cor-g7", (CORRIDOR, g[6]), (32, 11), False),
        ("g8-cor", (g[7], CORRIDOR), (24, 11), False),
        ("cor-g3", (CORRIDOR, g[2]), (24, 8), False),
    ]
    return {d: Door(d, rooms, (float(p[0]), float(p[1])), staff) for d, rooms, p, staff in spec}


def _seq_edges() -> tuple[SeqEdge, ...]:
    g = HALLS
    forward_via = ["g1-g2", "g2-g3", "g3-g4", "g4-g5", ("g5-cor", "cor-g6"), "g6-g7", "g7-g8", "g8-g9", "g9-g10"]
    edges = [SeqEdge(ENTRANCE, g[0], 1, "forward", ("entry",))]
    for i, via in enumerate(forward_via):
        edges.append(SeqEdge(g[i], g[i + 1], 1, "forward", via if isinstance(via, tuple) else (via,)))
    edges.append(SeqEdge(g[9], CHECKOUT, 1, "forward", ("exit",)))
    edges += [
        SeqEdge(g[0], g[1], 1, "staff", ("staff-g1-g2",), "S1"),
        SeqEdge(g[1], g[0], 1, "staff", ("staff-g1-g2",), "S1"),
        SeqEdge(g[3], g[6], 1, "shortcut", ("g4-cor", "cor-g7"), "S2"),
        SeqEdge(g[7], g[2], 1, "shortcut", ("g8-cor", "cor-g3"), "S3"),
        SeqEdge(CHECKOUT, g[0], 0, "reset", ("reset-n", "reset-s", "entry"), "reset"),
        SeqEdge(CHECKOUT, ENTRANCE, 0, "reset", ("reset-n", "reset-s"), "reset"),
    ]
    return tuple(edges)


def build_floorplan() -> FloorPlan:
    rooms = _rooms()
    room_node: dict[str, str | None] = {r: r for r in rooms}
    room_node[RESET_PASSAGE] = CHECKOUT
    room_node[CORRIDOR] = None
    exhibits = {"Exhibit l1": Location(24, 2), "Exhibit l2": Location(41, 17), "Exhibit l3": Location(16, 17)}
    plan = FloorPlan(
        rooms=rooms,
        doors=_doors(),
        seq_nodes=(ENTRANCE, *HALLS, CHECKOUT),
        seq_edges=_seq_edges(),
        room_node=room_node,
        exhibits=exhibits,
    )
    plan.exhibit_hall = {name: plan.room_at(loc) for name, loc in exhibits.items()}
    return plan


EXHIBIT_RADIUS = 0.6


def build_exhibition() -> tuple[World, dict[str, ReferenceFrame], FloorPlan]:
    """The exhibition world (R15): zone, places, displays in their own frames, agents."""
    plan = build_floorplan()
    world = World()
    world.add_zone(SpatialZone("exhibition", Rect(0, 0, 44, 19), ambient_light=280))
    building = world.add_place(Place("Exhibition", Rect(0, 0, 44, 19)))
    for name, rect in plan.rooms.items():
        world.add_place(Place(name, rect, parent=building))
    for name, loc in plan.exhibits.items():
        world.add_place(Place(name, Circle(loc, EXHIBIT_RADIUS), parent=world.places[plan.exhibit_hall[name]]))

    frames = {
        "g1-screen": ReferenceFrame("g1-screen", origin=(8, 0.4), rotation=90),
        "g2-screen": ReferenceFrame("g2-screen", origin=(16, 0.4), rotation=90),
        "g6-screen": ReferenceFrame("g6-screen", origin=(43.6, 15), rotation=180),
        "g10-screen": ReferenceFrame("g10-screen", origin=(8, 18.6), rotation=-90),
    }
    for display_id, frame in frames.items():
        world.add_display(SmartDisplay(display_id, Location(0, 0, frame)), zone_id="exhibition")

    world.add_visitor(Visitor("alice", Location(8, 5), dwell_time=30))
    world.add_visitor(Visitor("bob", Location(13.2, 5), dwell_time=12))
    world.add_visitor(Visitor("carol", Location(25, 13), dwell_time=50))
    world.add_visitor(Visitor("sam", Location(14.5, 6.5), dwell_time=200, role="staff"))
    return world, frames, plan
