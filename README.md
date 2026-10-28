# SPATAI

Semantic model for a spatial AI system: visitors move through spatial zones and named places, and zones control smart displays. Location is first-class: every position is a `Location` in a `ReferenceFrame`, and a `World` registry answers spatial queries.

The repository has two parts that share one model:

- **`spatai/`**, the Python package, with `demo.py` and `visualize.py`. `spatai/exhibition.py` and `spatai/metrics.py` add a 10-hall exhibition and two alternative distance metrics, specified in [docs/SIMULATION_METRICS.md](docs/SIMULATION_METRICS.md). See [Alternative distance metrics](#alternative-distance-metrics).
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

## Alternative distance metrics

[docs/SIMULATION_METRICS.md](docs/SIMULATION_METRICS.md) is the instruction set for this part: it restates the brief and fixes every design choice as numbered requirements (R1–R24), which the code and tests cite.

**Floor plan** (`spatai/exhibition.py`). A 44 × 19 m building folded like a snake: Gallery 1–5 run west to east, a central corridor carries the fold, and Gallery 6–10 run back east to west to the Checkout. Gallery 1 and Gallery 2 share a partition wall. Doors are gaps in the walls. There are three shortcuts: **S1**, a staff-only emergency door between Gallery 1 and 2; **S2**, a one-way express corridor from Gallery 4 to 7; and **S3**, a one-way return corridor from Gallery 8 to 3. The mandatory exhibits *L* are l1 in Gallery 3, l2 in Gallery 6 and l3 in Gallery 9.

**Metrics** (`spatai/metrics.py`):

| Metric | What it measures | Unit |
| --- | --- | --- |
| Euclidean $d_E$ | Straight line, ignoring walls | m |
| Sequence $d_{\text{seq}}$ (Case II) | Shortest path in the directed valve graph: forward transitions weigh 1, reverse moves are blocked, and the Exit/Reset loop back to Gallery 1 weighs 0. Staff may also use S1. A strict mode removes the reset, so reverse trips become ∞. | steps |
| Task-constrained $d_L$ (Case III) | Shortest walk through the doors that visits l1, l2 and l3, in any order: an elastic band pinned to *L* | m |

What the tests show:

- $d_{\text{seq}}(g_1, g_2) = 1$ but $d_{\text{seq}}(g_2, g_1) = 7$, looping through S2 and the Exit/Reset. In strict mode it is ∞; for staff it is 1.
- $d_L(x, x) = 96.7$ m at the Entrance $x$, while $d_E(x, x) = 0$.
- $d_L$ is symmetric with a positive self-distance. It does **not** satisfy the partial-metric axiom $p(a,a) \le p(a,b)$; `axiom_report()` reports that rather than assuming it.

**Inference.** For comparison, each metric is min–max normalised over all pairs of hall centres (plus Entrance and Checkout). A visitor is inferred *near* a target under a metric at ≤ 0.2 and *far* at ≥ 0.5. A **discrepancy** is near by one metric and far by another. In the starting scene, bob stands in Gallery 2 beside the shared wall: 5.3 m from Gallery 1's centre, but 7 steps away by $d_{\text{seq}}$. sam, who is staff, is 1 step away.

```python
from spatai.exhibition import build_exhibition
from spatai import metrics as M

world, frames, plan = build_exhibition()
g1, g2 = plan.centre("Gallery 1"), plan.centre("Gallery 2")
M.seq(plan, g2, g1).value                    # 7.0
M.seq(plan, g2, g1, strict=True).value       # inf
x = plan.centre("Entrance")
M.task(plan, x, x).value                     # 96.72...
ranges = M.reference_ranges(plan)
M.discrepancies(plan, world, g1, ranges)     # bob: near by euclidean, far by seq, ...
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
- `js/exhibition.js` and `js/metrics.js` port `exhibition.py` and `metrics.py`, and the page uses that exhibition. (`js/scene.js` still builds `demo.py`'s lobby for the parity test.)
- The page's 3D objects are views over those model records. Zone membership, the power-on rule, the four location questions and the three metrics all go through these modules.
- The two implementations use the same arithmetic. Distances use a plain square root, shortest paths pop the same smallest (distance, node) entry, and ties and cone edges use the same tolerance. As a result, the page and Python give the same answers.

### Scene

| Entity | In the scene |
| --- | --- |
| **Spatial Zone** | The exhibition's purple floor and outline, with a floating node. `Ambient_Light` (lux) drives its ceiling light. |
| **Place** | Labelled, semi-transparent ground regions: the ten galleries, Entrance, Checkout, the corridor, the reset passage and the exhibits l1–l3. Partition walls stand on every room boundary, with gaps at the doors. Each forward door carries a check-valve glyph (▶\|) pointing the allowed way, and the S1–S3 shortcuts are drawn and labelled. **Places** toggles the layer. |
| **Smart Display** | Four kiosk screens (`g1-screen`, `g2-screen`, `g6-screen`, `g10-screen`) with a facing arrow, a ±45° "in front" wedge and a 2.5 m ring showing the rule radius. Both are coloured by the rule state. |
| **Visitor** | A walking figure. alice, bob, carol and sam (staff) stand where the spec puts them until you drag them. Visitors you add wander from room to room through the doors. |

The relationships (toggle with **Relations**):

- **Visitor _enters_ Spatial Zone**: thin lines from each visitor to its zone node.
- **Spatial Zone _controls_ Smart Display**: dashed lines from the zone node to its displays.

### Metrics tab

The left panel has two tabs. **Metrics** compares the three metrics between two locations, **A** and **B**:

- **Pickers** for A and B: halls, Entrance, Checkout, corridor, exhibits and agents. Click an agent to make it A, or click the ground to make that spot B. Use ⇄ to swap them.
- A **visitor / staff** switch, and a **strict valve** switch that removes the Exit/Reset loop.
- A **table** of each metric's A → B and B → A values, raw and normalised, with the d_seq route and the d_L visiting order.
- A **comparison chart**: grouped bars per metric, with solid bars for A → B and hatched bars for B → A, on the normalised scale and labelled with raw values. It shows d_seq's asymmetry, and, with A = B, d_L's non-zero self-distance.
- A **discrepancy map**: every agent's normalised Euclidean distance to B against its d_seq (●) and d_L (■) distance. The near/far corners are shaded, and agents in them are named.
- **Inferred near B**: the agents near B under each metric.
- **Far by one metric, near by another**: every current discrepancy. Each new one is also written to the event log once it has held for 0.5 s, for example "alice: near Gallery 1 by Euclidean (5.0 m) but far by d_seq (7 steps)".
- **Scene overlays**:
  - the Euclidean line, the d_seq route through the doors and the d_L band through l1–l3;
  - **Case II**: a tight arc from g1 to g2 labelled 1, and a large loop from g2 back to g1 around the building, labelled 7 (∞ in strict mode);
  - **Case III**: the petal self-loop at the Entrance x through l1, l2 and l3, labelled d_L(x, x) = 96.7 m > 0.
- An **axiom summary** for both metrics.

Each tab shows only its own overlays. While Metrics is open, the Rule engine panel shrinks to its event log.

### Location panel

| Question | How to ask it |
| --- | --- |
| **Q1 Locate**: `locate(id)` | Click a visitor, display, zone node or place label. The panel shows the object's coordinates and frame, plus world coordinates for a display, which sits in its own frame. |
| **Q2 Occupants**: `occupants_at(loc, r)` | Click an empty spot on the ground. A ring marks the radius, which a slider adjusts, and the panel lists who is inside, with distances, or "nobody". |
| **Q3 Frame of reference**: `position_in(id, frame)` | Choose World or a display's frame. The last visitor you clicked is shown in that frame as "X m ahead, Y m left/right". The frame's axes and the two legs of that offset are drawn on the floor. |
| **Q4 Describe**: `describe(loc)` | Hover anywhere: "At Gallery 3 (in Exhibition → exhibition), 11.9 m right of g2-screen". Typing in the text box highlights the place a description points to: "near g6-screen", "in front of g1-screen", "gallery 7", "exhibit l2" or "bob". "In front of", "behind", "left of" and "right of" a display mean the point 1.5 m from it in that direction. |

The **Event log** also records location events, such as "alice entered Gallery 2", "carol left Exhibit l1 (back in Gallery 3)", "bob is now in front of g2-screen" and "bob moved away from g2-screen". A display relationship is tracked only within 4 m of the nearest display. A change is logged once it has held for 0.5 s.

### Rule and action

The rule above is evaluated every frame, and the **Rule engine** panel shows each condition live. A green ring means the rule is satisfied. A red ring means a visitor is in range but the zone is at capacity. To keep the demo readable, a display returns to `OFF` 3 s after the rule stops matching, and its `Status` shows "Cooling down" in the meantime. **`Launch_Media()`** only works on a display that is ON.

### Controls

- **Visitor**: `＋ Visitor` spawns at the Entrance, `＋10 Crowd` adds ten wandering visitors to the selected zone (default exhibition), and `− Visitor` removes the selected or most recent visitor.
- **Smart Display**: `Launch_Media()` and `Default loop`.
- **View**: toggles for Relations, Velocity, Labels and Places, and a camera reset.
- **Simulation**: pause or resume (Space), and reset to the spec's starting scene.
- **In the scene**: click to inspect or probe, hover to describe, drag visitors, right-drag to pan, and scroll to zoom.

## Tests

```
python3 -m unittest -v
```

This runs the Python tests. When Node.js is installed, it also runs `tests/test_js_parity.py`. That test sends the same queries through Python and through `js/spatial.js` (`tests/js/parity.mjs`) and fails on any difference. The queries cover every 0.5 m point across and around the lobby, the Reception Desk circle, nested rotated frames and the rule. `tests/test_metrics.py` covers the floor plan and the metrics, one test per spec requirement. The parity test also compares the exhibition, every metric over all reference pairs for both roles and both valve modes, a 2 m grid of points, the normalisation ranges, the axiom report and the inference results. It also runs the Node tests for the page-only text lookup:

```
node --test tests/js/spatial.test.mjs
```
