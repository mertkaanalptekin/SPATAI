import math
import unittest

from spatai import WORLD_FRAME, Circle, Location, Rect, ReferenceFrame


class ReferenceFrameTests(unittest.TestCase):
    def test_world_location_is_unchanged(self):
        loc = Location(3, 4).to_world()
        self.assertEqual((loc.x, loc.y), (3, 4))

    def test_translated_frame(self):
        f = ReferenceFrame("room", origin=(10, 5))
        w = Location(1, 2, f).to_world()
        self.assertAlmostEqual(w.x, 11)
        self.assertAlmostEqual(w.y, 7)

    def test_rotated_frame(self):
        f = ReferenceFrame("rot", origin=(10, 0), rotation=90)
        w = Location(1, 0, f).to_world()  # +x of frame points along world +y
        self.assertAlmostEqual(w.x, 10)
        self.assertAlmostEqual(w.y, 1)

    def test_nested_rotated_frames_round_trip(self):
        hall = ReferenceFrame("hall", origin=(5, 5), rotation=30)
        booth = ReferenceFrame("booth", origin=(2, -1), rotation=-75, parent=hall)
        loc = Location(1.5, 2.5, booth)
        back = loc.to_world().in_frame(booth)
        self.assertAlmostEqual(back.x, 1.5)
        self.assertAlmostEqual(back.y, 2.5)
        self.assertAlmostEqual(booth.world_rotation(), -45)

    def test_distance_across_frames(self):
        f = ReferenceFrame("rot", origin=(0, 0), rotation=180)
        self.assertAlmostEqual(Location(1, 0, f).distance_to(Location(-1, 0)), 0)

    def test_frame_cycle_detected(self):
        a = ReferenceFrame("a")
        b = ReferenceFrame("b", parent=a)
        a.parent = b
        with self.assertRaises(ValueError):
            a.world_rotation()


class RegionTests(unittest.TestCase):
    def test_rect_boundary_is_inclusive(self):
        r = Rect(0, 0, 4, 2)
        for p in [(0, 0), (4, 2), (4, 1), (2, 0)]:
            self.assertTrue(r.contains(Location(*p)), p)
        self.assertFalse(r.contains(Location(4.001, 1)))

    def test_rect_in_rotated_frame(self):
        f = ReferenceFrame("rot", rotation=90)
        r = Rect(0, 0, 4, 1, f)  # covers world x in [-1, 0], y in [0, 4]
        self.assertTrue(r.contains(Location(-0.5, 3)))
        self.assertTrue(r.contains(Location(-1, 4)))  # rotated corner
        self.assertFalse(r.contains(Location(3, 0.5)))

    def test_rect_rejects_inverted_corners(self):
        with self.assertRaises(ValueError):
            Rect(2, 0, 1, 1)

    def test_circle_boundary_is_inclusive(self):
        c = Circle(Location(0, 0), 2)
        self.assertTrue(c.contains(Location(2, 0)))
        self.assertTrue(c.contains(Location(math.sqrt(2), math.sqrt(2))))
        self.assertFalse(c.contains(Location(2.01, 0)))

    def test_zero_radius_circle_contains_only_its_centre(self):
        c = Circle(Location(1, 1), 0)
        self.assertTrue(c.contains(Location(1, 1)))
        self.assertFalse(c.contains(Location(1, 1.1)))

    def test_centroids(self):
        f = ReferenceFrame("f", origin=(1, 1))
        self.assertEqual(Rect(0, 0, 4, 2, f).centroid(), Location(2, 1, f))
        self.assertIs(Rect(0, 0, 1, 1).centroid().frame, WORLD_FRAME)


if __name__ == "__main__":
    unittest.main()
