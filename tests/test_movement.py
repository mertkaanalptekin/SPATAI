"""Tests for the movement prepositions, keyed to docs/MOVEMENT_PREPOSITIONS.md."""

import math
import unittest

from spatai.movement import REACH, classify, primary

N = 13          # M2: 3 s at 4 Hz
DT = 0.25


def line(x0, y0, vx, vy, n=N):
    return [(x0 + vx * DT * i, y0 + vy * DT * i) for i in range(n)]


def orbit(cx, cy, r, a0, omega, n=N):
    return [(cx + r * math.cos(a0 + omega * DT * i), cy + r * math.sin(a0 + omega * DT * i)) for i in range(n)]


def still(x, y, n=N):
    return [(x, y)] * n


class ClassifyTests(unittest.TestCase):
    def test_m4_toward(self):
        r = classify(line(0, 0, 1, 0), still(5, 0), REACH["screen"])
        self.assertEqual(r.preposition, "toward")
        self.assertAlmostEqual(r.radial, 3)

    def test_m4_away(self):
        self.assertEqual(classify(line(1, 0, -1, 0), still(3, 0), REACH["artwork"]).preposition, "away")

    def test_m4_around_both_directions(self):
        ccw = classify(orbit(0, 0, 1.6, 0, 0.6), still(0, 0), REACH["artwork"])   # 1 m/s on a 1.6 m circle
        self.assertEqual((ccw.preposition, ccw.direction), ("around", "anticlockwise"))
        cw = classify(orbit(0, 0, 1.6, 0, -0.6), still(0, 0), REACH["artwork"])
        self.assertEqual((cw.preposition, cw.direction), ("around", "clockwise"))

    def test_m4_walking_past_is_not_around(self):
        # a straight pass 1.5 m from the artwork sweeps a wide angle but never turns
        self.assertIsNone(classify(line(-1.5, -1.5, 1, 0), still(0, 0), REACH["artwork"]))

    def test_m4_walking_alongside_is_nothing(self):
        self.assertIsNone(classify(line(0, 0, 1, 0), line(0, 1, 1, 0), REACH["agent"]))

    def test_m3_only_own_movement_counts(self):
        # bob stands still while carol walks up to him: bob is not moving toward carol
        self.assertIsNone(classify(still(0, 0), line(3, 0, -1, 0), REACH["agent"]))
        self.assertEqual(classify(line(3, 0, -1, 0), still(0, 0), REACH["agent"]).preposition, "toward")

    def test_m4_out_of_reach_and_too_short(self):
        self.assertIsNone(classify(line(0, 0, 1, 0), still(12, 0), REACH["screen"]))
        self.assertIsNone(classify(line(0, 0, 0.02, 0), still(2, 0), REACH["screen"]))   # 0.06 m moved
        self.assertIsNone(classify(line(0, 0, 1, 0)[:2], still(2, 0)[:2], REACH["screen"]))

    def test_m4_toward_a_moving_agent(self):
        r = classify(line(0, 0, 1, 0), line(4, 0, 0, 0.3), REACH["agent"])
        self.assertEqual(r.preposition, "toward")

    def test_m5_primary(self):
        t = classify(line(0, 0, 1, 0), still(5, 0), 6)
        a = classify(orbit(0, 0, 1.6, 0, 0.6), still(0, 0), 5)
        self.assertEqual(primary([("g1-screen", t), ("Installation g1", a)])[0], "Installation g1")
        self.assertIsNone(primary([]))


if __name__ == "__main__":
    unittest.main()
