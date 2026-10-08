"""SPATAI: semantic model for a spatial AI system of visitors, zones and smart displays."""

from spatai.actions import launch_media
from spatai.geometry import WORLD_FRAME, Circle, Location, Rect, ReferenceFrame
from spatai.model import (
    DEFAULT_LOOP_MEDIA,
    INTERACTIVE_MEDIA,
    Place,
    PowerState,
    SmartDisplay,
    SpatialZone,
    Visitor,
)
from spatai.rules import (
    MAX_OCCUPANCY_FOR_POWER_ON,
    PROXIMITY_THRESHOLD_M,
    evaluate_rules,
    should_power_on,
)
from spatai.world import Description, World

__all__ = [
    "DEFAULT_LOOP_MEDIA",
    "INTERACTIVE_MEDIA",
    "MAX_OCCUPANCY_FOR_POWER_ON",
    "PROXIMITY_THRESHOLD_M",
    "WORLD_FRAME",
    "Circle",
    "Description",
    "Location",
    "Place",
    "PowerState",
    "Rect",
    "ReferenceFrame",
    "SmartDisplay",
    "SpatialZone",
    "Visitor",
    "World",
    "evaluate_rules",
    "launch_media",
    "should_power_on",
]
