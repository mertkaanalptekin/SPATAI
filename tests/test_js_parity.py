"""Check that js/spatial.js and the Python model give the same answers.

Runs one query spec over the demo scene in Python and in Node
(tests/js/parity.mjs) and compares the results. Skipped when Node is not installed.
"""

import json
import math
import shutil
import subprocess
import unittest
from pathlib import Path

from demo import build_scene
from spatai import WORLD_FRAME, Circle, Location, ReferenceFrame, evaluate_rules, should_power_on

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")
FLOAT_TOLERANCE = 1e-9


def _frange(start, stop, step):
    n = round((stop - start) / step)
    return [start + i * step for i in range(n + 1)]


# Every 0.5 m from 2 m outside the lobby on each side: hits zone and place edges,
# the Reception Desk circle, 45-degree cone edges and equidistant points.
SPEC = {
    "points": [[x, y] for x in _frange(-2, 22, 0.5) for y in _frange(-2, 14, 0.5)]
    + [[10 + 1.5 * math.cos(a / 8 * math.pi), 3 + 1.5 * math.sin(a / 8 * math.pi)] for a in range(16)],
    "radii": [0, 1, 2.5, 4],
    "nested": [
        {"chain": [{"origin": [5, 5], "rotation": 30}, {"origin": [2, -1], "rotation": -75}],
         "points": [[0, 0], [1.5, 2.5], [-3, 4]]},
        {"chain": [{"origin": [10, 0], "rotation": 90}, {"origin": [2, 0], "rotation": 90},
                   {"origin": [-1, 3], "rotation": 225}],
         "points": [[1, 0], [0, 1], [7.25, -2.5]]},
    ],
}


def _loc(l):
    w = l.to_world()
    return [w.x, w.y]


def _region(r):
    if isinstance(r, Circle):
        return {"kind": "circle", "center": _loc(r.center), "radius": r.radius, "area": r.area}
    return {"kind": "rect", "bounds": [r.x_min, r.y_min, r.x_max, r.y_max], "frame": r.frame.frame_id, "area": r.area}


def run_queries(spec):
    """Python twin of runQueries() in tests/js/parity.mjs."""
    world, frames = build_scene()
    all_frames = {"world": WORLD_FRAME, **frames}
    ids = [*world.visitors, *world.displays, *world.zones, *world.places]
    out = {}

    out["scene"] = {
        "zones": [{"id": z.zone_id, "boundary": _region(z.boundary), "ambient": z.ambient_light,
                   "displays": sorted(z.display_ids)} for z in world.zones.values()],
        "places": [{"name": p.name, "region": _region(p.region), "parent": p.parent.name if p.parent else None}
                   for p in world.places.values()],
        "displays": [{"id": d.display_id, "world": _loc(d.position), "frame": d.position.frame.frame_id,
                      "orientation": d.world_orientation()} for d in world.displays.values()],
        "visitors": [{"id": v.user_id, "world": _loc(v.position), "dwell": v.dwell_time}
                     for v in world.visitors.values()],
    }

    out["locate"] = {}
    for obj_id in ids:
        l = world.locate(obj_id)
        out["locate"][obj_id] = [l.x, l.y, l.frame.frame_id]

    out["position_in"] = {
        obj_id: {name: [p.x, p.y] for name, f in all_frames.items() for p in [world.position_in(obj_id, f)]}
        for obj_id in ids
    }

    out["points"] = []
    for x, y in spec["points"]:
        l = Location(x, y)
        d = world.describe(l)
        zone, place = world.zone_at(l), world.place_at(l)
        out["points"].append({
            "zone": zone.zone_id if zone else None,
            "place": place.name if place else None,
            "describe": [d.place.name if d.place else None,
                         d.nearest_display.display_id if d.nearest_display else None,
                         d.distance, d.direction, str(d)],
            "occupants": [[v.user_id for v in world.occupants_at(l, r)] for r in spec["radii"]],
        })

    out["nested"] = []
    for case in spec["nested"]:
        frame = None
        for i, f in enumerate(case["chain"]):
            frame = ReferenceFrame(f"f{i}", origin=tuple(f["origin"]), rotation=f["rotation"], parent=frame)
        pts = []
        for x, y in case["points"]:
            w = Location(x, y, frame).to_world()
            back = w.in_frame(frame)
            pts.append([w.x, w.y, back.x, back.y])
        out["nested"].append({"world_rotation": frame.world_rotation(), "points": pts})

    out["should_power_on"] = {d: should_power_on(world, "lobby", d) for d in world.displays}
    out["occupancy"] = {z: world.occupancy(z) for z in world.zones}
    out["evaluate_rules"] = [d.display_id for d in evaluate_rules(world)]
    return out


@unittest.skipIf(NODE is None, "node is not installed")
class JsParityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.py = json.loads(json.dumps(run_queries(SPEC)))  # tuples -> lists, like the JS side
        proc = subprocess.run(
            [NODE, str(ROOT / "tests" / "js" / "parity.mjs")],
            input=json.dumps(SPEC), capture_output=True, text=True, check=True, timeout=60,
        )
        cls.js = json.loads(proc.stdout)

    def assertSame(self, py, js, path="$"):
        if isinstance(py, float) or isinstance(js, float):
            self.assertIsInstance(js, (int, float), path)
            self.assertTrue(math.isclose(py, js, rel_tol=0, abs_tol=FLOAT_TOLERANCE), f"{path}: {py} != {js}")
        elif isinstance(py, dict):
            self.assertEqual(sorted(py), sorted(js), path)
            for k in py:
                self.assertSame(py[k], js[k], f"{path}.{k}")
        elif isinstance(py, list):
            self.assertEqual(len(py), len(js), path)
            for i, (a, b) in enumerate(zip(py, js)):
                self.assertSame(a, b, f"{path}[{i}]")
        else:
            self.assertEqual(py, js, path)

    def test_same_scene(self):
        self.assertSame(self.py["scene"], self.js["scene"], "scene")

    def test_locate(self):
        self.assertSame(self.py["locate"], self.js["locate"], "locate")

    def test_position_in(self):
        self.assertSame(self.py["position_in"], self.js["position_in"], "position_in")
        self.assertSame(self.py["position_in"]["bob"]["gallery-screen"], [3.0, -2.0])

    def test_point_queries(self):
        self.assertEqual(len(self.py["points"]), len(SPEC["points"]))
        for i, (py, js) in enumerate(zip(self.py["points"], self.js["points"])):
            self.assertSame(py, js, f"points[{i}] at {SPEC['points'][i]}")

    def test_point_queries_cover_every_outcome(self):
        seen = {p["describe"][3] for p in self.py["points"]}
        self.assertEqual(seen, {"front", "behind", "left", "right", "at"})
        self.assertEqual({p["place"] for p in self.py["points"]},
                         {None, "Main Lobby", "Entrance", "Reception Desk", "Gallery Corner"})

    def test_nested_frames(self):
        self.assertSame(self.py["nested"], self.js["nested"], "nested")

    def test_rules(self):
        for key in ["should_power_on", "occupancy", "evaluate_rules"]:
            self.assertSame(self.py[key], self.js[key], key)
        self.assertEqual(self.py["evaluate_rules"], ["welcome-screen"])

    def test_js_only_helpers(self):
        """Run the Node tests for helpers with no Python counterpart (text resolution)."""
        proc = subprocess.run(
            [NODE, "--test", str(ROOT / "tests" / "js" / "spatial.test.mjs")],
            capture_output=True, text=True, timeout=60,
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)


if __name__ == "__main__":
    unittest.main()
