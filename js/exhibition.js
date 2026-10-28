// The 10-hall exhibition from docs/SIMULATION_METRICS.md (R1-R6, R9, R15).
// JavaScript port of spatai/exhibition.py; tests/test_js_parity.py checks both build the same plan.

import { Circle, Location, Place, Rect, ReferenceFrame, SmartDisplay, SpatialZone, Visitor, World } from './spatial.js';

export const ENTRANCE = 'Entrance';
export const CHECKOUT = 'Checkout';
export const CORRIDOR = 'Central Corridor';
export const RESET_PASSAGE = 'Reset Passage';
export const HALLS = Array.from({ length: 10 }, (_, i) => `Gallery ${i + 1}`);
export const DOOR_WIDTH = 1.2;   // metres
export const EXHIBIT_RADIUS = 0.6;

export class FloorPlan {
  constructor({ rooms, doors, seqNodes, seqEdges, roomNode, exhibits }) {
    Object.assign(this, { rooms, doors, seqNodes, seqEdges, roomNode, exhibits });
    this.exhibitHall = new Map([...exhibits].map(([name, loc]) => [name, this.roomAt(loc)]));
  }

  /** The first room (in plan order) containing `location`; door points lie on two rooms. */
  roomAt(location) {
    for (const [name, rect] of this.rooms) if (rect.contains(location)) return name;
    return null;
  }

  doorsOf(room, role = 'visitor') {
    return [...this.doors.values()].filter((d) => d.rooms.includes(room) && (role === 'staff' || !d.staffOnly));
  }

  centre(room) { return this.rooms.get(room).centroid(); }

  /** S1-S3 (R5): the staff door counts once although it has an edge each way. */
  get shortcuts() {
    const seen = new Set(), out = [];
    for (const e of this.seqEdges) {
      if ((e.kind === 'shortcut' || e.kind === 'staff') && !seen.has(e.label)) { seen.add(e.label); out.push(e); }
    }
    return out;
  }
}

function rooms() {
  const r = new Map([[ENTRANCE, new Rect(0, 0, 4, 8)]]);
  for (let i = 0; i < 5; i++) r.set(HALLS[i], new Rect(4 + 8 * i, 0, 12 + 8 * i, 8));        // south row, west → east
  r.set(CORRIDOR, new Rect(4, 8, 44, 11));
  for (let i = 0; i < 5; i++) r.set(HALLS[5 + i], new Rect(36 - 8 * i, 11, 44 - 8 * i, 19)); // north row, east → west
  r.set(CHECKOUT, new Rect(0, 11, 4, 19));
  r.set(RESET_PASSAGE, new Rect(0, 8, 4, 11));
  return r;
}

function doors() {
  const g = HALLS;
  const spec = [
    ['entry', [ENTRANCE, g[0]], [4, 4], false],
    ['g1-g2', [g[0], g[1]], [12, 2.5], false],
    ['staff-g1-g2', [g[0], g[1]], [12, 6], true],
    ['g2-g3', [g[1], g[2]], [20, 4], false],
    ['g3-g4', [g[2], g[3]], [28, 4], false],
    ['g4-g5', [g[3], g[4]], [36, 4], false],
    ['g5-cor', [g[4], CORRIDOR], [40, 8], false],
    ['cor-g6', [CORRIDOR, g[5]], [40, 11], false],
    ['g6-g7', [g[5], g[6]], [36, 15], false],
    ['g7-g8', [g[6], g[7]], [28, 15], false],
    ['g8-g9', [g[7], g[8]], [20, 15], false],
    ['g9-g10', [g[8], g[9]], [12, 15], false],
    ['exit', [g[9], CHECKOUT], [4, 15], false],
    ['reset-n', [CHECKOUT, RESET_PASSAGE], [2, 11], false],
    ['reset-s', [RESET_PASSAGE, ENTRANCE], [2, 8], false],
    ['g4-cor', [g[3], CORRIDOR], [32, 8], false],
    ['cor-g7', [CORRIDOR, g[6]], [32, 11], false],
    ['g8-cor', [g[7], CORRIDOR], [24, 11], false],
    ['cor-g3', [CORRIDOR, g[2]], [24, 8], false],
  ];
  return new Map(spec.map(([doorId, rs, point, staffOnly]) => [doorId, Object.freeze({ doorId, rooms: rs, point, staffOnly })]));
}

const edge = (src, dst, weight, kind, via, label = '') => Object.freeze({ src, dst, weight, kind, via, label });

function seqEdges() {
  const g = HALLS;
  const forwardVia = [['g1-g2'], ['g2-g3'], ['g3-g4'], ['g4-g5'], ['g5-cor', 'cor-g6'], ['g6-g7'], ['g7-g8'], ['g8-g9'], ['g9-g10']];
  const edges = [edge(ENTRANCE, g[0], 1, 'forward', ['entry'])];
  forwardVia.forEach((via, i) => edges.push(edge(g[i], g[i + 1], 1, 'forward', via)));
  edges.push(edge(g[9], CHECKOUT, 1, 'forward', ['exit']));
  edges.push(
    edge(g[0], g[1], 1, 'staff', ['staff-g1-g2'], 'S1'),
    edge(g[1], g[0], 1, 'staff', ['staff-g1-g2'], 'S1'),
    edge(g[3], g[6], 1, 'shortcut', ['g4-cor', 'cor-g7'], 'S2'),
    edge(g[7], g[2], 1, 'shortcut', ['g8-cor', 'cor-g3'], 'S3'),
    edge(CHECKOUT, g[0], 0, 'reset', ['reset-n', 'reset-s', 'entry'], 'reset'),
    edge(CHECKOUT, ENTRANCE, 0, 'reset', ['reset-n', 'reset-s'], 'reset'),
  );
  return edges;
}

export function buildFloorplan() {
  const r = rooms();
  const roomNode = new Map([...r.keys()].map((k) => [k, k]));
  roomNode.set(RESET_PASSAGE, CHECKOUT);
  roomNode.set(CORRIDOR, null);
  const exhibits = new Map([
    ['Exhibit l1', new Location(24, 2)],
    ['Exhibit l2', new Location(41, 17)],
    ['Exhibit l3', new Location(16, 17)],
  ]);
  return new FloorPlan({
    rooms: r, doors: doors(), seqNodes: [ENTRANCE, ...HALLS, CHECKOUT], seqEdges: seqEdges(), roomNode, exhibits,
  });
}

/** The exhibition world (R15): zone, places, displays in their own frames, agents. */
export function buildExhibition() {
  const plan = buildFloorplan();
  const world = new World();
  world.addZone(new SpatialZone('exhibition', new Rect(0, 0, 44, 19), { ambientLight: 280 }));
  const building = world.addPlace(new Place('Exhibition', new Rect(0, 0, 44, 19)));
  for (const [name, rect] of plan.rooms) world.addPlace(new Place(name, rect, building));
  for (const [name, loc] of plan.exhibits) {
    world.addPlace(new Place(name, new Circle(loc, EXHIBIT_RADIUS), world.places.get(plan.exhibitHall.get(name))));
  }

  const frames = {
    'g1-screen': new ReferenceFrame('g1-screen', { origin: [8, 0.4], rotation: 90 }),
    'g2-screen': new ReferenceFrame('g2-screen', { origin: [16, 0.4], rotation: 90 }),
    'g6-screen': new ReferenceFrame('g6-screen', { origin: [43.6, 15], rotation: 180 }),
    'g10-screen': new ReferenceFrame('g10-screen', { origin: [8, 18.6], rotation: -90 }),
  };
  for (const [id, frame] of Object.entries(frames)) world.addDisplay(new SmartDisplay(id, new Location(0, 0, frame)), 'exhibition');

  world.addVisitor(new Visitor('alice', new Location(8, 5), { dwellTime: 30 }));
  world.addVisitor(new Visitor('bob', new Location(13.2, 5), { dwellTime: 12 }));
  world.addVisitor(new Visitor('carol', new Location(25, 13), { dwellTime: 50 }));
  world.addVisitor(new Visitor('sam', new Location(14.5, 6.5), { dwellTime: 200, role: 'staff' }));
  return { world, frames, plan };
}
