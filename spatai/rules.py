"""Rules of the semantic model.

IF Visitor.Position is within 2.5m of Display.Position AND Zone.Occupancy < 20,
set Display.Power_State to ON.

Only visitors located in the zone controlling the display are considered.
The rule never powers a display off; it only specifies when to turn one on.
"""

from __future__ import annotations

from spatai.model import PowerState, SmartDisplay
from spatai.world import World

PROXIMITY_THRESHOLD_M = 2.5
MAX_OCCUPANCY_FOR_POWER_ON = 20  # exclusive upper bound


def should_power_on(world: World, zone_id: str, display_id: str) -> bool:
    zone = world.zones[zone_id]
    occupants = world.occupants_of(zone_id)
    if len(occupants) >= MAX_OCCUPANCY_FOR_POWER_ON:
        return False
    nearby = world.occupants_at(world.locate(display_id), PROXIMITY_THRESHOLD_M)
    in_zone = {v.user_id for v in occupants}
    return display_id in zone.display_ids and any(v.user_id in in_zone for v in nearby)


def evaluate_rules(world: World) -> list[SmartDisplay]:
    """Apply the rule to every zone's displays; return the displays switched on."""
    switched = []
    for zone_id, zone in world.zones.items():
        for display_id in sorted(zone.display_ids):
            display = world.displays[display_id]
            if display.power_state is not PowerState.ON and should_power_on(world, zone_id, display_id):
                display.power_state = PowerState.ON
                switched.append(display)
    return switched
