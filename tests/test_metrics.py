"""Tests for the exhibition plan and metrics, keyed to docs/SIMULATION_METRICS.md."""

import math
import unittest

from spatai import Location
from spatai.exhibition import CHECKOUT, CORRIDOR, ENTRANCE, HALLS, RESET_PASSAGE, build_exhibition
from spatai.metrics import (
    FAR,
    INF,
    METRICS,
    NEAR,
    REFERENCE_NODES,
    axiom_report,
    discrepancies,
    euclidean,
    normalize,
    occupancy,
    reference_ranges,
    seq,
    seq_between,
    seq_node,
    task,
    visitor_profile,
    walk,
)

WORLD, FRAMES, PLAN = build_exhibition()
RANGES = reference_ranges(PLAN)


def g(i):
    return PLAN.centre(HALLS[i - 1])


class FloorPlanTests(unittest.TestCase):
    def test_r1_r2_ten_halls_in_a_folded_snake(self):
        self.assertEqual(len(HALLS), 10)
        self.assertEqual(WORLD.zones["exhibition"].boundary.area, 44 * 19)
        south = [PLAN.rooms[h] for h in HALLS[:5]]
        north = [PLAN.rooms[h] for h in HALLS[5:]]
        self.assertEqual([r.x_min for r in south], [4, 12, 20, 28, 36])   # west -> east
        self.assertEqual([r.x_min for r in north], [36, 28, 20, 12, 4])   # east -> west: the fold
        for name in [*HALLS, ENTRANCE, CHECKOUT, CORRIDOR, RESET_PASSAGE]:
            self.assertIs(WORLD.places[name].parent, WORLD.places["Exhibition"])

    def test_r3_g1_and_g2_share_a_partition_wall(self):
        self.assertEqual(PLAN.rooms["Gallery 1"].x_max, PLAN.rooms["Gallery 2"].x_min)

    def test_r4_every_door_lies_on_both_of_its_rooms(self):
        for d in PLAN.doors.values():
            for room in d.rooms:
                self.assertTrue(PLAN.rooms[room].contains(Location(*d.point)), d.door_id)
        self.assertTrue(PLAN.doors["staff-g1-g2"].staff_only)
        self.assertEqual(sum(d.staff_only for d in PLAN.doors.values()), 1)

    def test_r5_at_most_three_shortcuts(self):
        labels = [e.label for e in PLAN.shortcuts]
        self.assertEqual(labels, ["S1", "S2", "S3"])
        self.assertLessEqual(len(labels), 3)

    def test_r6_exhibits_in_three_different_halls(self):
        self.assertEqual(PLAN.exhibit_hall, {"Exhibit l1": "Gallery 3", "Exhibit l2": "Gallery 6", "Exhibit l3": "Gallery 9"})
        self.assertEqual(WORLD.place_at(Location(24, 2)).name, "Exhibit l1")

    def test_r15_agents(self):
        self.assertEqual({v.user_id: v.role for v in WORLD.visitors.values()},
                         {"alice": "visitor", "bob": "visitor", "carol": "visitor", "sam": "staff"})
        self.assertEqual(set(FRAMES), {"g1-screen", "g2-screen", "g6-screen", "g10-screen"})


class WalkTests(unittest.TestCase):
    def test_same_room_is_straight(self):
        self.assertAlmostEqual(walk(PLAN, Location(5, 1), Location(8, 5)).value, 5)

    def test_through_a_door(self):
        m = walk(PLAN, g(1), g(2))
        self.assertAlmostEqual(m.value, 2 * math.hypot(4, 1.5))
        self.assertEqual(m.path[1], (12.0, 2.5))

    def test_staff_door_only_for_staff(self):
        a, b = Location(11, 6), Location(13, 6)
        self.assertGreater(walk(PLAN, a, b).value, 4)
        self.assertAlmostEqual(walk(PLAN, a, b, role="staff").value, 2)

    def test_walk_ignores_one_way_rules_and_is_symmetric(self):
        self.assertAlmostEqual(walk(PLAN, g(2), g(1)).value, walk(PLAN, g(1), g(2)).value)

    def test_outside_is_unreachable(self):
        self.assertEqual(walk(PLAN, Location(-1, 0), g(1)).value, INF)


class SeqTests(unittest.TestCase):
    def test_r11_asymmetry_between_g1_and_g2(self):
        self.assertEqual(seq(PLAN, g(1), g(2)).value, 1)
        back = seq(PLAN, g(2), g(1))
        self.assertEqual(back.value, 7)
        self.assertEqual(back.nodes, ("Gallery 2", "Gallery 3", "Gallery 4", "Gallery 7", "Gallery 8",
                                      "Gallery 9", "Gallery 10", CHECKOUT, "Gallery 1"))

    def test_r9_brief_example_weight_three_for_four_halls(self):
        # With the express corridor removed, g2 -> g1 loops the whole sequence: g2..g10 -> Exit -> g1.
        self.assertEqual(seq_between(PLAN, "Gallery 2", "Gallery 4")[0] + 0, 2)
        self.assertEqual(seq_between(PLAN, CHECKOUT, "Gallery 1")[0], 0)

    def test_r11_strict_valve_and_staff(self):
        self.assertEqual(seq(PLAN, g(2), g(1), strict=True).value, INF)
        self.assertEqual(seq(PLAN, g(2), g(1), role="staff").value, 1)
        self.assertEqual(seq(PLAN, g(2), g(1), role="staff", strict=True).value, 1)

    def test_r5_shortcuts_change_distances(self):
        self.assertEqual(seq(PLAN, g(4), g(7)).value, 1)          # S2
        self.assertEqual(seq(PLAN, g(7), g(4)).value, 3)          # g7 -> g8 -> g3 (S3) -> g4
        self.assertEqual(seq(PLAN, g(8), g(3)).value, 1)          # S3

    def test_r11_quasimetric_axioms(self):
        report = axiom_report(PLAN)
        self.assertTrue(report["seq_self_zero"])
        self.assertTrue(report["seq_triangle"])
        self.assertGreater(report["seq_asymmetric_pairs"], 0)

    def test_r9_room_to_node_mapping(self):
        self.assertEqual(seq_node(PLAN, Location(2, 9)), (CHECKOUT, False))     # Reset Passage
        self.assertEqual(seq_node(PLAN, Location(25, 9.5)), ("Gallery 3", True))  # corridor, snapped
        self.assertTrue(seq(PLAN, Location(25, 9.5), g(5)).approx)

    def test_same_hall_is_zero(self):
        self.assertEqual(seq(PLAN, Location(5, 1), Location(11, 7)).value, 0)


class TaskTests(unittest.TestCase):
    def test_r11_self_distance_positive(self):
        x = PLAN.centre(ENTRANCE)
        self.assertEqual(euclidean(x, x).value, 0)
        m = task(PLAN, x, x)
        self.assertGreater(m.value, 0)
        self.assertEqual(m.path[0], m.path[-1])
        self.assertEqual(len(m.nodes), 3)

    def test_band_visits_every_exhibit(self):
        m = task(PLAN, PLAN.centre(ENTRANCE), PLAN.centre(CHECKOUT))
        for loc in PLAN.exhibits.values():
            self.assertIn((loc.x, loc.y), m.path)

    def test_r11_symmetric_but_not_small_self_distance(self):
        report = axiom_report(PLAN)
        self.assertTrue(report["task_self_positive"])
        self.assertTrue(report["task_symmetric"])
        # The pinned band breaks p(a, a) <= p(a, b): reported, not assumed (R11).
        self.assertFalse(report["task_small_self_distance"])

    def test_never_shorter_than_plain_walk(self):
        for a in REFERENCE_NODES:
            for b in REFERENCE_NODES:
                pa, pb = PLAN.centre(a), PLAN.centre(b)
                self.assertGreaterEqual(task(PLAN, pa, pb).value + 1e-9, walk(PLAN, pa, pb).value)


class InferenceTests(unittest.TestCase):
    def test_r12_normalisation(self):
        self.assertEqual(RANGES["euclidean"][0], 0)
        self.assertEqual(RANGES["seq"], (0, 9))
        self.assertGreater(RANGES["task"][0], 0)
        self.assertEqual(normalize(INF, RANGES["seq"]), 1)
        self.assertEqual(normalize(-5, RANGES["euclidean"]), 0)

    def test_r14_bob_near_by_euclid_far_by_seq(self):
        found = {(d.user_id, d.near_metric, d.far_metric) for d in discrepancies(PLAN, WORLD, g(1), RANGES)}
        self.assertIn(("bob", "euclidean", "seq"), found)
        self.assertNotIn(("sam", "euclidean", "seq"), found)   # staff: the emergency door

    def test_r13_occupancy_differs_by_metric(self):
        near = occupancy(PLAN, WORLD, g(1), RANGES)
        self.assertIn("bob", near["euclidean"])
        self.assertNotIn("bob", near["seq"])
        self.assertIn("sam", near["seq"])

    def test_profile_thresholds(self):
        prof = visitor_profile(PLAN, WORLD, "bob", g(1), RANGES)
        self.assertLessEqual(prof["euclidean"][1], NEAR)
        self.assertGreaterEqual(prof["seq"][1], FAR)
        self.assertEqual(set(prof), set(METRICS))


if __name__ == "__main__":
    unittest.main()
