// Proximity rules for the exhibition (docs/PROXIMITY_RULES.md).
//
// The pure rule functions port spatai/proximity.py (tests/test_js_parity.py checks they
// agree). ArtworkGuard, the staff-call state machine for P7-P9, is page-only and is
// unit-tested in tests/js/proximity.test.mjs. Nothing here depends on three.js.

import { EPSILON, Location } from './spatial.js';
import { INF, walk } from './metrics.js';

export const PERSONAL_SPACE_M = 1.0;
export const ARTWORK_DISTANCE_M = 1.0;
export const STAFF_STANDOFF_M = 1.3;
export const STEP_BACK_TO_M = 1.6;
export const ARRIVED_SLACK_M = 0.4;
export const RESOLVED_SLACK_M = 0.15;
export const REPLAN_AFTER_S = 2.0;

const xy = (loc) => { const w = loc.toWorld(); return [w.x, w.y]; };
const hyp = (dx, dy) => Math.sqrt(dx * dx + dy * dy);

/** A velocity given in the frame of `loc`, turned into world axes. */
export function worldVelocity(loc, [vx, vy]) {
  const r = (loc.frame.worldRotation() * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return [vx * c - vy * s, vx * s + vy * c];
}

/** Component of velocity `v` (at `me`) towards `other`; 0 when they coincide. */
export function closingSpeed(me, v, other) {
  const dx = other[0] - me[0], dy = other[1] - me[1], d = hyp(dx, dy);
  return d <= EPSILON ? 0 : (v[0] * dx + v[1] * dy) / d;
}

/** P2-P3: must `me` stop for `other`? */
export function yields(meId, me, meV, otherId, other, otherV, limit = PERSONAL_SPACE_M) {
  if (hyp(other[0] - me[0], other[1] - me[1]) >= limit - EPSILON) return false;
  const mine = closingSpeed(me, meV, other), theirs = closingSpeed(other, otherV, me);
  if (mine <= EPSILON) return false;
  if (Math.abs(mine - theirs) <= EPSILON) return meId > otherId;
  return mine > theirs;
}

/** P2-P5 over every pair of agents, using each one's current velocity as its intent. */
export function personalSpaceConflicts(world, exempt = new Set()) {
  const agents = [...world.visitors.values()].filter((v) => !exempt.has(v.userId));
  const pos = new Map(agents.map((v) => [v.userId, xy(v.position)]));
  const vel = new Map(agents.map((v) => [v.userId, worldVelocity(v.position, v.velocity)]));
  const out = [];
  agents.forEach((a, i) => {
    for (const b of agents.slice(i + 1)) {
      for (const [me, other] of [[a, b], [b, a]]) {
        if (yields(me.userId, pos.get(me.userId), vel.get(me.userId), other.userId, pos.get(other.userId), vel.get(other.userId))) {
          out.push({ stopper: me.userId, other: other.userId, distance: me.position.distanceTo(other.position) });
        }
      }
    }
  });
  return out;
}

const tupleLess = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

/** P6: visitors (not staff) closer than 1 m to an artwork; the nearest artwork per visitor. */
export function artworkBreaches(plan, world) {
  const out = [];
  for (const v of world.visitors.values()) {
    if (v.role !== 'visitor') continue;
    let best = null;
    for (const [name, loc] of plan.artworks) {
      const k = [v.position.distanceTo(loc), name];
      if (best === null || tupleLess(k, best)) best = k;
    }
    if (best && best[0] < ARTWORK_DISTANCE_M - EPSILON) out.push({ visitor: v.userId, artwork: best[1], distance: best[0] });
  }
  return out;
}

/** P7: the free staff member with the shortest walk to `location`; ties by ID. */
export function nearestStaff(plan, world, location, exclude = new Set()) {
  let best = null;
  for (const v of world.visitors.values()) {
    if (v.role !== 'staff' || exclude.has(v.userId)) continue;
    const d = walk(plan, v.position, location, 'staff').value;
    if (d !== INF && (best === null || tupleLess([d, v.userId], best))) best = [d, v.userId];
  }
  return best ? best[1] : null;
}

/** P7: the point `standoff` metres from the visitor on the side the staff member arrives from. */
export function approachPoint(plan, staff, visitor, standoff = STAFF_STANDOFF_M) {
  const route = walk(plan, staff, visitor, 'staff');
  const v = xy(visitor);
  const prev = route.path.length >= 2 ? route.path[route.path.length - 2] : xy(staff);
  const dx = prev[0] - v[0], dy = prev[1] - v[1], d = hyp(dx, dy);
  if (d <= EPSILON) return new Location(v[0], v[1]);
  const k = Math.min(standoff, d) / d;
  return new Location(v[0] + dx * k, v[1] + dy * k);
}

/** P8: `to` metres from the artwork along the line from the artwork through the visitor. */
export function stepBackPoint(plan, artwork, visitor, to = STEP_BACK_TO_M) {
  const a = xy(plan.artworks.get(artwork)), v = xy(visitor);
  let dx = v[0] - a[0], dy = v[1] - a[1], d = hyp(dx, dy);
  if (d <= EPSILON) {
    const c = xy(plan.centre(plan.artworkHall.get(artwork)));
    dx = c[0] - a[0]; dy = c[1] - a[1]; d = hyp(dx, dy) || 1;
  }
  return new Location(a[0] + (dx / d) * to, a[1] + (dy / d) * to);
}

// ---------------------------------------------------------------------------
// P7-P9: staff calls
// ---------------------------------------------------------------------------

const m1 = (x) => x.toFixed(1);

/**
 * One call per visitor in breach: waiting → dispatched → stepping → closed.
 * update() reads the world and returns orders for the page to carry out:
 *   goTo:     staffId → Location to walk to (the approach point)
 *   release:  staff whose call ended, to send back to their post
 *   stepBack: visitorId → Location to step back to
 *   events:   [{ text }] for the event log
 */
export class ArtworkGuard {
  constructor() { this.calls = new Map(); }

  busyStaff() { return new Set([...this.calls.values()].map((c) => c.staff).filter(Boolean)); }

  /** P5: staff on a call and visitors stepping back are exempt from personal space. */
  exempt() {
    const out = this.busyStaff();
    for (const [vid, c] of this.calls) if (c.phase === 'stepping') out.add(vid);
    return out;
  }

  update(plan, world) {
    const goTo = new Map(), release = [], stepBack = new Map(), events = [];
    const close = (vid, c, text) => { if (text) events.push({ text }); if (c.staff) release.push(c.staff); this.calls.delete(vid); };

    for (const [vid, c] of this.calls) {
      if (!world.visitors.has(vid)) close(vid, c, '');
      else if (c.staff && !world.visitors.has(c.staff)) { c.staff = null; c.phase = 'waiting'; }
    }
    for (const b of artworkBreaches(plan, world)) {
      if (!this.calls.has(b.visitor)) this.calls.set(b.visitor, { artwork: b.artwork, staff: null, phase: 'waiting', fresh: b.distance });
    }

    // Most urgent first: the visitor closest to their artwork gets the free staff (P7).
    const order = [...this.calls].map(([vid, c]) => [world.visitors.get(vid).position.distanceTo(plan.artworks.get(c.artwork)), vid])
      .sort((a, b) => (tupleLess(a, b) ? -1 : tupleLess(b, a) ? 1 : 0)).map(([, vid]) => vid);
    for (const vid of order) {
      const c = this.calls.get(vid);
      const v = world.visitors.get(vid);
      const art = plan.artworks.get(c.artwork);
      const dArt = v.position.distanceTo(art);
      if (c.phase !== 'stepping' && dArt >= ARTWORK_DISTANCE_M - EPSILON) {
        close(vid, c, c.fresh === undefined
          ? `${vid} moved away from ${c.artwork}${c.staff ? ` → ${c.staff} stands down` : ''}`
          : '');
        continue;
      }
      if (c.phase === 'waiting') {
        const busy = this.busyStaff();
        const staff = nearestStaff(plan, world, v.position, busy);
        if (staff) { c.staff = staff; c.phase = 'dispatched'; }
        if (c.fresh !== undefined) {
          events.push({ text: `${vid} is ${m1(c.fresh)} m from ${c.artwork} → ${staff ? `${staff} dispatched` : 'no staff free, waiting'}` });
          delete c.fresh;
        } else if (staff) {
          events.push({ text: `${staff} dispatched to ${vid} at ${c.artwork}` });
        }
      }
      if (c.phase === 'dispatched') {
        const s = world.visitors.get(c.staff);
        if (s.position.distanceTo(v.position) <= STAFF_STANDOFF_M + ARRIVED_SLACK_M) {
          c.phase = 'stepping';
          c.target = stepBackPoint(plan, c.artwork, v.position);
          events.push({ text: `${c.staff} reached ${vid}; ${vid} steps back from ${c.artwork}` });
        } else {
          goTo.set(c.staff, approachPoint(plan, s.position, v.position));
        }
      }
      if (c.phase === 'stepping') {
        if (dArt >= STEP_BACK_TO_M - RESOLVED_SLACK_M) {
          close(vid, c, `${vid} is ${m1(dArt)} m from ${c.artwork} → ${c.staff} returns to post`);
        } else {
          stepBack.set(vid, c.target);
        }
      }
    }
    return { goTo, release, stepBack, events };
  }
}
