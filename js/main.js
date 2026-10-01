// Spatial AI Architecture — interactive visualisation of the semantic model.
//
// Entities:      Visitor, Spatial Zone, Smart Display
// Relationships: Visitor —enters→ Spatial Zone, Spatial Zone —controls→ Smart Display
// Rule:          IF Visitor.Position within 2.5 m of Display.Position AND Zone.Occupancy < 20
//                THEN Display.Power_State = ON
// Action:        Launch_Media() switches Display.Current_Media from the default loop to interactive content.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

// ---------------------------------------------------------------------------
// Model constants
// ---------------------------------------------------------------------------
const RULE_RADIUS = 2.5;      // metres
const MAX_OCCUPANCY = 20;     // rule threshold (strictly less than)
const STANDBY_DELAY = 3;      // seconds a display stays ON after the rule stops matching
const MAX_VISITORS = 150;
const MEDIA_LOOP = 'Default Loop';
const MEDIA_INTERACTIVE = 'Interactive Content';

const FLOOR = { minX: -15, maxX: 15, minZ: -7, maxZ: 7 };
const MARGIN = 0.4;
const UP = new THREE.Vector3(0, 1, 0);

const ZONE_DEFS = [
  { id: 'Z-01', name: 'Lobby',   color: 0x4fa3ff, minX: -15, maxX: -5, ambient: 450 },
  { id: 'Z-02', name: 'Gallery', color: 0xb07cff, minX: -5,  maxX: 5,  ambient: 300 },
  { id: 'Z-03', name: 'Lounge',  color: 0x3fd6a4, minX: 5,   maxX: 15, ambient: 600 },
];

// rot = rotation about Y; the screen faces local +Z.
const DISPLAY_DEFS = [
  { id: 'D-01', zone: 'Z-01', x: -10,  z: -6.3, rot: 0,            volume: 35 },
  { id: 'D-02', zone: 'Z-02', x: -2.2, z: -6.3, rot: 0,            volume: 50 },
  { id: 'D-03', zone: 'Z-02', x: 2.6,  z: 5.9,  rot: Math.PI,      volume: 50 },
  { id: 'D-04', zone: 'Z-03', x: 14.3, z: 0,    rot: -Math.PI / 2, volume: 25 },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

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

const fmtVec = (v) => `(${v.x.toFixed(2)}, ${v.z.toFixed(2)})`;

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
scene.fog = new THREE.Fog(0x0d1117, 45, 90);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 200);
const HOME_VIEW = { pos: new THREE.Vector3(0, 15, 21), target: new THREE.Vector3(0, 0, 0.5) };
camera.position.copy(HOME_VIEW.pos);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(HOME_VIEW.target);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI / 2 - 0.05;
controls.minDistance = 4;
controls.maxDistance = 60;

scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x1a1d24, 0.7));
const sun = new THREE.DirectionalLight(0xffffff, 0.8);
sun.position.set(-8, 20, 12);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -18, right: 18, top: 12, bottom: -12, near: 1, far: 50 });
scene.add(sun);

// Floor, grid and walls ------------------------------------------------------
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(36, 20),
  new THREE.MeshStandardMaterial({ color: 0x1a1f27, roughness: 0.95 })
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

{
  const pts = [];
  for (let x = FLOOR.minX; x <= FLOOR.maxX; x++) pts.push(x, 0.005, FLOOR.minZ, x, 0.005, FLOOR.maxZ);
  for (let z = FLOOR.minZ; z <= FLOOR.maxZ; z++) pts.push(FLOOR.minX, 0.005, z, FLOOR.maxX, 0.005, z);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  scene.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x2a313c })));
}

{
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x232a35, roughness: 0.9 });
  const back = new THREE.Mesh(new THREE.BoxGeometry(30.4, 3, 0.2), wallMat);
  back.position.set(0, 1.5, FLOOR.minZ - 0.1);
  const side = new THREE.Mesh(new THREE.BoxGeometry(0.2, 3, 14.2), wallMat);
  side.position.set(FLOOR.maxX + 0.1, 1.5, 0);
  for (const w of [back, side]) { w.receiveShadow = true; scene.add(w); }

  const entrance = makeLabel('entrance', 0.3);
  entrance.el.textContent = 'ENTRANCE →';
  entrance.obj.position.set(FLOOR.minX - 1.2, 0.3, 0);
  scene.add(entrance.obj);
}

// Groups for the different overlay layers
const relationGroup = new THREE.Group();   // enters / controls lines
const velocityGroup = new THREE.Group();   // velocity arrows
velocityGroup.visible = false;
scene.add(relationGroup, velocityGroup);

const pickables = [];

// ---------------------------------------------------------------------------
// Entity: Spatial Zone
// ---------------------------------------------------------------------------
class SpatialZone {
  constructor(def) {
    this.kind = 'zone';
    this.Zone_ID = def.id;
    this.name = def.name;
    this.Occupancy = 0;
    this.Ambient_Light = def.ambient;   // lux
    this.defaultAmbient = def.ambient;
    this.displays = [];                  // Spatial Zone —controls→ Smart Display
    this.color = new THREE.Color(def.color);
    this.bounds = { minX: def.minX, maxX: def.maxX, minZ: FLOOR.minZ, maxZ: FLOOR.maxZ };
    const cx = (def.minX + def.maxX) / 2;
    this.center = new THREE.Vector3(cx, 0, 0);

    const w = def.maxX - def.minX;
    const h = FLOOR.maxZ - FLOOR.minZ;
    const geo = new THREE.PlaneGeometry(w - 0.1, h - 0.1);

    this.floorMat = new THREE.MeshStandardMaterial({
      color: this.color, emissive: this.color, emissiveIntensity: 0.05,
      transparent: true, opacity: 0.16, depthWrite: false,
    });
    this.floor = new THREE.Mesh(geo, this.floorMat);
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.position.set(cx, 0.01, 0);
    this.floor.receiveShadow = true;
    this.floor.userData.entity = this;

    this.border = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: this.color, transparent: true, opacity: 0.8 })
    );
    this.border.rotation.x = -Math.PI / 2;
    this.border.position.set(cx, 0.02, 0);

    // Floating "hub" node that represents the zone entity in the relationship graph
    this.hub = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.38),
      new THREE.MeshStandardMaterial({ color: this.color, emissive: this.color, emissiveIntensity: 0.5, flatShading: true })
    );
    this.hub.position.set(cx, 4.8, 0);
    this.hub.userData.entity = this;

    this.label = makeLabel('zone', 0.85);
    this.hub.add(this.label.obj);

    // Ceiling light whose intensity is the zone's Ambient_Light
    this.spot = new THREE.SpotLight(0xfff1dc, 1, 0, 0.62, 0.6, 0);
    this.spot.position.set(cx, 10, 0);
    this.spot.target.position.set(cx, 0, 0);

    scene.add(this.floor, this.border, this.hub, this.spot, this.spot.target);
    pickables.push(this.floor, this.hub);
    this.setAmbient(this.Ambient_Light);
  }

  contains(p) {
    const b = this.bounds;
    const inX = p.x >= b.minX && (p.x < b.maxX || (b.maxX === FLOOR.maxX && p.x <= b.maxX));
    return inX && p.z >= b.minZ && p.z <= b.maxZ;
  }

  randomPoint(margin = 0.7) {
    const b = this.bounds;
    return new THREE.Vector3(rand(b.minX + margin, b.maxX - margin), 0, rand(b.minZ + margin, b.maxZ - margin));
  }

  setAmbient(lux) {
    this.Ambient_Light = lux;
    this.spot.intensity = (lux / 1000) * 3;
    this.floorMat.emissiveIntensity = 0.03 + (lux / 1000) * 0.3;
  }

  get atCapacity() { return this.Occupancy >= MAX_OCCUPANCY; }

  updateLabel() {
    this.label.el.classList.toggle('full', this.atCapacity);
    this.label.el.innerHTML =
      `<b>${this.Zone_ID} · ${this.name}</b><span>${this.Occupancy} / ${MAX_OCCUPANCY} · ${this.Ambient_Light} lx</span>`;
  }
}

// ---------------------------------------------------------------------------
// Entity: Smart Display
// ---------------------------------------------------------------------------
const SCREEN_W = 512, SCREEN_H = 288;

class SmartDisplay {
  constructor(def, zone) {
    this.kind = 'display';
    this.Display_ID = def.id;
    this.Current_Media = MEDIA_LOOP;
    this.Volume_Level = def.volume;
    this.defaultVolume = def.volume;
    this.Power_State = 'OFF';
    this.Status = 'Standby';
    this.Position = new THREE.Vector3(def.x, 0, def.z);
    this.forward = new THREE.Vector3(Math.sin(def.rot), 0, Math.cos(def.rot));
    this.zone = zone;
    zone.displays.push(this);

    this.nearby = [];          // [{ visitor, dist }] within RULE_RADIUS, sorted
    this.proximity = false;
    this.capacityOK = true;
    this.ruleMatched = false;
    this.unmatchedFor = 0;

    this.group = new THREE.Group();
    this.group.position.copy(this.Position);
    this.group.rotation.y = def.rot;

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

    for (const m of [base, pole, frame]) { m.castShadow = true; }
    for (const m of [base, pole, frame, screen]) { m.userData.entity = this; pickables.push(m); }
    this.group.add(base, pole, frame, screen, led, ring, disc);

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
      log(`Launch_Media() rejected on <b>${this.Display_ID}</b>: Power_State is OFF`, 'warn');
      return false;
    }
    if (this.Current_Media === MEDIA_INTERACTIVE) {
      log(`<b>${this.Display_ID}</b> is already showing interactive content`, 'warn');
      return false;
    }
    this.Current_Media = MEDIA_INTERACTIVE;
    log(`Launch_Media() on <b>${this.Display_ID}</b>: Current_Media → ${MEDIA_INTERACTIVE}`, 'action');
    return true;
  }

  resetMedia(reason = '') {
    if (this.Current_Media === MEDIA_LOOP) return false;
    this.Current_Media = MEDIA_LOOP;
    log(`<b>${this.Display_ID}</b>: Current_Media → ${MEDIA_LOOP}${reason}`, 'action');
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
    this.ringMat.color.setHex(c);
    this.discMat.color.setHex(c);
    this.discMat.opacity = this.proximity ? 0.12 : 0.04;
  }

  updateLabel() {
    const interactive = this.Power_State === 'ON' && this.Current_Media === MEDIA_INTERACTIVE;
    this.label.el.className = `lbl display ${this.Power_State}${interactive ? ' interactive' : ''}`;
    this.label.el.textContent = `${this.Display_ID} · ${this.Power_State}${interactive ? ' · interactive' : ''}`;
  }
}

// ---------------------------------------------------------------------------
// Entity: Visitor
// ---------------------------------------------------------------------------
const visitorGeo = {
  body: new THREE.CapsuleGeometry(0.22, 0.8, 4, 12),
  head: new THREE.SphereGeometry(0.17, 16, 12),
};
let visitorSeq = 0;
const tmpDesired = new THREE.Vector3();
const tmpTo = new THREE.Vector3();

class Visitor {
  constructor(pos, homeZone = null) {
    this.kind = 'visitor';
    const n = ++visitorSeq;
    this.User_ID = 'V-' + String(n).padStart(3, '0');
    this.Position = clampToFloor(pos.clone());
    this.Velocity = new THREE.Vector3();
    this.Dwell_Time = 0;
    this.zone = null;              // Visitor —enters→ Spatial Zone
    this.homeZone = homeZone;      // crowd members stay in their zone
    this.speed = rand(0.7, 1.3);
    this.pause = rand(0, 1.5);
    this.target = new THREE.Vector3();
    this.dragging = false;

    const color = new THREE.Color().setHSL(((n * 47) % 360) / 360, 0.65, 0.6);
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6 });
    this.group = new THREE.Group();
    this.body = new THREE.Mesh(visitorGeo.body, mat);
    this.body.position.y = 0.62;
    this.head = new THREE.Mesh(visitorGeo.head, new THREE.MeshStandardMaterial({ color: 0xf2e6d8, roughness: 0.7 }));
    this.head.position.y = 1.42;
    for (const m of [this.body, this.head]) { m.castShadow = true; m.userData.entity = this; pickables.push(m); }
    this.group.add(this.body, this.head);

    this.label = makeLabel('visitor', 1.85);
    this.label.el.textContent = this.User_ID;
    this.group.add(this.label.obj);
    this.group.position.copy(this.Position);
    scene.add(this.group);

    this.arrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 1, 0xffd166, 0.2, 0.14);
    velocityGroup.add(this.arrow);

    this.pickTarget();
  }

  pickTarget() {
    // Visitors are drawn to displays now and then, which is what exercises the rule.
    const candidates = this.homeZone ? this.homeZone.displays : displays;
    if (Math.random() < 0.38 && candidates.length) {
      const d = pick(candidates);
      const dir = d.forward.clone().applyAxisAngle(UP, rand(-0.9, 0.9));
      this.target.copy(d.Position).addScaledVector(dir, rand(0.7, 2.2));
      clampToFloor(this.target);
      return;
    }
    const z = this.homeZone ?? (this.zone && Math.random() < 0.55 ? this.zone : pick(zones));
    this.target.copy(z.randomPoint());
  }

  update(dt, others) {
    if (this.dragging) { this.Velocity.set(0, 0, 0); return; }
    tmpDesired.set(0, 0, 0);
    if (this.pause > 0) {
      this.pause -= dt;
    } else {
      tmpTo.subVectors(this.target, this.Position).setY(0);
      const d = tmpTo.length();
      if (d < 0.25) {
        this.pause = rand(1.5, 6);
        this.pickTarget();
      } else {
        tmpDesired.copy(tmpTo).multiplyScalar(this.speed / d);
      }
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
    this.Velocity.lerp(tmpDesired, Math.min(1, dt * 4));
    this.Position.addScaledVector(this.Velocity, dt);
    clampToFloor(this.Position);
    this.group.position.copy(this.Position);
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
  }
}

// ---------------------------------------------------------------------------
// World state
// ---------------------------------------------------------------------------
const zones = ZONE_DEFS.map((d) => new SpatialZone(d));
const displays = DISPLAY_DEFS.map((d) => new SmartDisplay(d, zones.find((z) => z.Zone_ID === d.zone)));
let visitors = [];

const zoneAt = (p) => zones.find((z) => z.contains(p)) ?? null;

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
const MAX_PROX = MAX_VISITORS * DISPLAY_DEFS.length;
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
// Event log
// ---------------------------------------------------------------------------
const logEl = document.getElementById('log');
let simTime = 0;

function log(msg, type = 'info') {
  const li = document.createElement('li');
  li.className = type;
  li.innerHTML = `<time>${simTime.toFixed(1)}s</time>${msg}`;
  logEl.prepend(li);
  while (logEl.children.length > 120) logEl.lastChild.remove();
}

// ---------------------------------------------------------------------------
// Visitor management
// ---------------------------------------------------------------------------
function spawnVisitor(pos, homeZone = null, silent = false) {
  if (visitors.length >= MAX_VISITORS) {
    log(`Visitor limit (${MAX_VISITORS}) reached`, 'warn');
    return null;
  }
  const v = new Visitor(pos, homeZone);
  if (silent) v.zone = zoneAt(v.Position);
  visitors.push(v);
  return v;
}

function removeVisitor(v) {
  v.dispose();
  visitors = visitors.filter((o) => o !== v);
  if (selected === v) select(null);
  log(`${v.User_ID} leaves${v.zone ? ' ' + v.zone.Zone_ID : ''}`, 'enter');
}

function spawnCrowd(zone, count = 10) {
  let n = 0;
  for (let i = 0; i < count; i++) {
    const v = spawnVisitor(zone.randomPoint(0.8), zone, true);
    if (v) n++;
  }
  if (n) log(`${n} visitors enter <b>${zone.Zone_ID}</b> (crowd)`, 'enter');
}

// ---------------------------------------------------------------------------
// Simulation step: movement → relationships → rule evaluation
// ---------------------------------------------------------------------------
function step(dt) {
  for (const v of visitors) v.update(dt, visitors);

  // Visitor —enters→ Spatial Zone, Occupancy, Dwell_Time
  for (const z of zones) z.Occupancy = 0;
  for (const v of visitors) {
    const z = zoneAt(v.Position);
    if (z !== v.zone) {
      if (z) log(`${v.User_ID} enters ${z.Zone_ID} ${z.name}`, 'enter');
      v.zone = z;
      v.Dwell_Time = 0;
    } else {
      v.Dwell_Time += dt;
    }
    if (z) z.Occupancy++;
  }

  for (const d of displays) evaluateRule(d, dt);
}

function evaluateRule(d, dt) {
  d.nearby.length = 0;
  for (const v of visitors) {
    const dist = Math.hypot(v.Position.x - d.Position.x, v.Position.z - d.Position.z);
    if (dist <= RULE_RADIUS) d.nearby.push({ visitor: v, dist });
  }
  d.nearby.sort((a, b) => a.dist - b.dist);

  d.proximity = d.nearby.length > 0;
  d.capacityOK = d.zone.Occupancy < MAX_OCCUPANCY;
  d.ruleMatched = d.proximity && d.capacityOK;

  if (d.ruleMatched) {
    d.unmatchedFor = 0;
    if (d.Power_State !== 'ON') {
      d.Power_State = 'ON';
      log(`Rule fired → <b>${d.Display_ID}</b> Power_State = ON ` +
          `(${d.nearby[0].visitor.User_ID} @ ${d.nearby[0].dist.toFixed(2)} m, ` +
          `${d.zone.Zone_ID} occupancy ${d.zone.Occupancy})`, 'rule');
    }
  } else if (d.Power_State === 'ON') {
    d.unmatchedFor += dt;
    if (d.unmatchedFor >= STANDBY_DELAY) {
      d.Power_State = 'OFF';
      const why = d.proximity ? `${d.zone.Zone_ID} at capacity` : 'no visitor in range';
      log(`<b>${d.Display_ID}</b> Power_State = OFF (${why})`, 'off');
      d.resetMedia(' (powered off)');
    }
  }

  if (d.Power_State === 'ON') {
    if (!d.ruleMatched) d.Status = `Cooling down (${Math.max(0, STANDBY_DELAY - d.unmatchedFor).toFixed(1)} s)`;
    else if (d.Current_Media === MEDIA_INTERACTIVE) d.Status = 'Interactive session';
    else d.Status = 'Engaged · visitor in range';
  } else {
    d.Status = d.proximity && !d.capacityOK ? 'Inhibited · zone at capacity' : 'Standby';
  }
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
// Selection & inspector
// ---------------------------------------------------------------------------
const inspectorEl = document.getElementById('inspector');
let selected = null;

function entityRef(e) {
  if (e.kind === 'visitor') return `visitor:${e.User_ID}`;
  if (e.kind === 'zone') return `zone:${e.Zone_ID}`;
  return `display:${e.Display_ID}`;
}

function entityByRef(ref) {
  const [kind, id] = ref.split(':');
  if (kind === 'visitor') return visitors.find((v) => v.User_ID === id) ?? null;
  if (kind === 'zone') return zones.find((z) => z.Zone_ID === id) ?? null;
  if (kind === 'display') return displays.find((d) => d.Display_ID === id) ?? null;
  return null;
}

const chip = (e) => {
  const name = e.kind === 'visitor' ? e.User_ID : e.kind === 'zone' ? `${e.Zone_ID} ${e.name}` : e.Display_ID;
  return `<span class="chip ${e.kind}" data-select="${entityRef(e)}">${name}</span>`;
};

const attrRow = (name, field, derived = false) =>
  `<div class="attr${derived ? ' derived' : ''}"><span class="k">${name}</span><span class="v" data-field="${field}"></span></div>`;

function select(entity) {
  selected = entity;
  renderInspector(true);
}

function renderInspector(full = false) {
  const e = selected;
  if (!e) { renderOverview(); return; }

  if (full) {
    let html = `<div class="ins-head"><span class="chip ${e.kind}">${
      { visitor: 'Visitor', zone: 'Spatial Zone', display: 'Smart Display' }[e.kind]
    }</span><h2 data-field="title"></h2><button class="x" data-action="deselect" title="Close">×</button></div>`;

    if (e.kind === 'visitor') {
      html += `<div class="attrs">${attrRow('User_ID', 'User_ID')}${attrRow('Position', 'Position')}${
        attrRow('Velocity', 'Velocity')}${attrRow('Dwell_Time', 'Dwell_Time')}</div>
        <h4>Relationships</h4><div data-field="rel"></div>
        <h4>Rule context</h4><div data-field="ctx"></div>
        <div class="btns"><button data-action="remove-visitor" class="danger">Remove visitor</button></div>
        <p class="hint-text">Drag the visitor in the 3D view to move it next to a display.</p>`;
    } else if (e.kind === 'zone') {
      html += `<div class="attrs">${attrRow('Zone_ID', 'Zone_ID')}${attrRow('Occupancy', 'Occupancy')}${
        attrRow('Ambient_Light', 'Ambient_Light')}</div>
        <div class="bar" data-field="occBar"><i></i></div>
        <div class="ctrl"><label>Ambient_Light <span data-field="luxValue"></span></label>
          <input type="range" min="0" max="1000" step="10" data-input="ambient" value="${e.Ambient_Light}"></div>
        <h4>Controls</h4><div data-field="controls"></div>
        <h4>Visitors who entered</h4><div data-field="visitors"></div>
        <div class="btns">
          <button data-action="add-crowd">＋10 Crowd here</button>
          <button data-action="clear-zone" class="danger">Clear zone</button>
        </div>
        <p class="hint-text">Raise occupancy to ${MAX_OCCUPANCY}+ to see the rule inhibit this zone's displays.</p>`;
    } else {
      html += `<div class="attrs">${attrRow('Display_ID', 'Display_ID')}${attrRow('Current_Media', 'Current_Media')}${
        attrRow('Volume_Level', 'Volume_Level')}${attrRow('Power_State', 'Power_State')}${attrRow('Status', 'Status')}${
        attrRow('Position', 'Position', true)}</div>
        <div class="ctrl"><label>Volume_Level <span data-field="volValue"></span></label>
          <input type="range" min="0" max="100" step="1" data-input="volume" value="${e.Volume_Level}"></div>
        <h4>Relationships</h4><div data-field="rel"></div>
        <h4>Rule evaluation</h4><div data-field="ctx"></div>
        <div class="btns">
          <button data-action="launch-media" class="primary">▶ Launch_Media()</button>
          <button data-action="reset-media">⟲ Default loop</button>
        </div>`;
    }
    inspectorEl.innerHTML = html;
  }

  const f = {};
  if (e.kind === 'visitor') {
    f.title = e.User_ID;
    f.User_ID = e.User_ID;
    f.Position = fmtVec(e.Position) + ' m';
    f.Velocity = `${fmtVec(e.Velocity)} · ${e.Velocity.length().toFixed(2)} m/s`;
    f.Dwell_Time = `${e.Dwell_Time.toFixed(1)} s`;
    f.rel = e.zone ? `${chip(e)}<span class="rel">enters</span>${chip(e.zone)}` : '<span class="no">outside all zones</span>';
    let best = null;
    for (const d of displays) {
      const dist = Math.hypot(e.Position.x - d.Position.x, e.Position.z - d.Position.z);
      if (!best || dist < best.dist) best = { d, dist };
    }
    f.ctx = `Nearest ${chip(best.d)} at <span class="${best.dist <= RULE_RADIUS ? 'ok' : 'no'}">${best.dist.toFixed(2)} m</span>` +
      (best.dist <= RULE_RADIUS ? ' — within rule radius' : ` — needs ≤ ${RULE_RADIUS} m`);
  } else if (e.kind === 'zone') {
    f.title = `${e.Zone_ID} · ${e.name}`;
    f.Zone_ID = e.Zone_ID;
    f.Occupancy = `<span class="${e.atCapacity ? 'no' : 'ok'}">${e.Occupancy}</span> / ${MAX_OCCUPANCY}`;
    f.Ambient_Light = `${e.Ambient_Light} lx`;
    f.luxValue = `${e.Ambient_Light} lx`;
    f.controls = e.displays.map((d) => `${chip(e)}<span class="rel">controls</span>${chip(d)}`).join('<br>');
    const inside = visitors.filter((v) => v.zone === e);
    f.visitors = inside.length
      ? inside.slice(0, 24).map(chip).join('') + (inside.length > 24 ? ` <span class="rel">+${inside.length - 24} more</span>` : '')
      : '<span class="rel">none</span>';
  } else {
    f.title = e.Display_ID;
    f.Display_ID = e.Display_ID;
    f.Current_Media = e.Current_Media;
    f.Volume_Level = `${e.Volume_Level}%`;
    f.volValue = `${e.Volume_Level}%`;
    f.Power_State = `<span class="badge ${e.Power_State}">${e.Power_State}</span>`;
    f.Status = e.Status;
    f.Position = fmtVec(e.Position) + ' m';
    f.rel = `${chip(e.zone)}<span class="rel">controls</span>${chip(e)}`;
    const n = e.nearby[0];
    f.ctx = `<div>${e.proximity ? '✓' : '✗'} Visitor within ${RULE_RADIUS} m: <span class="${e.proximity ? 'ok' : 'no'}">${
      n ? `${n.visitor.User_ID} @ ${n.dist.toFixed(2)} m${e.nearby.length > 1 ? ` (+${e.nearby.length - 1})` : ''}` : 'none'
    }</span></div><div>${e.capacityOK ? '✓' : '✗'} ${e.zone.Zone_ID}.Occupancy &lt; ${MAX_OCCUPANCY}: <span class="${
      e.capacityOK ? 'ok' : 'no'}">${e.zone.Occupancy}</span></div><div>⇒ ${
      e.ruleMatched ? '<span class="ok">rule satisfied — Power_State ON</span>' : '<span class="warn">rule not satisfied</span>'}</div>`;
  }

  for (const el of inspectorEl.querySelectorAll('[data-field]')) {
    const k = el.dataset.field;
    if (k === 'occBar') {
      el.classList.toggle('full', e.atCapacity);
      el.firstElementChild.style.width = `${Math.min(100, (e.Occupancy / MAX_OCCUPANCY) * 100)}%`;
    } else if (k in f && el.innerHTML !== f[k]) {
      el.innerHTML = f[k];
    }
  }
}

function renderOverview() {
  const zoneRows = zones.map((z) =>
    `<tr data-select="${entityRef(z)}"><td>${chip(z)}</td><td class="${z.atCapacity ? 'no' : ''}">${z.Occupancy} / ${MAX_OCCUPANCY}</td><td>${z.Ambient_Light} lx</td></tr>`).join('');
  const dispRows = displays.map((d) =>
    `<tr data-select="${entityRef(d)}"><td>${chip(d)}</td><td><span class="badge ${d.Power_State}">${d.Power_State}</span></td><td>${
      d.Current_Media === MEDIA_INTERACTIVE ? 'Interactive' : 'Loop'}</td></tr>`).join('');
  const html = `
    <div class="ins-head"><h2>Semantic model</h2></div>
    <p class="hint-text">Click any visitor, zone (floor or floating node) or display to inspect its attributes.</p>
    <h4>Spatial Zones</h4>
    <table class="overview"><tr><th>Zone</th><th>Occupancy</th><th>Light</th></tr>${zoneRows}</table>
    <h4>Smart Displays</h4>
    <table class="overview"><tr><th>Display</th><th>Power</th><th>Media</th></tr>${dispRows}</table>
    <h4>Visitors</h4>
    <div>${visitors.length} in the neighborhood</div>
    <h4>Legend</h4>
    <div class="hint-text" style="margin:0">
      <span class="ok">●</span> rule satisfied ·
      <span class="no">●</span> visitor in range but zone at capacity ·
      <span class="warn">●</span> cooling down<br>
      Dashed lines: zone <i>controls</i> display · thin lines: visitor <i>enters</i> zone
    </div>`;
  // Only touch the DOM when something changed, so clicks on rows are not lost.
  if (html !== lastOverview || !inspectorEl.querySelector('table.overview')) {
    inspectorEl.innerHTML = html;
    lastOverview = html;
  }
}
let lastOverview = '';

const ruleEvalEl = document.getElementById('rule-eval');
function renderRuleEval() {
  // Rows are created once and only their contents refreshed, so clicks are not lost.
  if (ruleEvalEl.children.length !== displays.length) {
    ruleEvalEl.innerHTML = displays.map((d) =>
      `<div class="rule-row" data-select="${entityRef(d)}"><b>${d.Display_ID}</b><span></span></div>`).join('');
  }
  displays.forEach((d, i) => {
    const n = d.nearby[0];
    const html = `<span class="${d.proximity ? 'ok' : 'no'}">${n ? `${n.visitor.User_ID} @ ${n.dist.toFixed(2)} m` : `no visitor ≤ ${RULE_RADIUS} m`}</span>` +
      ` ∧ <span class="${d.capacityOK ? 'ok' : 'no'}">${d.zone.Zone_ID}.occ ${d.zone.Occupancy} ${d.capacityOK ? '&lt;' : '≥'} ${MAX_OCCUPANCY}</span>` +
      ` ⇒ <span class="badge ${d.Power_State}">${d.Power_State}</span>`;
    const body = ruleEvalEl.children[i].lastElementChild;
    if (body.innerHTML !== html) body.innerHTML = html;
  });
}

function refreshLabels() {
  for (const z of zones) z.updateLabel();
  for (const d of displays) d.updateLabel();
}

// ---------------------------------------------------------------------------
// Actions (toolbar + inspector buttons)
// ---------------------------------------------------------------------------
let paused = false;

function contextZone() {
  if (!selected) return null;
  if (selected.kind === 'zone') return selected;
  return selected.zone ?? null;
}

const actions = {
  'add-visitor'() {
    const v = spawnVisitor(new THREE.Vector3(FLOOR.minX + 0.5, 0, rand(-2.5, 2.5)));
    if (v) log(`${v.User_ID} arrives at the entrance`, 'action');
  },
  'add-crowd'() {
    spawnCrowd(contextZone() ?? zones[1]);
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
      log('Launch_Media(): select a display, or wait until one is powered ON by the rule', 'warn');
      return;
    }
    for (const d of on) d.launchMedia();
  },
  'reset-media'() {
    const targets = selected?.kind === 'display' ? [selected] : displays;
    if (!targets.some((d) => d.resetMedia())) log('Displays are already on the default loop', 'warn');
  },
  'toggle-relations'(btn) {
    relationGroup.visible = !relationGroup.visible;
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
  'reset-camera'() {
    camera.position.copy(HOME_VIEW.pos);
    controls.target.copy(HOME_VIEW.target);
  },
  pause() {
    paused = !paused;
    const btn = document.querySelector('[data-action="pause"]');
    btn.textContent = paused ? '▶ Resume' : '⏸ Pause';
    btn.classList.toggle('on', paused);
    log(paused ? 'Simulation paused (rule engine still evaluates dragged visitors)' : 'Simulation resumed', 'action');
  },
  reset() {
    loadDemo();
  },
  deselect() {
    select(null);
  },
};

function runAction(name, btn) {
  actions[name]?.(btn);
  renderInspector(true);
}

document.getElementById('toolbar').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (btn) runAction(btn.dataset.action, btn);
});

for (const el of [inspectorEl, ruleEvalEl]) {
  el.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (btn) { runAction(btn.dataset.action, document.querySelector(`#toolbar [data-action="${btn.dataset.action}"]`)); return; }
    const sel = e.target.closest('[data-select]');
    if (sel) {
      const ent = entityByRef(sel.dataset.select);
      if (ent) select(ent);
    }
  });
}

inspectorEl.addEventListener('input', (e) => {
  const input = e.target.closest('[data-input]');
  if (!input || !selected) return;
  const value = Number(input.value);
  if (input.dataset.input === 'ambient' && selected.kind === 'zone') selected.setAmbient(value);
  if (input.dataset.input === 'volume' && selected.kind === 'display') {
    selected.Volume_Level = value;
    selected.drawTimer = 0;
  }
  renderInspector();
  refreshLabels();
});

window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea')) return;
  if (e.code === 'Space') { e.preventDefault(); runAction('pause'); }
  if (e.code === 'Escape') select(null);
  if (e.code === 'Delete' && selected?.kind === 'visitor') runAction('remove-visitor');
});

// ---------------------------------------------------------------------------
// Picking & dragging
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

const canvas = renderer.domElement;

// Capture phase so a visitor grab can pre-empt OrbitControls.
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  pointerDown = { x: e.clientX, y: e.clientY };
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
    }
    return;
  }
  if (e.buttons === 0) {
    const ent = pickAt(e);
    canvas.style.cursor = ent?.kind === 'visitor' ? 'grab' : ent ? 'pointer' : '';
  }
});

canvas.addEventListener('pointerup', (e) => {
  if (dragging) {
    dragging.dragging = false;
    dragging.pause = 10;            // linger where dropped so the rule outcome is visible
    dragging.target.copy(dragging.Position);
    canvas.releasePointerCapture(e.pointerId);
    canvas.style.cursor = 'grab';
    dragging = null;
    pointerDown = null;
    return;
  }
  if (pointerDown && Math.hypot(e.clientX - pointerDown.x, e.clientY - pointerDown.y) < 5) {
    select(pickAt(e));
  }
  pointerDown = null;
});

// Keep the panels below the toolbar however many rows it wraps to.
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
// Demonstration scene
// ---------------------------------------------------------------------------
function loadDemo() {
  for (const v of visitors) v.dispose();
  visitors = [];
  visitorSeq = 0;
  for (const z of zones) { z.setAmbient(z.defaultAmbient); z.Occupancy = 0; }
  for (const d of displays) {
    Object.assign(d, {
      Power_State: 'OFF', Current_Media: MEDIA_LOOP, Volume_Level: d.defaultVolume,
      Status: 'Standby', unmatchedFor: 0, ruleMatched: false, proximity: false,
    });
    d.nearby.length = 0;
  }
  select(null);
  logEl.innerHTML = '';
  simTime = 0;

  // A visitor already standing at D-01 so the rule fires right away
  const greeter = spawnVisitor(new THREE.Vector3(-10, 0, -4.6), null, true);
  greeter.pause = 8;
  greeter.target.copy(greeter.Position);

  // Wanderers spread over the neighborhood
  const spots = [[-12, 3], [-7, 1], [-1, -2], [1, 4], [3, -3], [7, 4], [10, -2], [12, 3]];
  for (const [x, z] of spots) spawnVisitor(new THREE.Vector3(x, 0, z), null, true);

  // A busier lounge (still below capacity)
  for (let i = 0; i < 6; i++) spawnVisitor(zones[2].randomPoint(), zones[2], true);

  log('Demonstration scene loaded — 3 zones, 4 displays, 15 visitors', 'action');
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
let uiTimer = 0;

loadDemo();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  const simDt = paused ? 0 : dt;
  simTime += simDt;

  step(simDt);
  updateVisuals(dt, t);

  uiTimer -= dt;
  if (uiTimer <= 0) {
    uiTimer = 0.2;
    refreshLabels();
    renderRuleEval();
    renderInspector();
  }

  controls.update();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}
animate();
