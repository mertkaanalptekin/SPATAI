# Simulation spec: prepositions of movement, and the simplified interface

This spec covers two things. The first is the movement attributes of every agent: whether it moves **toward**, **away from** or **around** each screen, artwork and other agent. The second is the interface rework that shows them. Requirements carry IDs (**M1**, **M2**, …; **U1**, **U2**, …), which the code and tests cite.

## Brief (as given)

1. Detect each agent's preposition of movement relative to the entities in the space (screens, installations, other agents): *toward the X*, *away from the X*, *around the X*.
2. Give each type of movement a visual indicator and a log, with a log window for each agent's activities.
3. Clean up the interface: reveal details through pop-up menus or better-fitting solutions, and make the visual markers and graphic language a little more minimal.

## Movement prepositions (M1–M9)

- **M1. Entities.** Every agent is compared against three kinds of entity, each within a reach:

  | Entity | Reach |
  | --- | --- |
  | Screen (smart display) | 6 m |
  | Artwork (exhibit or installation) | 5 m |
  | Other agent | 4 m |

  The reach applies to the mean distance over the window (M2).
- **M2. Window.** Positions are sampled 4 times a second. A preposition is judged over the last **3 s** (13 samples) of the agent's own track. For another agent, it is judged against that agent's track over the same window.
- **M3. Measures.** For each step $a_i$ of the agent, with $\hat r_i$ the unit vector to the entity and $d_i$ the distance:
  - path $P = \sum |a_i|$;
  - radial progress $R = \sum a_i \cdot \hat r_i$, positive when closing in;
  - sweep $S = \sum (\hat r_i \times a_i) / \max(d_i, 0.3)$: the angle the agent's own motion carries it around the entity;
  - turn $H$: the sum of the signed heading changes between consecutive steps longer than 2 cm.

  Only the agent's **own** movement counts. An agent standing still is not "moving toward" someone who walks up to it.
- **M4. Classification**, in this order:
  1. *none* if the agent moved less than 0.3 m ($P < 0.3$) or the entity is out of reach;
  2. **around** if $|S| \ge 45°$, the agent turns the same way ($S \cdot H > 0$ and $|H| \ge 0.5\,|S|$), and the move is mostly tangential ($|R| \le 0.5\,P$). The sign of $S$ gives the direction: anticlockwise when positive;
  3. **toward** if $R \ge 0.4\,P$ and $R \ge 0.3$ m;
  4. **away** if $-R \ge 0.4\,P$ and $-R \ge 0.3$ m;
  5. otherwise *none*: passing by, or moving alongside.

  The turn condition is what separates walking *around* something from walking straight *past* it, or alongside another agent.
- **M5. Primary preposition.** An agent can be moving toward one thing and away from another at once. Its *primary* relation is chosen by preposition (around before toward before away), then by the nearest entity, then by ID.
- **M6. Events.** A relation (agent, entity, preposition) is logged when it starts, once it has held for 2 consecutive samples (0.5 s), for example:
  - "bob walks toward g2-screen";
  - "carol walks around Installation g8 (anticlockwise)";
  - "sam walks away from bob".

  The same relation is not logged again within 6 s. Ends are not logged.
- **M7. Viewing behaviour.** Some wanderers stop to look at an artwork: about one destination in four is a partial circuit of 120–240° around an artwork, at 1.4–1.7 m (outside its 1 m guard ring). That makes *around* happen in normal running, not only when you drag an agent. (Implemented with EXPLORATION.md E9: the circuit is part of each artwork stop on a visitor's interest route.)
- **M8. Code.** `classify()` is a pure function in `spatai/movement.py`, ported to `js/movement.js`; `tests/test_js_parity.py` checks the two agree. `MovementTracker` in `js/movement.js` samples, classifies and emits the M6 events. It is unit-tested in `tests/js/movement.test.mjs`.
- **M9. Colours and glyphs**, validated as a set on the dark surface:
  - **toward**: aqua `#199e70`, glyph →;
  - **away**: orange `#d95926`, glyph ←;
  - **around**: violet `#9085e9`, glyph ↻.

  A glyph always comes with the colour, so the colour is never the only cue.

## Indicators and logs (M10–M12)

- **M10. In the scene.** Each agent's label shows its primary preposition as a small coloured glyph and the entity's name, for example "bob → g2-screen". The **Movement** view option draws the relations as thin lines: solid with an arrowhead for *toward*, dashed for *away*, and an arc around the entity for *around*. By default lines are drawn only for agents whose window is open, to keep the scene quiet; a view option shows them for everyone.
- **M11. Agent windows.** Clicking an agent opens its window, a small card that is the agent's own log window. It shows:
  - the current relations as chips;
  - an **Activity** log of everything that happened to that agent: movement, places entered, proximity stops, staff calls, rule triggers;
  - a collapsed **Details** section with its attributes.

  Up to three windows can be open at once. Each can be moved by its header and closed. Clicking a screen or the zone node opens the same kind of window with that entity's details.
- **M12. The global log** has category filters: Rules, Proximity, Location, Movement, Metrics. Movement is off by default, because it is the busiest; every agent window shows its own movement regardless.

## Interface (U1–U6)

- **U1. Toolbar.** One row: the brand, then **Add ▾** (Visitor, Crowd of 10, Staff, Remove), **Media ▾** (Launch_Media, Default loop), **View ▾** (on/off options and camera reset), a speed button (EXPLORATION.md E14), a pause button and a reset button. Menus open on click and close on Escape or an outside click.
- **U2. One side drawer** on the right replaces the inspector, Location and Rule engine panels. Its tabs are:
  - **Rules**: live state of the power-on and proximity rules (open by default);
  - **Location**: the four location questions;
  - **Metrics**: the distance metrics;
  - **Scene**: the overview of zones, screens and places, plus the legend;
  - **Log**: the global log with filters.

  The drawer collapses to a thin tab strip.
- **U3. Status bar.** A one-line status bar at the bottom shows: agents, screens on, agents stopped, open artwork calls. A **?** button opens the controls and legend.
- **U4. Labels.** Text only, small and muted, with no boxes, for agents, rooms and screens. Artworks are unlabelled dots until you hover over them; their names show in the hover description and in the Scene tab. Screen labels show a status dot instead of "· OFF".
- **U5. Lighter marks.**
  - The zone node and the relationship lines appear only with **Relations**.
  - Personal-space rings show only on stopped agents, unless the **Proximity rings** option is on.
  - Artwork guard rings are faint until breached.
  - The display cone and radius are faint until a visitor is in range.
  - Valve glyphs are smaller, and shortcut tags are reduced to "S1", "S2" and "S3", with their meaning in a hover title.
- **U6.** Every earlier feature stays reachable, from the toolbar menus, the drawer tabs or the windows.
