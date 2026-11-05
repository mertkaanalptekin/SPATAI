// A visitor's mind (docs/EXPLORATION.md E1, E5-E10): what it has seen, which run it is on,
// and where it walks next, planned on its own map with js/exploration.js. No three.js here:
// positions are model (x, y) metres and angles are model radians (anticlockwise from +x).

import * as X from './exploration.js';
import { CHECKOUT, ENTRANCE } from './exhibition.js';

export const LOOK_HZ = 4;                                  // E2
export const LOOK_AROUND = (60 * Math.PI) / 180;           // gaze sweep while standing
export const LOOK_PERIOD = 2.5;
export const PHASE_LABEL = { explore: 'exploring', exit: 'to the Checkout', reset: 'to the Entrance', route: 'route' };
const EXIT_POINT = [2.25, 15.25];       // inside the Checkout
const START_POINT = [2.25, 4.25];       // inside the Entrance
const ARRIVED = 0.8;                    // metres from a leg's goal that count as there
const SCREEN_VIEW = 1.5;                // E9
const AVOID_R = 1.4;                    // E10: metres kept from an agent it had to stop for

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const fmtDuration = (s) => (s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${Math.round(s)} s`);

export class Explorer {
  /**
   * @param walls      shared Walls for visitors (X.buildWalls(plan))
   * @param artworks   Map id → [x, y]
   * @param screens    Map id → { xy: [x, y], forward: [fx, fy] }
   * @param emit       (kind, text) for the log: kind is 'discover', 'spot' or 'run'
   */
  constructor({ id, walls, artworks, screens, rng = Math.random, emit = () => {} }) {
    Object.assign(this, { id, walls, artworks, screens, rng, emit });
    this.entities = new Map([...artworks, ...[...screens].map(([k, s]) => [k, s.xy])]);
    // E7: a taste per entity, fixed for this visitor.
    this.taste = new Map([...this.entities.keys()].map((e) => [e, 0.5 + rng()]));
    this.forget(0);
  }

  /** E1: an empty map, run 1. */
  forget(t) {
    this.map = X.newMap(this.walls);
    this.trail = [];
    this.phase = 'explore';
    this.run = 1;
    this.runStart = t;
    this.stops = [];        // [{ id, kind, done }] in visiting order
    this.stopIndex = 0;
    this.visits = new Map();
    this.leg = null;        // { kind, goal, stop? }
    this.blockedCache = null;
    this.avoid = null;      // E10: { me, other } while planning around an agent it yields to
  }

  get counts() {
    const arts = [...this.artworks.keys()].filter((a) => this.map.viewTime.has(a)).length;
    const scr = [...this.screens.keys()].filter((s) => this.map.viewTime.has(s)).length;
    return { rooms: this.map.rooms.length, artworks: arts, screens: scr, coverage: X.coverage(this.map) };
  }

  /** E2-E3: look once from `pos` along `gaze`; logs discoveries and extends the trail. */
  look(pos, gaze, dt, t) {
    const o = X.observe(this.walls, this.map, pos, gaze, this.entities, dt);
    for (const r of o.rooms) this.emit('discover', `discovers ${r}`);
    for (const e of o.spotted) this.emit('spot', `spots ${e}`);
    if (o.spotted.some((e) => this.artworks.has(e))) this.blockedCache = null;
    const last = this.trail[this.trail.length - 1];
    if (!last || dist(last, pos) >= 0.5) {
      this.trail.push([pos[0], pos[1]]);
      if (this.trail.length > 4000) this.trail.splice(0, 1000);
    }
    return o;
  }

  /** E4 keep-outs, plus (E10) the cells within AVOID_R of an agent it yields to, on that agent's side. */
  blocked() {
    if (!this.blockedCache) this.blockedCache = X.keepout(this.walls, this.map, this.artworks);
    if (!this.avoid) return this.blockedCache;
    const out = this.blockedCache.slice();
    const { me, other } = this.avoid, w = this.walls;
    const here = w.cellOf(me), ox = other[0] - me[0], oy = other[1] - me[1];
    const c = w.cellOf(other), ci = c % w.nx, cj = Math.floor(c / w.nx), r = Math.ceil(AVOID_R / X.CELL) + 1;
    for (let j = Math.max(0, cj - r); j <= Math.min(w.ny - 1, cj + r); j++) {
      for (let i = Math.max(0, ci - r); i <= Math.min(w.nx - 1, ci + r); i++) {
        const k = j * w.nx + i;
        if (k === here) continue;
        const [x, y] = w.centre(k);
        if (Math.hypot(x - other[0], y - other[1]) < AVOID_R && (x - me[0]) * ox + (y - me[1]) * oy > 0) out[k] = 1;
      }
    }
    return out;
  }

  /** E4: straight legs on the visitor's own map from `pos` to `goal`, or null. */
  plan(pos, goal) {
    const blocked = this.blocked();
    const g = this.walls.cellOf(goal);
    const p = X.pathCells(this.walls, this.map, pos, g, blocked);
    if (!p) return null;
    const legs = X.smooth(this.walls, this.map, pos, p[0], blocked);
    legs.push([goal[0], goal[1]]);
    return legs;
  }

  /**
   * The next leg, called when the visitor reaches the end of its current one (or must plan again).
   * Returns { waypoints, dwell, face }: stand `dwell` seconds here (looking at `face`, if set),
   * then walk the waypoints.
   */
  next(pos, heading, t, avoid = null) {
    this.avoid = avoid ? { me: pos, other: avoid } : null;
    try { return this.nextLeg(pos, heading, t); } finally { this.avoid = null; }
  }

  nextLeg(pos, heading, t) {
    let dwell = 0, face = null;
    const leg = this.leg;
    if (leg && dist(pos, leg.goal) < ARRIVED) {
      if (leg.kind === 'frontier') dwell = 0.5 + this.rng();
      else if (leg.kind === 'exit') {
        this.emit('run', `reaches the Checkout: run ${this.run} done`);
        this.phase = 'reset';
        dwell = 1;
      } else if (leg.kind === 'reset') {
        this.run += 1;
        this.runStart = t;
        this.startRoute(pos);
        dwell = 1;
      } else if (leg.kind === 'circuit' || leg.kind === 'screen') {
        const s = leg.stop;
        s.done = true;
        this.visits.set(s.id, (this.visits.get(s.id) ?? 0) + 1);
        this.stopIndex += 1;
        this.emit('run', `views ${s.id} (${this.stopIndex}/${this.stops.length})`);
        dwell = leg.kind === 'screen' ? 4 : 2 + 2 * this.rng();
        face = this.entities.get(s.id);
      }
    }
    const arrivedAt = leg && dist(pos, leg.goal) < ARRIVED ? leg.kind : null;
    this.leg = null;

    for (let tries = 0; tries < 8 && !this.leg; tries++) {
      if (this.phase === 'explore') {
        const f = X.nextFrontier(this.walls, this.map, pos, heading, this.blocked());
        if (f) {
          const goal = this.walls.centre(f[0]);
          const wps = this.plan(pos, goal);
          if (wps) return this.go({ kind: 'frontier', goal }, wps, dwell, face);
        }
        if (this.avoid) { this.avoid = null; continue; }   // nothing around it: plan as usual
        this.emit('run', `has mapped the exhibition (run ${this.run}, ${fmtDuration(t - this.runStart)}, ${Math.round(X.coverage(this.map) * 100)}% seen)`);
        this.phase = 'exit';
      } else if (this.phase === 'exit' || this.phase === 'reset') {
        const goal = this.phase === 'exit' ? EXIT_POINT : START_POINT;
        const wps = this.plan(pos, goal);
        if (wps) return this.go({ kind: this.phase, goal }, wps, dwell, face);
        if (this.avoid) { this.avoid = null; continue; }
        this.phase = 'explore';   // it does not know the way yet: keep exploring
      } else if (this.phase === 'route') {
        const s = this.stops[this.stopIndex];
        if (!s) { this.phase = 'exit'; continue; }
        if (s.kind === 'screen') {
          const sc = this.screens.get(s.id);
          const goal = [sc.xy[0] + SCREEN_VIEW * sc.forward[0], sc.xy[1] + SCREEN_VIEW * sc.forward[1]];
          const wps = this.map.seen[this.walls.cellOf(goal)] ? this.plan(pos, goal) : null;
          if (wps) return this.go({ kind: 'screen', goal, stop: s }, wps, dwell, face);
        } else if (arrivedAt === 'view') {
          const wps = this.circuit(pos, this.artworks.get(s.id));
          return this.go({ kind: 'circuit', goal: wps[wps.length - 1], stop: s }, wps, dwell, face);
        } else {
          const goal = X.viewpoint(this.walls, this.map, this.blocked(), this.artworks.get(s.id), pos);
          const wps = goal && this.plan(pos, goal);
          if (wps) return this.go({ kind: 'view', goal, stop: s }, wps, dwell, face);
        }
        if (this.avoid) { this.avoid = null; continue; }
        this.emit('run', `cannot reach ${s.id}, skips it`);
        this.stopIndex += 1;
      }
    }
    return { waypoints: [], dwell: Math.max(dwell, 1), face };
  }

  go(leg, waypoints, dwell, face) {
    this.leg = leg;
    return { waypoints, dwell, face };
  }

  /** E9 / M7: part of a circle around an artwork, 120-240 degrees at VIEW_DISTANCE, in its room. */
  circuit(pos, art) {
    const r = X.VIEW_DISTANCE, room = this.walls.room[this.walls.cellOf(art)];
    const a0 = Math.atan2(pos[1] - art[1], pos[0] - art[0]);
    const sweep = ((120 + 120 * this.rng()) * Math.PI) / 180 * (this.rng() < 0.5 ? 1 : -1);
    const n = Math.ceil(Math.abs(sweep) / ((20 * Math.PI) / 180));
    const out = [];
    for (let i = 1; i <= n; i++) {
      const a = a0 + (sweep * i) / n;
      const p = [art[0] + r * Math.cos(a), art[1] + r * Math.sin(a)];
      const c = this.walls.cellOf(p);
      if (this.walls.room[c] !== room || !this.map.seen[c]) break;
      out.push(p);
    }
    return out.length ? out : [[pos[0], pos[1]]];
  }

  /** E8: pick the interests and the shortest order through them, ending at the Checkout. */
  startRoute(pos) {
    const ids = X.chooseInterests(this.map.viewTime, this.taste, this.visits);
    const goals = ids.map((id) => {
      if (this.screens.has(id)) { const s = this.screens.get(id); return [s.xy[0] + SCREEN_VIEW * s.forward[0], s.xy[1] + SCREEN_VIEW * s.forward[1]]; }
      return X.viewpoint(this.walls, this.map, this.blocked(), this.artworks.get(id), pos) ?? this.artworks.get(id);
    });
    const points = [pos, ...goals, EXIT_POINT];
    const blocked = this.blocked();
    const d = points.map((p) => {
      const { dist: dd } = X.distances(this.walls, this.map, this.walls.cellOf(p), blocked);
      return points.map((q) => dd[this.walls.cellOf(q)]);
    });
    const [order] = ids.length ? X.orderRoute(d) : [[]];
    this.stops = order.map((i) => ({ id: ids[i - 1], kind: this.screens.has(ids[i - 1]) ? 'screen' : 'artwork', done: false }));
    this.stopIndex = 0;
    this.phase = 'route';
    this.emit('run', this.stops.length
      ? `starts run ${this.run}: ${this.stops.map((s) => s.id).join(' → ')}`
      : `starts run ${this.run} with nothing in mind`);
  }

  /** E12: head for the Checkout now, if this visitor has seen it. */
  finishExploring() {
    if (this.phase !== 'explore' || !this.map.rooms.includes(CHECKOUT)) return false;
    this.emit('run', `stops exploring (run ${this.run}, ${Math.round(X.coverage(this.map) * 100)}% seen)`);
    this.phase = 'exit';
    this.leg = null;
    return true;
  }

  /** The route still ahead, for drawing: [{ id, xy, done }]. */
  routeAhead() {
    return this.stops.map((s) => ({ id: s.id, xy: this.entities.get(s.id), done: s.done }));
  }
}

export { CHECKOUT, ENTRANCE, EXIT_POINT, START_POINT };
