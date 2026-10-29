import unittest

from spatai import (
    DEFAULT_LOOP_MEDIA,
    INTERACTIVE_MEDIA,
    Circle,
    Location,
    Place,
    PowerState,
    Rect,
    ReferenceFrame,
    SmartDisplay,
    SpatialZone,
    Visitor,
    World,
    evaluate_rules,
    launch_media,
    should_power_on,
)


def gallery_world():
    """Two adjacent 10x10 zones; a nested museum > wing > alcove place hierarchy."""
    w = World()
    w.add_zone(SpatialZone("east", Rect(0, 0, 10, 10)))
    w.add_zone(SpatialZone("west", Rect(-10, 0, 0, 10)))
    museum = w.add_place(Place("Museum", Rect(-10, 0, 10, 10)))
    wing = w.add_place(Place("East Wing", Rect(0, 0, 10, 10), parent=museum))
    w.add_place(Place("Alcove", Circle(Location(8, 8), 1.5), parent=wing))
    w.add_display(SmartDisplay("d1", Location(5, 5), orientation=0), zone_id="east")
    return w


class RegistryTests(unittest.TestCase):
    def test_ids_are_unique_across_kinds(self):
        w = gallery_world()
        with self.assertRaises(ValueError):
            w.add_visitor(Visitor("east", Location(0, 0)))
        with self.assertRaises(ValueError):
            w.add_display(SmartDisplay("d1", Location(0, 0)))

    def test_add_display_to_unknown_zone_registers_nothing(self):
        w = World()
        with self.assertRaises(KeyError):
            w.add_display(SmartDisplay("d", Location(0, 0)), zone_id="nope")
        self.assertEqual(w.displays, {})

    def test_place_parent_must_be_registered(self):
        w = World()
        orphan_parent = Place("Elsewhere", Rect(0, 0, 1, 1))
        with self.assertRaises(ValueError):
            w.add_place(Place("Child", Rect(0, 0, 1, 1), parent=orphan_parent))

    def test_remove(self):
        w = gallery_world()
        w.add_visitor(Visitor("u1", Location(1, 1)))
        self.assertEqual(w.remove("u1").user_id, "u1")
        self.assertNotIn("u1", w.visitors)
        w.remove("d1")
        self.assertEqual(w.zones["east"].display_ids, set())
        with self.assertRaises(KeyError):
            w.remove("u1")

    def test_remove_place_with_children_is_refused(self):
        w = gallery_world()
        with self.assertRaises(ValueError):
            w.remove("East Wing")
        self.assertEqual(list(w.places), ["Museum", "East Wing", "Alcove"])  # order kept
        w.remove("Alcove")
        w.remove("East Wing")
        self.assertNotIn("East Wing", w.places)

    def test_display_defaults(self):
        d = SmartDisplay("d", Location(0, 0))
        self.assertEqual(d.power_state, PowerState.OFF)
        self.assertEqual(d.current_media, DEFAULT_LOOP_MEDIA)
        with self.assertRaises(ValueError):
            SmartDisplay("d", Location(0, 0), volume_level=101)


class LocateTests(unittest.TestCase):
    def test_locate_visitor_and_display(self):
        w = gallery_world()
        w.add_visitor(Visitor("u1", Location(1, 2)))
        self.assertEqual(w.locate("u1"), Location(1, 2))
        self.assertEqual(w.locate("d1"), Location(5, 5))

    def test_locate_zone_and_place_use_centre(self):
        w = gallery_world()
        self.assertEqual(w.locate("west"), Location(-5, 5))
        self.assertEqual(w.locate("Alcove"), Location(8, 8))

    def test_locate_follows_movement(self):
        w = gallery_world()
        v = w.add_visitor(Visitor("u1", Location(1, 2)))
        v.position = Location(3, 3)
        self.assertEqual(w.locate("u1"), Location(3, 3))

    def test_locate_unknown_raises(self):
        with self.assertRaises(KeyError):
            gallery_world().locate("ghost")


class OccupantsAtTests(unittest.TestCase):
    def test_empty_location(self):
        w = gallery_world()
        w.add_visitor(Visitor("u1", Location(9, 9)))
        self.assertEqual(w.occupants_at(Location(-5, 5), 2), [])

    def test_empty_world(self):
        self.assertEqual(World().occupants_at(Location(0, 0), 100), [])

    def test_boundary_is_inclusive_and_sorted_by_distance(self):
        w = World()
        w.add_visitor(Visitor("edge", Location(3, 4)))  # exactly 5 m
        w.add_visitor(Visitor("near", Location(1, 0)))
        w.add_visitor(Visitor("out", Location(5.01, 0)))
        self.assertEqual([v.user_id for v in w.occupants_at(Location(0, 0), 5)], ["near", "edge"])

    def test_zero_radius_matches_exact_position_only(self):
        w = World()
        w.add_visitor(Visitor("u", Location(2, 2)))
        self.assertEqual(len(w.occupants_at(Location(2, 2), 0)), 1)
        self.assertEqual(w.occupants_at(Location(2, 2.1), 0), [])

    def test_query_in_rotated_frame(self):
        w = World()
        w.add_visitor(Visitor("u", Location(10, 1)))
        f = ReferenceFrame("rot", origin=(10, 0), rotation=90)
        self.assertEqual(len(w.occupants_at(Location(1, 0, f), 0.01)), 1)

    def test_near_equal_distances_tie_break_by_id(self):
        w = World()
        w.add_visitor(Visitor("b", Location(0.1 + 0.2, 0)))  # 0.30000000000000004
        w.add_visitor(Visitor("a", Location(0.3, 0)))
        self.assertEqual([v.user_id for v in w.occupants_at(Location(0, 0), 1)], ["a", "b"])

    def test_negative_radius_raises(self):
        with self.assertRaises(ValueError):
            World().occupants_at(Location(0, 0), -1)


class ZoneAtTests(unittest.TestCase):
    def test_inside_each_zone(self):
        w = gallery_world()
        self.assertEqual(w.zone_at(Location(5, 5)).zone_id, "east")
        self.assertEqual(w.zone_at(Location(-5, 5)).zone_id, "west")

    def test_outside_all_zones(self):
        self.assertIsNone(gallery_world().zone_at(Location(0, -0.5)))
        self.assertIsNone(World().zone_at(Location(0, 0)))

    def test_boundary_point_is_inside(self):
        w = World()
        w.add_zone(SpatialZone("z", Rect(0, 0, 10, 10)))
        self.assertEqual(w.zone_at(Location(10, 10)).zone_id, "z")

    def test_shared_edge_resolves_deterministically(self):
        # x = 0 is on both zones' edges; equal areas fall back to zone_id order.
        self.assertEqual(gallery_world().zone_at(Location(0, 5)).zone_id, "east")

    def test_overlap_prefers_smaller_zone(self):
        w = gallery_world()
        w.add_zone(SpatialZone("booth", Rect(4, 4, 6, 6)))
        self.assertEqual(w.zone_at(Location(5, 5)).zone_id, "booth")

    def test_rotated_zone_boundary(self):
        w = World()
        f = ReferenceFrame("diag", origin=(0, 0), rotation=45)
        w.add_zone(SpatialZone("diag", Rect(0, -0.5, 10, 0.5, f)))
        self.assertEqual(w.zone_at(Location(5, 5)).zone_id, "diag")
        self.assertIsNone(w.zone_at(Location(5, 0)))


class PositionInTests(unittest.TestCase):
    def test_same_frame_is_identity(self):
        w = gallery_world()
        f = ReferenceFrame("f", origin=(1, 1))
        w.add_visitor(Visitor("u", Location(2, 3, f)))
        self.assertEqual(w.position_in("u", f), Location(2, 3, f))

    def test_world_to_rotated_frame(self):
        w = gallery_world()
        f = ReferenceFrame("rot", origin=(5, 0), rotation=90)
        p = w.position_in("d1", f)  # display at world (5, 5)
        self.assertIs(p.frame, f)
        self.assertAlmostEqual(p.x, 5)
        self.assertAlmostEqual(p.y, 0)

    def test_between_nested_frames(self):
        w = World()
        hall = ReferenceFrame("hall", origin=(10, 0), rotation=90)
        booth = ReferenceFrame("booth", origin=(2, 0), rotation=90, parent=hall)
        w.add_visitor(Visitor("u", Location(1, 0, booth)))
        world = w.position_in("u", ReferenceFrame("world-copy"))
        self.assertAlmostEqual(world.x, 9)
        self.assertAlmostEqual(world.y, 2)
        in_hall = w.position_in("u", hall)
        self.assertAlmostEqual(in_hall.x, 2)
        self.assertAlmostEqual(in_hall.y, 1)

    def test_zone_centre_in_frame(self):
        w = gallery_world()
        p = w.position_in("east", ReferenceFrame("shifted", origin=(5, 5)))
        self.assertAlmostEqual(p.x, 0)
        self.assertAlmostEqual(p.y, 0)

    def test_unknown_raises(self):
        with self.assertRaises(KeyError):
            World().position_in("ghost", ReferenceFrame("f"))


class DescribeTests(unittest.TestCase):
    def test_most_specific_place(self):
        w = gallery_world()
        self.assertEqual(w.describe(Location(8, 8)).place.name, "Alcove")
        self.assertEqual(w.describe(Location(2, 2)).place.name, "East Wing")
        self.assertEqual(w.describe(Location(-2, 2)).place.name, "Museum")

    def test_place_boundary_point(self):
        w = gallery_world()
        self.assertEqual(w.describe(Location(9.5, 8)).place.name, "Alcove")  # on the circle

    def test_empty_world(self):
        desc = World().describe(Location(0, 0))
        self.assertIsNone(desc.place)
        self.assertIsNone(desc.nearest_display)
        self.assertIsNone(desc.direction)
        self.assertEqual(str(desc), "Outside any known place; no displays")

    def test_outside_places_still_finds_display(self):
        desc = gallery_world().describe(Location(5, -3))
        self.assertIsNone(desc.place)
        self.assertEqual(desc.nearest_display.display_id, "d1")
        self.assertAlmostEqual(desc.distance, 8)

    def test_directions_relative_to_display_facing(self):
        w = gallery_world()  # d1 at (5, 5) facing +x
        cases = {(7, 5): "front", (3, 5): "behind", (5, 7): "left", (5, 3): "right", (5, 5): "at"}
        for (x, y), expected in cases.items():
            self.assertEqual(w.describe(Location(x, y)).direction, expected, (x, y))

    def test_direction_with_rotated_display_frame(self):
        w = World()
        f = ReferenceFrame("rot", origin=(0, 0), rotation=90)
        w.add_display(SmartDisplay("d", Location(0, 0, f), orientation=0))  # faces world +y
        self.assertEqual(w.describe(Location(0, 3)).direction, "front")
        self.assertEqual(w.describe(Location(-3, 0)).direction, "left")
        self.assertEqual(w.describe(Location(3, 0)).direction, "right")

    def test_direction_at_45_degree_boundary_is_front(self):
        w = World()
        w.add_display(SmartDisplay("d", Location(0, 0)))
        self.assertEqual(w.describe(Location(1, 1)).direction, "front")

    def test_nearest_display_tie_breaks_by_id(self):
        w = World()
        w.add_display(SmartDisplay("b", Location(1, 0)))
        w.add_display(SmartDisplay("a", Location(-1, 0)))
        self.assertEqual(w.describe(Location(0, 0)).nearest_display.display_id, "a")

    def test_str(self):
        self.assertEqual(str(gallery_world().describe(Location(7, 5))), "In East Wing, 2.0 m in front of d1")


class PowerOnRuleTests(unittest.TestCase):
    def test_nearby_visitor_low_occupancy_powers_on(self):
        w = gallery_world()
        w.add_visitor(Visitor("u", Location(6.5, 7)))  # exactly 2.5 m
        self.assertEqual([d.display_id for d in evaluate_rules(w)], ["d1"])
        self.assertEqual(w.displays["d1"].power_state, PowerState.ON)

    def test_far_visitor_does_not_power_on(self):
        w = gallery_world()
        w.add_visitor(Visitor("u", Location(7.6, 5)))
        self.assertEqual(evaluate_rules(w), [])

    def test_empty_world_is_noop(self):
        self.assertEqual(evaluate_rules(World()), [])

    def test_visitor_in_other_zone_does_not_count(self):
        w = World()
        w.add_zone(SpatialZone("east", Rect(0, 0, 10, 10)))
        w.add_zone(SpatialZone("west", Rect(-10, 0, -0.5, 10)))
        w.add_display(SmartDisplay("d1", Location(1, 5)), zone_id="east")
        w.add_visitor(Visitor("u", Location(-1, 5)))  # 2 m away, but in west
        self.assertEqual(evaluate_rules(w), [])

    def test_occupancy_19_powers_on_20_does_not(self):
        for crowd, expected in [(18, PowerState.ON), (19, PowerState.OFF)]:
            w = gallery_world()
            w.add_visitor(Visitor("near", Location(5.5, 5)))
            for i in range(crowd):
                w.add_visitor(Visitor(f"u{i}", Location(9, 1)))
            self.assertEqual(w.occupancy("east"), crowd + 1)
            evaluate_rules(w)
            self.assertEqual(w.displays["d1"].power_state, expected, crowd + 1)

    def test_crowd_in_other_zone_does_not_block(self):
        w = gallery_world()
        w.add_visitor(Visitor("near", Location(5.5, 5)))
        for i in range(25):
            w.add_visitor(Visitor(f"u{i}", Location(-5, 5)))
        self.assertTrue(should_power_on(w, "east", "d1"))

    def test_rotated_frame_positions(self):
        w = World()
        f = ReferenceFrame("rot", origin=(10, 10), rotation=135)
        w.add_zone(SpatialZone("z", Rect(-5, -5, 5, 5, f)))
        w.add_display(SmartDisplay("d", Location(0, 0, f)), zone_id="z")
        w.add_visitor(Visitor("u", Location(11.5, 11.5)))  # ~2.12 m from (10, 10)
        self.assertEqual(len(evaluate_rules(w)), 1)

    def test_rule_never_powers_off_and_skips_already_on(self):
        w = gallery_world()
        w.displays["d1"].power_state = PowerState.ON
        w.add_visitor(Visitor("u", Location(5, 6)))
        self.assertEqual(evaluate_rules(w), [])
        self.assertEqual(w.displays["d1"].power_state, PowerState.ON)


class LaunchMediaTests(unittest.TestCase):
    def test_switches_to_interactive(self):
        d = SmartDisplay("d", Location(0, 0))
        launch_media(d)
        self.assertEqual(d.current_media, INTERACTIVE_MEDIA)


if __name__ == "__main__":
    unittest.main()
