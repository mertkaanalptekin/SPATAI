"""Rules of the semantic model.

IF Visitor.Position is within 2.5m of Display.Position AND Zone.Occupancy < 20,
set Display.Power_State to ON.

Only visitors that have entered the zone controlling the display are considered.
The rule never powers a display off; it only specifies when to turn one on.
"""

from __future__ import annotations

from spatai.model import PowerState, SmartDisplay, SpatialZone, distance

PROXIMITY_THRESHOLD_M = 2.5
MAX_OCCUPANCY_FOR_POWER_ON = 20  # exclusive upper bound


def should_power_on(zone: SpatialZone, display: SmartDisplay) -> bool:
    if zone.occupancy >= MAX_OCCUPANCY_FOR_POWER_ON:
        return False
    return any(
        distance(v.position, display.position) <= PROXIMITY_THRESHOLD_M
        for v in zone.visitors.values()
    )


def apply_power_on_rule(zone: SpatialZone, display: SmartDisplay) -> bool:
    """Apply the rule to one display. Returns True if the display was switched on."""
    if display.power_state is PowerState.ON or not should_power_on(zone, display):
        return False
    display.power_state = PowerState.ON
    return True


def evaluate_rules(zone: SpatialZone) -> list[SmartDisplay]:
    """Apply the rule to every display the zone controls; return those switched on."""
    return [d for d in zone.displays.values() if apply_power_on_rule(zone, d)]
