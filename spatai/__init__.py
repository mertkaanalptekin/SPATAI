"""SPATAI: semantic model for a spatial AI system of visitors, zones and smart displays."""

from spatai.actions import launch_media
from spatai.model import (
    DEFAULT_LOOP_MEDIA,
    INTERACTIVE_MEDIA,
    PowerState,
    SmartDisplay,
    SpatialZone,
    Visitor,
)
from spatai.rules import (
    MAX_OCCUPANCY_FOR_POWER_ON,
    PROXIMITY_THRESHOLD_M,
    apply_power_on_rule,
    evaluate_rules,
    should_power_on,
)

__all__ = [
    "DEFAULT_LOOP_MEDIA",
    "INTERACTIVE_MEDIA",
    "MAX_OCCUPANCY_FOR_POWER_ON",
    "PROXIMITY_THRESHOLD_M",
    "PowerState",
    "SmartDisplay",
    "SpatialZone",
    "Visitor",
    "apply_power_on_rule",
    "evaluate_rules",
    "launch_media",
    "should_power_on",
]
