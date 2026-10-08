// SPATAI location model: a JavaScript port of spatai/geometry.py, spatai/model.py,
// spatai/world.py and spatai/rules.py.
//
// Keep this file in step with the Python package. tests/test_js_parity.py runs both
// over the demo scene and fails if any answer differs. Names follow the Python
// ones in camelCase (occupants_at -> occupantsAt). It has no dependencies, so the
// page and Node can both import it.
//
// All angles are in degrees, counter-clockwise, with 0 along the frame's +x axis.
// Distances are in metres. Boundary checks are inclusive, with a small tolerance.

export const EPSILON = 1e-9;

// ---------------------------------------------------------------------------
// geometry.py
// ---------------------------------------------------------------------------

function rotate(x, y, degrees) {
  const r = (degrees * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return [x * c - y * s, x * s + y * c];
}

/** Map an angle onto (-180, 180]. */
export function normalizeAngle(degrees) {
  let a = degrees % 360;
  if (a <= -180) a += 360;
  else if (a > 180) a -= 360;
  return a;
}

/**
 * A 2D coordinate frame placed inside a parent frame. `origin` is where this
 * frame's (0, 0) sits in the parent's coordinates, and `rotation` is how far its
 * +x axis is turned from the parent's. No parent means world coordinates.
 */
export class ReferenceFrame {
  constructor(frameId, { origin = [0, 0], rotation = 0, parent = null } = {}) {
    this.frameId = frameId;
    this.origin = origin;
    this.rotation = rotation;
    this.parent = parent;
  }

  toParent(x, y) {
    const [rx, ry] = rotate(x, y, this.rotation);
    return [rx + this.origin[0], ry + this.origin[1]];
  }

  fromParent(x, y) {
    return rotate(x - this.origin[0], y - this.origin[1], -this.rotation);
  }

  toWorld(x, y) {
    for (let f = this; f !== null; f = f.parent) [x, y] = f.toParent(x, y);
    return [x, y];
  }

  fromWorld(x, y) {
    for (const f of this.ancestry().reverse()) [x, y] = f.fromParent(x, y);
    return [x, y];
  }

  /** This frame's +x heading, in world degrees. */
  worldRotation() {
    return this.ancestry().reduce((sum, f) => sum + f.rotation, 0);
  }

  /** This frame followed by its parents, innermost first. */
  ancestry() {
    const chain = [];
    for (let f = this; f !== null; f = f.parent) {
      if (chain.includes(f)) throw new Error(`Reference frame cycle at '${f.frameId}'`);
      chain.push(f);
    }
    return chain;
  }
}

export const WORLD_FRAME = new ReferenceFrame('world');

/** A point (x, y) expressed in a reference frame. Immutable. */
export class Location {
  constructor(x, y, frame = WORLD_FRAME) {
    this.x = x;
    this.y = y;
    this.frame = frame;
    Object.freeze(this);
  }

  toWorld() {
    return new Location(...this.frame.toWorld(this.x, this.y), WORLD_FRAME);
  }

  inFrame(frame) {
    if (frame === this.frame) return this;
    const w = this.toWorld();
    return new Location(...frame.fromWorld(w.x, w.y), frame);
  }

  distanceTo(other) {
    const a = this.toWorld(), b = other.toWorld();
    const dx = b.x - a.x, dy = b.y - a.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /** World heading in degrees from this location towards `other`. */
  bearingTo(other) {
    const a = this.toWorld(), b = other.toWorld();
    return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  }
}

export class Circle {
  constructor(center, radius) {
    if (radius < 0) throw new Error(`radius must be >= 0, got ${radius}`);
    this.center = center;
    this.radius = radius;
    Object.freeze(this);
  }

  get area() { return Math.PI * this.radius ** 2; }

  centroid() { return this.center; }

  contains(location) {
    return this.center.distanceTo(location) <= this.radius + EPSILON;
  }
}

/** An axis-aligned rectangle in `frame`; rotate the frame to rotate the rectangle. */
export class Rect {
  constructor(xMin, yMin, xMax, yMax, frame = WORLD_FRAME) {
    if (xMin > xMax || yMin > yMax) throw new Error('Rect min corner must not exceed max corner');
    Object.assign(this, { xMin, yMin, xMax, yMax, frame });
    Object.freeze(this);
  }

  get area() { return (this.xMax - this.xMin) * (this.yMax - this.yMin); }

  centroid() {
    return new Location((this.xMin + this.xMax) / 2, (this.yMin + this.yMax) / 2, this.frame);
  }

  /** The four corners in world coordinates, counter-clockwise from the min corner. */
  worldCorners() {
    const { xMin, yMin, xMax, yMax, frame } = this;
    return [[xMin, yMin], [xMax, yMin], [xMax, yMax], [xMin, yMax]]
      .map(([x, y]) => new Location(x, y, frame).toWorld());
  }

  contains(location) {
    const p = location.inFrame(this.frame);
    return this.xMin - EPSILON <= p.x && p.x <= this.xMax + EPSILON
      && this.yMin - EPSILON <= p.y && p.y <= this.yMax + EPSILON;
  }
}

// ---------------------------------------------------------------------------
// model.py
// ---------------------------------------------------------------------------

export const DEFAULT_LOOP_MEDIA = 'default_loop';
export const INTERACTIVE_MEDIA = 'interactive';

export class Visitor {
  constructor(userId, position, { velocity = [0, 0], dwellTime = 0 } = {}) {
    Object.assign(this, { userId, position, velocity, dwellTime });
  }
}

export class SmartDisplay {
  constructor(displayId, position, {
    orientation = 0, currentMedia = DEFAULT_LOOP_MEDIA, volumeLevel = 50, powerState = 'OFF', status = 'idle',
  } = {}) {
    if (!(volumeLevel >= 0 && volumeLevel <= 100)) throw new Error(`volumeLevel must be 0-100, got ${volumeLevel}`);
    Object.assign(this, { displayId, position, orientation, currentMedia, volumeLevel, powerState, status });
  }

  worldOrientation() {
    return this.orientation + this.position.frame.worldRotation();
  }
}

export class SpatialZone {
  constructor(zoneId, boundary, { ambientLight = 0 } = {}) {
    Object.assign(this, { zoneId, boundary, ambientLight });
    this.displayIds = new Set();
  }

  /** Relationship: Spatial Zone *controls* Smart Display. */
  control(display) {
    this.displayIds.add(display.displayId);
  }
}

/** A named region, optionally nested inside a larger place. */
export class Place {
  constructor(name, region, parent = null) {
    Object.assign(this, { name, region, parent });
  }

  depth() {
    let d = 0;
    for (let p = this.parent; p !== null; p = p.parent) {
      if (++d > 10_000) throw new Error(`Place parent cycle at '${this.name}'`);
    }
    return d;
  }

  /** Enclosing places, innermost first. */
  ancestors() {
    const out = [];
    for (let p = this.parent; p !== null; p = p.parent) out.push(p);
    return out;
  }
}

// ---------------------------------------------------------------------------
// world.py
// ---------------------------------------------------------------------------

/** Within this many degrees of a display's facing direction counts as "in front". */
export const FRONT_HALF_ANGLE = 45;

// Python orders by tuples such as (area, id); compare the same way here.
function compareKeys(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

function minBy(items, key) {
  let best = null, bestKey = null;
  for (const item of items) {
    const k = key(item);
    if (best === null || compareKeys(k, bestKey) < 0) { best = item; bestKey = k; }
  }
  return best;
}

/** Order [distance, id] pairs; distances within EPSILON count as a tie, broken by id. */
function byDistanceThenId(a, b) {
  if (Math.abs(a[0] - b[0]) > EPSILON) return a[0] < b[0] ? -1 : 1;
  return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
}

const DIRECTION_PHRASE = { front: 'in front of', behind: 'behind', left: 'left of', right: 'right of' };

export class Description {
  constructor(place, nearestDisplay, distance, direction) {
    Object.assign(this, { place, nearestDisplay, distance, direction });
    Object.freeze(this);
  }

  /** Same text as Python's Description.__str__. */
  toString() {
    const where = this.place ? `In ${this.place.name}` : 'Outside any known place';
    if (this.nearestDisplay === null) return `${where}; no displays`;
    const d = this.nearestDisplay.displayId;
    if (this.direction === 'at') return `${where}, at ${d}`;
    return `${where}, ${this.distance.toFixed(1)} m ${DIRECTION_PHRASE[this.direction]} ${d}`;
  }
}

/**
 * Registry of every visitor, display, zone and place under an ID unique across
 * all four. Zone membership is derived from location: a visitor is in the zone
 * that zoneAt() returns for their position.
 */
export class World {
  constructor() {
    this.visitors = new Map();
    this.displays = new Map();
    this.zones = new Map();
    this.places = new Map();
  }

  // -- registration -------------------------------------------------------

  registries() { return [this.visitors, this.displays, this.zones, this.places]; }

  checkNew(objId) {
    if (this.registries().some((r) => r.has(objId))) throw new Error(`ID already registered: '${objId}'`);
  }

  addVisitor(visitor) {
    this.checkNew(visitor.userId);
    this.visitors.set(visitor.userId, visitor);
    return visitor;
  }

  /** Register a display; with `zoneId`, that zone also controls it. */
  addDisplay(display, zoneId = null) {
    const zone = zoneId !== null ? this.zones.get(zoneId) : null;
    if (zoneId !== null && !zone) throw new Error(`Unknown zone: '${zoneId}'`);
    this.checkNew(display.displayId);
    this.displays.set(display.displayId, display);
    zone?.control(display);
    return display;
  }

  addZone(zone) {
    this.checkNew(zone.zoneId);
    this.zones.set(zone.zoneId, zone);
    return zone;
  }

  addPlace(place) {
    this.checkNew(place.name);
    if (place.parent !== null && this.places.get(place.parent.name) !== place.parent) {
      throw new Error(`Parent place '${place.parent.name}' is not registered`);
    }
    this.places.set(place.name, place);
    return place;
  }

  /** Unregister an object; a removed display is also dropped from its zone. */
  remove(objId) {
    const registry = this.registries().find((r) => r.has(objId));
    if (!registry) throw new Error(`Unknown ID: '${objId}'`);
    const obj = registry.get(objId);
    if (obj instanceof Place && [...this.places.values()].some((p) => p.parent === obj)) {
      throw new Error(`Place '${objId}' still has child places`);
    }
    registry.delete(objId);
    if (obj instanceof SmartDisplay) for (const z of this.zones.values()) z.displayIds.delete(objId);
    return obj;
  }

  get(objId) {
    for (const r of this.registries()) if (r.has(objId)) return r.get(objId);
    throw new Error(`Unknown ID: '${objId}'`);
  }

  kindOf(objId) {
    const kinds = ['visitor', 'display', 'zone', 'place'];
    const i = this.registries().findIndex((r) => r.has(objId));
    if (i < 0) throw new Error(`Unknown ID: '${objId}'`);
    return kinds[i];
  }

  // -- queries ------------------------------------------------------------

  /** Where an object is: its position, or the centre of a zone or place. */
  locate(objId) {
    const obj = this.get(objId);
    if (obj instanceof Visitor || obj instanceof SmartDisplay) return obj.position;
    if (obj instanceof SpatialZone) return obj.boundary.centroid();
    return obj.region.centroid();
  }

  /** Visitors within `radius` metres (inclusive) of `location`, nearest first. */
  occupantsAt(location, radius) {
    if (radius < 0) throw new Error(`radius must be >= 0, got ${radius}`);
    return [...this.visitors.values()]
      .map((v) => [location.distanceTo(v.position), v.userId])
      .filter(([d]) => d <= radius + EPSILON)
      .sort(byDistanceThenId)
      .map(([, id]) => this.visitors.get(id));
  }

  /** The zone whose boundary contains `location`; the smallest wins if zones overlap. */
  zoneAt(location) {
    const hits = [...this.zones.values()].filter((z) => z.boundary.contains(location));
    return minBy(hits, (z) => [z.boundary.area, z.zoneId]);
  }

  /** locate(objId) expressed in `frame`. */
  positionIn(objId, frame) {
    return this.locate(objId).inFrame(frame);
  }

  /** The most specific place containing `location`: deepest nesting, then smallest area. */
  placeAt(location) {
    const hits = [...this.places.values()].filter((p) => p.region.contains(location));
    return minBy(hits, (p) => [-p.depth(), p.region.area, p.name]);
  }

  nearestDisplay(location) {
    const ranked = [...this.displays.values()]
      .map((d) => [location.distanceTo(d.position), d.displayId])
      .sort(byDistanceThenId);
    return ranked.length ? this.displays.get(ranked[0][1]) : null;
  }

  /** Most specific containing place, nearest display, and where `location` lies relative to it. */
  describe(location) {
    const place = this.placeAt(location);
    const display = this.nearestDisplay(location);
    if (display === null) return new Description(place, null, null, null);
    const dist = display.position.distanceTo(location);
    return new Description(place, display, dist, relativeDirection(display, location));
  }

  // -- zone membership ------------------------------------------------------

  /** Visitors whose location falls in this zone (per zoneAt). */
  occupantsOf(zoneId) {
    const zone = this.zones.get(zoneId);
    if (!zone) throw new Error(`Unknown zone: '${zoneId}'`);
    return [...this.visitors.values()].filter((v) => this.zoneAt(v.position) === zone);
  }

  occupancy(zoneId) {
    return this.occupantsOf(zoneId).length;
  }
}

/** Where `location` lies relative to the way `display` faces. */
export function relativeDirection(display, location) {
  if (display.position.distanceTo(location) <= EPSILON) return 'at';
  const angle = normalizeAngle(display.position.bearingTo(location) - display.worldOrientation());
  if (Math.abs(angle) <= FRONT_HALF_ANGLE + EPSILON) return 'front';
  if (Math.abs(angle) >= 180 - FRONT_HALF_ANGLE - EPSILON) return 'behind';
  return angle > 0 ? 'left' : 'right';
}

// ---------------------------------------------------------------------------
// rules.py
// ---------------------------------------------------------------------------

export const PROXIMITY_THRESHOLD_M = 2.5;
export const MAX_OCCUPANCY_FOR_POWER_ON = 20; // exclusive upper bound

export function shouldPowerOn(world, zoneId, displayId) {
  const zone = world.zones.get(zoneId);
  const occupants = world.occupantsOf(zoneId);
  if (occupants.length >= MAX_OCCUPANCY_FOR_POWER_ON) return false;
  const nearby = world.occupantsAt(world.locate(displayId), PROXIMITY_THRESHOLD_M);
  const inZone = new Set(occupants.map((v) => v.userId));
  return zone.displayIds.has(displayId) && nearby.some((v) => inZone.has(v.userId));
}

/** Apply the rule to every zone's displays; return the displays switched on. */
export function evaluateRules(world) {
  const switched = [];
  for (const [zoneId, zone] of world.zones) {
    for (const displayId of [...zone.displayIds].sort()) {
      const display = world.displays.get(displayId);
      if (display.powerState !== 'ON' && shouldPowerOn(world, zoneId, displayId)) {
        display.powerState = 'ON';
        switched.push(display);
      }
    }
  }
  return switched;
}

// ---------------------------------------------------------------------------
// Page-only helper: turn a short description back into a place.
// ---------------------------------------------------------------------------

/** How far "in front of X", "behind X" and so on reach from a display. */
export const OFFSET_M = 1.5;

const RELATIONS = [
  [/^(?:near|at|by|next to|close to|around|beside)\s+(.+)$/, null],
  [/^(?:in front of|ahead of|facing)\s+(.+)$/, 0],
  [/^behind\s+(.+)$/, 180],
  [/^(?:(?:to\s+the\s+)?left\s+of)\s+(.+)$/, 90],
  [/^(?:(?:to\s+the\s+)?right\s+of)\s+(.+)$/, -90],
];

/** Find a registered ID by exact, prefix or substring match, ignoring case and spaces vs hyphens. */
export function findId(world, text) {
  const norm = (s) => s.toLowerCase().replace(/[\s_-]+/g, ' ').trim();
  const q = norm(text);
  if (!q) return null;
  const ids = world.registries().flatMap((r) => [...r.keys()]);
  return ids.find((id) => norm(id) === q)
    ?? ids.find((id) => norm(id).startsWith(q))
    ?? ids.find((id) => norm(id).includes(q))
    ?? null;
}

/**
 * Resolve text such as "near gallery-screen", "in front of welcome-screen",
 * "reception" or "bob" to the place it points at. Returns
 * { place, location, anchorId, relation, offset } or null if nothing matches;
 * `offset` is true when `location` was stepped away from a display.
 * A relative phrase about a display steps OFFSET_M from it in that direction;
 * about anything else it uses the object's own location.
 */
export function resolveDescription(world, text) {
  let q = text.trim().toLowerCase().replace(/^(?:the|where is|where's|find)\s+/, '');
  let angle = null, relation = 'at';
  for (const [re, a] of RELATIONS) {
    const m = q.match(re);
    if (m) { q = m[1].replace(/^the\s+/, ''); angle = a; relation = m[0].slice(0, m[0].length - m[1].length).trim(); break; }
  }
  const anchorId = findId(world, q);
  if (anchorId === null) return null;
  const anchor = world.get(anchorId);
  if (anchor instanceof Place && angle === null) {
    return { place: anchor, location: anchor.region.centroid(), anchorId, relation, offset: false };
  }
  let location = world.locate(anchorId);
  const offset = anchor instanceof SmartDisplay && angle !== null;
  if (offset) {
    const r = ((anchor.worldOrientation() + angle) * Math.PI) / 180;
    const w = location.toWorld();
    location = new Location(w.x + OFFSET_M * Math.cos(r), w.y + OFFSET_M * Math.sin(r));
  }
  return { place: world.placeAt(location), location, anchorId, relation, offset };
}
