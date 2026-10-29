# Simulation spec: alternative distance metrics

This file is the instruction set for the updated Spatial AI Neighborhood simulation. It restates the brief, then fixes every design choice the brief leaves open, so the Python model (`spatai/`), its JavaScript port (`js/`) and the page are built from it. Requirements carry IDs (**R1**, **R2**, …). Tests and code comments cite them.

## 1. Brief (as given)

Add two methods of measurement to the simulation. The simulation must compute and show the distance between two locations, and the occupancy inferred from each metric. It must:

- visualise these distances and draw a graphic comparison between them;
- identify cases where an agent is far from a location under one metric but potentially close to it under another.

### Case II: Linear Exhibition / IKEA Sequence ($d_{\text{seq}}$, quasimetric)

- **Spatial geometry (planimetric adjacency).** A folded snake/meander plan, like an IKEA showroom or an enfilade gallery. Gallery 1 ($g_1$) and Gallery 2 ($g_2$) share a physical partition wall, and an emergency shortcut door between them exists only for staff.
- **Topological deformation (directed valve / diode graph).** Forward transitions ($g_1 \to g_2 \to g_3 \to g_4$) are plotted as low-resistance solid vectors with unit weight ($w = 1$). Reverse movement ($g_2 \to g_1$) is blocked by a topological valve (check-valve symbol). This forces the reverse path to loop through the whole sequence ($g_2 \to g_3 \to g_4 \to \text{Exit/Reset} \to g_1$), with weight $w = 3$ (or $\infty$).
- **Visualising the axiom failure.** Plot two asymmetric half-circles, or directional arrows of unequal arc radius, between $g_1$ and $g_2$. A tight inner arc shows $d(g_1, g_2) = 1$ and a massive outer loop shows $d(g_2, g_1) = 3$, visually proving $d(x,y) \neq d(y,x)$.

### Case III: Task-Constrained Grocery Store Trajectory ($d_L$, partial metric)

- **Spatial geometry (aisle grid + waypoint field).** An orthogonal store layout with Entrance ($x$), Checkout ($y$) and mandatory product nodes $L = \{l_1, l_2, l_3\}$ scattered across different aisles.
- **Topological deformation (mandatory detour / elastic string tension).** Any trajectory between two points behaves like an elastic band pinned to the required items $L$. Even the distance from the Entrance to itself ($x \to x$) pulls the trajectory into the store interior: it wraps around the convex hull / Hamiltonian tour of $L$ before returning to $x$.
- **Visualising the axiom failure.** Draw a non-zero self-loop (petal diagram) anchored at node $x$. It stretches across the plan to capture $l_1, l_2, l_3$ and returns to $x$, annotated $d_L(x, x) > 0$ to highlight the failure of the identity of indiscernibles (reflexivity).

### Space

To meet both cases, the exhibition space becomes 10 distinct exhibition halls, with corridors connecting the halls and at most 3 shortcuts.

## 2. Floor plan (R1–R6)

All coordinates are metres in the world frame. +x points east and +y points north.

- **R1. Building.** One spatial zone, `exhibition`, `Rect(0, 0, 44, 19)`. The rule's occupancy check (fewer than 20) applies to it.
- **R2. Rooms.** Each room is an axis-aligned rectangle, registered as a `Place` whose parent is `Exhibition` (the whole building).

  | Room | Rect (x0, y0, x1, y1) | Role |
  | --- | --- | --- |
  | Entrance | 0, 0, 4, 8 | node $x$ of Case III; start of the sequence |
  | Gallery 1 … Gallery 5 | south row, 8 m each: x 4–12, 12–20, 20–28, 28–36, 36–44, y 0–8 | $g_1 … g_5$, numbered west to east |
  | Central Corridor | 4, 8, 44, 11 | carries the fold and the shortcut corridors; not a hall |
  | Gallery 6 … Gallery 10 | north row, 8 m each: x 36–44, 28–36, 20–28, 12–20, 4–12, y 11–19 | $g_6 … g_{10}$, numbered east to west, so the plan folds back on itself |
  | Checkout | 0, 11, 4, 19 | node $y$ of Case III; Exit/Reset of Case II |
  | Reset Passage | 0, 8, 4, 11 | walkway from Checkout back to Entrance |

- **R3. Partition walls.** Walls stand on every room boundary except at doors. Gallery 1 and Gallery 2 share the wall at x = 12.
- **R4. Doors.** A door is a 1.2 m gap at a point on a shared wall. It is public or staff-only.

  | Door | Point | Rooms | Use |
  | --- | --- | --- | --- |
  | `entry` | (4, 4) | Entrance – Gallery 1 | public |
  | `g1-g2` | (12, 2.5) | Gallery 1 – Gallery 2 | public, carries the valve |
  | `staff-g1-g2` | (12, 6) | Gallery 1 – Gallery 2 | **staff only**, the emergency door |
  | `g2-g3`, `g3-g4`, `g4-g5` | (20, 4), (28, 4), (36, 4) | consecutive south halls | public |
  | `g5-cor`, `cor-g6` | (40, 8), (40, 11) | Gallery 5 – Corridor – Gallery 6 | public, the fold |
  | `g6-g7`, `g7-g8`, `g8-g9`, `g9-g10` | (36, 15), (28, 15), (20, 15), (12, 15) | consecutive north halls | public |
  | `exit` | (4, 15) | Gallery 10 – Checkout | public |
  | `reset-n`, `reset-s` | (2, 11), (2, 8) | Checkout – Reset Passage – Entrance | public |
  | `g4-cor`, `cor-g7` | (32, 8), (32, 11) | Gallery 4 – Corridor – Gallery 7 | public, shortcut S2 |
  | `g8-cor`, `cor-g3` | (24, 11), (24, 8) | Gallery 8 – Corridor – Gallery 3 | public, shortcut S3 |

- **R5. Shortcuts (exactly 3, so at most 3 as required).**
  - **S1, staff emergency door** Gallery 1 ↔ Gallery 2, through `staff-g1-g2`. Staff only, both directions, w = 1.
  - **S2, express corridor** Gallery 4 → Gallery 7, one way, w = 1. It skips $g_5, g_6$.
  - **S3, return corridor** Gallery 8 → Gallery 3, one way, w = 1. This is the only public backward link, so it shows that a valve can have an exception without restoring symmetry.
- **R6. Exhibits $L$.** Three mandatory exhibits, each in a different hall and registered as a 0.6 m circular `Place` inside its hall: $l_1$ in Gallery 3 at (24, 2), $l_2$ in Gallery 6 at (41, 17), $l_3$ in Gallery 9 at (16, 17).

## 3. Metrics (R7–R12)

Each metric takes two locations, `a` (from) and `b` (to), and an agent role (`visitor` or `staff`).

- **R7. Euclidean $d_E$** (the planimetric baseline): the straight-line distance in metres, ignoring walls. It is the existing `Location.distance_to`.
- **R8. Walking distance $W$** (support metric, not compared on its own): the shortest walk in metres through rooms and doors, ignoring the one-way rules. Rooms are convex, so inside a room the walk is a straight segment. Staff doors count only for staff. A location outside every room is unreachable ($\infty$).
- **R9. Sequence quasimetric $d_{\text{seq}}$** (Case II): the shortest weighted path in a directed graph.
  - *Nodes:* Entrance, $g_1 … g_{10}$, Exit (= Checkout).
  - *Edges, w = 1:* Entrance → $g_1$; $g_i \to g_{i+1}$ for i = 1…9; $g_{10}$ → Exit; S2; S3; and, for staff only, S1 in both directions.
  - *Reset edges, w = 0:* Exit → $g_1$ and Exit → Entrance. This reproduces the brief's weight: for its four halls, $g_2 \to g_3 \to g_4 \to \text{Exit/Reset} \to g_1$ gives 1 + 1 + 1 + 0 = 3.
  - *Locating a point:* a location maps to its room's node. Reset Passage maps to Exit. A point in the Central Corridor maps to the nearest hall centre, and the UI says so.
  - *Unit:* steps (hall transitions).
  - *Strict valve mode* (the brief's "or $\infty$") removes the reset edges. Reverse movement then has no path, and $d_{\text{seq}} = \infty$.
- **R10. Task-constrained $d_L$** (Case III): the shortest walk from `a` to `b` that visits every exhibit in $L$, in any order (the elastic band pinned to $L$):
  $d_L(a, b) = \min_{\sigma} \big[ W(a, l_{\sigma_1}) + W(l_{\sigma_1}, l_{\sigma_2}) + W(l_{\sigma_2}, l_{\sigma_3}) + W(l_{\sigma_3}, b) \big]$, over the 6 orders σ. The unit is metres. The result returns the order and the polyline.
- **R11. Axiom facts the tests must show:**
  - $d_{\text{seq}}(g_1, g_2) = 1$ and $d_{\text{seq}}(g_2, g_1) = 7$: $g_2 \to g_3 \to g_4 \xrightarrow{S2} g_7 \to g_8 \to g_9 \to g_{10} \to \text{Exit} \xrightarrow{0} g_1$. So $d(x,y) \neq d(y,x)$.
  - In strict mode $d_{\text{seq}}(g_2, g_1) = \infty$. For staff it is 1, through S1.
  - $d_{\text{seq}}$ satisfies $d(a, a) = 0$ and the triangle inequality on all node triples.
  - $d_L(x, x) > 0$ while $d_E(x, x) = 0$, so the identity of indiscernibles fails. $d_L$ is symmetric.
  - Being a *partial metric* also requires the small-self-distance axiom $p(a,a) \le p(a,b)$. The pinned-band definition does not guarantee it, so the code reports whether it holds rather than assuming it.
- **R12. Normalisation, so metrics with different units can be compared.**
  - For each metric $m$, take its minimum and maximum over the reference set: all ordered pairs (self pairs included) of the representative points of Entrance, $g_1 … g_{10}$ and Checkout, as a visitor, with resets on, ignoring $\infty$.
  - The normalised distance is $\hat d_m = (d_m - \min_m) / (\max_m - \min_m)$, clipped to [0, 1]. $\infty$ maps to 1 and is labelled ∞.

## 4. Inference (R13–R14)

- **R13. Occupancy per metric.** For a target location `b`, visitor `v` is inferred near `b` under metric $m$ when $\hat d_m(v \to b) \le$ **NEAR = 0.2**. Direction matters for $d_{\text{seq}}$, and it is always measured *from the visitor to the target*.
- **R14. Discrepancy.** Visitor `v` shows a discrepancy for target `b` when one metric says near ($\hat d \le 0.2$) and another says far ($\hat d \ge$ **FAR = 0.5**). The report names both metrics, with raw and normalised values. The motivating case is a visitor standing in $g_2$ beside the shared wall, aiming for $g_1$: near by $d_E$ (about 1 m) but far by $d_{\text{seq}}$ (7 steps), unless the visitor is staff.

## 5. Page (R15–R22)

- **R15. Scene.** The page uses the exhibition floor plan instead of the lobby. Floors and walls are drawn with door gaps, and every room is a labelled Place, so Places, Q1–Q4 and the rule keep working.
  - *Displays* (each at the origin of its own frame, as before): `g1-screen` at (8, 0.4) facing 90° (north), `g2-screen` at (16, 0.4) facing 90°, `g6-screen` at (43.6, 15) facing 180° (west), `g10-screen` at (8, 18.6) facing −90° (south).
  - *Agents:* alice in Gallery 1 at (8, 5); bob in Gallery 2 at (13.2, 5), 1.2 m from the shared wall; carol in Gallery 8 at (25, 13); and sam, **staff**, in Gallery 2 at (14.5, 6.5). Visitors added later wander along walking paths through the doors.
- **R16. Valves.** Each forward door carries a check-valve glyph (an arrow against a bar) pointing in the allowed direction. The staff door is dashed and labelled "staff". S2 and S3 are drawn as one-way corridor arrows.
- **R17. Metrics tab** (next to Location in the left panel):
  - pickers for **A** (from) and **B** (to), listing halls, Entrance, Checkout, exhibits and agents, with a swap button;
  - a *role* switch (visitor / staff) and a *strict valve* switch;
  - for each metric, the raw $d(A \to B)$ and $d(B \to A)$ and the normalised values.
- **R18. Comparison chart.** A grouped bar chart with one group per metric and two bars per group (A → B and B → A), on the normalised scale, with raw values as labels. The bars make the asymmetry of $d_{\text{seq}}$ and the non-zero self-distance of $d_L$ (when A = B) visible at a glance.
- **R19. Discrepancy map.** A scatter with one point per agent: x is $\hat d_E$ to B, y is $\hat d_{\text{seq}}$ (one mark) and $\hat d_L$ (another mark) to B. The near/far corners are shaded, and points in a discrepancy corner are labelled.
- **R20. Paths in the scene** for the selected A → B, one colour per metric: a straight line for $d_E$, directed hall-to-hall arrows through the doors used for $d_{\text{seq}}$, and the pinned elastic band through $L$ for $d_L$. Each has its own checkbox.
- **R21. Case overlays** (toggles):
  - *Case II:* the tight inner arc $g_1 \to g_2$ labelled $d = 1$ and the large outer loop $g_2 \to g_1$ around the building labelled with the current value (7, or ∞ in strict mode);
  - *Case III:* the petal self-loop at Entrance $x$ through $l_1, l_2, l_3$, labelled $d_L(x,x) = … > 0$.
- **R22. Inference in the UI and log.** The Metrics tab lists the agents inferred near B under each metric (R13), and every current discrepancy (R14). The Event log records a discrepancy when it starts, for example "bob: near Gallery 1 by Euclidean (1.2 m) but far by d_seq (7 steps)", using the same 0.5 s settle as the other location events.

## 6. Parity and tests (R23–R24)

- **R23.** The Python module is the reference. The JavaScript port gives the same numbers: `tests/test_js_parity.py` compares every metric over the reference set and a grid of points, for both roles and both valve modes.
- **R24. Acceptance checks:**
  - unit tests for every fact in R5, R9 and R11–R14;
  - the parity test;
  - a browser run checking R15–R22 with no console errors.
