# SPATAI

Semantic model for a spatial AI system: visitors move through spatial zones, and zones control smart displays.

## Model

| Entity | Attributes |
| --- | --- |
| `Visitor` | `user_id`, `position`, `velocity`, `dwell_time` |
| `SpatialZone` | `zone_id`, `occupancy` (derived from visitors who entered), `ambient_light` |
| `SmartDisplay` | `display_id`, `position`, `current_media`, `volume_level`, `power_state`, `status` |

**Relationships**
- Visitor *enters* Spatial Zone: `zone.enter(visitor)`
- Spatial Zone *controls* Smart Display: `zone.control(display)`

**Rule.** If a visitor in the zone is within 2.5 m of the display (inclusive) and zone occupancy is below 20, set `power_state` to `ON` (`evaluate_rules(zone)`). The rule only ever turns displays on.

**Action.** `launch_media(display)` switches `current_media` from the default loop to interactive content.

## Usage

```python
from spatai import SpatialZone, SmartDisplay, Visitor, evaluate_rules, launch_media

zone = SpatialZone("lobby", ambient_light=300)
display = SmartDisplay("d1", position=(0.0, 0.0))
zone.control(display)
zone.enter(Visitor("u1", position=(1.0, 2.0)))

for d in evaluate_rules(zone):   # displays switched on
    launch_media(d)
```

## Tests

```
python3 -m unittest -v
```
