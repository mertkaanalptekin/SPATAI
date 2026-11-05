// Spatial AI Architecture — interactive visualisation of the semantic model.
//
// Entities:      Visitor, Spatial Zone, Smart Display, Place, Reference Frame
// Relationships: Visitor —enters→ Spatial Zone, Spatial Zone —controls→ Smart Display,
//                Place —is inside→ Place
// Rule:          IF Visitor.Position within 2.5 m of Display.Position AND Zone.Occupancy < 20
//                THEN Display.Power_State = ON
// Action:        Launch_Media() switches Display.Current_Media from the default loop to interactive content.
//
// The scene is demo.py's, built by js/scene.js. Every location question (zone
// membership, the rule, locate / occupants_at / position_in / describe) is
// answered by js/spatial.js, the JavaScript port of the Python model, so the page
// and Python agree. The three.js objects below are views over those model records.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

import { HALLS, buildExhibition } from './exhibition.js';
import { walk } from './metrics.js';
import { initMetrics } from './metrics-panel.js';
import { MovementTracker, PREPOSITIONS, PREP_STYLE, SAMPLE_HZ, describe } from './movement.js';
import {
  ARTWORK_DISTANCE_M, ArtworkGuard, PERSONAL_SPACE_M, REPLAN_AFTER_S, STAFF_STANDOFF_M, yields,
} from './proximity.js';
import {
  Circle, FRONT_HALF_ANGLE, Location, MAX_OCCUPANCY_FOR_POWER_ON, OFFSET_M, PROXIMITY_THRESHOLD_M,
  Visitor as ModelVisitor, WORLD_FRAME, normalizeAngle, relativeDirection, resolveDescription, shouldPowerOn,
} from './spatial.js';

// ---------------------------------------------------------------------------
// Model constants
// ---------------------------------------------------------------------------
const RULE_RADIUS = PROXIMITY_THRESHOLD_M;      // metres
const MAX_OCCUPANCY = MAX_OCCUPANCY_FOR_POWER_ON; // rule threshold (strictly less than)
const STANDBY_DELAY = 3;      // seconds a display stays ON after the rule stops matching
const MAX_VISITORS = 150;
const MEDIA_LOOP = 'Default Loop';
const MEDIA_INTERACTIVE = 'Interactive Content';

const RELATION_RANGE = 4;     // metres: location events follow the nearest display within this range
const SETTLE_TIME = 0.5;      // seconds a new place or relation must hold before it is logged
const FRAME_AXIS_LEN = 3.5;   // metres drawn for each reference-frame axis

const MARGIN = 0.4;
const UP = new THREE.Vector3(0, 1, 0);

// The location model: the 10-hall exhibition of docs/SIMULATION_METRICS.md, built with the JS port.
const { world: model, frames: FRAMES, plan: PLAN } = buildExhibition();

const ZONE_COLOR = 0xb07cff;
// Places are neutral: the categorical colours are kept for the three metrics (metrics-panel.js).
const ROOT_PLACE_COLOR = '#8592a3';
function placeStyle(place) {
  if (place.parent === null) return { color: ROOT_PLACE_COLOR, opacity: 0.03 };
  if (place.name.startsWith('Exhibit ')) return { color: '#f2e3b3', opacity: 0.45 };
  const hall = HALLS.indexOf(place.name);
  if (hall >= 0) return { color: hall % 2 ? '#a3adbb' : '#7f8a9a', opacity: 0.09 };
  return { color: '#9aa7b8', opacity: 0.05 };   // Entrance, Checkout, corridor, reset passage
}
const FRAME_COLOR = 0xe87ba4;
const PROBE_COLOR = 0x38d0ff;
const WANDER_ROOMS = ['Entrance', ...HALLS, 'Central Corridor', 'Checkout'];
// Rooms whose label would collide with a neighbour's at the default spot (world metres).
const LABEL_AT = { 'Central Corridor': [19.5, 9.5], 'Reset Passage': [2, 9.5], Entrance: [2, 6.3], Checkout: [2, 12.7] };

const DIRECTION_PHRASE = { front: 'in front of', behind: 'behind', left: 'left of', right: 'right of', at: 'at' };

// ---------------------------------------------------------------------------
// Model ↔ scene coordinates
// Model (x, y) lies on the ground. The scene puts the first zone's centre at the
// origin, model +x to the right and model +y away from the camera (scene -z).
// ---------------------------------------------------------------------------
const firstZone = model.zones.values().next().value;
const zoneCorners = firstZone.boundary.worldCorners();
const CX = (Math.min(...zoneCorners.map((c) => c.x)) + Math.max(...zoneCorners.map((c) => c.x))) / 2;
const CY = (Math.min(...zoneCorners.map((c) => c.y)) + Math.max(...zoneCorners.map((c) => c.y))) / 2;

const toThree = (loc, y = 0) => { const w = loc.toWorld(); return new THREE.Vector3(w.x - CX, y, CY - w.y); };
const toModel = (v) => new Location(v.x + CX, CY - v.z);
const worldXYToThree = (x, y, h = 0) => new THREE.Vector3(x - CX, h, CY - y);

const FLOOR = {
  minX: Math.min(...zoneCorners.map((c) => c.x)) - CX, maxX: Math.max(...zoneCorners.map((c) => c.x)) - CX,
  minZ: CY - Math.max(...zoneCorners.map((c) => c.y)), maxZ: CY - Math.min(...zoneCorners.map((c) => c.y)),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const f2 = (n) => (Math.abs(n) < 0.005 ? 0 : n).toFixed(2);
const f1 = (n) => (Math.abs(n) < 0.05 ? 0 : n).toFixed(1);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function clampToFloor(v) {
  v.x = clamp(v.x, FLOOR.minX + MARGIN, FLOOR.maxX - MARGIN);
  v.z = clamp(v.z, FLOOR.minZ + MARGIN, FLOOR.maxZ - MARGIN);
  v.y = 0;
  return v;
}

function makeLabel(className, y) {
  const el = document.createElement('div');
  el.className = 'lbl ' + className;
  const obj = new CSS2DObject(el);
  obj.position.y = y;
  return { el, obj };
}

const fmtLoc = (l) => `(${f2(l.x)}, ${f2(l.y)})`;

// 0° = +x (east), counter-clockwise; model +y is north.
function compass(deg) {
  const names = ['east', 'north-east', 'north', 'north-west', 'west', 'south-west', 'south', 'south-east'];
  return names[(Math.round(normalizeAngle(deg) / 45) + 8) % 8];
}

/** A region's outline as world (x, y) points. */
function regionOutline(region) {
  if (region instanceof Circle) {
    const c = region.center.toWorld();
    return Array.from({ length: 72 }, (_, i) => {
      const a = (i / 72) * Math.PI * 2;
      return [c.x + region.radius * Math.cos(a), c.y + region.radius * Math.sin(a)];
    });
  }
  return region.worldCorners().map((l) => [l.x, l.y]);
}

function groundFill(points) {
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x - CX, y - CY)));
  const g = new THREE.ShapeGeometry(shape);
  g.rotateX(-Math.PI / 2);   // shape (x, y) → scene (x, 0, -y)
  return g;
}

const groundLoop = (points, h) =>
  new THREE.BufferGeometry().setFromPoints(points.map(([x, y]) => worldXYToThree(x, y, h)));

// ---------------------------------------------------------------------------
// Renderer, scene, camera
// ---------------------------------------------------------------------------
const container = document.getElementById('viewport');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
container.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(window.innerWidth, window.innerHeight);
labelRenderer.domElement.className = 'label-layer';
container.appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1117);
scene.fog = new THREE.Fog(0x0d1117, 80, 170);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 200);
const HOME_VIEW = { pos: new THREE.Vector3(6.2, 41, 37), target: new THREE.Vector3(6.2, 0, 2.6) };
/** The home view for this window: further back on narrow screens, so the whole building fits. */
function homeView() {
  const aspect = window.innerWidth / window.innerHeight;
  if (aspect >= 1.2) return HOME_VIEW;
  const k = Math.min(3, 1.4 / aspect);
  const target = new THREE.Vector3(0, 0, 1.5);
  return { pos: target.clone().add(new THREE.Vector3(0, 41, 34.4).multiplyScalar(k)), target };
}
camera.position.copy(homeView().pos);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(homeView().target);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI / 2 - 0.05;
controls.minDistance = 4;
controls.maxDistance = 130;

scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x1a1d24, 0.7));
const sun = new THREE.DirectionalLight(0xffffff, 0.8);
sun.position.set(-8, 20, 12);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 18, bottom: -18, near: 1, far: 90 });
scene.add(sun);

// Floor, grid and walls ------------------------------------------------------
const floorW = FLOOR.maxX - FLOOR.minX, floorD = FLOOR.maxZ - FLOOR.minZ;
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(floorW + 8, floorD + 8),
  new THREE.MeshStandardMaterial({ color: 0x1a1f27, roughness: 0.95 })
);
floor.rotation.x = -Math.PI / 2;
floor.position.set((FLOOR.minX + FLOOR.maxX) / 2, 0, (FLOOR.minZ + FLOOR.maxZ) / 2);
floor.receiveShadow = true;
scene.add(floor);

{
  const pts = [];
  for (let x = Math.ceil(FLOOR.minX); x <= FLOOR.maxX; x++) pts.push(x, 0.005, FLOOR.minZ, x, 0.005, FLOOR.maxZ);
  for (let z = Math.ceil(FLOOR.minZ); z <= FLOOR.maxZ; z++) pts.push(FLOOR.minX, 0.005, z, FLOOR.maxX, 0.005, z);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  scene.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x20262f })));
}

// Partition walls on every room boundary, with a gap at each door (R3, R4).
const WALL_H = 1.3, WALL_T = 0.16;

/** Wall segments [x1, y1, x2, y2] in world metres: room edges merged per line, minus door gaps. */
function wallSegments(plan) {
  const lines = new Map();   // 'v:x' or 'h:y' → [[from, to], ...]
  const add = (key, a, b) => { if (!lines.has(key)) lines.set(key, []); lines.get(key).push([a, b]); };
  for (const r of plan.rooms.values()) {
    add(`h:${r.yMin}`, r.xMin, r.xMax); add(`h:${r.yMax}`, r.xMin, r.xMax);
    add(`v:${r.xMin}`, r.yMin, r.yMax); add(`v:${r.xMax}`, r.yMin, r.yMax);
  }
  const merged = new Map();
  for (const [key, spans] of lines) {
    spans.sort((p, q) => p[0] - q[0]);
    const outSpans = [];
    for (const [a, b] of spans) {
      const last = outSpans[outSpans.length - 1];
      if (last && a <= last[1] + 1e-9) last[1] = Math.max(last[1], b); else outSpans.push([a, b]);
    }
    merged.set(key, outSpans);
  }
  for (const d of plan.doors.values()) {
    const [px, py] = d.point;
    const onV = (merged.get(`v:${px}`) ?? []).some(([a, b]) => py > a && py < b);
    const key = onV ? `v:${px}` : `h:${py}`, c = onV ? py : px, h = DOOR_GAP / 2;
    merged.set(key, (merged.get(key) ?? []).flatMap(([a, b]) =>
      (c + h <= a || c - h >= b) ? [[a, b]] : [[a, c - h], [c + h, b]].filter(([u, w]) => w - u > 0.05)));
  }
  const segs = [];
  for (const [key, spans] of merged) {
    const [axis, v] = [key[0], Number(key.slice(2))];
    for (const [a, b] of spans) segs.push(axis === 'v' ? [v, a, v, b] : [a, v, b, v]);
  }
  return segs;
}
const DOOR_GAP = 1.2;

{
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x2a3340, roughness: 0.85, transparent: true, opacity: 0.92 });
  for (const [x1, y1, x2, y2] of wallSegments(PLAN)) {
    const len = Math.hypot(x2 - x1, y2 - y1);
    const vertical = x1 === x2;
    const wall = new THREE.Mesh(new THREE.BoxGeometry(vertical ? WALL_T : len + WALL_T, WALL_H, vertical ? len + WALL_T : WALL_T), wallMat);
    wall.position.copy(worldXYToThree((x1 + x2) / 2, (y1 + y2) / 2, WALL_H / 2));
    wall.castShadow = true;
    wall.receiveShadow = true;
    scene.add(wall);
  }
}


// Groups for the different overlay layers
const relationGroup = new THREE.Group();   // enters / controls lines (off by default, U5)
relationGroup.visible = false;
const velocityGroup = new THREE.Group();   // velocity arrows
velocityGroup.visible = false;
const placesGroup = new THREE.Group();     // zone boundary + named places
const locGroup = new THREE.Group();        // location-question overlays (probe, frame axes, find marker)
const proxGroup = new THREE.Group();       // proximity rules: artwork guard rings, staff dispatch lines (P10)
scene.add(relationGroup, velocityGroup, placesGroup, locGroup, proxGroup);

const pickables = [];

// ---------------------------------------------------------------------------
// Entity: Spatial Zone (view over a model SpatialZone)
// ---------------------------------------------------------------------------
class SpatialZone {
  constructor(zoneModel) {
    this.kind = 'zone';
    this.model = zoneModel;
    this.Zone_ID = zoneModel.zoneId;
    this.Occupancy = 0;
    this.Ambient_Light = zoneModel.ambientLight;   // lux
    this.defaultAmbient = zoneModel.ambientLight;
    this.displays = [];                             // Spatial Zone —controls→ Smart Display
    this.color = new THREE.Color(ZONE_COLOR);

    const outline = regionOutline(zoneModel.boundary);
    const centre = toThree(zoneModel.boundary.centroid());

    this.floorMat = new THREE.MeshStandardMaterial({
      color: this.color, emissive: this.color, emissiveIntensity: 0.05,
      transparent: true, opacity: 0.16, depthWrite: false,
    });
    this.floor = new THREE.Mesh(groundFill(outline), this.floorMat);
    this.floor.position.y = 0.01;
    this.floor.receiveShadow = true;

    this.border = new THREE.LineLoop(
      groundLoop(outline, 0.02),
      new THREE.LineBasicMaterial({ color: this.color, transparent: true, opacity: 0.8 })
    );

    // Floating "hub" node that represents the zone entity in the relationship graph
    this.hub = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.38),
      new THREE.MeshStandardMaterial({ color: this.color, emissive: this.color, emissiveIntensity: 0.5, flatShading: true })
    );
    this.hub.position.set(centre.x, 4.8, centre.z);
    this.hub.userData.entity = this;

    this.label = makeLabel('zone', 0.85);
    this.hub.add(this.label.obj);

    // Ceiling light whose intensity is the zone's Ambient_Light
    this.spot = new THREE.SpotLight(0xfff1dc, 1, 0, 0.95, 0.6, 0);
    this.spot.position.set(centre.x, 26, centre.z);
    this.spot.target.position.set(centre.x, 0, centre.z);

    scene.add(this.floor, this.border, this.hub, this.spot, this.spot.target);
    // Only the hub is pickable: a click on the floor probes occupants (Q2).
    pickables.push(this.hub);
    this.setAmbient(this.Ambient_Light);
  }

  contains(p) {
    return model.zoneAt(toModel(p)) === this.model;
  }

  randomPoint(margin = 0.7) {
    const b = this.model.boundary;   // a Rect: sample in its own frame
    const l = new Location(rand(b.xMin + margin, b.xMax - margin), rand(b.yMin + margin, b.yMax - margin), b.frame);
    return clampToFloor(toThree(l));
  }

  setAmbient(lux) {
    this.Ambient_Light = lux;
    this.model.ambientLight = lux;
    this.spot.intensity = (lux / 1000) * 3;
    this.floorMat.emissiveIntensity = 0.03 + (lux / 1000) * 0.3;
  }

  get atCapacity() { return this.Occupancy >= MAX_OCCUPANCY; }

  updateLabel() {
    this.label.el.classList.toggle('full', this.atCapacity);
    this.label.el.innerHTML =
      `${esc(this.Zone_ID)} <span>${this.Occupancy}/${MAX_OCCUPANCY}</span>`;
  }
}

// ---------------------------------------------------------------------------
// Entity: Smart Display (view over a model SmartDisplay)
// ---------------------------------------------------------------------------
const SCREEN_W = 512, SCREEN_H = 288;

class SmartDisplay {
  constructor(displayModel, zone) {
    this.kind = 'display';
    this.model = displayModel;
    this.Display_ID = displayModel.displayId;
    this.Current_Media = MEDIA_LOOP;
    this.Volume_Level = displayModel.volumeLevel;
    this.defaultVolume = displayModel.volumeLevel;
    this.Power_State = 'OFF';
    this.Status = 'Standby';
    this.Position = toThree(displayModel.position);
    this.heading = displayModel.worldOrientation();       // model degrees
    const h = (this.heading * Math.PI) / 180;
    this.forward = new THREE.Vector3(Math.cos(h), 0, -Math.sin(h));
    const rot = Math.atan2(Math.cos(h), -Math.sin(h));     // rotation about Y so local +Z = forward
    this.zone = zone;
    zone.displays.push(this);

    this.nearby = [];          // [{ visitor, dist }] within RULE_RADIUS, sorted
    this.proximity = false;
    this.capacityOK = true;
    this.ruleMatched = false;
    this.unmatchedFor = 0;

    this.group = new THREE.Group();
    this.group.position.copy(this.Position);
    this.group.rotation.y = rot;

    const darkMat = new THREE.MeshStandardMaterial({ color: 0x2b323d, roughness: 0.5, metalness: 0.4 });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.42, 0.06, 24), darkMat);
    base.position.y = 0.03;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.1, 12), darkMat);
    pole.position.y = 0.6;
    this.frameMat = new THREE.MeshStandardMaterial({ color: 0x161b22, roughness: 0.4, metalness: 0.5 });
    const frame = new THREE.Mesh(new THREE.BoxGeometry(2.1, 1.24, 0.1), this.frameMat);
    frame.position.y = 1.7;

    this.canvas = document.createElement('canvas');
    this.canvas.width = SCREEN_W;
    this.canvas.height = SCREEN_H;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    const screen = new THREE.Mesh(
      new THREE.PlaneGeometry(1.96, 1.1),
      new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false })
    );
    screen.position.set(0, 1.7, 0.051);

    this.ledMat = new THREE.MeshBasicMaterial({ color: 0xff5d6c });
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.04, 10, 8), this.ledMat);
    led.position.set(0.95, 1.13, 0.06);

    // Rule radius visualisation (2.5 m around Display.Position)
    this.ringMat = new THREE.MeshBasicMaterial({ color: 0x8592a3, transparent: true, opacity: 0.6, depthWrite: false });
    const ring = new THREE.Mesh(new THREE.RingGeometry(RULE_RADIUS - 0.06, RULE_RADIUS, 72), this.ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    this.discMat = new THREE.MeshBasicMaterial({ color: 0x8592a3, transparent: true, opacity: 0.05, depthWrite: false });
    const disc = new THREE.Mesh(new THREE.CircleGeometry(RULE_RADIUS, 72), this.discMat);
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.025;

    // Orientation: the ±45° "in front" cone out to the rule radius, and a facing arrow.
    // CircleGeometry angle -90° maps to local +Z (the way the screen faces) once laid flat.
    const half = (FRONT_HALF_ANGLE * Math.PI) / 180;
    this.coneMat = new THREE.MeshBasicMaterial({ color: 0x8592a3, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide });
    const cone = new THREE.Mesh(new THREE.CircleGeometry(RULE_RADIUS, 36, -Math.PI / 2 - half, 2 * half), this.coneMat);
    cone.rotation.x = -Math.PI / 2;
    cone.position.y = 0.032;
    this.coneEdgeMat = new THREE.LineBasicMaterial({ color: 0x8592a3, transparent: true, opacity: 0.7 });
    const edgeR = RULE_RADIUS;
    const coneEdges = new THREE.Line(new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(Math.sin(-half) * edgeR, 0.036, Math.cos(half) * edgeR),
      new THREE.Vector3(0, 0.036, 0),
      new THREE.Vector3(Math.sin(half) * edgeR, 0.036, Math.cos(half) * edgeR),
    ]), this.coneEdgeMat);
    const facing = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0.07, 0), 1.9, 0xdbe3ee, 0.45, 0.3);

    for (const m of [base, pole, frame]) { m.castShadow = true; }
    for (const m of [base, pole, frame, screen]) { m.userData.entity = this; pickables.push(m); }
    this.group.add(base, pole, frame, screen, led, ring, disc, cone, coneEdges, facing);

    this.label = makeLabel('display', 2.65);
    this.group.add(this.label.obj);
    scene.add(this.group);

    this.drawTimer = 0;
    this.draw(0);
  }

  get topPoint() { return new THREE.Vector3(this.Position.x, 2.35, this.Position.z); }

  // Action: Launch_Media()
  launchMedia() {
    if (this.Power_State !== 'ON') {
      log(`Launch_Media() rejected on <b>${this.Display_ID}</b>: Power_State is OFF`, 'warn', [this.Display_ID]);
      return false;
    }
    if (this.Current_Media === MEDIA_INTERACTIVE) {
      log(`<b>${this.Display_ID}</b> is already showing interactive content`, 'warn', [this.Display_ID]);
      return false;
    }
    this.Current_Media = MEDIA_INTERACTIVE;
    log(`Launch_Media() on <b>${this.Display_ID}</b>: Current_Media → ${MEDIA_INTERACTIVE}`, 'action', [this.Display_ID]);
    return true;
  }

  resetMedia(reason = '') {
    if (this.Current_Media === MEDIA_LOOP) return false;
    this.Current_Media = MEDIA_LOOP;
    log(`<b>${this.Display_ID}</b>: Current_Media → ${MEDIA_LOOP}${reason}`, 'action', [this.Display_ID]);
    return true;
  }

  draw(t) {
    const ctx = this.ctx, W = SCREEN_W, H = SCREEN_H;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';

    if (this.Power_State === 'OFF') {
      ctx.fillStyle = '#030405';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#1c222b';
      ctx.font = 'bold 26px system-ui, sans-serif';
      ctx.fillText(`${this.Display_ID} · OFF`, W / 2, H / 2 + 9);
    } else if (this.Current_Media === MEDIA_LOOP) {
      const hue = (t * 25) % 360;
      const g = ctx.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, `hsl(${hue}, 65%, 38%)`);
      g.addColorStop(1, `hsl(${(hue + 90) % 360}, 65%, 22%)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = '#fff';
      for (let i = 0; i < 8; i++) {
        const x = ((i * 90 + t * 70) % (W + 240)) - 120;
        ctx.beginPath();
        ctx.moveTo(x, 0); ctx.lineTo(x + 40, 0); ctx.lineTo(x - 60, H); ctx.lineTo(x - 100, H);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 48px system-ui, sans-serif';
      ctx.fillText('DEFAULT LOOP', W / 2, H / 2 + 6);
      ctx.font = '22px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.fillText(`Ambient content · ${this.Display_ID}`, W / 2, H / 2 + 44);
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.fillRect(40, H - 26, W - 80, 6);
      ctx.fillStyle = '#fff';
      ctx.fillRect(40, H - 26, (W - 80) * ((t % 8) / 8), 6);
    } else {
      ctx.fillStyle = '#071022';
      ctx.fillRect(0, 0, W, H);
      const cx = W / 2, cy = H / 2 - 20;
      ctx.lineWidth = 3;
      for (let i = 0; i < 4; i++) {
        const r = (t * 70 + i * 50) % 200;
        ctx.strokeStyle = `rgba(56, 208, 255, ${(1 - r / 200) * 0.8})`;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = '#e8fbff';
      ctx.font = 'bold 46px system-ui, sans-serif';
      ctx.fillText('INTERACTIVE', cx, cy + 14);
      const who = this.nearby[0]?.visitor.User_ID;
      ctx.font = '22px system-ui, sans-serif';
      ctx.fillStyle = '#7fe3ff';
      ctx.fillText(who ? `Welcome, ${who} — tap to explore` : 'Step closer to interact', cx, cy + 52);
      const active = Math.floor(t * 1.5) % 4;
      for (let i = 0; i < 4; i++) {
        ctx.fillStyle = i === active ? '#38d0ff' : '#18355a';
        ctx.fillRect(56 + i * 104, H - 62, 88, 40);
      }
    }

    // Volume indicator
    if (this.Power_State === 'ON') {
      const bars = Math.round(this.Volume_Level / 20);
      for (let i = 0; i < 5; i++) {
        ctx.fillStyle = i < bars ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.2)';
        const bh = 6 + i * 4;
        ctx.fillRect(W - 70 + i * 10, 34 - bh, 6, bh);
      }
    }
    this.texture.needsUpdate = true;
  }

  updateVisuals(dt, t) {
    this.drawTimer -= dt;
    if (this.drawTimer <= 0) { this.draw(t); this.drawTimer = 1 / 20; }

    const on = this.Power_State === 'ON';
    const interactive = on && this.Current_Media === MEDIA_INTERACTIVE;
    this.ledMat.color.setHex(interactive ? 0x38d0ff : on ? 0x3fd68a : 0xff5d6c);

    let c = 0x8592a3;
    if (this.ruleMatched) c = 0x3fd68a;
    else if (this.proximity && !this.capacityOK) c = 0xff5d6c;
    else if (on) c = 0xffb547;
    for (const m of [this.ringMat, this.discMat, this.coneMat, this.coneEdgeMat]) m.color.setHex(c);
    // U5: faint until a visitor is in range.
    this.discMat.opacity = this.proximity ? 0.1 : 0.02;
    this.coneMat.opacity = this.proximity ? 0.16 : 0.05;
    this.ringMat.opacity = this.proximity || on ? 0.55 : 0.22;
    this.coneEdgeMat.opacity = this.proximity ? 0.6 : 0.25;
  }

  updateLabel() {
    const interactive = this.Power_State === 'ON' && this.Current_Media === MEDIA_INTERACTIVE;
    this.label.el.className = `lbl display ${this.Power_State}${interactive ? ' interactive' : ''}`;
    const html = `<i class="dot" title="${this.Power_State}"></i>${esc(this.Display_ID)}`;
    if (this.label.el.innerHTML !== html) this.label.el.innerHTML = html;
  }
}

// ---------------------------------------------------------------------------
// Entity: Visitor (view over a model Visitor)
// ---------------------------------------------------------------------------
const visitorGeo = {
  body: new THREE.CapsuleGeometry(0.22, 0.8, 4, 12),
  head: new THREE.SphereGeometry(0.17, 16, 12),
};
let visitorSeq = 0;
const tmpDesired = new THREE.Vector3();
const tmpTo = new THREE.Vector3();

class Visitor {
  constructor(visitorModel, { homeZone = null, anchored = false } = {}) {
    this.kind = 'visitor';
    const n = ++visitorSeq;
    this.model = visitorModel;
    this.User_ID = visitorModel.userId;
    this.Position = clampToFloor(toThree(visitorModel.position));
    this.Velocity = new THREE.Vector3();
    this.Dwell_Time = visitorModel.dwellTime;
    this.zone = null;              // Visitor —enters→ Spatial Zone
    this.homeZone = homeZone;      // crowd members stay in their zone
    this.anchored = anchored;      // demo.py visitors stay where they are put
    this.speed = rand(0.7, 1.3);
    this.pause = rand(0, 1.5);
    this.target = new THREE.Vector3();
    this.dragging = false;
    this.track = null;             // location-event state, see trackLocation()
    // Proximity (docs/PROXIMITY_RULES.md): mode is null (own business), 'duty' (staff on an
    // artwork call), 'step' (visitor stepping back) or 'return' (staff going back to post).
    this.mode = null;
    this.post = anchored ? this.Position.clone() : null;
    this.intent = new THREE.Vector3();   // where it wants to go this frame, before yielding
    this.stopFor = null;                 // ID it is yielding to (P3)
    this.blocked = 0;                    // seconds spent yielding (P4)
    this.lastStopLog = -Infinity;
    this.stopLogged = false;

    const color = new THREE.Color().setHSL(((n * 47) % 360) / 360, 0.65, 0.6);
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6 });
    this.group = new THREE.Group();
    this.body = new THREE.Mesh(visitorGeo.body, mat);
    this.body.position.y = 0.62;
    this.head = new THREE.Mesh(visitorGeo.head, new THREE.MeshStandardMaterial({ color: 0xf2e6d8, roughness: 0.7 }));
    this.head.position.y = 1.42;
    for (const m of [this.body, this.head]) { m.castShadow = true; m.userData.entity = this; pickables.push(m); }
    this.group.add(this.body, this.head);

    this.label = makeLabel(visitorModel.role === 'staff' ? 'visitor staff' : 'visitor', 1.85);
    this.label.el.textContent = this.User_ID;
    this.group.add(this.label.obj);

    // P10: a 0.5 m ring, so two rings overlap exactly when agents are closer than 1 m.
    this.spaceMat = new THREE.MeshBasicMaterial({ color: 0x8592a3, transparent: true, opacity: 0.35, depthWrite: false });
    this.spaceRing = new THREE.Mesh(new THREE.RingGeometry(PERSONAL_SPACE_M / 2 - 0.04, PERSONAL_SPACE_M / 2, 40), this.spaceMat);
    this.spaceRing.rotation.x = -Math.PI / 2;
    this.spaceRing.position.y = 0.045;
    this.group.add(this.spaceRing);
    this.group.position.copy(this.Position);
    scene.add(this.group);

    this.arrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 1, 0xffd166, 0.2, 0.14);
    velocityGroup.add(this.arrow);

    this.pickTarget();
    this.syncModel();
  }

  pickTarget() {
    // Visitors are drawn to displays now and then, which is what exercises the rule.
    const goal = new THREE.Vector3();
    const candidates = this.homeZone ? this.homeZone.displays : displays;
    if (Math.random() < 0.3 && candidates.length) {
      const d = pick(candidates);
      const dir = d.forward.clone().applyAxisAngle(UP, rand(-0.9, 0.9));
      goal.copy(d.Position).addScaledVector(dir, rand(0.9, 2.2));
    } else {
      // P12: never aim within 1.3 m of an artwork.
      for (let tries = 0; tries < 12; tries++) {
        const r = PLAN.rooms.get(pick(WANDER_ROOMS));
        const l = new Location(rand(r.xMin + 0.8, r.xMax - 0.8), rand(r.yMin + 0.8, r.yMax - 0.8));
        goal.copy(toThree(l));
        if ([...PLAN.artworks.values()].every((a) => a.distanceTo(l) >= 1.3)) break;
      }
    }
    clampToFloor(goal);
    // Walk there through the doors rather than through the walls (R15).
    const route = walk(PLAN, toModel(this.Position), toModel(goal), this.model.role);
    this.waypoints = route.value === Infinity ? [goal] : route.path.slice(1).map(([x, y]) => worldXYToThree(x, y));
    this.target.copy(this.waypoints.shift());
  }

  /** Walk to `goal` through the doors (staff calls, returning to post). */
  routeTo(goal, mode) {
    const route = walk(PLAN, toModel(this.Position), toModel(goal), this.model.role);
    this.waypoints = route.value === Infinity ? [goal.clone()] : route.path.slice(1).map(([x, y]) => worldXYToThree(x, y));
    this.target.copy(this.waypoints.shift());
    this.goal = goal.clone();
    this.mode = mode;
    this.pause = 0;
  }

  /** P8: walk straight back to `goal` (it is inside the same hall). */
  stepBackTo(goal) {
    this.stepDone = false;
    this.waypoints = [];
    this.target.copy(goal);
    this.goal = goal.clone();
    this.mode = 'step';
    this.pause = 0;
  }

  /** P5: staff on a call and visitors stepping back follow the guard procedure, not personal space. */
  get exempt() { return this.dragging || this.mode === 'duty' || this.mode === 'step'; }

  update(dt, others) {
    if (this.dragging || (this.anchored && !this.mode)) { this.Velocity.set(0, 0, 0); this.intent.set(0, 0, 0); this.stopFor = null; return; }
    tmpDesired.set(0, 0, 0);
    if (this.pause > 0) {
      this.pause -= dt;
    } else {
      tmpTo.subVectors(this.target, this.Position).setY(0);
      const d = tmpTo.length();
      const speed = this.mode === 'step' ? 0.7 : this.mode === 'duty' ? Math.max(this.speed, 1.2) : this.speed;
      if (d < 0.25 && this.waypoints?.length) {
        this.target.copy(this.waypoints.shift());   // through a door, on to the next leg
      } else if (d < (this.mode === 'step' ? 0.03 : 0.25)) {
        if (this.mode === 'step' && this.stepDone) {
          // P8: the call is over and the step back is complete
          this.mode = null; this.stepDone = false;
          if (this.anchored) this.post = this.Position.clone(); else this.pause = 1.5;
        } else if (this.mode === 'duty' || this.mode === 'step') {
          // hold here until the guard moves on (P8/P9)
        } else if (this.mode === 'return' && this.post) {
          this.mode = null;                        // back at post: stand again
        } else {
          this.mode = null;
          this.pause = rand(1.5, 6);
          this.pickTarget();
        }
      } else {
        tmpDesired.copy(tmpTo).multiplyScalar(Math.min(speed, (d / 0.25) * speed) / d);
      }
    }
    this.intent.copy(tmpDesired);

    // P2-P4: personal space. Yield if closer than 1 m and closing in faster than the other.
    const was = this.stopFor;
    this.stopFor = null;
    if (!this.exempt) {
      const me = [this.Position.x + CX, CY - this.Position.z], mv = [tmpDesired.x, -tmpDesired.z];
      for (const o of others) {
        if (o === this || o.exempt) continue;
        const op = [o.Position.x + CX, CY - o.Position.z];
        if (Math.abs(op[0] - me[0]) >= PERSONAL_SPACE_M || Math.abs(op[1] - me[1]) >= PERSONAL_SPACE_M) continue;
        if (yields(this.User_ID, me, mv, o.User_ID, op, [o.intent.x, -o.intent.z])) { this.stopFor = o; break; }
      }
    }
    if (this.stopFor) {
      tmpDesired.set(0, 0, 0);
      this.blocked += dt;
      if (this.blocked >= REPLAN_AFTER_S && !this.mode && !this.anchored) {
        // P4: pick a new destination whose first leg doesn't close in on the agent we yield to.
        this.blocked = 0;
        const me = [this.Position.x + CX, CY - this.Position.z];
        const other = [this.stopFor.Position.x + CX, CY - this.stopFor.Position.z];
        for (let tries = 0; tries < 8; tries++) {
          this.pickTarget();
          const leg = [this.target.x - this.Position.x, -(this.target.z - this.Position.z)];
          if (!yields(this.User_ID, me, leg, this.stopFor.User_ID, other, [this.stopFor.intent.x, -this.stopFor.intent.z])) break;
        }
      }
      if (!was) { this.stopTime = 0; this.stopLogged = false; }
      this.stopTime = (this.stopTime ?? 0) + dt;
      // P11: log a stop once it has lasted 0.5 s, at most one line per agent every 5 s.
      if (!this.stopLogged && this.stopTime >= 0.5 && simTime - this.lastStopLog >= 5) {
        const d = Math.hypot(this.Position.x - this.stopFor.Position.x, this.Position.z - this.stopFor.Position.z);
        this.stopLogged = true;
        this.lastStopLog = simTime;
        log(`<b>${esc(this.User_ID)}</b> stops: ${d.toFixed(2)} m from ${esc(this.stopFor.User_ID)} (personal space)`, 'prox', [this.User_ID, this.stopFor.User_ID]);
      }
    } else {
      this.blocked = 0;
      if (was && this.stopLogged) { log(`<b>${esc(this.User_ID)}</b> walks on`, 'prox', [this.User_ID]); this.stopLogged = false; }
    }
    // Simple separation so crowds do not overlap
    for (const o of others) {
      if (o === this) continue;
      const dx = this.Position.x - o.Position.x;
      const dz = this.Position.z - o.Position.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < 0.36 && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        const push = ((0.6 - d) / 0.6) * 1.2;
        tmpDesired.x += (dx / d) * push;
        tmpDesired.z += (dz / d) * push;
      }
    }
    if (this.stopFor) this.Velocity.copy(tmpDesired);   // a stop is a stop, not a slow drift
    else this.Velocity.lerp(tmpDesired, Math.min(1, dt * 4));
    this.Position.addScaledVector(this.Velocity, dt);
    clampToFloor(this.Position);
    this.group.position.copy(this.Position);
  }

  /** Copy the scene state into the model record the location queries read. */
  syncModel() {
    this.model.position = toModel(this.Position);
    this.model.velocity = [this.Velocity.x, -this.Velocity.z];
    this.model.dwellTime = this.Dwell_Time;
  }

  updateArrow() {
    const speed = this.Velocity.length();
    this.arrow.visible = speed > 0.05;
    if (!this.arrow.visible) return;
    this.arrow.position.set(this.Position.x, 0.08, this.Position.z);
    this.arrow.setDirection(tmpTo.copy(this.Velocity).normalize());
    this.arrow.setLength(0.3 + speed * 1.2, 0.2, 0.14);
  }

  dispose() {
    scene.remove(this.group);
    velocityGroup.remove(this.arrow);
    for (const m of [this.body, this.head]) {
      const i = pickables.indexOf(m);
      if (i >= 0) pickables.splice(i, 1);
    }
    this.body.material.dispose();
    this.head.material.dispose();
    this.arrow.dispose();
    this.spaceRing.geometry.dispose();
    this.spaceMat.dispose();
    if (model.visitors.get(this.User_ID) === this.model) model.remove(this.User_ID);
    visitorById.delete(this.User_ID);
  }
}

// ---------------------------------------------------------------------------
// World state
// ---------------------------------------------------------------------------
const zones = [...model.zones.values()].map((z) => new SpatialZone(z));
const zoneOfModel = new Map(zones.map((z) => [z.model, z]));
for (const z of zones) { z.hub.visible = false; z.label.obj.visible = false; }   // shown with Relations (U5)
const displays = [...model.displays.values()].map((d) =>
  new SmartDisplay(d, zones.find((z) => z.model.displayIds.has(d.displayId))));
const displayById = new Map(displays.map((d) => [d.Display_ID, d]));
let visitors = [];
const visitorById = new Map();

const zoneAt = (p) => zoneOfModel.get(model.zoneAt(toModel(p))) ?? null;

// Relationship: Spatial Zone —controls→ Smart Display (static dashed lines)
for (const z of zones) {
  for (const d of z.displays) {
    const g = new THREE.BufferGeometry().setFromPoints([z.hub.position, d.topPoint]);
    const line = new THREE.Line(g, new THREE.LineDashedMaterial({
      color: z.color, dashSize: 0.3, gapSize: 0.18, transparent: true, opacity: 0.9,
    }));
    line.computeLineDistances();
    relationGroup.add(line);
  }
}

// Relationship: Visitor —enters→ Spatial Zone (dynamic, one segment per visitor)
const enterLines = new THREE.LineSegments(
  new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.35 })
);
enterLines.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_VISITORS * 6), 3));
enterLines.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_VISITORS * 6), 3));
enterLines.frustumCulled = false;
relationGroup.add(enterLines);

// Rule proximity links (visitor ↔ display within 2.5 m) — always visible
const proxLines = new THREE.LineSegments(
  new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ vertexColors: true })
);
const MAX_PROX = MAX_VISITORS * displays.length;
proxLines.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_PROX * 6), 3));
proxLines.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_PROX * 6), 3));
proxLines.frustumCulled = false;
scene.add(proxLines);

// Selection marker
const selRing = new THREE.Mesh(
  new THREE.RingGeometry(0.45, 0.53, 48),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false })
);
selRing.rotation.x = -Math.PI / 2;
selRing.position.y = 0.04;
selRing.visible = false;
scene.add(selRing);

// ---------------------------------------------------------------------------
// Places layer: zone boundary + named places as labelled ground regions
// ---------------------------------------------------------------------------
const placeViews = new Map();   // name → { place, fillMat, lineMat, baseOpacity, label }

{
  for (const place of model.places.values()) {
    const nested = place.parent !== null;
    const { color, opacity: baseOpacity } = placeStyle(place);
    const depth = place.depth();
    const outline = regionOutline(place.region);

    const fillMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: baseOpacity, depthWrite: false });
    const fill = new THREE.Mesh(groundFill(outline), fillMat);
    fill.position.y = 0.012 + depth * 0.003;
    fill.renderOrder = 1 + depth;
    const lineMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: nested ? 0.95 : 0.6 });
    const line = new THREE.LineLoop(groundLoop(outline, 0.03 + depth * 0.003), lineMat);

    // Circles are labelled at the centre. Rectangles are labelled just inside their
    // south edge, clear of the displays and frame axes near their middles; the
    // outer place's label sits in its south-west corner.
    let anchor = place.region.centroid();
    if (LABEL_AT[place.name]) {
      anchor = new Location(...LABEL_AT[place.name]);
    } else if (place.name.startsWith('Exhibit ')) {
      const c = place.region.centroid();
      anchor = new Location(c.x, c.y - 1.2);   // just south, clear of wall displays' labels
    } else if (place.region.worldCorners) {
      const r = place.region;
      // South-row rooms are labelled along their north edge, clear of the displays on the south wall.
      const top = nested && r.yMin === 0;
      anchor = nested
        ? new Location(r.xMax - Math.min(1.6, (r.xMax - r.xMin) / 2), top ? r.yMax - 0.5 : r.yMin + 0.5, r.frame)
        : new Location(r.xMin + 3, r.yMax + 1.1, r.frame);   // the building: just outside its north wall
    }
    const label = makeLabel('place', 0.05);
    label.obj.position.copy(toThree(anchor, 0.05));
    label.el.textContent = place.name;
    // U4: rooms get a quiet text label; artworks and the building itself go unlabelled
    // (their names show in the hover description and the Scene tab).
    if (!nested || place.name.startsWith('Exhibit ') || place.name.startsWith('Installation ')) {
      label.obj.visible = false;
      label.obj.userData.hiddenLabel = true;
    }
    label.el.title = `Locate ${place.name}`;
    // A press on a label over a visitor or display goes to that object: the label is
    // flat on the floor where agents stand, so it must not stop you grabbing them.
    label.el.addEventListener('pointerdown', (e) => {
      label.forwarded = false;
      if (e.button !== 0) return;
      const ent = pickAt(e);
      if (!ent || ent.kind === 'zone') return;
      label.forwarded = true;
      if (ent.kind === 'visitor') {
        canvas.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, clientX: e.clientX, clientY: e.clientY,
          pointerId: e.pointerId, pointerType: e.pointerType, button: 0, buttons: 1, isPrimary: true,
        }));
      } else {
        select(ent);
      }
    });
    label.el.addEventListener('click', () => {
      if (label.forwarded) { label.forwarded = false; return; }
      if (metricsActive()) { metricsUI.setB(`place:${place.name}`); return; }   // Metrics tab: the place becomes B
      setLocSubject(place.name); renderLocation();
    });
    // The label sits on the ground it names, so hovering it still describes that ground (Q4).
    label.el.addEventListener('pointermove', (e) => hoverAt(e));
    label.el.addEventListener('pointerleave', hideTip);

    placesGroup.add(fill, line, label.obj);
    placeViews.set(place.name, { place, fillMat, lineMat, baseOpacity, label, color });
  }

}

const placesLabelObjs = () => placesGroup.children.filter((o) => o.isCSS2DObject);

// ---------------------------------------------------------------------------
// Event log
// ---------------------------------------------------------------------------
const logEl = document.getElementById('log');
let simTime = 0;

// M12: every entry has a category the Log tab can filter on.
const LOG_CATEGORY = {
  info: 'rules', rule: 'rules', off: 'rules', action: 'rules', warn: 'rules',
  prox: 'proximity', place: 'location', enter: 'location', move: 'movement', disc: 'metrics',
};
// M11: each agent's (and screen's) own activity, shown in its window.
const activity = new Map();   // id → [{ t, html, type }]

/** Log `msg` (HTML) globally, and in the activity of every ID in `who`. */
function log(msg, type = 'info', who = []) {
  const cat = LOG_CATEGORY[type] ?? 'rules';
  const li = document.createElement('li');
  li.className = `${type} cat-${cat}`;
  li.innerHTML = `<time>${simTime.toFixed(1)}s</time>${msg}`;
  logEl.prepend(li);
  while (logEl.children.length > 200) logEl.lastChild.remove();
  for (const id of new Set(who)) {
    if (!id) continue;
    if (!activity.has(id)) activity.set(id, []);
    const list = activity.get(id);
    list.push({ t: simTime, html: msg, type });
    if (list.length > 150) list.splice(0, list.length - 150);
  }
}

// ---------------------------------------------------------------------------
// Visitor management
// ---------------------------------------------------------------------------
function spawnVisitor(pos, { homeZone = null, silent = false, id = null, anchored = false, dwell = 0, role = 'visitor' } = {}) {
  if (visitors.length >= MAX_VISITORS) {
    log(`Visitor limit (${MAX_VISITORS}) reached`, 'warn');
    return null;
  }
  let userId = id;
  if (!userId) {
    let n = visitorSeq + 1;
    while (model.visitors.has(`V-${String(n).padStart(3, '0')}`)) n++;
    userId = `V-${String(n).padStart(3, '0')}`;
  }
  const mv = model.addVisitor(new ModelVisitor(userId, toModel(clampToFloor(pos.clone())), { dwellTime: dwell, role }));
  const v = new Visitor(mv, { homeZone, anchored });
  if (silent) v.zone = zoneAt(v.Position);
  visitors.push(v);
  visitorById.set(v.User_ID, v);
  initTrack(v);
  return v;
}

function removeVisitor(v) {
  v.dispose();
  visitors = visitors.filter((o) => o !== v);
  if (selected === v) select(null);
  log(`${v.User_ID} leaves${v.zone ? ' ' + v.zone.Zone_ID : ''}`, 'enter', [v.User_ID]);
}

function spawnCrowd(zone, count = 10) {
  let n = 0;
  for (let i = 0; i < count; i++) {
    const v = spawnVisitor(zone.randomPoint(0.8), { homeZone: zone, silent: true });
    if (v) n++;
  }
  if (n) log(`${n} visitors enter <b>${zone.Zone_ID}</b> (crowd)`, 'enter');
}

// ---------------------------------------------------------------------------
// Simulation step: movement → relationships → rule evaluation
// ---------------------------------------------------------------------------
const guard = new ArtworkGuard();
let guardView = { goTo: new Map(), stepBack: new Map() };

/** P7-P9: run the artwork guard and carry out its orders. */
function runGuard() {
  const orders = guard.update(PLAN, model);
  for (const e of orders.events) log(esc(e.text), 'prox', e.agents ?? []);
  for (const [id, goal] of orders.goTo) {
    const s = visitorById.get(id);
    const g = toThree(goal);
    if (s && (s.mode !== 'duty' || !s.goal || s.goal.distanceTo(g) > 0.4)) s.routeTo(g, 'duty');
  }
  for (const [id, goal] of orders.stepBack) {
    const v = visitorById.get(id);
    if (v && v.mode !== 'step') v.stepBackTo(toThree(goal));
  }
  for (const id of orders.release) {
    const s = visitorById.get(id);
    if (!s) continue;
    if (s.post) s.routeTo(s.post, 'return');
    else { s.mode = null; s.pickTarget(); }
  }
  // A visitor whose call ended finishes the step back, then carries on (see update()).
  for (const v of visitors) if (v.mode === 'step' && !orders.stepBack.has(v.User_ID)) v.stepDone = true;
  guardView = orders;
}

function step(dt) {
  for (const v of visitors) v.update(dt, visitors);
  for (const v of visitors) v.syncModel();
  runGuard();

  // Visitor —enters→ Spatial Zone, Occupancy, Dwell_Time (membership comes from the model)
  for (const v of visitors) {
    const z = zoneAt(v.Position);
    if (z !== v.zone) {
      if (z) log(`${v.User_ID} enters zone ${z.Zone_ID}`, 'enter', [v.User_ID]);
      v.zone = z;
      v.Dwell_Time = 0;
    } else {
      v.Dwell_Time += dt;
    }
    v.model.dwellTime = v.Dwell_Time;
  }
  for (const z of zones) z.Occupancy = model.occupancy(z.Zone_ID);

  for (const d of displays) evaluateRule(d, dt);
}

function evaluateRule(d, dt) {
  // Same semantics as rules.py: only visitors in the display's controlling zone count.
  const zoneModel = d.zone.model;
  d.nearby = model.occupantsAt(d.model.position, RULE_RADIUS)
    .filter((mv) => model.zoneAt(mv.position) === zoneModel)
    .map((mv) => ({ visitor: visitorById.get(mv.userId), dist: d.model.position.distanceTo(mv.position) }));

  d.proximity = d.nearby.length > 0;
  d.capacityOK = d.zone.Occupancy < MAX_OCCUPANCY;
  d.ruleMatched = shouldPowerOn(model, zoneModel.zoneId, d.Display_ID);

  if (d.ruleMatched) {
    d.unmatchedFor = 0;
    if (d.Power_State !== 'ON') {
      d.Power_State = 'ON';
      log(`Rule fired → <b>${d.Display_ID}</b> Power_State = ON ` +
          `(${d.nearby[0].visitor.User_ID} @ ${d.nearby[0].dist.toFixed(2)} m, ` +
          `${d.zone.Zone_ID} occupancy ${d.zone.Occupancy})`, 'rule', [d.Display_ID, d.nearby[0].visitor.User_ID]);
    }
  } else if (d.Power_State === 'ON') {
    d.unmatchedFor += dt;
    if (d.unmatchedFor >= STANDBY_DELAY) {
      d.Power_State = 'OFF';
      const why = d.proximity ? `${d.zone.Zone_ID} at capacity` : 'no visitor in range';
      log(`<b>${d.Display_ID}</b> Power_State = OFF (${why})`, 'off', [d.Display_ID]);
      d.resetMedia(' (powered off)');
    }
  }
  d.model.powerState = d.Power_State;

  if (d.Power_State === 'ON') {
    if (!d.ruleMatched) d.Status = `Cooling down (${Math.max(0, STANDBY_DELAY - d.unmatchedFor).toFixed(1)} s)`;
    else if (d.Current_Media === MEDIA_INTERACTIVE) d.Status = 'Interactive session';
    else d.Status = 'Engaged · visitor in range';
  } else {
    d.Status = d.proximity && !d.capacityOK ? 'Inhibited · zone at capacity' : 'Standby';
  }
}

// ---------------------------------------------------------------------------
// Location events: "alice entered Reception Desk", "bob is now in front of gallery-screen"
// A change is logged once it has held for SETTLE_TIME, so edge jitter stays quiet.
// ---------------------------------------------------------------------------
const placeKey = (loc) => model.placeAt(loc)?.name ?? null;

function relationKey(loc) {
  const d = model.nearestDisplay(loc);
  if (!d || d.position.distanceTo(loc) > RELATION_RANGE) return null;
  return `${d.displayId}|${relativeDirection(d, loc)}`;
}

function initTrack(v) {
  const loc = v.model.position;
  v.track = {
    place: { current: placeKey(loc), pending: null, t: 0 },
    rel: { current: relationKey(loc), pending: null, t: 0 },
  };
}

function settle(state, value, dt, emit) {
  if (value === state.current) { state.pending = null; return; }
  if (value !== state.pending) { state.pending = value; state.t = 0; return; }
  state.t += dt;
  if (state.t >= SETTLE_TIME) {
    const prev = state.current;
    state.current = value;
    state.pending = null;
    emit(prev, value);
  }
}

function logPlaceChange(v, prev, next) {
  const who = `<b>${esc(v.User_ID)}</b>`;
  if (next === null) { log(`${who} left ${esc(prev)}`, 'place', [v.User_ID]); return; }
  const prevPlace = prev && model.places.get(prev);
  if (prevPlace && prevPlace.ancestors().some((p) => p.name === next)) {
    log(`${who} left ${esc(prev)} (back in ${esc(next)})`, 'place', [v.User_ID]);
  } else {
    log(`${who} entered ${esc(next)}`, 'place', [v.User_ID]);
  }
}

function logRelationChange(v, prev, next) {
  const who = `<b>${esc(v.User_ID)}</b>`;
  if (next === null) {
    log(`${who} moved away from ${esc(prev.split('|')[0])}`, 'place', [v.User_ID]);
    return;
  }
  const [displayId, dir] = next.split('|');
  log(`${who} is now ${DIRECTION_PHRASE[dir]} ${esc(displayId)}`, 'place', [v.User_ID, displayId]);
}

function trackLocation(dt) {
  for (const v of visitors) {
    const loc = v.model.position;
    settle(v.track.place, placeKey(loc), dt, (a, b) => logPlaceChange(v, a, b));
    settle(v.track.rel, relationKey(loc), dt, (a, b) => logRelationChange(v, a, b));
  }
}

// ---------------------------------------------------------------------------
// Location questions (Q1-Q4)
// ---------------------------------------------------------------------------
const locEl = document.getElementById('drawer');
const out = (name) => locEl.querySelector(`[data-out="${name}"]`);
const locInput = (name) => locEl.querySelector(`[data-loc-input="${name}"]`);

const loc = {
  subject: null,        // Q1: id of the object to locate
  probe: null,          // Q2: Location clicked on the ground
  radius: 2,            // Q2: metres
  frame: 'g2-screen',   // Q3: 'world' or a display's frame id
  visitor: 'bob',       // Q3: visitor shown in that frame
  hover: null,          // Q4: Location under the pointer
  find: null,           // Q4: resolveDescription() result for the text box
};

const frameByName = (name) => (name === 'world' ? WORLD_FRAME : FRAMES[name]);

function setLocSubject(id) {
  loc.subject = id;
  if (model.visitors.has(id)) loc.visitor = id;
}

/** "At Reception Desk (in Main Lobby → lobby), 8.6 m in front of welcome-screen" */
function describeText(l) {
  const d = model.describe(l);
  const zone = model.zoneAt(l);
  let where;
  if (d.place) {
    const chain = d.place.ancestors().map((p) => p.name);
    if (zone) chain.push(zone.zoneId);
    where = `At ${d.place.name}${chain.length ? ` (in ${chain.join(' → ')})` : ''}`;
  } else {
    where = zone ? `In zone ${zone.zoneId}` : 'Outside any known place';
  }
  if (!d.nearestDisplay) return `${where}; no displays`;
  if (d.direction === 'at') return `${where}, at ${d.nearestDisplay.displayId}`;
  return `${where}, ${d.distance.toFixed(1)} m ${DIRECTION_PHRASE[d.direction]} ${d.nearestDisplay.displayId}`;
}

function idChip(id) {
  const kind = model.kindOf(id);
  return `<span class="chip ${kind}" data-locate="${esc(id)}">${esc(id)}</span>`;
}

function renderQ1() {
  const el = out('q1');
  const id = loc.subject;
  if (!id || !model.registries().some((r) => r.has(id))) {
    setHTML(el, '<span class="rel">Click a visitor, display, zone node or place label.</span>');
    return;
  }
  const kind = model.kindOf(id);
  const l = model.locate(id);
  const w = l.toWorld();
  let html = `<div>${idChip(id)}<span class="rel">${kind}</span></div>`;
  html += `<div class="mono">${fmtLoc(l)} in frame <b>${esc(l.frame.frameId)}</b></div>`;
  if (l.frame !== WORLD_FRAME) html += `<div class="mono">= ${fmtLoc(w)} in frame <b>world</b></div>`;
  const obj = model.get(id);
  if (kind === 'visitor') {
    html += `<div class="sub">in ${esc(model.placeAt(l)?.name ?? 'no place')} · zone ${esc(model.zoneAt(l)?.zoneId ?? 'none')}</div>`;
  } else if (kind === 'display') {
    const h = obj.worldOrientation();
    html += `<div class="sub">faces ${f1(h)}° (${compass(h)}) · ${esc(model.placeAt(l)?.name ?? 'no place')}</div>`;
  } else if (kind === 'zone') {
    const b = obj.boundary;
    html += `<div class="sub">centre of a ${b.xMax - b.xMin} × ${b.yMax - b.yMin} m boundary</div>`;
  } else {
    const r = obj.region;
    const shape = r instanceof Circle ? `circle, r = ${r.radius} m` : `${r.xMax - r.xMin} × ${r.yMax - r.yMin} m rectangle`;
    html += `<div class="sub">centre of a ${shape}${obj.parent ? ` · inside ${esc(obj.parent.name)}` : ''}</div>`;
  }
  setHTML(el, html);
}

function renderQ2() {
  setHTML(out('radius'), `${loc.radius.toFixed(1)} m`);
  if (!loc.probe) {
    setHTML(out('q2'), '<span class="rel">Click an empty spot on the ground.</span>');
    return;
  }
  const hits = model.occupantsAt(loc.probe, loc.radius);
  const where = model.placeAt(loc.probe)?.name ?? 'outside every place';
  let html = `<div class="mono">within ${loc.radius.toFixed(1)} m of ${fmtLoc(loc.probe)} · ${esc(where)}</div>`;
  html += hits.length
    ? `<div>${hits.map((v) => `${idChip(v.userId)}<span class="rel">${f2(loc.probe.distanceTo(v.position))} m</span>`).join(' ')}</div>`
    : '<div class="no">nobody</div>';
  setHTML(out('q2'), html);
}

function renderQ3() {
  const sel = locInput('frame');
  const names = ['world', ...Object.keys(FRAMES)];
  if (sel.options.length !== names.length) {
    sel.innerHTML = names.map((n) => `<option value="${esc(n)}">${n === 'world' ? 'World' : `${esc(n)} frame`}</option>`).join('');
  }
  if (sel.value !== loc.frame) sel.value = loc.frame;

  if (!model.visitors.has(loc.visitor)) loc.visitor = model.visitors.keys().next().value ?? null;
  if (!loc.visitor) { setHTML(out('q3'), '<span class="rel">No visitors.</span>'); return; }
  const frame = frameByName(loc.frame);
  const p = model.positionIn(loc.visitor, frame);
  let html = `<div class="mono">${fmtLoc(p)} in frame <b>${esc(frame.frameId)}</b></div>`;
  if (loc.frame === 'world') {
    html += `<div>${idChip(loc.visitor)} is ${f2(p.x)} m along x and ${f2(p.y)} m along y from the world origin</div>`;
  } else {
    const ahead = p.x >= 0 ? `${f2(p.x)} m ahead` : `${f2(-p.x)} m behind`;
    const side = p.y >= 0 ? `${f2(p.y)} m left` : `${f2(-p.y)} m right`;
    html += `<div class="big">${idChip(loc.visitor)} is <b>${ahead}, ${side}</b> of ${esc(loc.frame)}</div>`;
  }
  html += '<div class="sub">Click another visitor to change who is shown.</div>';
  setHTML(out('q3'), html);
}

function renderQ4() {
  setHTML(out('q4'), loc.hover
    ? `<div class="mono">${fmtLoc(loc.hover)}</div><div>${esc(describeText(loc.hover))}</div>`
    : '<span class="rel">Hover over the ground (or tap it).</span>');

  const text = locInput('find').value.trim();
  let html = '';
  if (text) {
    const r = loc.find;
    if (!r) {
      html = '<span class="no">No visitor, display, zone or place matches that.</span>';
    } else {
      const target = r.place ? `<b class="place-name">${esc(r.place.name)}</b>` : '<span class="no">no place (outside)</span>';
      html = `“${esc(text)}” → ${target}`;
      if (r.offset) {
        html += `<div class="sub">the point ${OFFSET_M} m ${esc(r.relation)} ${esc(r.anchorId)}, ${fmtLoc(r.location.toWorld())}</div>`;
      } else if (model.kindOf(r.anchorId) !== 'place') {
        html += `<div class="sub">where ${esc(r.anchorId)} is, ${fmtLoc(r.location.toWorld())}</div>`;
      }
    }
  }
  setHTML(out('find'), html);
}

function renderLocation() {
  renderQ1();
  renderQ2();
  renderQ3();
  renderQ4();
}

function setHTML(el, html) {
  if (el && el.innerHTML !== html) el.innerHTML = html;
}

// Q2 probe ring, Q3 frame axes, Q4 find marker -------------------------------
const probeMat = new THREE.MeshBasicMaterial({ color: PROBE_COLOR, transparent: true, opacity: 0.85, depthWrite: false });
const probeRing = new THREE.Mesh(new THREE.RingGeometry(1 - 0.03, 1, 72), probeMat);
probeRing.rotation.x = -Math.PI / 2;
const probeDisc = new THREE.Mesh(
  new THREE.CircleGeometry(1, 72),
  new THREE.MeshBasicMaterial({ color: PROBE_COLOR, transparent: true, opacity: 0.07, depthWrite: false })
);
probeDisc.rotation.x = -Math.PI / 2;
const probeDot = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.04, 16), probeMat);
const probe = new THREE.Group();
probe.add(probeRing, probeDisc, probeDot);
probe.position.y = 0.045;
probe.visible = false;
locGroup.add(probe);

function updateProbe() {
  probe.visible = loc.probe !== null;
  if (!probe.visible) return;
  const p = toThree(loc.probe, 0.045);
  probe.position.copy(p);
  // Ring stays 6 cm wide whatever the radius.
  probeRing.geometry.dispose();
  probeRing.geometry = new THREE.RingGeometry(Math.max(0.01, loc.radius - 0.06), loc.radius, 72);
  probeDisc.scale.setScalar(loc.radius);
}

const findPin = new THREE.Mesh(
  new THREE.ConeGeometry(0.18, 0.5, 16),
  new THREE.MeshBasicMaterial({ color: 0xffffff })
);
findPin.rotation.x = Math.PI;
findPin.visible = false;
locGroup.add(findPin);

const frameGroup = new THREE.Group();
locGroup.add(frameGroup);
const frameParts = {
  xArrow: new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), FRAME_AXIS_LEN, FRAME_COLOR, 0.4, 0.26),
  yArrow: new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), FRAME_AXIS_LEN, FRAME_COLOR, 0.4, 0.26),
  xLabel: makeLabel('frame-axis', 0),
  yLabel: makeLabel('frame-axis', 0),
  along: new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: FRAME_COLOR })),
  across: new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: FRAME_COLOR, dashSize: 0.25, gapSize: 0.15 })),
  alongLabel: makeLabel('measure', 0),
  acrossLabel: makeLabel('measure', 0),
};
frameGroup.add(frameParts.xArrow, frameParts.yArrow, frameParts.xLabel.obj, frameParts.yLabel.obj,
  frameParts.along, frameParts.across, frameParts.alongLabel.obj, frameParts.acrossLabel.obj);

function setLine(line, a, b) {
  line.geometry.dispose();
  line.geometry = new THREE.BufferGeometry().setFromPoints([a, b]);
  if (line.material.isLineDashedMaterial) line.computeLineDistances();
}

function updateFrameOverlay() {
  const frame = frameByName(loc.frame);
  const isWorld = loc.frame === 'world';
  const H = 0.09;
  const o = worldXYToThree(...frame.toWorld(0, 0), H);
  const ex = worldXYToThree(...frame.toWorld(FRAME_AXIS_LEN, 0), H);
  const ey = worldXYToThree(...frame.toWorld(0, FRAME_AXIS_LEN), H);
  const { xArrow, yArrow, xLabel, yLabel, along, across, alongLabel, acrossLabel } = frameParts;
  xArrow.position.copy(o); xArrow.setDirection(ex.clone().sub(o).normalize());
  yArrow.position.copy(o); yArrow.setDirection(ey.clone().sub(o).normalize());
  xLabel.obj.visible = yLabel.obj.visible = locGroup.visible;   // CSS2D labels ignore their parent
  xLabel.obj.position.copy(ex.clone().add(ex.clone().sub(o).setLength(0.5)));
  yLabel.obj.position.copy(ey.clone().add(ey.clone().sub(o).setLength(0.5)));
  setHTML(xLabel.el, isWorld ? 'x (world)' : 'x′ ahead');
  setHTML(yLabel.el, isWorld ? 'y (world)' : 'y′ left');

  const v = loc.visitor && model.visitors.get(loc.visitor);
  const show = !!v && locGroup.visible;
  for (const part of [along, across, alongLabel.obj, acrossLabel.obj]) part.visible = show;
  if (!show) return;
  const p = v.position.inFrame(frame);
  const corner = worldXYToThree(...frame.toWorld(p.x, 0), H);
  const target = toThree(v.position, H);
  setLine(along, o, corner);
  setLine(across, corner, target);
  alongLabel.obj.position.copy(o.clone().lerp(corner, 0.5));
  acrossLabel.obj.position.copy(corner.clone().lerp(target, 0.5));
  const aheadWord = isWorld ? 'along x' : p.x >= 0 ? 'ahead' : 'behind';
  const sideWord = isWorld ? 'along y' : p.y >= 0 ? 'left' : 'right';
  setHTML(alongLabel.el, `${f1(Math.abs(p.x))} m ${aheadWord}`);
  setHTML(acrossLabel.el, `${f1(Math.abs(p.y))} m ${sideWord}`);
  alongLabel.obj.visible = Math.abs(p.x) > 0.05;
  acrossLabel.obj.visible = Math.abs(p.y) > 0.05;
}

function updateFindMarker(t) {
  const r = loc.find;
  findPin.visible = !!r && locInput('find').value.trim() !== '';
  if (findPin.visible) {
    findPin.position.copy(toThree(r.location, 0.45 + Math.sin(t * 4) * 0.08));
  }
  const hit = findPin.visible ? r.place?.name : null;
  for (const [name, pv] of placeViews) {
    const on = name === hit;
    pv.fillMat.opacity = on ? pv.baseOpacity + 0.22 + Math.sin(t * 5) * 0.08 : pv.baseOpacity;
    pv.lineMat.color.set(on ? '#ffffff' : pv.color);
    pv.label.el.classList.toggle('hit', on);
  }
}

// ---------------------------------------------------------------------------
// Proximity visuals (docs/PROXIMITY_RULES.md P10)
// ---------------------------------------------------------------------------
const guardRings = new Map();   // artwork → { mat }
for (const [name, loc] of PLAN.artworks) {
  const mat = new THREE.MeshBasicMaterial({ color: 0x8592a3, transparent: true, opacity: 0.55, depthWrite: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(ARTWORK_DISTANCE_M - 0.05, ARTWORK_DISTANCE_M, 56), mat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.copy(toThree(loc, 0.05));
  proxGroup.add(ring);
  guardRings.set(name, { mat });
}
const dispatchLines = new THREE.LineSegments(
  new THREE.BufferGeometry(),
  new THREE.LineDashedMaterial({ color: 0xffb547, dashSize: 0.35, gapSize: 0.2 })
);
dispatchLines.frustumCulled = false;
proxGroup.add(dispatchLines);

function updateProximityVisuals(t) {
  const breached = new Set([...guard.calls.values()].map((c) => c.artwork));
  for (const [name, { mat }] of guardRings) {
    const on = breached.has(name);
    mat.color.setHex(on ? 0xff5d6c : 0x8592a3);
    mat.opacity = on ? 0.65 + Math.sin(t * 6) * 0.3 : 0.12;   // U5: faint until breached
  }
  const pts = [];
  for (const [vid, c] of guard.calls) {
    const v = visitorById.get(vid), s = c.staff && visitorById.get(c.staff);
    if (v && s && c.phase === 'dispatched') pts.push(s.Position.x, 0.5, s.Position.z, v.Position.x, 0.5, v.Position.z);
  }
  dispatchLines.geometry.dispose();
  dispatchLines.geometry = new THREE.BufferGeometry();
  dispatchLines.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  dispatchLines.computeLineDistances();
  for (const v of visitors) {
    const stopped = !!v.stopFor;
    v.spaceMat.color.setHex(stopped ? 0xffb547 : v.mode === 'step' ? 0xff5d6c : v.mode === 'duty' ? 0x38d0ff : 0x8592a3);
    v.spaceMat.opacity = stopped || v.mode ? 0.9 : 0.3;
    // U5: the 0.5 m ring shows on stopped or busy agents, or for everyone when asked.
    v.spaceRing.visible = ringsForAll || stopped || !!v.mode;
    // M10: the label carries the primary preposition as a coloured glyph and the entity.
    const p = tracker.primaryOf(v.User_ID);
    const badge = p ? `<span class="mv" style="color:${PREP_STYLE[p.preposition].color}">${PREP_STYLE[p.preposition].glyph} ${esc(p.entity)}</span>` : '';
    const html = `${esc(v.User_ID)}${stopped ? ' ⏸' : ''}${v.mode === 'duty' ? ' · call' : ''}${v.mode === 'step' ? ' ↩' : ''}${badge}`;
    if (v.label.el.innerHTML !== html) v.label.el.innerHTML = html;
  }
}

// ---------------------------------------------------------------------------
// Movement prepositions (docs/MOVEMENT_PREPOSITIONS.md M2, M6, M10)
// ---------------------------------------------------------------------------
const tracker = new MovementTracker();
const fixedEntities = [
  ...displays.map((d) => { const w = d.model.position.toWorld(); return { id: d.Display_ID, kind: 'screen', x: w.x, y: w.y }; }),
  ...[...PLAN.artworks].map(([id, l]) => ({ id, kind: 'artwork', x: l.x, y: l.y })),
];
const fixedById = new Map(fixedEntities.map((f) => [f.id, f]));
let sampleClock = 0, sampleTime = 0;

function sampleMovement(dt) {
  sampleClock += dt;
  if (sampleClock < 1 / SAMPLE_HZ) return;
  sampleClock %= 1 / SAMPLE_HZ;
  sampleTime += 1 / SAMPLE_HZ;
  const agents = visitors.map((v) => ({ id: v.User_ID, x: v.model.position.x, y: v.model.position.y }));
  for (const ev of tracker.sample(sampleTime, agents, fixedEntities)) {
    const s = PREP_STYLE[ev.preposition];
    const who = [ev.agent];
    if (ev.kind !== 'artwork') who.push(ev.entity);   // screens and agents have windows too
    log(`<span class="mv-k ${ev.preposition}">${s.glyph}</span> ${esc(describe(ev.agent, ev))}`, 'move', who);
  }
  drawMovementLines();
}

// Lines: toward = solid with a chevron at the entity, away = dashed with a chevron at
// the agent, around = an arc about the entity with a chevron at its leading end.
const movementGroup = new THREE.Group();
scene.add(movementGroup);
const mvMats = Object.fromEntries(Object.entries(PREP_STYLE).map(([k, st]) => [k,
  k === 'away' ? new THREE.LineDashedMaterial({ color: st.color, dashSize: 0.3, gapSize: 0.2, transparent: true, opacity: 0.9 })
    : new THREE.LineBasicMaterial({ color: st.color, transparent: true, opacity: 0.9 })]));
const mvLines = Object.fromEntries(Object.keys(PREP_STYLE).map((k) => {
  const l = new THREE.LineSegments(new THREE.BufferGeometry(), mvMats[k]);
  l.frustumCulled = false;
  movementGroup.add(l);
  return [k, l];
}));

function entityXY(id) {
  const f = fixedById.get(id);
  if (f) return [f.x, f.y];
  const v = visitorById.get(id);
  return v ? [v.model.position.x, v.model.position.y] : null;
}

function chevron(out, tip, dir, h, size = 0.35) {
  const len = Math.hypot(dir[0], dir[1]) || 1, ux = dir[0] / len, uy = dir[1] / len;
  for (const s of [1, -1]) {
    const bx = tip[0] - ux * size + s * -uy * size * 0.6, by = tip[1] - uy * size + s * ux * size * 0.6;
    out.push(...worldXYToThree(tip[0], tip[1], h).toArray(), ...worldXYToThree(bx, by, h).toArray());
  }
}

function drawMovementLines() {
  const H = 0.12;
  const pts = { toward: [], away: [], around: [] };
  const open = new Set(wins.filter((w) => w.entity.kind === 'visitor').map((w) => w.entity.User_ID));
  for (const v of visitors) {
    if (!movementForAll && !open.has(v.User_ID)) continue;
    const a = [v.model.position.x, v.model.position.y];
    for (const r of tracker.relationsOf(v.User_ID)) {
      const e = entityXY(r.entity);
      if (!e) continue;
      const out = pts[r.preposition];
      const dx = e[0] - a[0], dy = e[1] - a[1], d = Math.hypot(dx, dy) || 1;
      if (r.preposition === 'toward') {
        const tip = [e[0] - (dx / d) * 0.5, e[1] - (dy / d) * 0.5];
        out.push(...worldXYToThree(a[0], a[1], H).toArray(), ...worldXYToThree(tip[0], tip[1], H).toArray());
        chevron(out, tip, [dx, dy], H);
      } else if (r.preposition === 'away') {
        const tail = [e[0] - (dx / d) * 0.5, e[1] - (dy / d) * 0.5];
        out.push(...worldXYToThree(tail[0], tail[1], H).toArray(), ...worldXYToThree(a[0], a[1], H).toArray());
        chevron(out, a, [-dx, -dy], H);
      } else {
        const rad = d, a0 = Math.atan2(a[1] - e[1], a[0] - e[0]);
        const sgn = r.direction === 'clockwise' ? -1 : 1, span = (100 * Math.PI) / 180, nSeg = 16;
        let prev = null;
        for (let i = 0; i <= nSeg; i++) {
          const ang = a0 - sgn * span * 0.6 + sgn * span * (i / nSeg);
          const p = [e[0] + rad * Math.cos(ang), e[1] + rad * Math.sin(ang)];
          if (prev) out.push(...worldXYToThree(prev[0], prev[1], H).toArray(), ...worldXYToThree(p[0], p[1], H).toArray());
          prev = p;
        }
        const angEnd = a0 + sgn * span * 0.4;
        chevron(out, prev, [-Math.sin(angEnd) * sgn, Math.cos(angEnd) * sgn], H);
      }
    }
  }
  for (const k of Object.keys(pts)) {
    const l = mvLines[k];
    l.geometry.dispose();
    l.geometry = new THREE.BufferGeometry();
    l.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts[k], 3));
    if (k === 'away') l.computeLineDistances();
  }
}

/** Inspector line: what the proximity rules are doing with this agent. */
function proximityState(e) {
  if (e.stopFor) return `<span class="warn">stopped</span> for ${esc(e.stopFor.User_ID)} (personal space)`;
  if (e.mode === 'step') return '<span class="no">stepping back</span> from an artwork';
  if (e.mode === 'duty') {
    const call = [...guard.calls].find(([, c]) => c.staff === e.User_ID);
    return call ? `on call: ${esc(call[0])} at ${esc(call[1].artwork)}` : 'on call';
  }
  if (e.mode === 'return') return 'returning to post';
  return 'clear';
}

const proxEvalEl = document.getElementById('prox-eval');
function renderProximityEval() {
  // P11: pairs closer than 1 m, who is stopped, and the open artwork calls.
  let pairs = 0;
  for (let i = 0; i < visitors.length; i++) {
    for (let j = i + 1; j < visitors.length; j++) {
      const a = visitors[i].model.position, b = visitors[j].model.position;
      if (a.distanceTo(b) < PERSONAL_SPACE_M) pairs++;
    }
  }
  const stopped = visitors.filter((v) => v.stopFor).map((v) => `${esc(v.User_ID)} ⏸ for ${esc(v.stopFor.User_ID)}`);
  const space = pairs
    ? `<span class="warn">${pairs} pair${pairs > 1 ? 's' : ''} &lt; 1 m</span> · ${stopped.length ? stopped.join(', ') : 'nobody closing in, so nobody stops'}`
    : '<span class="ok">every pair ≥ 1 m apart</span>';
  const calls = [...guard.calls].map(([vid, c]) => {
    const v = visitorById.get(vid);
    const d = v ? v.model.position.distanceTo(PLAN.artworks.get(c.artwork)).toFixed(1) : '?';
    const what = c.phase === 'waiting' ? 'waiting for free staff' : c.phase === 'dispatched' ? `${esc(c.staff)} on the way` : `${esc(c.staff)} there, stepping back`;
    return `<span class="no">${esc(vid)} ${d} m from ${esc(c.artwork)}</span> → ${what}`;
  });
  const html = `<div class="rule-row"><b>Personal space</b><span>${space}</span></div>` +
    `<div class="rule-row"><b>Artwork</b><span>${calls.length ? calls.join('<br>') : `<span class="ok">every visitor ≥ ${ARTWORK_DISTANCE_M} m from the artworks</span>`}</span></div>`;
  if (proxEvalEl.innerHTML !== html) proxEvalEl.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Per-frame visuals
// ---------------------------------------------------------------------------
const okColor = new THREE.Color(0x3fd68a);
const badColor = new THREE.Color(0xff5d6c);

function updateVisuals(dt, t) {
  for (const d of displays) d.updateVisuals(dt, t);
  for (const z of zones) {
    z.hub.rotation.y += dt * 0.6;
    z.floorMat.opacity = selected === z ? 0.32 : 0.16;
  }

  if (relationGroup.visible) {
    const pos = enterLines.geometry.attributes.position.array;
    const col = enterLines.geometry.attributes.color.array;
    let n = 0;
    for (const v of visitors) {
      if (!v.zone) continue;
      const h = v.zone.hub.position;
      pos.set([v.Position.x, 1.6, v.Position.z, h.x, h.y, h.z], n * 6);
      const c = v.zone.color;
      col.set([c.r, c.g, c.b, c.r, c.g, c.b], n * 6);
      n++;
    }
    enterLines.geometry.setDrawRange(0, n * 2);
    enterLines.geometry.attributes.position.needsUpdate = true;
    enterLines.geometry.attributes.color.needsUpdate = true;
  }

  {
    const pos = proxLines.geometry.attributes.position.array;
    const col = proxLines.geometry.attributes.color.array;
    let n = 0;
    for (const d of displays) {
      const c = d.ruleMatched ? okColor : badColor;
      for (const { visitor: v } of d.nearby) {
        if (n >= MAX_PROX) break;
        pos.set([v.Position.x, 0.9, v.Position.z, d.Position.x, 0.9, d.Position.z], n * 6);
        col.set([c.r, c.g, c.b, c.r, c.g, c.b], n * 6);
        n++;
      }
    }
    proxLines.geometry.setDrawRange(0, n * 2);
    proxLines.geometry.attributes.position.needsUpdate = true;
    proxLines.geometry.attributes.color.needsUpdate = true;
  }

  if (velocityGroup.visible) for (const v of visitors) v.updateArrow();

  // Each tab shows only its own overlays.
  // Each drawer tab shows only its own overlays.
  const metricsMode = metricsActive();
  locGroup.visible = paneOpen('location');
  metricsUI.setSceneVisible(metricsMode);
  movementGroup.visible = !metricsMode;
  updateFrameOverlay();
  updateFindMarker(t);
  updateProximityVisuals(t);

  if (selected && selected.kind !== 'zone') {
    selRing.visible = true;
    selRing.position.x = selected.Position.x;
    selRing.position.z = selected.Position.z;
    selRing.scale.setScalar(selected.kind === 'display' ? 1.7 : 1);
    selRing.material.opacity = 0.6 + Math.sin(t * 5) * 0.3;
  } else {
    selRing.visible = false;
  }
}

// ---------------------------------------------------------------------------
// Selection and entity windows (docs/MOVEMENT_PREPOSITIONS.md M11)
// Clicking an agent, screen or zone node opens its window: movement, its own
// activity log, and its details folded away. Up to MAX_WINDOWS stay open.
// ---------------------------------------------------------------------------
const windowsEl = document.getElementById('windows');
const overviewEl = document.getElementById('overview');
const MAX_WINDOWS = 3;
let selected = null;
const wins = [];   // [{ ref, entity, el, shown }], oldest first

function entityRef(e) {
  if (e.kind === 'visitor') return `visitor:${e.User_ID}`;
  if (e.kind === 'zone') return `zone:${e.Zone_ID}`;
  return `display:${e.Display_ID}`;
}

function entityByRef(ref) {
  const i = ref.indexOf(':');
  const kind = ref.slice(0, i), id = ref.slice(i + 1);
  if (kind === 'visitor') return visitorById.get(id) ?? null;
  if (kind === 'zone') return zones.find((z) => z.Zone_ID === id) ?? null;
  if (kind === 'display') return displayById.get(id) ?? null;
  return null;
}

const entityId = (e) => (e.kind === 'visitor' ? e.User_ID : e.kind === 'zone' ? e.Zone_ID : e.Display_ID);

const chip = (e) => `<span class="chip ${e.kind}" data-select="${esc(entityRef(e))}">${esc(entityId(e))}</span>`;

const attrRow = (name, field, derived = false) =>
  `<div class="attr${derived ? ' derived' : ''}"><span class="k">${name}</span><span class="v" data-field="${field}"></span></div>`;

function select(entity) {
  selected = entity;
  if (entity) { setLocSubject(entityId(entity)); openWindow(entity); }
  if (entity?.kind === 'visitor' && metricsActive()) metricsUI.setA(entity.User_ID);
  renderLocation();
}

function openWindow(entity) {
  const ref = entityRef(entity);
  let w = wins.find((x) => x.ref === ref);
  if (w) {
    wins.splice(wins.indexOf(w), 1);
    wins.push(w);
    windowsEl.append(w.el);
    w.el.classList.remove('flash'); void w.el.offsetWidth; w.el.classList.add('flash');
    return;
  }
  if (wins.length >= MAX_WINDOWS) closeWindow(wins[0].ref);
  const el = document.createElement('section');
  el.className = 'win panel';
  el.dataset.ref = ref;
  el.setAttribute('aria-label', `${entityId(entity)} window`);
  w = { ref, entity, el, shown: 0 };
  wins.push(w);
  windowsEl.append(el);
  renderWindow(w, true);
}

function closeWindow(ref) {
  const i = wins.findIndex((x) => x.ref === ref);
  if (i < 0) return;
  wins[i].el.remove();
  wins.splice(i, 1);
  if (selected && entityRef(selected) === ref) selected = null;
}

function movementChips(id) {
  const rels = [...tracker.relationsOf(id)].sort((a, b) =>
    PREPOSITIONS.indexOf(a.preposition) - PREPOSITIONS.indexOf(b.preposition) || a.distance - b.distance);
  if (!rels.length) return '<span class="rel">no movement relation right now</span>';
  return rels.slice(0, 6).map((r) => {
    const s = PREP_STYLE[r.preposition];
    return `<span class="mv-chip ${r.preposition}" title="${esc(describe(id, r))}">${s.glyph} ${esc(r.entity)}${r.direction ? (r.direction === 'clockwise' ? ' ⟳' : ' ⟲') : ''}</span>`;
  }).join('') + (rels.length > 6 ? `<span class="rel"> +${rels.length - 6}</span>` : '');
}

function renderWindow(w, full = false) {
  const e = w.entity, el = w.el;
  if (full) {
    const kindLabel = e.kind === 'visitor' ? (e.model.role === 'staff' ? 'Staff' : 'Visitor') : e.kind === 'zone' ? 'Zone' : 'Screen';
    let details;
    if (e.kind === 'visitor') {
      details = `<div class="attrs">${attrRow('Position', 'Position')}${attrRow('Velocity', 'Velocity')}${attrRow('Dwell_Time', 'Dwell_Time')}${
        attrRow('Role', 'Role')}${attrRow('Place', 'Place', true)}${attrRow('Proximity', 'Prox', true)}${attrRow('Zone', 'rel', true)}${attrRow('Nearest screen', 'ctx', true)}</div>
        <div class="btns"><button data-action="remove-visitor" class="danger">Remove</button></div>`;
    } else if (e.kind === 'zone') {
      details = `<div class="attrs">${attrRow('Occupancy', 'Occupancy')}${attrRow('Ambient_Light', 'Ambient_Light')}${attrRow('Boundary', 'Boundary', true)}</div>
        <div class="bar" data-field="occBar"><i></i></div>
        <div class="ctrl"><label>Ambient_Light <span data-field="luxValue"></span></label>
          <input type="range" min="0" max="1000" step="10" data-input="ambient" value="${e.Ambient_Light}"></div>
        <div class="win-cap">Controls</div><div data-field="controls"></div>
        <div class="btns"><button data-action="add-crowd">＋10 Crowd here</button><button data-action="clear-zone" class="danger">Clear zone</button></div>`;
    } else {
      details = `<div class="attrs">${attrRow('Power_State', 'Power_State')}${attrRow('Current_Media', 'Current_Media')}${attrRow('Status', 'Status')}${
        attrRow('Volume_Level', 'Volume_Level')}${attrRow('Position', 'Position', true)}${attrRow('Orientation', 'Orientation', true)}</div>
        <div class="ctrl"><label>Volume_Level <span data-field="volValue"></span></label>
          <input type="range" min="0" max="100" step="1" data-input="volume" value="${e.Volume_Level}"></div>
        <div class="win-cap">Rule</div><div data-field="ctx"></div>
        <div class="btns"><button data-action="launch-media" class="primary">▶ Launch_Media()</button><button data-action="reset-media">⟲ Default loop</button></div>`;
    }
    el.innerHTML = `
      <header class="win-head" title="Drag to move"><span class="chip ${e.kind}">${kindLabel}</span><b data-field="title"></b>
        <span class="win-sub" data-field="sub"></span><button class="x" data-win-close title="Close (Esc)" aria-label="Close">×</button></header>
      ${e.kind === 'visitor' ? '<div class="win-move" data-field="move"></div>' : ''}
      <div class="win-cap">Activity</div>
      <ol class="act" data-act></ol>
      <details class="win-details"${e.kind === 'visitor' ? '' : ' open'}><summary>Details</summary>${details}</details>`;
    w.shown = 0;
  }

  const f = {};
  if (e.kind === 'visitor') {
    const m = e.model;
    f.title = esc(e.User_ID);
    f.sub = `${esc(model.placeAt(m.position)?.name ?? 'outside')}${e.stopFor ? ' · ⏸ stopped' : e.mode === 'step' ? ' · stepping back' : e.mode === 'duty' ? ' · on call' : ''}`;
    f.move = movementChips(e.User_ID);
    f.Position = fmtLoc(m.position) + ' m';
    f.Velocity = `${e.Velocity.length().toFixed(2)} m/s`;
    f.Dwell_Time = `${e.Dwell_Time.toFixed(1)} s`;
    f.Role = m.role === 'staff' ? '<span class="warn">staff</span>' : 'visitor';
    f.Prox = proximityState(e);
    f.Place = esc(model.placeAt(m.position)?.name ?? '—');
    f.rel = e.zone ? chip(e.zone) : '<span class="no">outside all zones</span>';
    const nd = model.nearestDisplay(m.position);
    const best = nd && { d: displayById.get(nd.displayId), dist: nd.position.distanceTo(m.position) };
    f.ctx = best ? `${chip(best.d)} <span class="${best.dist <= RULE_RADIUS ? 'ok' : 'rel'}">${best.dist.toFixed(1)} m</span>` : '—';
  } else if (e.kind === 'zone') {
    const b = e.model.boundary;
    f.title = esc(e.Zone_ID);
    f.sub = `${e.Occupancy} inside`;
    f.Occupancy = `<span class="${e.atCapacity ? 'no' : 'ok'}">${e.Occupancy}</span> / ${MAX_OCCUPANCY}`;
    f.Ambient_Light = `${e.Ambient_Light} lx`;
    f.Boundary = `${b.xMax - b.xMin} × ${b.yMax - b.yMin} m`;
    f.luxValue = `${e.Ambient_Light} lx`;
    f.controls = e.displays.map(chip).join('');
  } else {
    f.title = esc(e.Display_ID);
    f.sub = `<span class="badge ${e.Power_State}">${e.Power_State}</span>`;
    f.Power_State = e.Power_State;
    f.Current_Media = e.Current_Media;
    f.Status = e.Status;
    f.Volume_Level = `${e.Volume_Level}%`;
    f.volValue = `${e.Volume_Level}%`;
    f.Position = fmtLoc(e.model.position.toWorld()) + ' m';
    f.Orientation = `${f1(e.heading)}° · faces ${compass(e.heading)}`;
    const n = e.nearby[0];
    f.ctx = `<div>${e.proximity ? '✓' : '✗'} visitor ≤ ${RULE_RADIUS} m: <span class="${e.proximity ? 'ok' : 'no'}">${
      n ? `${esc(n.visitor.User_ID)} @ ${n.dist.toFixed(2)} m` : 'none'}</span></div><div>${e.capacityOK ? '✓' : '✗'} occupancy &lt; ${MAX_OCCUPANCY}: ${e.zone.Occupancy}</div>`;
  }
  for (const node of el.querySelectorAll('[data-field]')) {
    const k = node.dataset.field;
    if (k === 'occBar') {
      node.classList.toggle('full', e.atCapacity);
      node.firstElementChild.style.width = `${Math.min(100, (e.Occupancy / MAX_OCCUPANCY) * 100)}%`;
    } else if (k in f && node.innerHTML !== f[k]) {
      node.innerHTML = f[k];
    }
  }

  // Activity: append what's new, newest first.
  const list = activity.get(entityId(e)) ?? [];
  const ol = el.querySelector('[data-act]');
  if (w.shown > list.length) w.shown = 0;
  if (!list.length && !ol.children.length) ol.innerHTML = '<li class="empty">Nothing yet. Activity shows up here as it happens.</li>';
  for (let i = w.shown; i < list.length; i++) {
    ol.querySelector('.empty')?.remove();
    const li = document.createElement('li');
    li.className = list[i].type;
    li.innerHTML = `<time>${list[i].t.toFixed(1)}s</time>${list[i].html}`;
    ol.prepend(li);
  }
  while (ol.children.length > 80) ol.lastChild.remove();
  w.shown = list.length;
}

function renderWindows(full = false) {
  for (const w of [...wins]) {
    if (w.entity.kind === 'visitor' && !visitorById.has(w.entity.User_ID)) { closeWindow(w.ref); continue; }
    renderWindow(w, full);
  }
}

function renderOverview() {
  const zoneRows = zones.map((z) =>
    `<tr data-select="${esc(entityRef(z))}"><td>${chip(z)}</td><td class="${z.atCapacity ? 'no' : ''}">${z.Occupancy} / ${MAX_OCCUPANCY}</td><td>${z.Ambient_Light} lx</td></tr>`).join('');
  const dispRows = displays.map((d) =>
    `<tr data-select="${esc(entityRef(d))}"><td>${chip(d)}</td><td><span class="badge ${d.Power_State}">${d.Power_State}</span></td><td>${
      d.Current_Media === MEDIA_INTERACTIVE ? 'Interactive' : 'Loop'}</td></tr>`).join('');
  const agentChips = visitors.map((v) => chip(v)).join('');
  const html = `
    <h3>Zone</h3>
    <table class="overview"><tr><th>Zone</th><th>Occupancy</th><th>Light</th></tr>${zoneRows}</table>
    <h3>Screens</h3>
    <table class="overview"><tr><th>Screen</th><th>Power</th><th>Media</th></tr>${dispRows}</table>
    <h3>Agents <span class="rel">${visitors.length}</span></h3>
    <div>${agentChips || '<span class="rel">none</span>'}</div>
    <h3>Places</h3>
    <div>${[...model.places.values()].filter((p) => p.parent).map((p) => `<span class="chip place" data-locate="${esc(p.name)}">${esc(p.name)}</span>`).join('')}</div>
    <h3>Legend</h3>
    <ul class="legend">
      <li><span class="mv-k toward">→</span> toward · <span class="mv-k away">←</span> away from · <span class="mv-k around">↻</span> around</li>
      <li><span class="ok">●</span> screen ON · <span class="rel">●</span> OFF · ring: ${RULE_RADIUS} m range · wedge: ±${FRONT_HALF_ANGLE}° in front</li>
      <li>⏸ stopped for personal space · <span class="warn">- - -</span> staff on the way · red ring: artwork breach</li>
      <li>▸| one-way door · S1 staff door g1⇄g2 · S2 express g4→g7 · S3 return g8→g3</li>
    </ul>`;
  // Only touch the DOM when something changed, so clicks on rows are not lost.
  if (html !== lastOverview) {
    overviewEl.innerHTML = html;
    lastOverview = html;
  }
}
let lastOverview = '';

const ruleEvalEl = document.getElementById('rule-eval');
function renderRuleEval() {
  // Rows are created once and only their contents refreshed, so clicks are not lost.
  if (ruleEvalEl.children.length !== displays.length) {
    ruleEvalEl.innerHTML = displays.map((d) =>
      `<div class="rule-row" data-select="${esc(entityRef(d))}"><b>${esc(d.Display_ID)}</b><span></span></div>`).join('');
  }
  displays.forEach((d, i) => {
    const n = d.nearby[0];
    const html = `<span class="badge ${d.Power_State}">${d.Power_State}</span> ` +
      `<span class="rel">${n ? `${esc(n.visitor.User_ID)} at ${n.dist.toFixed(1)} m` : `nobody within ${RULE_RADIUS} m`}${d.capacityOK ? '' : ' · zone full'}</span>`;
    const body = ruleEvalEl.children[i].lastElementChild;
    if (body.innerHTML !== html) body.innerHTML = html;
  });
}

function refreshLabels() {
  for (const z of zones) z.updateLabel();
  for (const d of displays) d.updateLabel();
}

// U3: one line of state, with help behind "?".
const statusEl = document.querySelector('[data-status="text"]');
function renderStatus() {
  const staff = visitors.filter((v) => v.model.role === 'staff').length;
  const on = displays.filter((d) => d.Power_State === 'ON').length;
  const stopped = visitors.filter((v) => v.stopFor).length;
  const calls = guard.calls.size;
  const parts = [
    `${visitors.length - staff} visitor${visitors.length - staff === 1 ? '' : 's'} · ${staff} staff`,
    `<span class="${on ? 'ok' : ''}">${on}/${displays.length} screens on</span>`,
    stopped ? `<span class="warn">${stopped} stopped</span>` : '0 stopped',
    calls ? `<span class="no">${calls} artwork call${calls > 1 ? 's' : ''}</span>` : 'no artwork calls',
  ];
  if (paused) parts.push('<span class="warn">paused</span>');
  const html = parts.join('<span class="sep">·</span>');
  if (statusEl.innerHTML !== html) statusEl.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Actions (toolbar menus + window buttons)
// ---------------------------------------------------------------------------
let paused = false;
let movementForAll = false;
let ringsForAll = false;

function contextZone() {
  if (!selected) return null;
  if (selected.kind === 'zone') return selected;
  return selected.zone ?? null;
}

const actions = {
  'add-visitor'() {
    const e = model.places.get('Entrance')?.region.centroid() ?? new Location(0.6, CY);
    const w = e.toWorld();
    const v = spawnVisitor(toThree(new Location(w.x, w.y + rand(-1.5, 1.5))));
    if (v) log(`${v.User_ID} arrives at the entrance`, 'action', [v.User_ID]);
  },
  'add-staff'() {
    let n = 1;
    while (model.visitors.has(`S-${String(n).padStart(3, '0')}`)) n++;
    const c = PLAN.centre('Checkout');
    const s = spawnVisitor(toThree(new Location(c.x + rand(-0.8, 0.8), c.y + rand(-2, 2))), { id: `S-${String(n).padStart(3, '0')}`, role: 'staff' });
    if (s) log(`${s.User_ID} (staff) starts a shift at the Checkout`, 'action', [s.User_ID]);
  },
  'add-crowd'() {
    spawnCrowd(contextZone() ?? zones[0]);
  },
  'remove-visitor'() {
    const v = selected?.kind === 'visitor' ? selected : visitors[visitors.length - 1];
    if (v) removeVisitor(v);
    else log('No visitors to remove', 'warn');
  },
  'clear-zone'() {
    const z = contextZone();
    if (!z) return;
    const inside = visitors.filter((v) => v.zone === z);
    for (const v of inside) v.dispose();
    visitors = visitors.filter((v) => v.zone !== z);
    if (selected?.kind === 'visitor' && inside.includes(selected)) select(null);
    log(`${inside.length} visitors removed from <b>${z.Zone_ID}</b>`, 'action');
  },
  'launch-media'() {
    if (selected?.kind === 'display') { selected.launchMedia(); return; }
    const on = displays.filter((d) => d.Power_State === 'ON' && d.Current_Media !== MEDIA_INTERACTIVE);
    if (!on.length) {
      log('Launch_Media(): open a screen\'s window, or wait until one is powered ON by the rule', 'warn');
      return;
    }
    for (const d of on) d.launchMedia();
  },
  'reset-media'() {
    const targets = selected?.kind === 'display' ? [selected] : displays;
    if (!targets.some((d) => d.resetMedia())) log('Screens are already on the default loop', 'warn');
  },
  'toggle-relations'(btn) {
    relationGroup.visible = !relationGroup.visible;
    for (const z of zones) { z.hub.visible = relationGroup.visible; z.label.obj.visible = relationGroup.visible; }
    btn?.classList.toggle('on', relationGroup.visible);
  },
  'toggle-velocity'(btn) {
    velocityGroup.visible = !velocityGroup.visible;
    btn?.classList.toggle('on', velocityGroup.visible);
  },
  'toggle-labels'(btn) {
    const show = labelRenderer.domElement.style.display === 'none';
    labelRenderer.domElement.style.display = show ? '' : 'none';
    btn?.classList.toggle('on', show);
  },
  'toggle-proximity'(btn) {
    ringsForAll = !ringsForAll;
    btn?.classList.toggle('on', ringsForAll);
  },
  'toggle-movement'(btn) {
    movementForAll = !movementForAll;
    btn?.classList.toggle('on', movementForAll);
  },
  'toggle-places'(btn) {
    placesGroup.visible = !placesGroup.visible;
    // CSS2D labels follow their own visible flag, not their parent's; artwork labels stay hidden (U4).
    for (const o of placesLabelObjs()) o.visible = placesGroup.visible && !o.userData.hiddenLabel;
    btn?.classList.toggle('on', placesGroup.visible);
  },
  'reset-camera'() {
    const home = homeView();
    camera.position.copy(home.pos);
    controls.target.copy(home.target);
  },
  pause() {
    paused = !paused;
    const btn = document.querySelector('#toolbar [data-action="pause"]');
    btn.textContent = paused ? '▶' : '⏸';
    btn.setAttribute('aria-label', paused ? 'Resume' : 'Pause');
    btn.classList.toggle('on', paused);
    log(paused ? 'Simulation paused (rules still run for dragged agents)' : 'Simulation resumed', 'action');
  },
  reset() {
    loadDemo();
  },
  help(btn) {
    const help = document.getElementById('help');
    help.hidden = !help.hidden;
    btn?.setAttribute('aria-expanded', String(!help.hidden));
  },
};

function runAction(name, btn) {
  actions[name]?.(btn);
  if (btn?.getAttribute('role') === 'menuitemcheckbox') btn.setAttribute('aria-checked', String(btn.classList.contains('on')));
  renderWindows();
}

// U1: menus open on click and close on Escape or an outside click.
function closeMenus(except = null) {
  for (const m of document.querySelectorAll('#toolbar .menu')) {
    if (m === except) continue;
    m.querySelector('.menu-pop').hidden = true;
    m.querySelector('.menu-btn').setAttribute('aria-expanded', 'false');
  }
}

document.getElementById('toolbar').addEventListener('click', (e) => {
  const mb = e.target.closest('.menu-btn');
  if (mb) {
    const menu = mb.closest('.menu'), pop = menu.querySelector('.menu-pop');
    closeMenus(menu);
    pop.hidden = !pop.hidden;
    mb.setAttribute('aria-expanded', String(!pop.hidden));
    return;
  }
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  runAction(btn.dataset.action, btn);
  if (!btn.closest('[data-keep-open]') || btn.getAttribute('role') !== 'menuitemcheckbox') closeMenus();
});
document.getElementById('statusbar').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (btn) runAction(btn.dataset.action, btn);
});
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#toolbar .menu')) closeMenus();
  if (!e.target.closest('#help, [data-action="help"]')) {
    document.getElementById('help').hidden = true;
    document.querySelector('[data-action="help"]').setAttribute('aria-expanded', 'false');
  }
});

// Windows: close, buttons (acting on that window's entity), chips, sliders, dragging by the header.
windowsEl.addEventListener('click', (e) => {
  const card = e.target.closest('.win');
  if (!card) return;
  const w = wins.find((x) => x.el === card);
  if (e.target.closest('[data-win-close]')) { closeWindow(card.dataset.ref); return; }
  const btn = e.target.closest('button[data-action]');
  if (btn && w) {
    selected = w.entity;
    runAction(btn.dataset.action, null);
    return;
  }
  const sel = e.target.closest('[data-select]');
  if (sel) { const ent = entityByRef(sel.dataset.select); if (ent) select(ent); }
});

windowsEl.addEventListener('input', (e) => {
  const input = e.target.closest('[data-input]');
  const card = e.target.closest('.win');
  const w = card && wins.find((x) => x.el === card);
  if (!input || !w) return;
  const value = Number(input.value), ent = w.entity;
  if (input.dataset.input === 'ambient' && ent.kind === 'zone') ent.setAmbient(value);
  if (input.dataset.input === 'volume' && ent.kind === 'display') {
    ent.Volume_Level = value;
    ent.model.volumeLevel = value;
    ent.drawTimer = 0;
  }
  renderWindows();
  refreshLabels();
});

windowsEl.addEventListener('pointerdown', (e) => {
  const head = e.target.closest('.win-head');
  if (!head || e.target.closest('button') || e.button !== 0) return;
  const card = head.closest('.win');
  const r = card.getBoundingClientRect();
  const dx = e.clientX - r.left, dy = e.clientY - r.top;
  card.classList.add('floating');   // position: fixed, still inside #windows so its events reach the handlers
  Object.assign(card.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px` });
  const move = (ev) => {
    card.style.left = `${Math.max(0, Math.min(window.innerWidth - 60, ev.clientX - dx))}px`;
    card.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - dy))}px`;
  };
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});

// ---------------------------------------------------------------------------
// Drawer (U2): Rules · Location · Metrics · Scene · Log
// ---------------------------------------------------------------------------
locEl.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) { setTab(tab.dataset.tab); return; }
  const head = e.target.closest('[data-loc-action="collapse"]');
  if (head) { setLocationCollapsed(!locEl.classList.contains('collapsed')); return; }
  const sel = e.target.closest('[data-select]');
  if (sel) { const ent = entityByRef(sel.dataset.select); if (ent) select(ent); return; }
  const chipEl = e.target.closest('[data-locate]');
  if (chipEl) {
    const id = chipEl.dataset.locate;
    const ent = entityByRef(`${model.kindOf(id)}:${id}`);
    if (ent) select(ent);
    else { setLocSubject(id); setTab('location'); renderLocation(); }
  }
});

locEl.addEventListener('input', (e) => {
  const filter = e.target.closest('[data-log-filter]');
  if (filter) { logEl.classList.toggle(`hide-${filter.dataset.logFilter}`, !filter.checked); return; }
  const input = e.target.closest('[data-loc-input]');
  if (!input) return;
  const kind = input.dataset.locInput;
  if (kind === 'radius') { loc.radius = Number(input.value); updateProbe(); }
  if (kind === 'frame') loc.frame = input.value;
  if (kind === 'find') loc.find = input.value.trim() ? resolveDescription(model, input.value) : null;
  renderLocation();
});
locInput('frame').addEventListener('change', (e) => { loc.frame = e.target.value; renderLocation(); });

function setLocationCollapsed(collapsed) {
  locEl.classList.toggle('collapsed', collapsed);
  locEl.querySelector('[data-loc-action="collapse"]').setAttribute('aria-expanded', String(!collapsed));
}

function setTab(name) {
  for (const t of locEl.querySelectorAll('[data-tab]')) t.setAttribute('aria-selected', String(t.dataset.tab === name));
  for (const pane of locEl.querySelectorAll('[data-pane]')) pane.hidden = pane.dataset.pane !== name;
  setLocationCollapsed(false);
  if (name === 'metrics') metricsUI.render(0);
}
const paneOpen = (name) => !locEl.querySelector(`[data-pane="${name}"]`).hidden && !locEl.classList.contains('collapsed');
const metricsActive = () => paneOpen('metrics');

window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape') {
    if (document.querySelector('#toolbar .menu-pop:not([hidden])')) { closeMenus(); return; }
    if (!document.getElementById('help').hidden) { document.getElementById('help').hidden = true; return; }
    if (wins.length) closeWindow(wins[wins.length - 1].ref);
    selected = null;
    return;
  }
  if (e.target.closest('input, textarea, select')) return;
  if (e.code === 'Space') { e.preventDefault(); runAction('pause'); }
  if (e.code === 'Delete' && selected?.kind === 'visitor') runAction('remove-visitor');
});

// ---------------------------------------------------------------------------
// Picking, dragging, ground clicks (Q2) and hover (Q4)
// ---------------------------------------------------------------------------
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const dragPoint = new THREE.Vector3();
let pointerDown = null;
let dragging = null;

function setRay(e) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
}

function pickAt(e) {
  setRay(e);
  for (const hit of raycaster.intersectObjects(pickables, false)) {
    if (hit.object.userData.entity) return hit.object.userData.entity;
  }
  return null;
}

function groundAt(e) {
  setRay(e);
  const p = new THREE.Vector3();
  return raycaster.ray.intersectPlane(groundPlane, p) ? toModel(p) : null;
}

const canvas = renderer.domElement;
const tipEl = document.getElementById('hover-tip');

function showTip(e, text) {
  tipEl.textContent = text;
  tipEl.style.display = 'block';
  const pad = 14, w = tipEl.offsetWidth, h = tipEl.offsetHeight;
  const x = e.clientX + pad + w > window.innerWidth ? e.clientX - pad - w : e.clientX + pad;
  const y = e.clientY + pad + h > window.innerHeight ? e.clientY - pad - h : e.clientY + pad;
  tipEl.style.left = `${Math.max(4, x)}px`;
  tipEl.style.top = `${Math.max(4, y)}px`;
}

function hideTip() { tipEl.style.display = 'none'; }

// Capture phase so a visitor grab can pre-empt OrbitControls.
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  pointerDown = { x: e.clientX, y: e.clientY };
  hideTip();
  const ent = pickAt(e);
  if (ent?.kind === 'visitor') {
    e.stopImmediatePropagation();
    dragging = ent;
    ent.dragging = true;
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
    select(ent);
  }
}, { capture: true });

canvas.addEventListener('pointermove', (e) => {
  if (dragging) {
    setRay(e);
    if (raycaster.ray.intersectPlane(groundPlane, dragPoint)) {
      dragging.Position.copy(clampToFloor(dragPoint));
      dragging.group.position.copy(dragging.Position);
      dragging.syncModel();
    }
    return;
  }
  if (e.buttons === 0) {
    const ent = pickAt(e);
    canvas.style.cursor = ent?.kind === 'visitor' ? 'grab' : ent ? 'pointer' : 'crosshair';
    hoverAt(e);
  }
});

/** Q4: describe the ground under a mouse pointer and show it in the tooltip. */
function hoverAt(e) {
  if (e.pointerType !== 'mouse' || e.buttons !== 0 || dragging) return;
  loc.hover = groundAt(e);
  if (loc.hover) showTip(e, describeText(loc.hover)); else hideTip();
  renderQ4();
}

canvas.addEventListener('pointerleave', hideTip);

canvas.addEventListener('pointerup', (e) => {
  if (dragging) {
    dragging.dragging = false;
    dragging.pause = 10;            // linger where dropped so the rule outcome is visible
    dragging.target.copy(dragging.Position);
    if (dragging.anchored) dragging.post = dragging.Position.clone();   // its new post (P9)
    canvas.releasePointerCapture(e.pointerId);
    canvas.style.cursor = 'grab';
    dragging = null;
    pointerDown = null;
    renderLocation();
    return;
  }
  if (pointerDown && Math.hypot(e.clientX - pointerDown.x, e.clientY - pointerDown.y) < 5) {
    const ent = pickAt(e);
    if (ent) {
      select(ent);
    } else {
      // Empty ground: in the Metrics tab it becomes B; otherwise probe who is there (Q2)
      // and describe the spot (Q4).
      const g = groundAt(e);
      if (g && metricsActive()) metricsUI.setPoint(g);
      else if (g) { loc.probe = g; loc.hover = g; updateProbe(); }
      select(null);
    }
  }
  pointerDown = null;
});

// Small screens place menus and windows below the toolbar.
const toolbarEl = document.getElementById('toolbar');
new ResizeObserver(() => {
  document.documentElement.style.setProperty('--toolbar-h', `${toolbarEl.offsetHeight}px`);
}).observe(toolbarEl);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  labelRenderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------------------
// Demonstration scene: the visitors from demo.py (js/scene.js)
// ---------------------------------------------------------------------------
function loadDemo() {
  for (const v of visitors) v.dispose();
  guard.calls.clear();
  tracker.reset();
  activity.clear();
  for (const w of [...wins]) closeWindow(w.ref);
  // The model starts with buildExhibition()'s agents; they are re-added below as scene objects.
  for (const id of [...model.visitors.keys()]) model.remove(id);
  visitors = [];
  visitorSeq = 0;
  for (const z of zones) { z.setAmbient(z.defaultAmbient); z.Occupancy = 0; }
  for (const d of displays) {
    Object.assign(d, {
      Power_State: 'OFF', Current_Media: MEDIA_LOOP, Volume_Level: d.defaultVolume,
      Status: 'Standby', unmatchedFor: 0, ruleMatched: false, proximity: false,
    });
    d.model.powerState = 'OFF';
    d.model.volumeLevel = d.defaultVolume;
    d.nearby = [];
  }
  select(null);
  logEl.innerHTML = '';
  simTime = 0;

  // The spec's agents (R15) stand where the spec puts them until you drag them.
  for (const mv of buildExhibition().world.visitors.values()) {
    spawnVisitor(toThree(mv.position), { id: mv.userId, anchored: true, dwell: mv.dwellTime, silent: true, role: mv.role });
  }

  Object.assign(loc, { subject: null, probe: null, hover: null, find: null, visitor: 'bob', frame: 'g2-screen' });
  metricsUI?.reset();
  locInput('find').value = '';
  updateProbe();
  renderLocation();

  log(`Exhibition loaded (docs/SIMULATION_METRICS.md): ${HALLS.length} halls, ${PLAN.shortcuts.length} shortcuts, ` +
      `${displays.length} displays, ${visitors.length} agents`, 'action');
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
let uiTimer = 0;

// Metrics tab and overlays (R16-R22).
const metricsUI = initMetrics({
  THREE, model, plan: PLAN, worldXYToThree, makeLabel, log, esc, placesGroup, scene,
  panel: locEl.querySelector('[data-pane="metrics"]'),
});

if (window.matchMedia('(max-width: 600px)').matches) setLocationCollapsed(true);
loadDemo();

function animate() {
  requestAnimationFrame(animate);
  const rawDt = clock.getDelta();
  const dt = Math.min(rawDt, 0.05);
  const t = clock.elapsedTime;
  const simDt = paused ? 0 : dt;
  simTime += simDt;

  step(simDt);
  trackLocation(dt);
  sampleMovement(rawDt);   // M2: real time, so the 3 s window means 3 s however slow the frames
  updateVisuals(dt, t);

  uiTimer -= dt;
  if (uiTimer <= 0) {
    uiTimer = 0.2;
    refreshLabels();
    renderRuleEval();
    renderProximityEval();
    renderWindows();
    renderOverview();
    renderStatus();
    renderLocation();
    metricsUI.render(0.2);
  }

  controls.update();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}
animate();

// Read-only handle for tests and the console.
window.spatai = {
  model, frames: FRAMES, plan: PLAN, loc, describeText, visitors: () => visitors, displays, toThree, toModel, guard, tracker, activity,
  windows: () => wins.map((w) => w.ref),
  /** Vertices drawn per movement line style, for tests. */
  movementLines: () => Object.fromEntries(Object.entries(mvLines).map(([k, l]) => [k, l.geometry.attributes.position?.count ?? 0])),
  metrics: () => metricsUI,
  /** Screen pixel of model point (x, y) at height h, e.g. to click it from a test. */
  screenOf(x, y, h = 0) {
    const v = toThree(new Location(x, y), h).project(camera);
    const r = canvas.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  },
};
