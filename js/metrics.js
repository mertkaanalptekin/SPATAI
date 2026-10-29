// Distance metrics on the exhibition floor plan (docs/SIMULATION_METRICS.md R7-R14).
// JavaScript port of spatai/metrics.py; tests/test_js_parity.py checks both agree, so keep the
// arithmetic (plain sqrt) and tie-breaks (pop the smallest [distance, node]) in step.
//
//   euclidean  d_E    straight line, metres (R7)
//   walk       W      shortest walk through rooms and doors, metres (R8, support only)
//   seq        d_seq  directed valve-graph quasimetric, steps (R9, Case II)
//   task       d_L    walk pinned to the exhibits L, metres (R10, Case III)

import { EPSILON } from './spatial.js';
import { CHECKOUT, ENTRANCE, HALLS } from './exhibition.js';

export const INF = Infinity;
export const NEAR = 0.2;
export const FAR = 0.5;
export const METRICS = ['euclidean', 'seq', 'task'];
export const METRIC_LABELS = { euclidean: 'Euclidean', seq: 'd_seq', task: 'd_L' };
export const METRIC_UNITS = { euclidean: 'm', seq: 'steps', task: 'm' };
export const REFERENCE_NODES = [ENTRANCE, ...HALLS, CHECKOUT];

const xy = (loc) => { const w = loc.toWorld(); return [w.x, w.y]; };
const dist = (p, q) => { const dx = q[0] - p[0], dy = q[1] - p[1]; return Math.sqrt(dx * dx + dy * dy); };
const measureOf = (value, path, nodes = [], approx = false) => ({ value, path, nodes, approx });

// R7 -------------------------------------------------------------------------
export function euclidean(a, b) {
  return measureOf(a.distanceTo(b), [xy(a), xy(b)]);
}

// R8 -------------------------------------------------------------------------
function keyLess(a, b) { return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]); }

/** Dijkstra that always pops the smallest [distance, node], like Python's heapq. */
function dijkstra(start, target, neighbours) {
  const best = new Map([[start, 0]]);
  const prev = new Map();
  const heap = [[0, start]];
  const done = new Set();
  while (heap.length) {
    let i = 0;
    for (let j = 1; j < heap.length; j++) if (keyLess(heap[j], heap[i])) i = j;
    const [d, node] = heap.splice(i, 1)[0];
    if (done.has(node)) continue;
    done.add(node);
    if (node === target) break;
    for (const [next, w] of neighbours(node)) {
      const nd = d + w;
      if (nd < (best.has(next) ? best.get(next) : INF) - EPSILON) {
        best.set(next, nd);
        prev.set(next, node);
        heap.push([nd, next]);
      }
    }
  }
  if (!best.has(target)) return [INF, []];
  const path = [target];
  for (let n = target; n !== start;) { n = prev.get(n); path.push(n); }
  return [best.get(target), path.reverse()];
}

export function walk(plan, a, b, role = 'visitor') {
  const ra = plan.roomAt(a), rb = plan.roomAt(b);
  if (ra === null || rb === null) return measureOf(INF, []);
  const pa = xy(a), pb = xy(b);
  if (ra === rb) return measureOf(dist(pa, pb), [pa, pb]);
  const doors = new Map([...plan.doors].filter(([, d]) => role === 'staff' || !d.staffOnly));
  const START = '@a', END = '@b';
  const neighbours = (node) => {
    if (node === START) return [...doors.values()].filter((d) => d.rooms.includes(ra)).map((d) => [d.doorId, dist(pa, d.point)]);
    const door = doors.get(node);
    const out = [...doors.values()]
      .filter((o) => o.doorId !== node && o.rooms.some((r) => door.rooms.includes(r)))
      .map((o) => [o.doorId, dist(door.point, o.point)]);
    if (door.rooms.includes(rb)) out.push([END, dist(door.point, pb)]);
    return out;
  };
  const [total, nodes] = dijkstra(START, END, neighbours);
  if (total === INF) return measureOf(INF, []);
  return measureOf(total, [pa, ...nodes.slice(1, -1).map((n) => doors.get(n).point), pb]);
}

// R9 -------------------------------------------------------------------------
/** [node, snapped]: the sequence node of a location, and whether it was snapped from the corridor. */
export function seqNode(plan, location) {
  const room = plan.roomAt(location);
  if (room === null) return [null, false];
  const node = plan.roomNode.get(room);
  if (node !== null) return [node, false];
  const ranked = HALLS.map((h) => [location.distanceTo(plan.centre(h)), h]).sort((p, q) => (keyLess(p, q) ? -1 : keyLess(q, p) ? 1 : 0));
  return [ranked[0][1], true];
}

export function seqEdges(plan, role = 'visitor', strict = false) {
  return plan.seqEdges.filter((e) => (e.kind !== 'staff' || role === 'staff') && (e.kind !== 'reset' || !strict));
}

/** d_seq between two sequence nodes: [steps, nodes, edges used]. */
export function seqBetween(plan, src, dst, role = 'visitor', strict = false) {
  const out = new Map();
  for (const e of seqEdges(plan, role, strict)) {
    if (!out.has(e.src)) out.set(e.src, []);
    out.get(e.src).push(e);
  }
  if (src === dst) return [0, [src], []];
  const [total, nodes] = dijkstra(src, dst, (n) => (out.get(n) ?? []).map((e) => [e.dst, e.weight]));
  if (total === INF) return [INF, [], []];
  const used = [];
  for (let i = 0; i + 1 < nodes.length; i++) {
    let pick = null;
    for (const e of out.get(nodes[i])) {
      if (e.dst !== nodes[i + 1]) continue;
      const k = [e.weight, e.kind !== 'forward' ? 1 : 0];
      if (pick === null || k[0] < pick.k[0] || (k[0] === pick.k[0] && k[1] < pick.k[1])) pick = { e, k };
    }
    used.push(pick.e);
  }
  return [total, nodes, used];
}

export function seq(plan, a, b, role = 'visitor', strict = false) {
  const [na, approxA] = seqNode(plan, a);
  const [nb, approxB] = seqNode(plan, b);
  if (na === null || nb === null) return measureOf(INF, []);
  const [total, nodes, used] = seqBetween(plan, na, nb, role, strict);
  if (total === INF) return measureOf(INF, [], [na, nb], approxA || approxB);
  const path = [xy(a)];
  for (const e of used) {
    for (const d of e.via) path.push(plan.doors.get(d).point);
    path.push(xy(plan.centre(e.dst)));
  }
  if (used.length) path[path.length - 1] = xy(b);
  else path.push(xy(b));
  return measureOf(total, path, nodes, approxA || approxB);
}

/** The edges d_seq uses, for drawing arrows hall by hall. */
export function seqUsedEdges(plan, a, b, role = 'visitor', strict = false) {
  const [na] = seqNode(plan, a), [nb] = seqNode(plan, b);
  if (na === null || nb === null) return [];
  return seqBetween(plan, na, nb, role, strict)[2];
}

// R10 ------------------------------------------------------------------------
function permutations(n) {
  const out = [];
  const rec = (prefix, rest) => {
    if (!rest.length) { out.push(prefix); return; }
    rest.forEach((x, i) => rec([...prefix, x], [...rest.slice(0, i), ...rest.slice(i + 1)]));
  };
  rec([], [...Array(n).keys()]);
  return out;   // lexicographic, like itertools.permutations
}

// Exhibit-to-exhibit legs never change, so they are cached per plan and role.
const exhibitLegs = new WeakMap();

export function task(plan, a, b, role = 'visitor') {
  const names = [...plan.exhibits.keys()];
  const pts = names.map((n) => plan.exhibits.get(n));
  if (!exhibitLegs.has(plan)) exhibitLegs.set(plan, new Map());
  const shared = exhibitLegs.get(plan), local = new Map();
  // Stops are numbered a = -1, exhibits 0..n-1, b = n; memoising legs changes no value.
  const leg = (i, j) => {
    const between = i >= 0 && i < pts.length && j >= 0 && j < pts.length;
    const cache = between ? shared : local;
    const k = `${role}|${i}|${j}`;
    if (!cache.has(k)) {
      const at = (n) => (n === -1 ? a : n === pts.length ? b : pts[n]);
      cache.set(k, walk(plan, at(i), at(j), role));
    }
    return cache.get(k);
  };
  let best = null;
  for (const order of permutations(pts.length)) {
    const stops = [-1, ...order, pts.length];
    let total = 0, path = [];
    for (let i = 0; i + 1 < stops.length; i++) {
      const legValue = leg(stops[i], stops[i + 1]);
      total += legValue.value;
      if (total === INF) break;
      path = path.length ? path.concat(legValue.path.slice(1)) : legValue.path.slice();
    }
    if (total < (best ? best.value : INF) - EPSILON) best = measureOf(total, path, order.map((i) => names[i]));
  }
  return best ?? measureOf(INF, []);
}

// R12-R14 ----------------------------------------------------------------------
export function measure(plan, metric, a, b, role = 'visitor', strict = false) {
  if (metric === 'euclidean') return euclidean(a, b);
  if (metric === 'seq') return seq(plan, a, b, role, strict);
  if (metric === 'task') return task(plan, a, b, role);
  throw new Error(`unknown metric '${metric}'`);
}

/** Min and max of each metric over ordered pairs of reference nodes (visitor, resets on). */
export function referenceRanges(plan) {
  const pts = REFERENCE_NODES.map((n) => plan.centre(n));
  const out = {};
  for (const m of METRICS) {
    const vals = pts.flatMap((a) => pts.map((b) => measure(plan, m, a, b).value)).filter((v) => v !== INF);
    out[m] = [Math.min(...vals), Math.max(...vals)];
  }
  return out;
}

export function normalize(value, [lo, hi]) {
  if (value === INF) return 1;
  if (hi - lo <= EPSILON) return 0;
  return Math.min(1, Math.max(0, (value - lo) / (hi - lo)));
}

/** metric -> [raw, normalised] distance from the visitor to the target, in the visitor's role. */
export function visitorProfile(plan, world, userId, target, ranges, strict = false) {
  const v = world.visitors.get(userId);
  const out = {};
  for (const m of METRICS) {
    const raw = measure(plan, m, v.position, target, v.role, strict).value;
    out[m] = [raw, normalize(raw, ranges[m])];
  }
  return out;
}

/** R13: visitors inferred near the target under each metric. */
export function occupancy(plan, world, target, ranges, strict = false) {
  const near = Object.fromEntries(METRICS.map((m) => [m, []]));
  for (const uid of world.visitors.keys()) {
    const prof = visitorProfile(plan, world, uid, target, ranges, strict);
    for (const m of METRICS) if (prof[m][1] <= NEAR + EPSILON) near[m].push(uid);
  }
  return near;
}

/** R14: near by one metric, far by another. */
export function discrepancies(plan, world, target, ranges, strict = false) {
  const out = [];
  for (const uid of world.visitors.keys()) {
    const prof = visitorProfile(plan, world, uid, target, ranges, strict);
    for (const m1 of METRICS) {
      for (const m2 of METRICS) {
        if (m1 !== m2 && prof[m1][1] <= NEAR + EPSILON && prof[m2][1] >= FAR - EPSILON) {
          out.push({ userId: uid, nearMetric: m1, farMetric: m2, nearValue: prof[m1][0], farValue: prof[m2][0], nearNorm: prof[m1][1], farNorm: prof[m2][1] });
        }
      }
    }
  }
  return out;
}

/** R11: which metric axioms hold over the reference nodes (visitor, resets on). */
export function axiomReport(plan) {
  const nodes = REFERENCE_NODES;
  const pts = new Map(nodes.map((n) => [n, plan.centre(n)]));
  const d = new Map(), p = new Map();
  for (const a of nodes) for (const b of nodes) {
    d.set(`${a}|${b}`, seqBetween(plan, a, b)[0]);
    p.set(`${a}|${b}`, task(plan, pts.get(a), pts.get(b)).value);
  }
  const D = (a, b) => d.get(`${a}|${b}`), P = (a, b) => p.get(`${a}|${b}`);
  let asym = 0, tri = true, small = true, sym = true;
  for (const a of nodes) for (const b of nodes) {
    if (a < b && D(a, b) !== D(b, a)) asym++;
    if (Math.abs(P(a, b) - P(b, a)) > 1e-6) sym = false;
    if (P(a, a) > P(a, b) + EPSILON) small = false;
    for (const c of nodes) if (D(a, c) > D(a, b) + D(b, c) + EPSILON) tri = false;
  }
  return {
    seq_asymmetric_pairs: asym,
    seq_self_zero: nodes.every((a) => D(a, a) === 0),
    seq_triangle: tri,
    task_self_positive: nodes.every((a) => P(a, a) > 0),
    task_symmetric: sym,
    task_small_self_distance: small,
  };
}
