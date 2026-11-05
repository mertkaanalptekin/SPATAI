"""docs/EXPLORATION.md: senses, the visitor's own map, exploring, interests and routes."""

import itertools
import math
import unittest

from spatai import exploration as X
from spatai.exhibition import CORRIDOR, ENTRANCE, HALLS, RESET_PASSAGE, build_exhibition

WORLD, _, PLAN = build_exhibition()
WALLS = X.build_walls(PLAN)
ARTWORKS = {n: (l.to_world().x, l.to_world().y) for n, l in PLAN.artworks.items()}
ENTITIES = dict(ARTWORKS)
for _d in WORLD.displays.values():
    _w = _d.position.to_world()
    ENTITIES[_d.display_id] = (_w.x, _w.y)
NONE = bytearray(WALLS.nx * WALLS.ny)


def explore(start=(2.0, 4.0), heading=0.0, speed=1.0, limit=900.0):
    """A kinematic explorer following E2 and E5; returns (map, seconds)."""
    cmap, pos, t, wps, pause = X.new_map(WALLS), start, 0.0, [], 0.0
    while t < limit:
        gaze = heading + (math.radians(60) * math.sin(t * 2 * math.pi / 2.5) if pause > 0 else 0)
        X.observe(WALLS, cmap, pos, gaze, ENTITIES)
        if not wps and pause <= 0:
            blocked = X.keepout(WALLS, cmap, ARTWORKS)
            f = X.next_frontier(WALLS, cmap, pos, heading, blocked)
            if f is None:
                return cmap, t
            cells, _ = X.path_cells(WALLS, cmap, pos, f[0], blocked)
            wps = X.smooth(WALLS, cmap, pos, cells, blocked) or [WALLS.centre(f[0])]
        if pause > 0:
            pause -= 0.25
        else:
            rem = speed * 0.25
            while rem > 0 and wps:
                dx, dy = wps[0][0] - pos[0], wps[0][1] - pos[1]
                d = math.hypot(dx, dy)
                if d > 1e-9:
                    heading = math.atan2(dy, dx)
                if d <= rem:
                    pos, rem = wps.pop(0), rem - d
                else:
                    pos, rem = (pos[0] + dx / d * rem, pos[1] + dy / d * rem), 0
            if not wps:
                pause = 1.0
        t += 0.25
    return cmap, t


class WallTests(unittest.TestCase):
    def test_grid(self):
        self.assertEqual((WALLS.nx, WALLS.ny), (88, 38))   # E3

    def test_doors_are_openings(self):
        for d in PLAN.doors.values():
            if d.staff_only:
                self.assertNotIn(d.door_id, WALLS.door_edges, "E2: the staff door is closed to visitors")
            else:
                self.assertEqual(len(WALLS.door_edges[d.door_id]), 2, d.door_id)   # 1.2 m gap -> two 0.5 m edges
        staff = X.build_walls(PLAN, "staff")
        self.assertIn("staff-g1-g2", staff.door_edges)

    def test_walls_between_rooms(self):
        a, b = WALLS.cell_of((3.75, 9.25)), WALLS.cell_of((4.25, 9.25))   # Reset Passage | corridor: no door
        self.assertEqual((WALLS.room[a], WALLS.room[b]), (RESET_PASSAGE, CORRIDOR))
        self.assertFalse(WALLS.open_between(a, b))
        a, b = WALLS.cell_of((3.75, 3.75)), WALLS.cell_of((4.25, 3.75))   # the entry door
        self.assertTrue(WALLS.open_between(a, b))
        self.assertTrue(WALLS.block_e[WALLS.cell_of((43.75, 5))], "outer wall")


class SenseTests(unittest.TestCase):
    def test_starts_empty(self):
        cmap = X.new_map(WALLS)   # E1
        self.assertEqual((X.coverage(cmap), cmap.rooms, cmap.view_time), (0, [], {}))

    def test_cone_range_and_walls(self):
        vis = set(X.visible_cells(WALLS, (2.0, 4.0), 0.0))      # E2: in the Entrance, looking east
        self.assertIn(WALLS.cell_of((7.25, 4.25)), vis, "through the entry door")
        self.assertNotIn(WALLS.cell_of((6.25, 7.25)), vis, "behind the Entrance wall")
        self.assertNotIn(WALLS.cell_of((8.75, 4.25)), vis, "beyond 6 m")
        self.assertNotIn(WALLS.cell_of((0.25, 4.25)), vis, "behind, outside the near sense")
        self.assertIn(WALLS.cell_of((1.25, 4.25)), vis, "behind, within the 1 m near sense")
        self.assertNotIn(WALLS.cell_of((2.25, 7.25)), vis, "outside the 120 degree cone")

    def test_staff_door_blocks_sight(self):
        vis = set(X.visible_cells(WALLS, (10.0, 6.0), 0.0))   # Gallery 1, facing the staff door at (12, 6)
        self.assertNotIn(WALLS.cell_of((13.25, 6.25)), vis)
        staff = X.build_walls(PLAN, "staff")
        self.assertIn(staff.cell_of((13.25, 6.25)), set(X.visible_cells(staff, (10.0, 6.0), 0.0)))

    def test_observe_records(self):
        cmap = X.new_map(WALLS)   # E3
        o = X.observe(WALLS, cmap, (2.0, 4.0), 0.0, ENTITIES)
        self.assertEqual(o["rooms"], [ENTRANCE, HALLS[0]])
        self.assertEqual(o["doors"], ["entry"])
        o = X.observe(WALLS, cmap, (7.0, 3.0), math.radians(60), ENTITIES)
        self.assertIn("Installation g1", o["spotted"])
        X.observe(WALLS, cmap, (7.0, 3.0), math.radians(60), ENTITIES, dt=0.5)
        self.assertEqual(cmap.view_time["Installation g1"], 0.75)
        self.assertEqual(X.observe(WALLS, cmap, (7.0, 3.0), math.radians(60), ENTITIES)["spotted"], [])


class PlanningTests(unittest.TestCase):
    def setUp(self):
        self.cmap = X.new_map(WALLS)
        for gaze in (0, 1.5, 3, -1.5):
            X.observe(WALLS, self.cmap, (2.0, 4.0), gaze, ENTITIES)
            X.observe(WALLS, self.cmap, (7.0, 4.0), gaze, ENTITIES)

    def test_paths_use_seen_cells_and_avoid_artworks(self):
        blocked = X.keepout(WALLS, self.cmap, ARTWORKS)   # E4
        self.assertTrue(any(blocked), "Installation g1 has been spotted")
        goal = WALLS.cell_of((9.25, 7.25))
        cells, length = X.path_cells(WALLS, self.cmap, (1.0, 1.0), goal, blocked)
        self.assertTrue(all(self.cmap.seen[c] and not blocked[c] for c in cells[1:]))
        self.assertGreater(length, 0)
        for c in cells:
            x, y = WALLS.centre(c)
            self.assertGreaterEqual(math.dist((x, y), ARTWORKS["Installation g1"]), X.ARTWORK_KEEPOUT)
        legs = X.smooth(WALLS, self.cmap, (1.0, 1.0), cells, blocked)
        self.assertLess(len(legs), len(cells))
        self.assertEqual(legs[-1], WALLS.centre(goal))

    def test_unknown_cells_are_not_walked(self):
        far = WALLS.cell_of((30.25, 4.25))
        self.assertIsNone(X.path_cells(WALLS, self.cmap, (2.0, 4.0), far, NONE))

    def test_frontier_prefers_ahead(self):
        blocked = X.keepout(WALLS, self.cmap, ARTWORKS)   # E5
        east = X.next_frontier(WALLS, self.cmap, (7.0, 4.0), 0.0, blocked)
        self.assertIsNotNone(east)
        k = east[0]
        self.assertFalse(all(self.cmap.seen[b] for b in X._neighbours4(WALLS, k) if WALLS.open_between(k, b)))

    def test_full_exploration(self):
        cmap, t = explore()   # E5: from the Entrance, at 1 m/s
        self.assertEqual(X.coverage(cmap), 1.0)
        self.assertEqual(len(cmap.rooms), 14)
        self.assertEqual(len(cmap.doors), len([d for d in PLAN.doors.values() if not d.staff_only]))
        self.assertEqual(set(cmap.view_time), set(ENTITIES))
        self.assertLess(t, 330)


class RouteTests(unittest.TestCase):
    def test_interests(self):
        view = {"a": 4.0, "b": 2.0, "c": 2.0, "d": 0.0}   # E8
        self.assertEqual(X.choose_interests(view, {}, {}), ["a", "b", "c"])
        self.assertEqual(X.choose_interests(view, {"b": 0.5}, {}), ["a", "c", "b"])
        self.assertEqual(X.choose_interests(view, {}, {"a": 2}), ["b", "c", "a"])
        self.assertNotIn("d", X.choose_interests(view, {}, {}, k=4), "never seen in view, never chosen")

    def test_route_is_shortest(self):
        import random

        rng = random.Random(3)
        for _ in range(30):
            n = rng.randint(3, 7)
            d = [[rng.uniform(0, 20) for _ in range(n)] for _ in range(n)]
            order, length = X.order_route(d)
            brute = min(sum(d[a][b] for a, b in zip((0, *p), (*p, n - 1)))
                        for p in itertools.permutations(range(1, n - 1)))
            self.assertAlmostEqual(length, brute)
            self.assertEqual(sorted(order), list(range(1, n - 1)))

    def test_viewpoint(self):
        cmap, _ = explore()   # E9
        blocked = X.keepout(WALLS, cmap, ARTWORKS)
        for name, art in ARTWORKS.items():
            p = X.viewpoint(WALLS, cmap, blocked, art, (24.0, 9.5))
            self.assertIsNotNone(p, name)
            self.assertAlmostEqual(math.dist(p, art), X.VIEW_DISTANCE)
            self.assertEqual(WALLS.room[WALLS.cell_of(p)], PLAN.artwork_hall[name])

    def test_checkout_reachable_after_exploring(self):
        cmap, _ = explore()   # E6
        goal = WALLS.cell_of((2.25, 15.25))
        blocked = X.keepout(WALLS, cmap, ARTWORKS)
        self.assertIsNotNone(X.path_cells(WALLS, cmap, (40.0, 4.0), goal, blocked))
        self.assertIsNotNone(X.path_cells(WALLS, cmap, (2.25, 15.25), WALLS.cell_of((2.25, 4.25)), blocked),
                             "Checkout -> Reset Passage -> Entrance")


if __name__ == "__main__":
    unittest.main()
