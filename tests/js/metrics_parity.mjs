// Run the exhibition/metrics parity spec (JSON on stdin) through js/metrics.js and print
// the answers as JSON. tests/test_js_parity.py runs the same spec through spatai.metrics.
// Keep runMetricQueries() in step with run_metric_queries() there.

import { buildExhibition } from '../../js/exhibition.js';
import {
  METRICS, REFERENCE_NODES, axiomReport, discrepancies, measure, occupancy, referenceRanges, seqNode, walk,
} from '../../js/metrics.js';
import { Circle, Location, Visitor } from '../../js/spatial.js';
import { approachPoint, artworkBreaches, nearestStaff, personalSpaceConflicts, stepBackPoint } from '../../js/proximity.js';

const fin = (v) => (v === Infinity ? 'inf' : v);
const region = (r) => (r instanceof Circle
  ? { kind: 'circle', center: [r.center.x, r.center.y], radius: r.radius }
  : { kind: 'rect', bounds: [r.xMin, r.yMin, r.xMax, r.yMax] });

function runMetricQueries(spec) {
  const { world, frames, plan } = buildExhibition();
  const out = {};
  out.plan = {
    rooms: [...plan.rooms].map(([n, r]) => [n, region(r)]),
    doors: [...plan.doors.values()].map((d) => [d.doorId, d.rooms, d.point, d.staffOnly]),
    edges: plan.seqEdges.map((e) => [e.src, e.dst, e.weight, e.kind, e.via, e.label]),
    exhibits: [...plan.exhibits].map(([n, l]) => [n, [l.x, l.y], plan.exhibitHall.get(n)]),
    artworks: [...plan.artworks].map(([n, l]) => [n, [l.x, l.y], plan.artworkHall.get(n)]),
    shortcuts: plan.shortcuts.map((e) => e.label),
  };
  out.scene = {
    places: [...world.places.values()].map((p) => [p.name, region(p.region), p.parent?.name ?? null]),
    displays: [...world.displays.values()].map((d) => { const w = d.position.toWorld(); return [d.displayId, [w.x, w.y], d.worldOrientation()]; }),
    visitors: [...world.visitors.values()].map((v) => [v.userId, [v.position.x, v.position.y], v.role]),
    frames: Object.keys(frames),
  };

  const pts = REFERENCE_NODES.map((n) => plan.centre(n));
  out.pairs = [];
  for (const role of ['visitor', 'staff']) {
    for (const strict of [false, true]) {
      for (const a of pts) {
        for (const b of pts) {
          const row = [];
          for (const m of METRICS) {
            const r = measure(plan, m, a, b, role, strict);
            row.push([fin(r.value), r.nodes]);
          }
          out.pairs.push(row);
        }
      }
    }
  }

  const targets = spec.targets.map(([x, y]) => new Location(x, y));
  out.points = spec.points.map(([x, y]) => {
    const p = new Location(x, y);
    const [node, snapped] = seqNode(plan, p);
    return {
      room: plan.roomAt(p),
      node: [node, snapped],
      to: targets.map((t) => [fin(walk(plan, p, t).value), fin(measure(plan, 'seq', p, t).value), fin(measure(plan, 'task', p, t).value),
        fin(measure(plan, 'seq', t, p).value), fin(walk(plan, p, t, 'staff').value)]),
    };
  });

  const ranges = referenceRanges(plan);
  out.ranges = ranges;
  out.axioms = axiomReport(plan);
  out.inference = targets.map((t) => ({
    occupancy: occupancy(plan, world, t, ranges),
    strict: occupancy(plan, world, t, ranges, true),
    discrepancies: discrepancies(plan, world, t, ranges).map((d) => [d.userId, d.nearMetric, d.farMetric, fin(d.nearValue), fin(d.farValue)]),
  }));
  // Proximity rules (PROXIMITY_RULES.md P13): the same agent scenarios through both ports.
  out.proximity = spec.proximity.map((agents) => {
    for (const id of [...world.visitors.keys()]) world.remove(id);
    for (const [id, x, y, vx, vy, role] of agents) world.addVisitor(new Visitor(id, new Location(x, y), { velocity: [vx, vy], role }));
    const pt = (l) => [l.x, l.y];
    return {
      conflicts: personalSpaceConflicts(world).map((c) => [c.stopper, c.other, c.distance]),
      breaches: artworkBreaches(plan, world).map((b) => {
        const v = world.visitors.get(b.visitor);
        const staff = nearestStaff(plan, world, v.position);
        return [b.visitor, b.artwork, b.distance, staff,
          staff ? pt(approachPoint(plan, world.visitors.get(staff).position, v.position)) : null,
          pt(stepBackPoint(plan, b.artwork, v.position))];
      }),
    };
  });
  return out;
}

let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => { process.stdout.write(JSON.stringify(runMetricQueries(JSON.parse(input)))); });
