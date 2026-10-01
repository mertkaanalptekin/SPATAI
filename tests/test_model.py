import unittest

from spatai import (
    DEFAULT_LOOP_MEDIA,
    INTERACTIVE_MEDIA,
    PowerState,
    SmartDisplay,
    SpatialZone,
    Visitor,
    evaluate_rules,
    launch_media,
    should_power_on,
)


def make_zone(visitor_positions, display_pos=(0.0, 0.0)):
    zone = SpatialZone("lobby", ambient_light=300.0)
    display = SmartDisplay("d1", position=display_pos)
    zone.control(display)
    for i, pos in enumerate(visitor_positions):
        zone.enter(Visitor(f"u{i}", position=pos))
    return zone, display


class RelationshipTests(unittest.TestCase):
    def test_enter_updates_occupancy(self):
        zone, _ = make_zone([(10, 10), (11, 11)])
        self.assertEqual(zone.occupancy, 2)
        zone.leave("u0")
        self.assertEqual(zone.occupancy, 1)

    def test_reentry_is_not_double_counted(self):
        zone, _ = make_zone([(10, 10)])
        zone.enter(Visitor("u0", position=(9, 9)))
        self.assertEqual(zone.occupancy, 1)

    def test_display_defaults(self):
        d = SmartDisplay("d", position=(0, 0))
        self.assertEqual(d.power_state, PowerState.OFF)
        self.assertEqual(d.current_media, DEFAULT_LOOP_MEDIA)

    def test_volume_bounds(self):
        with self.assertRaises(ValueError):
            SmartDisplay("d", position=(0, 0), volume_level=101)


class PowerOnRuleTests(unittest.TestCase):
    def test_nearby_visitor_low_occupancy_powers_on(self):
        zone, display = make_zone([(1.5, 2.0)])  # exactly 2.5 m
        self.assertEqual(evaluate_rules(zone), [display])
        self.assertEqual(display.power_state, PowerState.ON)

    def test_far_visitor_does_not_power_on(self):
        zone, display = make_zone([(2.6, 0.0)])
        self.assertEqual(evaluate_rules(zone), [])
        self.assertEqual(display.power_state, PowerState.OFF)

    def test_occupancy_19_powers_on(self):
        zone, display = make_zone([(0.5, 0.0)] + [(50, 50)] * 18)
        self.assertEqual(zone.occupancy, 19)
        self.assertTrue(should_power_on(zone, display))

    def test_occupancy_20_does_not_power_on(self):
        zone, display = make_zone([(0.5, 0.0)] + [(50, 50)] * 19)
        self.assertEqual(zone.occupancy, 20)
        evaluate_rules(zone)
        self.assertEqual(display.power_state, PowerState.OFF)

    def test_rule_never_powers_off(self):
        zone, display = make_zone([(30, 30)])
        display.power_state = PowerState.ON
        evaluate_rules(zone)
        self.assertEqual(display.power_state, PowerState.ON)

    def test_already_on_is_not_reported(self):
        zone, display = make_zone([(0, 0)])
        display.power_state = PowerState.ON
        self.assertEqual(evaluate_rules(zone), [])

    def test_3d_positions(self):
        zone, display = make_zone([(1.0, 1.0, 1.0)], display_pos=(0.0, 0.0, 0.0))
        self.assertTrue(should_power_on(zone, display))

    def test_mismatched_dimensions_raise(self):
        zone, display = make_zone([(1.0, 1.0, 1.0)])
        with self.assertRaises(ValueError):
            should_power_on(zone, display)


class LaunchMediaTests(unittest.TestCase):
    def test_switches_to_interactive(self):
        d = SmartDisplay("d", position=(0, 0))
        launch_media(d)
        self.assertEqual(d.current_media, INTERACTIVE_MEDIA)


if __name__ == "__main__":
    unittest.main()
