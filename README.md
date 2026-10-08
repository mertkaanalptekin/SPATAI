# SPATAI

Semantic model for a spatial AI system: visitors move through spatial zones and named places, and zones control smart displays. Location is first-class: every position is a `Location` in a `ReferenceFrame`, and a `World` registry answers spatial queries.

The repository has two parts that share one model:

- **`spatai/`**, the Python package, with `demo.py` and `visualize.py`.
- **The Spatial AI Neighborhood page** (`index.html`, `js/`, `css/`), an interactive three.js simulation. `js/spatial.js` is a JavaScript port of the Python model, and a test checks that both give the same answers. See [Web simulation](#web-simulation).

## Model

| Entity | Attributes |
| --- | --- |
| `Location` | `x`, `y`, `frame` (defaults to the world frame) |
| `ReferenceFrame` | `frame_id`, `origin` (in parent coordinates), `rotation` (degrees, counter-clockwise), `parent` (`None` = world) |
| `Place` | `name`, `region` (`Circle` or `Rect`), `parent` (optional enclosing place) |
| `Visitor` | `user_id`, `position: Location`, `velocity`, `dwell_time` |
| `SpatialZone` | `zone_id`, `boundary: Rect`, `ambient_light`, `display_ids`; occupancy is derived from visitor locations |
| `SmartDisplay` | `display_id`, `position: Location`, `orientation` (degrees the screen faces), `current_media`, `volume_level`, `power_state`, `status` |
| `World` | registry of `visitors`, `displays`, `zones` and `places`, keyed by an ID unique across all four; `add_*()` and `remove(obj_id)` |

A `Rect` is axis-aligned in its own frame; put it in a rotated frame to rotate it. Region and radius checks include their boundary, within 1e-9 m. Distances that equal within that tolerance are tied, and ties go to the smaller ID.

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

### Run the demo

From the repository root:

```
python3 demo.py
```

`demo.py` sets up a lobby zone with four named places, two displays facing different directions, and three visitors. It prints the answers to the four location questions (`locate`, `occupants_at`, `position_in` a display's frame, `describe`), then runs the power-on rule and lists which displays turned on. Each display sits at the origin of its own reference frame, so a visitor's position in that frame reads as metres ahead of the screen and metres to its left.

### In code

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

## Web simulation

The **Spatial AI Neighborhood** page shows the model as a full-window three.js scene. It is published with GitHub Pages at <https://mertkaanalptekin.github.io/SPATAI/>.

### Run it locally

ES modules must be served over HTTP; opening `index.html` from disk does not work.

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

three.js r160 loads from the jsDelivr CDN through an import map, so there is no build step.

### Same model as Python

- `js/spatial.js` ports `geometry.py`, `model.py`, `world.py` and `rules.py`. It uses the same names in camelCase, for example `occupants_at` becomes `occupantsAt`.
- `js/scene.js` builds the same scene as `demo.py`: one lobby zone, four places, two displays and alice, bob and carol.
- The page's 3D objects are views over those model records. Zone membership, the power-on rule and all four location questions go through `spatial.js`.
- The two implementations use the same arithmetic. Distances use a plain square root, and ties and cone edges use the same tolerance. As a result, the page and `python3 demo.py` give the same answers.

### Scene

| Entity | In the scene |
| --- | --- |
| **Spatial Zone** | The lobby's purple floor and outline, with a floating node. `Ambient_Light` (lux) drives its ceiling light. |
| **Place** | Labelled, semi-transparent ground regions: Main Lobby, with Entrance, Reception Desk and Gallery Corner inside it. **Places** toggles the layer. |
| **Smart Display** | A kiosk screen with a facing arrow, a ±45° "in front" wedge and a 2.5 m ring showing the rule radius. Both are coloured by the rule state. |
| **Visitor** | A walking figure. alice, bob and carol stand where `demo.py` puts them until you drag them. Visitors you add wander. |

The relationships (toggle with **Relations**):

- **Visitor _enters_ Spatial Zone**: thin lines from each visitor to its zone node.
- **Spatial Zone _controls_ Smart Display**: dashed lines from the zone node to its displays.

### Location panel

| Question | How to ask it |
| --- | --- |
| **Q1 Locate**: `locate(id)` | Click a visitor, display, zone node or place label. The panel shows the object's coordinates and frame, plus world coordinates for a display, which sits in its own frame. |
| **Q2 Occupants**: `occupants_at(loc, r)` | Click an empty spot on the ground. A ring marks the radius, which a slider adjusts, and the panel lists who is inside, with distances, or "nobody". |
| **Q3 Frame of reference**: `position_in(id, frame)` | Choose World or a display's frame. The last visitor you clicked is shown in that frame as "X m ahead, Y m left/right". The frame's axes and the two legs of that offset are drawn on the floor. |
| **Q4 Describe**: `describe(loc)` | Hover anywhere: "At Reception Desk (in Main Lobby → lobby), 8.6 m in front of welcome-screen". Typing in the text box highlights the place a description points to: "near gallery-screen", "in front of welcome-screen", "behind gallery-screen", "reception" or "bob". "In front of", "behind", "left of" and "right of" a display mean the point 1.5 m from it in that direction. |

The **Event log** also records location events, such as "alice entered Reception Desk", "bob left Gallery Corner (back in Main Lobby)", "bob is now in front of gallery-screen" and "bob moved away from gallery-screen". A display relationship is tracked only within 4 m of the nearest display. A change is logged once it has held for 0.5 s.

### Rule and action

The rule above is evaluated every frame, and the **Rule engine** panel shows each condition live. A green ring means the rule is satisfied. A red ring means a visitor is in range but the zone is at capacity. To keep the demo readable, a display returns to `OFF` 3 s after the rule stops matching, and its `Status` shows "Cooling down" in the meantime. **`Launch_Media()`** only works on a display that is ON.

### Controls

- **Visitor**: `＋ Visitor` spawns at the Entrance, `＋10 Crowd` adds ten wandering visitors to the selected zone (default lobby), and `− Visitor` removes the selected or most recent visitor.
- **Smart Display**: `Launch_Media()` and `Default loop`.
- **View**: toggles for Relations, Velocity, Labels and Places, and a camera reset.
- **Simulation**: pause or resume (Space), and reset to the `demo.py` scene.
- **In the scene**: click to inspect or probe, hover to describe, drag visitors, right-drag to pan, and scroll to zoom.

## Tests

```
python3 -m unittest -v
```

This runs the Python tests. When Node.js is installed, it also runs `tests/test_js_parity.py`. That test sends the same queries through Python and through `js/spatial.js` (`tests/js/parity.mjs`) and fails on any difference. The queries cover every 0.5 m point across and around the lobby, the Reception Desk circle, nested rotated frames and the rule. The parity test also runs the Node tests for the page-only text lookup:

```
node --test tests/js/spatial.test.mjs
```
