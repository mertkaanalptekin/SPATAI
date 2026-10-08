"""Walk through the SPATAI location queries on a small lobby scene.

Run from the repository root:  python3 demo.py
"""

from spatai import (
    Circle,
    Location,
    Place,
    Rect,
    ReferenceFrame,
    SmartDisplay,
    SpatialZone,
    Visitor,
    World,
    evaluate_rules,
)


def build_scene() -> tuple[World, dict[str, ReferenceFrame]]:
    """A 20 m x 12 m lobby with four places, two displays and three visitors.

    Each display sits at the origin of its own frame, facing that frame's +x
    axis, so a position in a display's frame reads as (metres ahead, metres left).
    """
    world = World()
    world.add_zone(SpatialZone("lobby", Rect(0, 0, 20, 12), ambient_light=320))

    main = world.add_place(Place("Main Lobby", Rect(0, 0, 20, 12)))
    world.add_place(Place("Entrance", Rect(0, 4, 1.5, 8), parent=main))
    world.add_place(Place("Reception Desk", Circle(Location(10, 3), 1.5), parent=main))
    world.add_place(Place("Gallery Corner", Rect(13, 7, 20, 12), parent=main))

    frames = {
        # On the west wall, facing east into the lobby.
        "welcome-screen": ReferenceFrame("welcome-screen", origin=(2, 6), rotation=0),
        # On the north wall of the gallery corner, facing south.
        "gallery-screen": ReferenceFrame("gallery-screen", origin=(16, 11), rotation=-90),
    }
    for display_id, frame in frames.items():
        world.add_display(SmartDisplay(display_id, Location(0, 0, frame)), zone_id="lobby")

    world.add_visitor(Visitor("alice", Location(3.5, 6.5), dwell_time=12))
    world.add_visitor(Visitor("bob", Location(14, 8), dwell_time=40))
    world.add_visitor(Visitor("carol", Location(10.5, 3.5), dwell_time=95))
    return world, frames


def fmt(loc: Location) -> str:
    return f"({loc.x:.2f}, {loc.y:.2f}) in frame '{loc.frame.frame_id}'"


def heading(title: str) -> None:
    print(f"\n{title}\n{'-' * len(title)}")


def main() -> None:
    world, frames = build_scene()

    heading("1. Where is it?  locate(obj_id)")
    for obj_id in ["bob", "gallery-screen", "Reception Desk", "lobby"]:
        print(f"  {obj_id:<16} -> {fmt(world.locate(obj_id).to_world())}")

    heading("2. Who is here?  occupants_at(location, radius)")
    for x, y, r in [(3, 6, 2.0), (10, 3, 1.0), (18, 2, 3.0)]:
        names = [v.user_id for v in world.occupants_at(Location(x, y), r)] or ["(nobody)"]
        print(f"  within {r:.1f} m of ({x}, {y}): {', '.join(names)}")

    heading("3. Where is a visitor relative to a display?  position_in(obj_id, frame)")
    for visitor_id, display_id in [("bob", "gallery-screen"), ("alice", "welcome-screen")]:
        p = world.position_in(visitor_id, frames[display_id])
        side = "left" if p.y >= 0 else "right"
        print(f"  {visitor_id} in {display_id}'s frame: {fmt(p)}")
        print(f"    = {p.x:.2f} m ahead of the screen, {abs(p.y):.2f} m to its {side}")

    heading("4. What is this coordinate?  describe(location)")
    for x, y in [(10.2, 3.4), (17, 9), (0.5, 6), (25, 25)]:
        print(f"  ({x}, {y}) -> {world.describe(Location(x, y))}")

    heading("Power-on rule  evaluate_rules(world)")
    print(f"  lobby occupancy: {world.occupancy('lobby')}")
    switched = {d.display_id for d in evaluate_rules(world)}
    for display_id, display in world.displays.items():
        nearby = [v.user_id for v in world.occupants_at(world.locate(display_id), 2.5)]
        state = "turned ON" if display_id in switched else f"stayed {display.power_state.value}"
        print(f"  {display_id:<15} {state:<12} visitors within 2.5 m: {', '.join(nearby) or 'none'}")


if __name__ == "__main__":
    main()
