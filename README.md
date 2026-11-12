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

## Proximity rules

[docs/PROXIMITY_RULES.md](docs/PROXIMITY_RULES.md) specifies two rules (P1–P13). Each gallery holds one artwork: the exhibits l1–l3 in Galleries 3, 6 and 9, and an installation in each of the other seven.

- **Personal space.** When two agents are closer than **1 m** and at least one of them is closing in, the one closing in faster stops; the other keeps wandering. On a tie, the agent whose ID sorts later stops. If neither is closing in, they are already parting, so nobody stops. A stopped agent walks on once it is clear. If it is still blocked after 2 s, it picks a new destination that leads away.
- **Artwork proximity.** When a visitor (not staff) comes closer than **1 m** to an artwork, the nearest free staff member, by walking distance, comes over. They stop 1.3 m from the visitor, outside the visitor's personal space. The visitor then steps back to 1.6 m from the artwork, and the staff member returns to their post. If the visitor leaves on their own first, the call is cancelled. If no staff member is free, the call waits, and the most urgent breach is served first.

The rules are pure functions in `spatai/proximity.py`, ported to `js/proximity.js`. `ArtworkGuard` in `js/proximity.js` runs the staff calls in the page.

## Movement prepositions

[docs/MOVEMENT_PREPOSITIONS.md](docs/MOVEMENT_PREPOSITIONS.md) specifies how each agent's movement is described relative to the screens, artworks and other agents around it (M1–M12), and the simplified interface (U1–U6).

- Positions are sampled 4 times a second and judged over the last **3 s** of the agent's own track. Only the agent's own movement counts.
- **toward** (→, aqua): at least 40 % of the path, and 0.3 m, closes the distance to the entity.
- **away from** (←, orange): at least 40 % of the path, and 0.3 m, opens it.
- **around** (↻, violet): the agent sweeps at least 45° around the entity while turning the same way, and the move is mostly tangential. The log says clockwise or anticlockwise.
- Reach: screens 6 m, artworks 5 m, other agents 4 m. An agent can hold several relations at once; its primary one (around, then toward, then away; nearest first) is shown on its label.
- Visitors on an interest route (EXPLORATION.md E9) walk part of a circle around each artwork they stop at, so *around* happens in normal running.

`classify()` is a pure function in `spatai/movement.py`, ported to `js/movement.js`. `MovementTracker` in `js/movement.js` samples the agents and emits events such as "bob walks toward g2-screen" or "carol walks around Installation g8 (anticlockwise)", once a relation has held for 0.5 s and at most once per 6 s.

## Exploring visitors

[docs/EXPLORATION.md](docs/EXPLORATION.md) (E1–E15) takes the building plan away from visitors. Staff still know it. The page starts with six visitors arriving at the Entrance, one every 3 s; the spec's agents (alice, bob, carol and sam) stay where the spec puts them until you drag them.

- **Senses.** A visitor looks 4 times a second through a vision cone 6 m long and 120° wide, plus a 1 m near sense. Walls block sight; door openings do not. While standing, it looks around.
- **Its own map.** The building is cut into 0.5 m cells. The visitor records the cells it has seen, the rooms, doors, artworks and screens it has found (with how long each was in view), and its trail. It plans only through cells it has seen, and keeps 1.2 m from artworks it knows about.
- **Run 1: explore.** It walks from one frontier between known and unknown space to the next, preferring the way it faces, without stopping, and looks around only after discovering a room. It keeps going until nothing is left to explore. Then it walks to the Checkout, and through the Reset Passage back to the Entrance. At 1 m/s, a full map takes about four minutes.
- **Run 2 and later: interests.** It picks 3 interests: the entities it has spotted, scored by time in view × its own taste × 0.5 for each earlier visit. It visits them in the order that is shortest on its own map, then leaves through the Checkout. At an artwork it walks part of a circle around it; at a screen it stands in front.

`spatai/exploration.py` holds the pure functions (sight, map, frontiers, planning, interests, route order), ported to `js/exploration.js`. `js/explorer.js` runs a visitor's phases and runs in the page.

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

### Interface

- **Toolbar** (one row): **Add ▾** (Visitor at the Entrance, Crowd of 10, Staff member, Remove), **Media ▾** (`Launch_Media()` on screens that are ON, Default loop), **View ▾** (Labels, Rooms and plan symbols, Movement lines for everyone, Personal-space rings, Relations, Vision cones for everyone, Velocity arrows, Reset camera), speed (×1, ×2, ×4), pause (Space) and reset.
- **Drawer** on the right, with tabs, collapsible to its tab strip:
  - **Rules**: the two proximity rules and the power-on rule, with their live state;
  - **Location**: the four location questions;
  - **Metrics**: the three distance metrics;
  - **Scene**: zones, screens, rooms and artworks;
  - **Log**: the global event log, filtered by Rules, Proximity, Location, Movement (off by default), Metrics and Exploration.
- **Windows**: click an agent, a screen or the zone node to open its window (up to three; drag by the header, Esc closes). An agent's window shows its current movement relations as chips, its exploration (run, phase, share of the building seen, finds, and the interests on a route), its own **Activity** log (movement, discoveries, rooms entered, proximity stops, staff calls, rule triggers) and a collapsed **Details** section with *Finish exploring* and *Forget the map*. The visitor in the most recently opened window has its map drawn on the floor: fog where it has not looked, its trail, ticked doors, ringed finds and numbered stops, with its vision cone.
- **Status bar**: agents, screens on, agents stopped, open artwork calls, and visitors exploring or on a route. **?** opens the controls and legend.
- **In the scene**: labels are small text; an agent's label carries its primary movement glyph, for example "bob → g2-screen". Movement lines (solid arrow toward, dashed away, an arc around) are drawn for agents whose window is open, or for everyone from **View**. Artworks are unlabelled dots until hovered. Personal-space rings show only on stopped agents, guard rings and screen cones stay faint until something happens, and the zone node and relationship lines appear only with **Relations**.

### Scene

| Entity | In the scene |
| --- | --- |
| **Spatial Zone** | The exhibition's floor and outline. `Ambient_Light` (lux) drives its ceiling light. With **Relations**, a floating node and lines show *Visitor enters Spatial Zone* and *Spatial Zone controls Smart Display*. |
| **Place** | Labelled ground regions: the ten galleries, Entrance, Checkout, the corridor, the reset passage and the exhibits l1–l3. Partition walls stand on every room boundary, with gaps at the doors. Each forward door carries a small check-valve glyph (▸\|), and the shortcuts are tagged S1–S3. |
| **Smart Display** | Four kiosk screens (`g1-screen`, `g2-screen`, `g6-screen`, `g10-screen`) with a faint "in front" wedge and 2.5 m ring, which brighten while a visitor is in range. The label's dot shows ON or OFF. |
| **Visitor** | A walking figure. alice, bob, carol and sam (staff) stand where the spec puts them until you drag them; added visitors wander. A stopped agent shows its 0.5 m personal-space ring and ⏸. |
| **Artwork** | One per gallery, with a faint 1 m guard ring that turns red while a visitor is too close. A dashed amber line joins a dispatched staff member to their visitor. |

### Metrics tab

Compares the three metrics between two locations, **A** and **B**. Pick them in the tab, or click an agent (A) or the ground (B); ⇄ swaps them. A **visitor / staff** switch and a **strict valve** switch change the rules. The tab shows a table of A → B and B → A, raw and normalised, and a comparison chart. Further sections open on demand: **Every agent → B** (the discrepancy map, the agents inferred near B, and the current discrepancies), **Show in the scene** (the Euclidean, d_seq and d_L overlays, and the Case II and Case III figures) and **Axioms**.

### Location tab

| Question | How to ask it |
| --- | --- |
| **Q1 Locate**: `locate(id)` | Click a visitor, display, zone node or place label. |
| **Q2 Occupants**: `occupants_at(loc, r)` | Click an empty spot on the ground. A ring marks the radius, which a slider adjusts. |
| **Q3 Frame of reference**: `position_in(id, frame)` | Choose World or a display's frame; the last visitor you clicked is shown in it. |
| **Q4 Describe**: `describe(loc)` | Hover anywhere, or type "near g6-screen", "in front of g1-screen", "gallery 7", "exhibit l2" or "bob". |

### Rules

The power-on rule is evaluated every frame. To keep the demo readable, a display returns to `OFF` 3 s after the rule stops matching. `Launch_Media()` only works on a display that is ON. The proximity rules log "bob stops: 0.97 m from carol (personal space)", "carol is 0.7 m from Installation g8 → sam dispatched" and so on; each event also appears in the windows of the agents involved.

## Tests

```
python3 -m unittest -v
```

This runs the Python tests. When Node.js is installed, it also runs `tests/test_js_parity.py`, which sends the same queries through Python and the JS ports and fails on any difference: the spatial model (`tests/js/parity.mjs`), the exhibition and metrics, 40 random proximity scenarios, the movement classifier (`tests/js/movement_parity.mjs`), and random looks, map queries, interests and routes (`tests/js/exploration_parity.mjs`). `tests/test_metrics.py`, `tests/test_proximity.py`, `tests/test_movement.py` and `tests/test_exploration.py` test the specs, keyed to their requirement IDs. The parity test also runs the Node tests for the page-only code:

```
node --test tests/js/spatial.test.mjs tests/js/proximity.test.mjs tests/js/movement.test.mjs
```
