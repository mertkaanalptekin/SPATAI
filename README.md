# SPATAI — Spatial AI Neighborhood

A single-page, vanilla-JavaScript web app that visualises the **Spatial AI Architecture** semantic model in a full-window three.js scene.

## Run

ES modules need to be served over HTTP (opening `index.html` from disk will not work):

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

three.js r160 is loaded from the jsDelivr CDN through an import map, so there is no build step.

## Semantic model

| Entity | Attributes | In the scene |
| --- | --- | --- |
| **Visitor** | `User_ID`, `Position`, `Velocity`, `Dwell_Time` | Walking figures. `Dwell_Time` is the time spent in the current zone. |
| **Spatial Zone** | `Zone_ID`, `Occupancy`, `Ambient_Light` | Coloured floor areas (Lobby, Gallery, Lounge) with a floating node. `Ambient_Light` (lux) drives the zone's ceiling light. |
| **Smart Display** | `Display_ID`, `Current_Media`, `Volume_Level`, `Power_State`, `Status` | Kiosk screens with a 2.5 m ring showing the rule radius. |

Relationships (toggle with **Relations**):

- **Visitor _enters_ Spatial Zone**: thin lines from each visitor to its zone node. Entering a zone resets `Dwell_Time` and updates `Occupancy`.
- **Spatial Zone _controls_ Smart Display**: dashed lines from the zone node to its displays.

### Rule

> IF `Visitor.Position` is within 2.5 m of `Display.Position` AND `Zone.Occupancy` < 20, set `Power_State` to ON.

The rule is evaluated every frame against the display's controlling zone. The **Rule engine** panel shows each condition live. In the scene, a green ring and links mean the rule is satisfied. A red ring means a visitor is in range but the zone is at capacity.

The model only defines when a display turns ON. To keep the demo readable, a display returns to `OFF` after 3 s without a rule match and its media goes back to the default loop. In the meantime its `Status` shows "Cooling down".

### Action

**`Launch_Media()`** changes `Current_Media` from `Default Loop` to `Interactive Content`. It only works on a display whose `Power_State` is ON. With a display selected it acts on that display; with none selected it acts on every powered display. **Default loop** reverts the media.

## Controls

- **Visitor**: `＋ Visitor` spawns at the entrance, `＋10 Crowd` adds ten visitors to the selected zone (default Gallery), and `− Visitor` removes the selected or most recent visitor. Add crowds until a zone reaches 20 to watch the rule hold its displays off.
- **Smart Display**: `Launch_Media()` and `Default loop`.
- **View**: toggle relationships, velocity vectors and labels, and reset the camera.
- **Simulation**: pause or resume (Space), and reset the demo scene.
- **In the scene**: click any entity to inspect its attributes. Drag a visitor to place it next to a display. The inspector also has an `Ambient_Light` slider for zones and a `Volume_Level` slider for displays.
