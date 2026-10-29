# Simulation spec: proximity rules

Two proximity rules for the exhibition simulation (see [SIMULATION_METRICS.md](SIMULATION_METRICS.md) for the floor plan). Requirements carry IDs (**P1**, **P2**, …), which the code and tests cite.

## Brief (as given)

1. **Personal space.** If a visitor comes closer than 1 metre to another visitor, one of them needs to stop; otherwise visitors keep wandering.
2. **Artwork proximity.** If a visitor comes closer than 1 metre to an installation or artwork, the staff come near the visitor and make them step back; otherwise no further action is needed.

## Artworks (P1)

- **P1.** Every gallery holds one artwork, registered as a 0.6 m circular `Place` inside its hall. The three mandatory exhibits $l_1, l_2, l_3$ are the artworks of Galleries 3, 6 and 9. The other seven are installations named after their gallery:

  | Installation | Point | Installation | Point |
  | --- | --- | --- | --- |
  | Installation g1 | (6, 5.5) | Installation g7 | (32, 15) |
  | Installation g2 | (18, 5.5) | Installation g8 | (24, 16.5) |
  | Installation g4 | (32, 4) | Installation g10 | (8, 13.5) |
  | Installation g5 | (40, 4) | | |

  Distances to an artwork are measured to its point (its centre). Every artwork stands at least 1.9 m from its hall's walls, so a visitor stepping back (P8) stays inside the hall.

## Personal space (P2–P5)

- **P2. Threshold.** Two agents are in conflict when they are closer than **PERSONAL_SPACE = 1.0 m** (strictly, by Euclidean distance) and at least one of them is *closing in*: its intended velocity has a positive component towards the other.
- **P3. Who stops.** The agent closing in faster stops; the other keeps wandering. If both close in equally fast (within 1e-9 m/s), the one whose ID sorts later stops. If neither is closing in, they are already parting or both standing, so nobody needs to stop.
- **P4. Resuming.** A stopped agent walks on as soon as it is no longer the one that has to stop: the other has moved off, it is 1 m or more away, or it is not closing in. If it has waited **REPLAN_AFTER = 2 s** and is still blocked, it picks a new destination whose first leg doesn't close in on the agent it yields to, so two agents can't deadlock.
- **P5. Exemptions.** A staff member on an artwork call (P7) and a visitor stepping back (P8) are exempt, as both are following the guard procedure. An agent being dragged with the mouse is placed by the user, not moving on its own.

## Artwork proximity (P6–P9)

- **P6. Breach.** A *visitor* (role `visitor`, not staff) is in breach when closer than **ARTWORK_DISTANCE = 1.0 m** to an artwork.
- **P7. Dispatch.** For each new breach, the nearest staff member who is not already on a call is sent. "Nearest" means the shortest walking distance (with staff doors), ties broken by ID. The staff member walks through the doors to a point **STAFF_STANDOFF = 1.3 m** from the visitor, on the side they arrive from. That keeps them outside the visitor's personal space. Breaches are served most urgent first, meaning the visitor closest to their artwork, ties broken by ID. If no staff member is free, the breach waits for one.
- **P8. Step back.** When the staff member is within 1.7 m of the visitor (the standoff plus 0.4 m), the visitor steps back. They walk straight to the point **STEP_BACK_TO = 1.6 m** from the artwork, along the line from the artwork through them. If they stand exactly on the artwork point, they step towards their hall's centre.
- **P9. Resolution.** The call ends when the visitor is 1.45 m or more from the artwork (STEP_BACK_TO minus 0.15 m). The staff member then returns to their post: the starting spot for sam, or wandering for staff added later. If the visitor leaves the 1 m zone on their own before staff arrive, the call is cancelled ("no further action needed").

## Page (P10–P12)

- **P10. View.** A **Proximity** toggle in the View group shows:
  - a 0.5 m ring around every agent, so two rings overlap exactly when the agents are closer than 1 m;
  - an amber ring and ⏸ on agents that are stopped;
  - a 1 m guard ring around every artwork, red while it is breached;
  - a dashed line from a dispatched staff member to their visitor.
- **P11. Rule panel and log.** The Rule engine panel states both rules and shows them live: pairs closer than 1 m and who is stopped; breaches and which staff member is on each. The Event log records:
  - "bob stops: 0.97 m from carol (personal space)" and "bob walks on", once a stop has lasted 0.5 s;
  - "carol is 0.7 m from Installation g8 → sam dispatched";
  - "sam reached carol; carol steps back from Installation g8";
  - "carol is 1.6 m from Installation g8 → sam returns to post";
  - "carol moved away from Installation g8 → sam stands down".

  Repeats of the same stop are throttled to one line per agent every 5 s.
- **P12.** A **＋ Staff** button adds a staff member at the Checkout who wanders until called. Wanderers never choose a destination within 1.3 m of an artwork.

## Implementation and tests (P13)

- **P13.** The rules themselves are pure functions in `spatai/proximity.py`, ported to `js/proximity.js`: `yields`, `personal_space_conflicts`, `artwork_breaches`, `nearest_staff`, `approach_point` and `step_back_point`. `tests/test_js_parity.py` checks the two agree. The call state machine (P7–P9) lives in `js/proximity.js` as `ArtworkGuard`. It runs in the page and is unit-tested with Node (`tests/js/proximity.test.mjs`). A browser run checks P10–P12.
