# Simulation spec: exploring visitors and interest routes

Visitors used to know the whole building: they were routed through the doors on the true floor plan. This spec takes that knowledge away. A visitor sees the space through a cone of vision and builds its own map as it walks. On its first run it explores. From its second run on, it picks a short list of things it is interested in and plans a route through them on its own map. Requirements carry IDs (**E1**, **E2**, …), which the code and tests cite.

## Brief (as given)

1. Visitors have no knowledge of the environment before they wander around the exhibition. They have a sensory tool to explore the space, such as a cone of vision. The places they pass through become their map, drawn on top of the modelled environment when the agent is selected.
2. On the first run, each visitor wanders the exhibition to explore and map it. From the second run on, it has a list of interests, entities that shape its route through the exhibition.

## Knowledge and senses (E1–E3)

- **E1. No prior knowledge.** Every visitor starts with an empty map, and plans only on what it has seen. That includes the demo visitors (alice, bob, carol), who stand where the spec puts them and only look around, and every crowd member. Staff know the building, because they work there, and keep routing on the true plan.
- **E2. Senses.** A visitor looks 4 times a second.
  - **Vision cone:** 6 m range, 120° wide (±60°), centred on the gaze. The gaze follows the walking direction. While the visitor stands, it looks around: the gaze sweeps ±60° about its last heading every 2.5 s.
  - **Near sense:** everything within 1 m, all round, and the cells next to its own through an open edge.
  - **Walls block sight;** door openings do not. The staff-only door (S1) is closed to visitors, for sight and for walking.
  - A cell is seen when its centre is inside the cone (or the near sense) and the straight line to it crosses no wall.
- **E3. The map.** The building is cut into 0.5 m cells (88 × 38). A visitor's map records:
  - which cells it has **seen** (the rest are unknown); the walls between two seen cells are known;
  - the **rooms** it has discovered (any cell seen), in order;
  - the **doors** it has found (cells on both sides of the opening seen);
  - the **entities** it has spotted (artworks and screens whose cell it has seen), with the time each has spent in view;
  - its **trail**: where it has walked.

## Moving on one's own map (E4–E5)

- **E4. Planning.** A visitor plans through seen cells only, 8-connected, without cutting corners. It keeps out of cells within 1.2 m of an artwork it has spotted, outside the 1 m guard ring. It can walk out of such a cell, for example after spotting an artwork it was already standing beside, but never into one. The cell path is straightened into legs that stay in seen, allowed cells.
- **E5. Exploring.** A *frontier* is a seen, allowed cell with an open edge to an unknown cell. The explorer walks to the reachable frontier with the lowest cost: path length plus 2 m × (1 − cos of the turn from its heading), so it prefers to keep going the way it faces. On arrival it stands for 0.5–1.5 s and looks around, then picks the next. It has finished exploring when no reachable frontier is left. At 1 m/s, a visitor starting at the Entrance maps the whole building in about four minutes.

## Runs, interests and routes (E6–E10)

- **E6. Runs.** A run ends when the visitor reaches the **Checkout**. It then walks through the Reset Passage to the **Entrance**, and arriving there starts the next run. A visitor keeps looking and mapping on every run.
  - **Run 1 is exploration (E5).** When nothing is left to explore, the visitor walks to the Checkout.
  - **Runs 2 and later follow an interest route (E8–E9).**
- **E7. Taste.** Each visitor gets a taste for each entity when it is created, between 0.5 and 1.5, so two visitors who saw the same things still want different things.
- **E8. Interests.** At the start of each later run, the visitor picks **3 interests** from the entities it has spotted. Each entity scores its time in view × taste × 0.5^(times visited as an interest), so the next run favours something new. Ties go to the lower ID. The visiting order is the one with the shortest walk on the visitor's own map, from where it stands, through every stop, to the Checkout. Every order is tried; on a tie the first wins.
- **E9. Stops.**
  - **Artwork:** the visitor walks to a spot 1.5 m from it, in its room (the nearest of eight around it), then walks part of a circle around it, 120°–240° at 1.5 m, and stands for 2–4 s. This is the viewing behaviour of MOVEMENT_PREPOSITIONS.md M7, so *around* shows up in normal running.
  - **Screen:** the visitor stands 1.5 m in front of it for 4 s, which can switch it on.

  A stop reached counts as a visit (E8).
- **E10. Interruptions.** The proximity rules still apply. After a personal-space stop or an artwork step-back, the visitor plans again from where it stands. If it is still blocked after 2 s, an explorer picks another frontier, and a visitor on a route plans its current leg again.

## In the page (E11–E14)

- **E11. Map overlay.** When a visitor is selected (the visitor in the most recently opened window), its map is drawn on the floor:
  - unknown cells are fogged and seen cells are clear;
  - the trail is a thin line in the visitor's colour;
  - found doors are ticked;
  - spotted entities are ringed;
  - on a route, the stops are numbered in visiting order and joined by a line.

  Every visitor with an open window shows its vision cone. A **View** option shows the cones for every visitor.
- **E12. Window.** A visitor's window gets an **Exploration** section showing:
  - the run and phase (*exploring*, *to the Checkout*, *to the Entrance*, *route*);
  - the share of the building seen;
  - rooms found out of 14, artworks out of 10 and screens out of 4;
  - on a route, the interests in order, ticked once visited.

  The section has two actions: *Finish exploring*, which heads for the Checkout now if the visitor has seen it, and *Forget the map*.
- **E13. Log.** A new **Exploration** category in the global log and in each visitor's activity, for example:
  - "V-005 discovers Gallery 3";
  - "V-005 spots Installation g8";
  - "V-005 has mapped the exhibition (run 1, 3 min 52 s)";
  - "V-005 starts run 2: Exhibit l2 → g6-screen → Installation g8";
  - "V-005 views Exhibit l2 (1/3)";
  - "V-005 reaches the Checkout: run 2 done".
- **E14. Speed.** A speed button in the toolbar (×1) runs the simulation at ×1, ×2 or ×4, so a first run can be watched in about a minute.

## Code (E15)

- **E15.** The senses, the map, planning, frontiers, interests and route order are pure functions in `spatai/exploration.py`, ported to `js/exploration.js`. `tests/test_js_parity.py` replays random looks and queries through both and checks they agree. `tests/test_exploration.py` tests the requirements, including a full exploration from the Entrance.
