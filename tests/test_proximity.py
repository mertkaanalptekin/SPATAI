"""Tests for the proximity rules, keyed to docs/PROXIMITY_RULES.md."""

import unittest

from spatai import Location, Visitor
from spatai.exhibition import HALLS, build_exhibition
from spatai.proximity import (
    PERSONAL_SPACE_M,
    STAFF_STANDOFF_M,
    STEP_BACK_TO_M,
    approach_point,
    artwork_breaches,
    closing_speed,
    nearest_staff,
    personal_space_conflicts,
    step_back_point,
    yields,
)


def fresh():
    world, _, plan = build_exhibition()
    for uid in list(world.visitors):
        world.remove(uid)
    return world, plan


class ArtworkTests(unittest.TestCase):
    def test_p1_one_artwork_per_gallery(self):
        _, plan = fresh()
        self.assertEqual(len(plan.artworks), 10)
        self.assertEqual(list(plan.artwork_hall.values()), list(HALLS))
        self.assertEqual(plan.artwork_hall["Exhibit l2"], "Gallery 6")

    def test_p1_installations_are_places(self):
        world, _, _ = build_exhibition()
        self.assertEqual(world.place_at(Location(24, 16.5)).name, "Installation g8")
        self.assertEqual(world.places["Installation g8"].parent.name, "Gallery 8")

    def test_p1_step_back_stays_inside_the_hall(self):
        _, plan = fresh()
        for name, loc in plan.artworks.items():
            r = plan.rooms[plan.artwork_hall[name]]
            clearance = min(loc.x - r.x_min, r.x_max - loc.x, loc.y - r.y_min, r.y_max - loc.y)
            self.assertGreaterEqual(clearance, STEP_BACK_TO_M + 0.3, name)

    def test_p1_starting_agents_are_clear_of_artworks(self):
        world, _, plan = build_exhibition()
        self.assertEqual(artwork_breaches(plan, world), [])


class PersonalSpaceTests(unittest.TestCase):
    def test_p2_closing_speed(self):
        self.assertAlmostEqual(closing_speed((0, 0), (1, 0), (2, 0)), 1)
        self.assertAlmostEqual(closing_speed((0, 0), (-1, 0), (2, 0)), -1)
        self.assertEqual(closing_speed((0, 0), (1, 0), (0, 0)), 0)

    def test_p2_only_closer_than_one_metre(self):
        self.assertTrue(yields("a", (0, 0), (1, 0), "b", (0.9, 0), (0, 0)))
        self.assertFalse(yields("a", (0, 0), (1, 0), "b", (PERSONAL_SPACE_M, 0), (0, 0)))

    def test_p3_the_one_closing_faster_stops(self):
        self.assertTrue(yields("a", (0, 0), (1, 0), "b", (0.8, 0), (-0.5, 0)))
        self.assertFalse(yields("b", (0.8, 0), (-0.5, 0), "a", (0, 0), (1, 0)))

    def test_p3_equal_speeds_later_id_stops(self):
        self.assertTrue(yields("b", (0, 0), (1, 0), "a", (0.8, 0), (-1, 0)))
        self.assertFalse(yields("a", (0.8, 0), (-1, 0), "b", (0, 0), (1, 0)))

    def test_p3_parting_or_standing_nobody_stops(self):
        self.assertFalse(yields("a", (0, 0), (-1, 0), "b", (0.5, 0), (1, 0)))
        self.assertFalse(yields("a", (0, 0), (0, 0), "b", (0.5, 0), (0, 0)))

    def test_conflicts_and_exemptions(self):
        world, _ = fresh()
        world.add_visitor(Visitor("ann", Location(10, 4), velocity=(1, 0)))
        world.add_visitor(Visitor("ben", Location(10.6, 4)))
        world.add_visitor(Visitor("cat", Location(30, 4), velocity=(1, 0)))
        c = personal_space_conflicts(world)
        self.assertEqual([(x.stopper, x.other) for x in c], [("ann", "ben")])
        self.assertAlmostEqual(c[0].distance, 0.6)
        self.assertEqual(personal_space_conflicts(world, frozenset({"ann"})), [])


class ArtworkGuardRuleTests(unittest.TestCase):
    def test_p6_only_visitors_closer_than_one_metre(self):
        world, plan = fresh()
        world.add_visitor(Visitor("vis", Location(24, 15.7)))                 # 0.8 m from Installation g8
        world.add_visitor(Visitor("stf", Location(24.5, 16.5), role="staff"))  # staff are never in breach
        world.add_visitor(Visitor("far", Location(6, 4.5)))                    # exactly 1 m from Installation g1
        b = artwork_breaches(plan, world)
        self.assertEqual([(x.visitor, x.artwork) for x in b], [("vis", "Installation g8")])
        self.assertAlmostEqual(b[0].distance, 0.8)

    def test_p7_nearest_free_staff_by_walking(self):
        world, plan = fresh()
        world.add_visitor(Visitor("s1", Location(13, 6.5), role="staff"))   # Gallery 2, through the staff door
        world.add_visitor(Visitor("s2", Location(8, 10), role="staff"))     # corridor: closer in a line, longer walk
        target = Location(9, 6)
        self.assertEqual(nearest_staff(plan, world, target), "s1")
        self.assertEqual(nearest_staff(plan, world, target, exclude={"s1"}), "s2")
        self.assertIsNone(nearest_staff(plan, world, target, exclude={"s1", "s2"}))

    def test_p7_approach_point_is_standoff_from_visitor(self):
        world, plan = fresh()
        visitor, staff = Location(24, 15.7), Location(28.5, 13)
        p = approach_point(plan, staff, visitor)
        self.assertAlmostEqual(p.distance_to(visitor), STAFF_STANDOFF_M)
        self.assertEqual(plan.room_at(p), "Gallery 8")

    def test_p8_step_back_point(self):
        _, plan = fresh()
        p = step_back_point(plan, "Installation g8", Location(24, 15.7))
        self.assertAlmostEqual(p.x, 24)
        self.assertAlmostEqual(p.y, 16.5 - STEP_BACK_TO_M)
        on = step_back_point(plan, "Installation g8", Location(24, 16.5))   # on the artwork: towards the hall centre
        self.assertAlmostEqual(on.distance_to(Location(24, 16.5)), STEP_BACK_TO_M)
        self.assertLess(on.y, 16.5)


if __name__ == "__main__":
    unittest.main()
