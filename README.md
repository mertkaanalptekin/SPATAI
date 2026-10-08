# SPATAI

Semantic model for a spatial AI system: visitors move through spatial zones and named places, and zones control smart displays. Location is first-class: every position is a `Location` in a `ReferenceFrame`, and a `World` registry answers spatial queries.

## Model

| Entity | Attributes |
| --- | --- |
| `Location` | `x`, `y`, `frame` (defaults to the world frame) |
| `ReferenceFrame` | `frame_id`, `origin` (in parent coordinates), `rotation` (degrees, counter-clockwise), `parent` (`None` = world) |
| `Place` | `name`, `region` (`Circle` or `Rect`), `parent` (optional enclosing place) |
| `Visitor` | `user_id`, `position: Location`, `velocity`, `dwell_time` |
| `SpatialZone` | `zone_id`, `boundary: Rect`, `ambient_light`, `display_ids`; occupancy is derived from visitor locations |
| `SmartDisplay` | `display_id`, `position: Location`, `orientation` (degrees the screen faces), `current_media`, `volume_level`, `power_state`, `status` |
| `World` | registry of `visitors`, `displays`, `zones` and `places`, keyed by an ID unique across all four |

A `Rect` is axis-aligned in its own frame; put it in a rotated frame to rotate it. Region and radius checks include their boundary.

## Relationships

- **Visitor *enters* Spatial Zone.** Derived from location: a visitor is in the zone that `world.zone_at(visitor.position)` returns. Where zones overlap, the smallest one wins.
- **Spatial Zone *controls* Smart Display.** `world.add_display(display, zone_id=...)` or `zone.control(display)`.
- **Place *is inside* Place.** Set with `Place(..., parent=...)`. The most specific place is the most deeply nested one, then the smallest by area.
- **ReferenceFrame *is nested in* ReferenceFrame.** Set with `ReferenceFrame(..., parent=...)`. Locations convert between any two frames.

## Queries

| Function | Returns |
| --- | --- |
| `world.locate(obj_id)` | Location of a visitor or display, or the centre of a zone or place |
| `world.occupants_at(location, radius)` | Visitors within `radius` metres, nearest first |
| `world.zone_at(location)` | Containing zone, or `None` |
| `world.position_in(obj_id, frame)` | `locate(obj_id)` expressed in `frame` |
| `world.describe(location)` | `Description` with the most specific place, nearest display, distance, and direction (`front`, `behind`, `left`, `right` or `at`) relative to where the display faces |

## Rules and actions

**Rule.** If a visitor in the zone is within 2.5 m of a display it controls, and the zone has fewer than 20 occupants, set the display's `power_state` to `ON`. Run it with `evaluate_rules(world)`, which returns the displays it switched on. The rule only ever turns displays on.

**Action.** `launch_media(display)` switches `current_media` from the default loop to interactive content.

## Usage

```python
from spatai import (
    Circle, Location, Place, Rect, ReferenceFrame, SmartDisplay, SpatialZone,
    Visitor, World, evaluate_rules, launch_media,
)

world = World()
hall = ReferenceFrame("hall", origin=(20.0, 0.0), rotation=90)   # hall's +x points along world +y

world.add_zone(SpatialZone("lobby", Rect(0, 0, 10, 8, hall), ambient_light=300))
museum = world.add_place(Place("Museum", Rect(-50, -50, 50, 50)))
world.add_place(Place("Sculpture Court", Circle(Location(5, 4, hall), 2), parent=museum))
world.add_display(SmartDisplay("d1", Location(5, 4, hall), orientation=0), zone_id="lobby")
world.add_visitor(Visitor("u1", Location(6, 4, hall)))

world.zone_at(world.locate("u1")).zone_id     # "lobby"
world.position_in("u1", hall)                 # Location(x=6, y=4, frame=hall)
str(world.describe(world.locate("u1")))       # "In Sculpture Court, 1.0 m in front of d1"

for display in evaluate_rules(world):         # displays switched on
    launch_media(display)
```

## Tests

```
python3 -m unittest -v
```
