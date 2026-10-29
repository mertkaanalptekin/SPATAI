// Run the parity query spec (JSON on stdin) against the JavaScript model and print
// the answers as JSON. tests/test_js_parity.py runs the same spec through Python
// and compares. Keep runQueries() in step with run_queries() there.

import { buildScene } from '../../js/scene.js';
import { Circle, Location, ReferenceFrame, WORLD_FRAME, evaluateRules, shouldPowerOn } from '../../js/spatial.js';

const loc = (l) => { const w = l.toWorld(); return [w.x, w.y]; };

function region(r) {
  return r instanceof Circle
    ? { kind: 'circle', center: loc(r.center), radius: r.radius, area: r.area }
    : { kind: 'rect', bounds: [r.xMin, r.yMin, r.xMax, r.yMax], frame: r.frame.frameId, area: r.area };
}

function runQueries(spec) {
  const { world, frames } = buildScene();
  const allFrames = { world: WORLD_FRAME, ...frames };
  const ids = [...world.visitors.keys(), ...world.displays.keys(), ...world.zones.keys(), ...world.places.keys()];
  const out = {};

  out.scene = {
    zones: [...world.zones.values()].map((z) => ({ id: z.zoneId, boundary: region(z.boundary), ambient: z.ambientLight, displays: [...z.displayIds].sort() })),
    places: [...world.places.values()].map((p) => ({ name: p.name, region: region(p.region), parent: p.parent?.name ?? null })),
    displays: [...world.displays.values()].map((d) => ({ id: d.displayId, world: loc(d.position), frame: d.position.frame.frameId, orientation: d.worldOrientation() })),
    visitors: [...world.visitors.values()].map((v) => ({ id: v.userId, world: loc(v.position), dwell: v.dwellTime })),
  };

  out.locate = Object.fromEntries(ids.map((id) => {
    const l = world.locate(id);
    return [id, [l.x, l.y, l.frame.frameId]];
  }));

  out.position_in = Object.fromEntries(ids.map((id) => [id, Object.fromEntries(
    Object.entries(allFrames).map(([name, f]) => { const p = world.positionIn(id, f); return [name, [p.x, p.y]]; }))]));

  out.points = spec.points.map(([x, y]) => {
    const l = new Location(x, y);
    const d = world.describe(l);
    return {
      zone: world.zoneAt(l)?.zoneId ?? null,
      place: world.placeAt(l)?.name ?? null,
      describe: [d.place?.name ?? null, d.nearestDisplay?.displayId ?? null, d.distance, d.direction, String(d)],
      occupants: spec.radii.map((r) => world.occupantsAt(l, r).map((v) => v.userId)),
    };
  });

  out.nested = spec.nested.map(({ chain, points }) => {
    let frame = null;
    chain.forEach(({ origin, rotation }, i) => { frame = new ReferenceFrame(`f${i}`, { origin, rotation, parent: frame }); });
    return {
      world_rotation: frame.worldRotation(),
      points: points.map(([x, y]) => {
        const w = new Location(x, y, frame).toWorld();
        const back = w.inFrame(frame);
        return [w.x, w.y, back.x, back.y];
      }),
    };
  });

  out.should_power_on = Object.fromEntries([...world.displays.keys()].map((id) => [id, shouldPowerOn(world, 'lobby', id)]));
  out.occupancy = Object.fromEntries([...world.zones.keys()].map((id) => [id, world.occupancy(id)]));
  out.evaluate_rules = evaluateRules(world).map((d) => d.displayId);
  return out;
}

let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => { process.stdout.write(JSON.stringify(runQueries(JSON.parse(input)))); });
