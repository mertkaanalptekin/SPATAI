// Exploration: a visitor's senses, its own map, and routes built from it (docs/EXPLORATION.md).
// JavaScript port of spatai/exploration.py; tests/test_js_parity.py checks the two agree.
// Cell (i, j) covers x in [x0 + i*CELL, x0 + (i+1)*CELL), y likewise; its index is j*nx + i.

import { Location } from './spatial.js';
import { DOOR_WIDTH } from './exhibition.js';

export const CELL = 0.5;                         // E3
export const VISION_RANGE = 6.0;                 // E2
export const VISION_HALF_ANGLE = (60 * Math.PI) / 180;
export const NEAR_SENSE = 1.0;
export const ARTWORK_KEEPOUT = 1.2;              // E4
export const TURN_COST = 2.0;                    // E5
export const INTERESTS = 3;                      // E8
export const VIEW_DISTANCE = 1.5;                // E9
export const NOVELTY = 0.5;
const SQRT2 = Math.sqrt(2);

export class Walls {
  constructor(x0, y0, nx, ny, blockE, blockN, room, doorEdges) {
    Object.assign(this, { x0, y0, nx, ny, blockE, blockN, room, doorEdges });
  }

  cellOf([x, y]) {
    const i = Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.x0) / CELL)));
    const j = Math.min(this.ny - 1, Math.max(0, Math.floor((y - this.y0) / CELL)));
    return j * this.nx + i;
  }

  centre(k) { return [this.x0 + ((k % this.nx) + 0.5) * CELL, this.y0 + (Math.floor(k / this.nx) + 0.5) * CELL]; }

  openBetween(a, b) {
    if (b === a + 1) return !this.blockE[a];
    if (b === a - 1) return !this.blockE[b];
    if (b === a + this.nx) return !this.blockN[a];
    if (b === a - this.nx) return !this.blockN[b];
    throw new Error('not 4-neighbours');
  }
}

/** E2-E3: a wall between two cells in different rooms, except across a door's opening. */
export function buildWalls(plan, role = 'visitor') {
  const rects = [...plan.rooms.values()];
  const x0 = Math.min(...rects.map((r) => r.xMin)), y0 = Math.min(...rects.map((r) => r.yMin));
  const nx = Math.round((Math.max(...rects.map((r) => r.xMax)) - x0) / CELL);
  const ny = Math.round((Math.max(...rects.map((r) => r.yMax)) - y0) / CELL);
  const room = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) room.push(plan.roomAt(new Location(x0 + (i + 0.5) * CELL, y0 + (j + 0.5) * CELL)));
  const doors = [...plan.doors.values()].filter((d) => role === 'staff' || !d.staffOnly);
  const doorAt = (ra, rb, wx, wy, vertical) => {
    for (const d of doors) {
      if (!(d.rooms.includes(ra) && d.rooms.includes(rb) && ra !== rb)) continue;
      const [px, py] = d.point;
      if (vertical && px === wx && Math.abs(wy - py) < DOOR_WIDTH / 2) return d.doorId;
      if (!vertical && py === wy && Math.abs(wx - px) < DOOR_WIDTH / 2) return d.doorId;
    }
    return null;
  };
  const blockE = new Uint8Array(nx * ny), blockN = new Uint8Array(nx * ny);
  const doorEdges = new Map();
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      for (const vertical of [true, false]) {
        let b, wx, wy;
        if (vertical) {
          if (i === nx - 1) { blockE[k] = 1; continue; }
          b = k + 1; wx = x0 + (i + 1) * CELL; wy = y0 + (j + 0.5) * CELL;
        } else {
          if (j === ny - 1) { blockN[k] = 1; continue; }
          b = k + nx; wx = x0 + (i + 0.5) * CELL; wy = y0 + (j + 1) * CELL;
        }
        const ra = room[k], rb = room[b];
        if (ra === rb) continue;
        const door = ra && rb ? doorAt(ra, rb, wx, wy, vertical) : null;
        if (door === null) (vertical ? blockE : blockN)[k] = 1;
        else { if (!doorEdges.has(door)) doorEdges.set(door, []); doorEdges.get(door).push([k, b]); }
      }
    }
  }
  return new Walls(x0, y0, nx, ny, blockE, blockN, room, doorEdges);
}

// --- sight -----------------------------------------------------------------------------------

/** Walk the cells p → q crosses; false on a wall or a cell `cellOk` rejects. */
function trace(walls, p, q, cellOk = null) {
  const nx = walls.nx;
  let i = Math.min(nx - 1, Math.max(0, Math.floor((p[0] - walls.x0) / CELL)));
  let j = Math.min(walls.ny - 1, Math.max(0, Math.floor((p[1] - walls.y0) / CELL)));
  const target = walls.cellOf(q);
  const ti = target % nx, tj = Math.floor(target / nx);
  const dx = q[0] - p[0], dy = q[1] - p[1];
  const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1;
  let tDx, tMx, tDy, tMy;
  if (dx !== 0) { tDx = CELL / Math.abs(dx); tMx = ((walls.x0 + (i + (dx > 0 ? 1 : 0)) * CELL) - p[0]) / dx; } else { tDx = tMx = Infinity; }
  if (dy !== 0) { tDy = CELL / Math.abs(dy); tMy = ((walls.y0 + (j + (dy > 0 ? 1 : 0)) * CELL) - p[1]) / dy; } else { tDy = tMy = Infinity; }
  const blockedX = (ci, cj, s) => { const k = cj * nx + ci; return s > 0 ? walls.blockE[k] : (ci === 0 || walls.blockE[k - 1]); };
  const blockedY = (ci, cj, s) => { const k = cj * nx + ci; return s > 0 ? walls.blockN[k] : (cj === 0 || walls.blockN[k - nx]); };
  const steps = Math.abs(ti - i) + Math.abs(tj - j) + 2;
  for (let n = 0; n < steps; n++) {
    if (i === ti && j === tj) return true;
    if (tMx < tMy) {
      if (blockedX(i, j, sx)) return false;
      i += sx; tMx += tDx;
    } else if (tMy < tMx) {
      if (blockedY(i, j, sy)) return false;
      j += sy; tMy += tDy;
    } else {
      if (blockedX(i, j, sx) || blockedY(i, j, sy) || blockedY(i + sx, j, sy) || blockedX(i, j + sy, sx)) return false;
      if (cellOk && !(cellOk(j * nx + i + sx) && cellOk((j + sy) * nx + i))) return false;
      i += sx; j += sy; tMx += tDx; tMy += tDy;
    }
    if (cellOk && !cellOk(j * nx + i)) return false;
  }
  return i === ti && j === tj;
}

function neighbours4(walls, k) {
  const i = k % walls.nx, j = Math.floor(k / walls.nx), out = [];
  if (i + 1 < walls.nx) out.push(k + 1);
  if (i > 0) out.push(k - 1);
  if (j + 1 < walls.ny) out.push(k + walls.nx);
  if (j > 0) out.push(k - walls.nx);
  return out;
}

/** E2: cells whose centre is in the vision cone, or within the near sense, and in sight. */
export function visibleCells(walls, pos, gaze) {
  const { nx, ny } = walls;
  const here = walls.cellOf(pos);
  const ci = here % nx, cj = Math.floor(here / nx);
  const reach = Math.ceil(VISION_RANGE / CELL) + 1;
  const gx = Math.cos(gaze), gy = Math.sin(gaze), cosHalf = Math.cos(VISION_HALF_ANGLE);
  const out = [];
  for (let j = Math.max(0, cj - reach); j <= Math.min(ny - 1, cj + reach); j++) {
    for (let i = Math.max(0, ci - reach); i <= Math.min(nx - 1, ci + reach); i++) {
      const k = j * nx + i;
      if (k === here) { out.push(k); continue; }
      const cx = walls.x0 + (i + 0.5) * CELL, cy = walls.y0 + (j + 0.5) * CELL;
      const dx = cx - pos[0], dy = cy - pos[1];
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > VISION_RANGE) continue;
      if (d > NEAR_SENSE && dx * gx + dy * gy < d * cosHalf) continue;
      if (trace(walls, pos, [cx, cy])) out.push(k);
    }
  }
  for (const b of neighbours4(walls, here)) if (walls.openBetween(here, b) && !out.includes(b)) out.push(b);
  return out.sort((a, b) => a - b);
}

// --- the map ---------------------------------------------------------------------------------

/** E3: what one agent knows; it starts empty (E1). */
export class CognitiveMap {
  constructor(size) {
    this.size = size;
    this.seen = new Uint8Array(size);
    this.rooms = [];
    this.doors = [];
    this.viewTime = new Map();
    this.seenCount = 0;
  }
}

export const newMap = (walls) => new CognitiveMap(walls.nx * walls.ny);

/** E2-E3: look once; `entities` is a Map id → [x, y]. */
export function observe(walls, cmap, pos, gaze, entities, dt = 0.25) {
  const vis = visibleCells(walls, pos, gaze);
  const fresh = vis.filter((k) => !cmap.seen[k]);
  for (const k of fresh) cmap.seen[k] = 1;
  cmap.seenCount += fresh.length;
  const rooms = [];
  for (const k of fresh) {
    const r = walls.room[k];
    if (r && !cmap.rooms.includes(r) && !rooms.includes(r)) rooms.push(r);
  }
  cmap.rooms.push(...rooms);
  const doors = [];
  for (const [doorId, edges] of walls.doorEdges) {
    if (!cmap.doors.includes(doorId) && edges.some(([a, b]) => cmap.seen[a] && cmap.seen[b])) doors.push(doorId);
  }
  cmap.doors.push(...doors);
  const visSet = new Set(vis);
  const inView = [...entities].filter(([, p]) => visSet.has(walls.cellOf(p))).map(([e]) => e).sort(cmp);
  const spotted = inView.filter((e) => !cmap.viewTime.has(e));
  for (const e of inView) cmap.viewTime.set(e, (cmap.viewTime.get(e) ?? 0) + dt);
  return { new: fresh, rooms, doors, inView, spotted };
}

export const coverage = (cmap) => cmap.seenCount / cmap.size;

// Python's default string order (code points), not localeCompare.
function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

// --- moving on one's own map -----------------------------------------------------------------

/** E4: cells within ARTWORK_KEEPOUT of an artwork the agent has spotted (`artworks`: Map id → [x, y]). */
export function keepout(walls, cmap, artworks) {
  const out = new Uint8Array(walls.nx * walls.ny);
  const r = Math.ceil(ARTWORK_KEEPOUT / CELL) + 1;
  for (const e of [...artworks.keys()].sort(cmp)) {
    if (!cmap.viewTime.has(e)) continue;
    const [ax, ay] = artworks.get(e);
    const c = walls.cellOf([ax, ay]);
    const ci = c % walls.nx, cj = Math.floor(c / walls.nx);
    for (let j = Math.max(0, cj - r); j <= Math.min(walls.ny - 1, cj + r); j++) {
      for (let i = Math.max(0, ci - r); i <= Math.min(walls.nx - 1, ci + r); i++) {
        const cx = walls.x0 + (i + 0.5) * CELL, cy = walls.y0 + (j + 0.5) * CELL;
        if (Math.sqrt((cx - ax) ** 2 + (cy - ay) ** 2) < ARTWORK_KEEPOUT) out[j * walls.nx + i] = 1;
      }
    }
  }
  return out;
}

function steps(walls, cmap, blocked, k) {
  const { nx, ny } = walls;
  const i = k % nx, j = Math.floor(k / nx);
  const inside = blocked[k];   // a blocked cell can be left but not entered
  const ok = (c) => cmap.seen[c] && (inside || !blocked[c]);
  const out = [];
  for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const a = i + di, b = j + dj;
    if (a >= 0 && a < nx && b >= 0 && b < ny) {
      const c = b * nx + a;
      if (ok(c) && walls.openBetween(k, c)) out.push([c, CELL]);
    }
  }
  for (const [di, dj] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const a = i + di, b = j + dj;
    if (!(a >= 0 && a < nx && b >= 0 && b < ny)) continue;
    const c = b * nx + a, sideX = j * nx + a, sideY = b * nx + i;
    if (ok(c) && ok(sideX) && ok(sideY)
        && walls.openBetween(k, sideX) && walls.openBetween(sideX, c)
        && walls.openBetween(k, sideY) && walls.openBetween(sideY, c)) out.push([c, CELL * SQRT2]);
  }
  return out;
}

/** A binary heap of [d, k], ordered like Python's tuples. */
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  less(x, y) { return x[0] < y[0] || (x[0] === y[0] && x[1] < y[1]); }
  push(v) {
    const a = this.a; a.push(v);
    for (let i = a.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (!this.less(a[i], a[p])) break;
      [a[i], a[p]] = [a[p], a[i]]; i = p;
    }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l], a[m])) m = l;
        if (r < a.length && this.less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]]; i = m;
      }
    }
    return top;
  }
}

/** Dijkstra from `start` over the agent's own map: { dist, prev }. */
export function distances(walls, cmap, start, blocked) {
  const n = walls.nx * walls.ny;
  const dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1);
  dist[start] = 0;
  const heap = new Heap();
  heap.push([0, start]);
  while (heap.size) {
    const [d, k] = heap.pop();
    if (d > dist[k]) continue;
    for (const [c, w] of steps(walls, cmap, blocked, k)) {
      const nd = d + w;
      if (nd < dist[c]) { dist[c] = nd; prev[c] = k; heap.push([nd, c]); }
    }
  }
  return { dist, prev };
}

/** E5: seen, unblocked cells with an open edge to an unknown cell. */
export function frontiers(walls, cmap, blocked) {
  const out = [];
  for (let k = 0; k < walls.nx * walls.ny; k++) {
    if (!cmap.seen[k] || blocked[k]) continue;
    if (neighbours4(walls, k).some((b) => !cmap.seen[b] && walls.openBetween(k, b))) out.push(k);
  }
  return out;
}

/** E5: [cell, cost] of the reachable frontier with the lowest path length + turning cost, or null. */
export function nextFrontier(walls, cmap, pos, heading, blocked) {
  const { dist } = distances(walls, cmap, walls.cellOf(pos), blocked);
  const hx = Math.cos(heading), hy = Math.sin(heading);
  let best = null;
  for (const k of frontiers(walls, cmap, blocked)) {
    if (dist[k] === Infinity) continue;
    const [cx, cy] = walls.centre(k);
    const dx = cx - pos[0], dy = cy - pos[1];
    const d = Math.sqrt(dx * dx + dy * dy);
    const cosTurn = d > 1e-9 ? (dx * hx + dy * hy) / d : 1.0;
    const cost = dist[k] + TURN_COST * (1 - cosTurn);
    if (best === null || cost < best[1]) best = [k, cost];
  }
  return best;
}

/** [cells, length] from the agent's cell to `goal` on its own map, or null. */
export function pathCells(walls, cmap, pos, goal, blocked) {
  const start = walls.cellOf(pos);
  const { dist, prev } = distances(walls, cmap, start, blocked);
  if (dist[goal] === Infinity) return null;
  const cells = [goal];
  while (cells[cells.length - 1] !== start) cells.push(prev[cells[cells.length - 1]]);
  return [cells.reverse(), dist[goal]];
}

/** E4: straight legs that stay in seen, unblocked cells. */
export function smooth(walls, cmap, pos, cells, blocked) {
  const ok = (c) => !!cmap.seen[c] && !blocked[c];
  const out = [];
  let anchor = pos, i = 0;
  const n = cells.length;
  while (i < n - 1) {
    let j = i + 1;
    while (j + 1 < n && trace(walls, anchor, walls.centre(cells[j + 1]), ok)) j++;
    anchor = walls.centre(cells[j]);
    out.push(anchor);
    i = j;
  }
  return out;
}

/** E9: a seen, unblocked spot VIEW_DISTANCE from an artwork, in its room, nearest `origin`. */
export function viewpoint(walls, cmap, blocked, art, origin) {
  const room = walls.room[walls.cellOf(art)];
  let best = null;
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    const p = [art[0] + VIEW_DISTANCE * Math.cos(a), art[1] + VIEW_DISTANCE * Math.sin(a)];
    const c = walls.cellOf(p);
    if (!cmap.seen[c] || blocked[c] || walls.room[c] !== room) continue;
    const d = Math.sqrt((p[0] - origin[0]) ** 2 + (p[1] - origin[1]) ** 2);
    if (best === null || d < best[1]) best = [p, d];
  }
  return best && best[0];
}

// --- interests and routes --------------------------------------------------------------------

/** E8: the k entities with the highest view time × taste × NOVELTY^visits (ties by ID). Maps in, array out. */
export function chooseInterests(viewTime, taste, visits, k = INTERESTS) {
  const scored = [];
  for (const [e, t] of viewTime) {
    if (t <= 0) continue;
    scored.push([-(t * (taste.get(e) ?? 1.0) * NOVELTY ** (visits.get(e) ?? 0)), e]);
  }
  scored.sort((a, b) => (a[0] - b[0]) || cmp(a[1], b[1]));
  return scored.slice(0, k).map(([, e]) => e);
}

/** E8: [order, length] of stops 1..n-2 from 0 to n-1 with the least total; ties go to the first. */
export function orderRoute(dist) {
  const n = dist.length;
  const stops = Array.from({ length: n - 2 }, (_, i) => i + 1);
  let best = [...stops], bestLen = Infinity;
  const rec = (prefix, rest, length, last) => {
    if (length >= bestLen) return;
    if (!rest.length) {
      const total = length + dist[last][n - 1];
      if (total < bestLen) { best = [...prefix]; bestLen = total; }
      return;
    }
    rest.forEach((s, idx) => rec([...prefix, s], [...rest.slice(0, idx), ...rest.slice(idx + 1)], length + dist[last][s], s));
  };
  rec([], stops, 0, 0);
  return [best, bestLen];
}
