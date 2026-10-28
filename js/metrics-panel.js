// Metrics tab and metric overlays for the exhibition (docs/SIMULATION_METRICS.md R16-R22).
//
// Everything it measures comes from js/metrics.js, the port of spatai/metrics.py.
// main.js owns the scene and calls initMetrics() once, then render() on every UI tick.

import {
  FAR, METRICS, METRIC_LABELS, METRIC_UNITS, NEAR, axiomReport, measure, normalize, referenceRanges, seqUsedEdges, task,
} from './metrics.js';
import { CHECKOUT, ENTRANCE, HALLS } from './exhibition.js';
import { EPSILON, Location } from './spatial.js';

// Categorical slots 1-3 (dark mode), validated as a set against the panel surface.
export const METRIC_COLORS = { euclidean: '#3987e5', seq: '#d95926', task: '#199e70' };
const INK = '#dbe3ee', MUTED = '#8592a3', SURFACE = '#12171f', WARN_TINT = 'rgba(255, 181, 71, 0.13)';
const LATERAL = { euclidean: 0, seq: 0.28, task: -0.28 };   // metres, so overlapping paths stay apart
const HEIGHT = { euclidean: 0.11, seq: 0.13, task: 0.15 };

export function initMetrics(ctx) {
  const { THREE, model, plan, worldXYToThree, makeLabel, log, esc, placesGroup, scene, panel } = ctx;

  const ranges = referenceRanges(plan);
  const axioms = axiomReport(plan);
  const xLoc = plan.centre(ENTRANCE);
  const selfLoop = task(plan, xLoc, xLoc);

  const state = {
    a: 'agent:bob', b: 'place:Gallery 1', point: null, role: 'visitor', strict: false,
    show: { euclidean: true, seq: true, task: true, case2: true, case3: false },
    disc: new Map(),   // userId → { current, pending, t } for the event log
    discKey: '',
  };

  const q = (sel) => panel.querySelector(sel);
  const out = (name) => panel.querySelector(`[data-out="${name}"]`);
  const setHTML = (el, html) => { if (el && el.innerHTML !== html) el.innerHTML = html; };

  // -------------------------------------------------------------------------
  // Geometry helpers: flat ribbons and arrowheads on the floor
  // -------------------------------------------------------------------------
  const V = ([x, y], h = 0) => worldXYToThree(x, y, h);

  function offsetPolyline(pts, d) {
    if (!d || pts.length < 2) return pts;
    return pts.map((p, i) => {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      const tx = b[0] - a[0], ty = b[1] - a[1], len = Math.hypot(tx, ty) || 1;
      return [p[0] - (ty / len) * d, p[1] + (tx / len) * d];
    });
  }

  function dashes(pts, dash, gap) {
    const outPts = [];
    let cur = [], on = true, left = dash;
    for (let i = 0; i + 1 < pts.length; i++) {
      let [x, y] = pts[i];
      const [x2, y2] = pts[i + 1];
      let seg = Math.hypot(x2 - x, y2 - y);
      const ux = (x2 - x) / (seg || 1), uy = (y2 - y) / (seg || 1);
      if (on && !cur.length) cur.push([x, y]);
      while (seg > left) {
        x += ux * left; y += uy * left; seg -= left;
        if (on) { cur.push([x, y]); outPts.push(cur); cur = []; } else cur = [[x, y]];
        on = !on; left = on ? dash : gap;
      }
      left -= seg;
      if (on) cur.push([x2, y2]);
    }
    if (on && cur.length > 1) outPts.push(cur);
    return outPts;
  }

  function ribbonGeometry(lines, width, h) {
    const pos = [], idx = [];
    for (const pts of lines) {
      if (pts.length < 2) continue;
      const base = pos.length / 3;
      pts.forEach((p, i) => {
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
        const tx = b[0] - a[0], ty = b[1] - a[1], len = Math.hypot(tx, ty) || 1;
        const nx = -ty / len * (width / 2), ny = tx / len * (width / 2);
        const l = V([p[0] + nx, p[1] + ny], h), r = V([p[0] - nx, p[1] - ny], h);
        pos.push(l.x, l.y, l.z, r.x, r.y, r.z);
        if (i) { const k = base + 2 * i; idx.push(k - 2, k - 1, k, k - 1, k + 1, k); }
      });
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    return g;
  }

  function arrowGeometry(tips, size, h) {
    const pos = [];
    for (const { at, dir } of tips) {
      const [dx, dy] = dir, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
      const tip = [at[0] + ux * size * 0.5, at[1] + uy * size * 0.5];
      const back = [at[0] - ux * size * 0.5, at[1] - uy * size * 0.5];
      const l = [back[0] - uy * size * 0.45, back[1] + ux * size * 0.45];
      const r = [back[0] + uy * size * 0.45, back[1] - ux * size * 0.45];
      for (const p of [tip, l, r]) { const v = V(p, h); pos.push(v.x, v.y, v.z); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    return g;
  }

  const mat = (color, opacity = 0.95) => new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide,
  });

  function polylineMesh(pts, { color, width = 0.18, h = 0.12, dashed = false, opacity = 0.95, arrows = 0 }) {
    const group = new THREE.Group();
    const m = mat(color, opacity);
    group.add(new THREE.Mesh(ribbonGeometry(dashed ? dashes(pts, 0.6, 0.4) : [pts], width, h), m));
    if (arrows) {
      const tips = [];
      for (let i = 0; i + 1 < pts.length; i++) {
        const [a, b] = [pts[i], pts[i + 1]];
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) < arrows) continue;
        tips.push({ at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], dir: [b[0] - a[0], b[1] - a[1]] });
      }
      const last = pts.length - 1;
      if (last > 0) tips.push({ at: pts[last], dir: [pts[last][0] - pts[last - 1][0], pts[last][1] - pts[last - 1][1]] });
      group.add(new THREE.Mesh(arrowGeometry(tips, width * 4, h + 0.002), m));
    }
    group.renderOrder = 6;
    return group;
  }

  function smooth(pts, n = 160, closed = false) {
    const curve = new THREE.CatmullRomCurve3(pts.map(([x, y]) => new THREE.Vector3(x, 0, y)), closed, 'centripetal');
    return curve.getPoints(n).map((v) => [v.x, v.z]);
  }

  function disposeGroup(g) {
    for (const o of [...g.children]) {
      g.remove(o);
      o.traverse?.((c) => { c.geometry?.dispose(); if (c.material && !c.material.shared) c.material.dispose?.(); });
      if (o.isCSS2DObject) o.element.remove();
    }
  }

  function tag(text, xy, cls, color, h = 0.2) {
    const l = makeLabel(`metric ${cls}`, h);
    l.el.textContent = text;
    if (color) { l.el.style.color = color; l.el.style.borderColor = color + 'aa'; }
    l.obj.position.copy(V(xy, h));
    return l.obj;
  }

  // -------------------------------------------------------------------------
  // R16: check valves on forward doors, one-way shortcut corridors, staff door
  // -------------------------------------------------------------------------
  function wallNormal(door) {
    const [r1, r2] = door.rooms.map((n) => plan.rooms.get(n));
    const vertical = Math.abs(r1.xMax - r2.xMin) < EPSILON || Math.abs(r2.xMax - r1.xMin) < EPSILON;
    return vertical ? [1, 0] : [0, 1];
  }

  {
    const glyphMat = mat(0xdbe3ee, 0.9);
    glyphMat.shared = true;
    const resetMat = mat(0x8592a3, 0.85);
    resetMat.shared = true;
    const drawn = new Set();
    for (const e of plan.seqEdges) {
      if (e.kind !== 'forward' && e.kind !== 'reset') continue;
      let from = e.src;
      for (const doorId of e.via) {
        const door = plan.doors.get(doorId);
        const to = door.rooms.find((r) => r !== from) ?? door.rooms[1];
        if (!drawn.has(doorId)) {
          drawn.add(doorId);
          const [nx, ny] = wallNormal(door);
          const c1 = plan.centre(from), c2 = plan.centre(to);
          const sign = Math.sign(nx ? c2.x - c1.x : c2.y - c1.y) || 1;
          const dir = [nx * sign, ny * sign];
          const at = door.point;
          // Diode / check-valve: a triangle pointing the allowed way, a bar across its tip.
          const tri = new THREE.Mesh(arrowGeometry([{ at, dir }], 0.9, 0.06), e.kind === 'reset' ? resetMat : glyphMat);
          const barPts = [[at[0] + dir[0] * 0.48 - dir[1] * 0.42, at[1] + dir[1] * 0.48 + dir[0] * 0.42],
            [at[0] + dir[0] * 0.48 + dir[1] * 0.42, at[1] + dir[1] * 0.48 - dir[0] * 0.42]];
          const bar = new THREE.Mesh(ribbonGeometry([barPts], 0.12, 0.061), e.kind === 'reset' ? resetMat : glyphMat);
          placesGroup.add(tri, bar);
        }
        from = to;
      }
    }

    for (const e of plan.shortcuts) {
      const pts = e.via.map((d) => plan.doors.get(d).point);
      if (e.kind === 'staff') {
        const p = pts[0];
        const [nx, ny] = wallNormal(plan.doors.get(e.via[0]));
        const across = [[p[0] - nx * 1.4, p[1] - ny * 1.4], [p[0] + nx * 1.4, p[1] + ny * 1.4]];
        placesGroup.add(polylineMesh(across, { color: 0xffb547, width: 0.12, h: 0.07, dashed: true }));
        placesGroup.add(tag('S1 staff ↔', [p[0] - 1.5, p[1]], 'shortcut', '#ffb547', 0.08));
      } else {
        const ext = [[pts[0][0], pts[0][1] - Math.sign(pts[1][1] - pts[0][1]) * 0.8], ...pts,
          [pts[1][0], pts[1][1] + Math.sign(pts[1][1] - pts[0][1]) * 0.8]];
        placesGroup.add(polylineMesh(ext, { color: 0xdbe3ee, width: 0.14, h: 0.07, arrows: 99 }));
        placesGroup.add(tag(e.label === 'S2' ? 'S2 express →' : 'S3 return →', [pts[0][0] + 1.9, (pts[0][1] + pts[1][1]) / 2], 'shortcut', INK, 0.08));
      }
    }
  }

  // -------------------------------------------------------------------------
  // Scene overlays: A → B paths (R20), Case II arcs and Case III petal (R21)
  // -------------------------------------------------------------------------
  const pathGroup = new THREE.Group();
  const case2Group = new THREE.Group();
  const case3Group = new THREE.Group();
  scene.add(pathGroup, case2Group, case3Group);

  function drawCase2() {
    disposeGroup(case2Group);
    if (!state.show.case2) return;
    const g1 = plan.centre(HALLS[0]), g2 = plan.centre(HALLS[1]);
    const back = measure(plan, 'seq', g2, g1, 'visitor', state.strict).value;
    const color = METRIC_COLORS.seq;
    // Tight inner arc g1 → g2 (radius 4, bulging north inside the two halls).
    const inner = Array.from({ length: 41 }, (_, i) => {
      const a = Math.PI - (i / 40) * Math.PI;
      return [12 + 4 * Math.cos(a), 4 + 3.2 * Math.sin(a)];
    });
    case2Group.add(polylineMesh(inner, { color, width: 0.2, h: 0.17, arrows: 99 }));
    case2Group.add(tag('d_seq(g1 → g2) = 1', [12, 9.5], 'case', color));
    // Massive outer loop g2 → … → Exit/Reset → g1, around the whole building.
    const loop = smooth([[g2.x, g2.y], [18, -1.6], [31, -3.1], [46.2, -2.4], [47.6, 9.5], [46.2, 21.3], [22, 22.6],
      [-2.2, 21.3], [-3.6, 9.5], [-2.2, -2.3], [5, -1.6], [g1.x, g1.y]], 220);
    const infinite = back === Infinity;
    case2Group.add(polylineMesh(loop, { color, width: 0.26, h: 0.17, dashed: infinite, opacity: infinite ? 0.6 : 0.95, arrows: 0 }));
    const tips = [60, 120, 180, 219].map((i) => ({ at: loop[i], dir: [loop[i][0] - loop[i - 1][0], loop[i][1] - loop[i - 1][1]] }));
    case2Group.add(new THREE.Mesh(arrowGeometry(tips, 1.1, 0.172), mat(color)));
    case2Group.add(tag(infinite ? 'd_seq(g2 → g1) = ∞  (strict valve: no reset)' : `d_seq(g2 → g1) = ${back}  (g2 → … → Exit/Reset → g1)`,
      [22, 22.6], 'case big', color));
    case2Group.add(tag('valve: g2 → g1 blocked', [12, 1.1], 'case', INK, 0.1));
  }

  function drawCase3() {
    disposeGroup(case3Group);
    if (!state.show.case3) return;
    const color = METRIC_COLORS.task;
    const petal = smooth(selfLoop.path, 260, false);
    case3Group.add(polylineMesh(petal, { color, width: 0.24, h: 0.19, arrows: 0 }));
    const tips = [50, 110, 170, 230].map((i) => ({ at: petal[i], dir: [petal[i][0] - petal[i - 1][0], petal[i][1] - petal[i - 1][1]] }));
    case3Group.add(new THREE.Mesh(arrowGeometry(tips, 1.0, 0.192), mat(color)));
    case3Group.add(tag(`d_L(x, x) = ${selfLoop.value.toFixed(1)} m > 0   (d_E(x, x) = 0)`, [9, -3.4], 'case big', color));
    case3Group.add(tag('x', [xLoc.x, xLoc.y + 0.8], 'case node', INK));
    const y = plan.centre(CHECKOUT);
    case3Group.add(tag('y', [y.x, y.y], 'case node', INK));
    selfLoop.nodes.forEach((name, i) => {
      const l = plan.exhibits.get(name);
      case3Group.add(tag(`${i + 1}. ${name.replace('Exhibit ', '')}`, [l.x, l.y + 1.1], 'case', color));
    });
  }

  // -------------------------------------------------------------------------
  // Pickers
  // -------------------------------------------------------------------------
  const placeOptions = [ENTRANCE, ...HALLS, 'Central Corridor', CHECKOUT, ...plan.exhibits.keys()];

  function locationOf(key) {
    if (key === '@point') return state.point;
    const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    if (kind === 'agent') return model.visitors.get(id)?.position ?? null;
    if (kind === 'place') return model.locate(id);
    return null;
  }

  function nameOf(key) {
    if (key === '@point') return state.point ? `(${state.point.x.toFixed(1)}, ${state.point.y.toFixed(1)})` : 'picked point';
    return key.slice(key.indexOf(':') + 1);
  }

  let agentIds = '';
  function fillPickers() {
    const ids = [...model.visitors.keys()];
    const key = ids.join(',') + '|' + (state.point ? `${state.point.x},${state.point.y}` : '');
    if (key === agentIds) return;
    agentIds = key;
    for (const which of ['a', 'b']) {
      const sel = q(`[data-met="${which}"]`);
      const opts = [`<optgroup label="Places">${placeOptions.map((p) => `<option value="place:${esc(p)}">${esc(p)}</option>`).join('')}</optgroup>`,
        `<optgroup label="Agents">${ids.map((id) => `<option value="agent:${esc(id)}">${esc(id)}${model.visitors.get(id).role === 'staff' ? ' (staff)' : ''}</option>`).join('')}</optgroup>`];
      if (state.point) opts.push(`<optgroup label="Map"><option value="@point">picked point ${esc(nameOf('@point'))}</option></optgroup>`);
      sel.innerHTML = opts.join('');
    }
    for (const which of ['a', 'b']) {
      const sel = q(`[data-met="${which}"]`);
      if (!locationOf(state[which])) state[which] = which === 'a' ? `agent:${ids[0] ?? ''}` : 'place:Gallery 1';
      sel.value = state[which];
    }
  }

  function setRoleFromA() {
    if (state.a.startsWith('agent:')) {
      const v = model.visitors.get(state.a.slice(6));
      if (v) state.role = v.role;
    }
  }

  panel.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('[data-met="a"]')) { state.a = t.value; setRoleFromA(); }
    if (t.matches('[data-met="b"]')) { state.b = t.value; }
    if (t.matches('[data-met="strict"]')) state.strict = t.checked;
    if (t.matches('[data-met-show]')) state.show[t.dataset.metShow] = t.checked;
    if (t.matches('[data-met-show="case2"], [data-met="strict"]')) drawCase2();
    if (t.matches('[data-met-show="case3"]')) drawCase3();
    render(0);
  });

  panel.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-met-action], [data-met-role]');
    if (!btn) return;
    if (btn.dataset.metAction === 'swap') [state.a, state.b] = [state.b, state.a];
    if (btn.dataset.metRole) state.role = btn.dataset.metRole;
    render(0);
  });

  // -------------------------------------------------------------------------
  // Charts (R18, R19)
  // -------------------------------------------------------------------------
  const fmt = (m, v) => (v === Infinity ? '∞' : m === 'seq' ? `${v}` : `${v.toFixed(1)}`);
  const unit = (m, v) => (m === 'seq' && v === 1 ? 'step' : METRIC_UNITS[m]);

  function barsSVG(rows) {
    const W = 316, H = 176, L = 30, T = 26, B = 34, plotH = H - T - B, gw = (W - L) / rows.length;
    const y = (n) => T + plotH * (1 - n);
    let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Normalised distance A to B and B to A for each metric">`;
    s += '<defs>' + rows.map((r) => `<pattern id="hatch-${r.m}" width="5" height="5" patternTransform="rotate(45)" patternUnits="userSpaceOnUse"><rect width="5" height="5" fill="${r.color}" fill-opacity="0.25"/><line x1="0" y1="0" x2="0" y2="5" stroke="${r.color}" stroke-width="2.2"/></pattern>`).join('') + '</defs>';
    for (const [n, lab] of [[0, '0'], [NEAR, `near ${NEAR}`], [FAR, `far ${FAR}`], [1, '1']]) {
      s += `<line x1="${L}" x2="${W}" y1="${y(n)}" y2="${y(n)}" stroke="${n === 0 ? '#3a4250' : '#2a313c'}" ${n === NEAR || n === FAR ? 'stroke-dasharray="3 3"' : ''}/>`;
      s += `<text x="${L - 4}" y="${y(n) + 3}" text-anchor="end" font-size="9" fill="${MUTED}">${lab.split(' ').pop()}</text>`;
    }
    rows.forEach((r, i) => {
      const cx = L + gw * i + gw / 2, bw = 26;
      for (const [k, dx, fill, stroke] of [['ab', -bw / 2 - 3, r.color, 'none'], ['ba', bw / 2 + 3, `url(#hatch-${r.m})`, r.color]]) {
        const d = r[k], n = Math.max(d.norm, 0.012);
        const x0 = cx + dx - bw / 2, top = y(n);
        s += `<g><title>${esc(r.label)} ${k === 'ab' ? 'A → B' : 'B → A'}: ${fmt(r.m, d.raw)} ${unit(r.m, d.raw)} (normalised ${d.norm.toFixed(2)})</title>`;
        s += `<rect x="${x0}" y="${top}" width="${bw}" height="${y(0) - top}" rx="3" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/></g>`;
        s += `<text x="${cx + dx}" y="${top - 4}" text-anchor="middle" font-size="10" fill="${INK}">${fmt(r.m, d.raw)}</text>`;
      }
      s += `<text x="${cx}" y="${H - B + 14}" text-anchor="middle" font-size="11" fill="${INK}" font-weight="600">${esc(r.label)}</text>`;
      s += `<text x="${cx}" y="${H - B + 26}" text-anchor="middle" font-size="9" fill="${MUTED}">${unit(r.m)}</text>`;
    });
    s += `<rect x="${L}" y="6" width="10" height="10" rx="2" fill="${INK}"/><text x="${L + 14}" y="15" font-size="10" fill="${INK}">A → B</text>`;
    s += `<pattern id="hatch-legend" width="5" height="5" patternTransform="rotate(45)" patternUnits="userSpaceOnUse"><line x1="0" y1="0" x2="0" y2="5" stroke="${INK}" stroke-width="2"/></pattern>`;
    s += `<rect x="${L + 64}" y="6" width="10" height="10" rx="2" fill="url(#hatch-legend)" stroke="${INK}"/><text x="${L + 78}" y="15" font-size="10" fill="${INK}">B → A</text>`;
    s += `<text x="${W}" y="15" text-anchor="end" font-size="9" fill="${MUTED}">dashed: near ${NEAR} · far ${FAR}</text>`;
    return s + '</svg>';
  }

  function scatterSVG(points) {
    const W = 316, H = 214, L = 34, R = 8, T = 10, B = 32, pw = W - L - R, ph = H - T - B;
    const X = (n) => L + pw * n, Y = (n) => T + ph * (1 - n);
    let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Each agent's normalised Euclidean distance to B against its d_seq and d_L distance">`;
    s += `<rect x="${X(0)}" y="${Y(1)}" width="${X(NEAR) - X(0)}" height="${Y(FAR) - Y(1)}" fill="${WARN_TINT}"/>`;
    s += `<rect x="${X(FAR)}" y="${Y(NEAR)}" width="${X(1) - X(FAR)}" height="${Y(0) - Y(NEAR)}" fill="${WARN_TINT}"/>`;
    for (const n of [0, 0.5, 1]) {
      s += `<line x1="${X(0)}" x2="${X(1)}" y1="${Y(n)}" y2="${Y(n)}" stroke="#2a313c"/><line x1="${X(n)}" x2="${X(n)}" y1="${Y(0)}" y2="${Y(1)}" stroke="#2a313c"/>`;
      s += `<text x="${X(0) - 4}" y="${Y(n) + 3}" text-anchor="end" font-size="9" fill="${MUTED}">${n}</text>`;
      s += `<text x="${X(n)}" y="${Y(0) + 12}" text-anchor="middle" font-size="9" fill="${MUTED}">${n}</text>`;
    }
    s += `<line x1="${X(0)}" y1="${Y(0)}" x2="${X(1)}" y2="${Y(1)}" stroke="#3a4250" stroke-dasharray="2 3"/>`;
    s += `<text x="${X(0.5)}" y="${H - 4}" text-anchor="middle" font-size="10" fill="${INK}">Euclidean → B (normalised)</text>`;
    s += `<text transform="translate(10 ${Y(0.5)}) rotate(-90)" text-anchor="middle" font-size="10" fill="${INK}">● d_seq   ■ d_L  (normalised)</text>`;
    const placed = [];   // label positions, nudged so names don't overlap
    for (const p of points) {
      const x = X(p.e), ys = Y(p.seq), yl = Y(p.task);
      s += `<line x1="${x}" y1="${ys}" x2="${x}" y2="${yl}" stroke="${MUTED}" stroke-opacity="0.5"/>`;
      s += `<g><title>${esc(p.id)}: Euclidean ${p.rawE.toFixed(1)} m (${p.e.toFixed(2)}), d_seq ${fmt('seq', p.rawSeq)} (${p.seq.toFixed(2)})</title><circle cx="${x}" cy="${ys}" r="4.5" fill="${METRIC_COLORS.seq}" stroke="${SURFACE}" stroke-width="1.5"/></g>`;
      s += `<g><title>${esc(p.id)}: Euclidean ${p.rawE.toFixed(1)} m (${p.e.toFixed(2)}), d_L ${p.rawTask.toFixed(1)} m (${p.task.toFixed(2)})</title><rect x="${x - 4}" y="${yl - 4}" width="8" height="8" fill="${METRIC_COLORS.task}" stroke="${SURFACE}" stroke-width="1.5"/></g>`;
      if (p.flag) {
        let ly = Math.min(ys, yl) + 3;
        while (placed.some(([px, py]) => Math.abs(px - x) < 40 && Math.abs(py - ly) < 11)) ly += 11;
        placed.push([x, ly]);
        s += `<text x="${x + 7}" y="${ly}" font-size="10" fill="${INK}">${esc(p.id)}</text>`;
      }
    }
    return s + '</svg>';
  }

  // -------------------------------------------------------------------------
  // Render (every UI tick)
  // -------------------------------------------------------------------------
  let lastPathKey = '';

  function drawPaths(a, b, ab) {
    const key = JSON.stringify([METRICS.map((m) => ab[m].path), state.show.euclidean, state.show.seq, state.show.task]);
    if (key === lastPathKey) return;
    lastPathKey = key;
    disposeGroup(pathGroup);
    for (const m of METRICS) {
      if (!state.show[m] || ab[m].value === Infinity || ab[m].path.length < 2) continue;
      const pts = offsetPolyline(ab[m].path, LATERAL[m]);
      pathGroup.add(polylineMesh(pts, { color: METRIC_COLORS[m], width: 0.2, h: HEIGHT[m], arrows: m === 'euclidean' ? 0 : 2.2, dashed: m === 'euclidean' }));
      const mid = pts[Math.floor(pts.length / 2)];
      const midPt = pts.length === 2 ? [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2] : mid;
      pathGroup.add(tag(`${METRIC_LABELS[m]} ${fmt(m, ab[m].value)} ${unit(m, ab[m].value)}`, midPt, 'path', METRIC_COLORS[m], 0.3));
    }
    const wa = a.toWorld(), wb = b.toWorld();
    pathGroup.add(tag('A', [wa.x, wa.y], 'end', INK, 0.4));
    pathGroup.add(tag('B', [wb.x, wb.y], 'end', INK, 0.4));
  }

  function discText(d, bName) {
    const v = (m, x) => `${fmt(m, x)} ${unit(m, x)}`;
    return `${d.userId}: near ${bName} by ${METRIC_LABELS[d.nearMetric]} (${v(d.nearMetric, d.nearValue)}) but far by ${METRIC_LABELS[d.farMetric]} (${v(d.farMetric, d.farValue)})`;
  }

  function render(dt) {
    fillPickers();
    // Keep the dropdowns showing the state, whichever way it changed (click, swap, reset).
    for (const which of ['a', 'b']) {
      const sel = q(`[data-met="${which}"]`);
      if (sel.value !== state[which]) sel.value = state[which];
    }
    const a = locationOf(state.a), b = locationOf(state.b);
    for (const btn of panel.querySelectorAll('[data-met-role]')) btn.classList.toggle('on', btn.dataset.metRole === state.role);
    if (!a || !b) return;
    const bName = nameOf(state.b);

    const ab = {}, ba = {};
    for (const m of METRICS) {
      ab[m] = measure(plan, m, a, b, state.role, state.strict);
      ba[m] = measure(plan, m, b, a, state.role, state.strict);
    }
    drawPaths(a, b, ab);

    const cell = (m, r) => `${fmt(m, r.value)} <span class="u">${unit(m, r.value)}</span>${r.approx ? ' <span class="u" title="A corridor point was snapped to the nearest hall">≈</span>' : ''}`;
    setHTML(out('m-table'), `<tr><th></th><th>A → B</th><th>B → A</th><th>norm.</th></tr>` + METRICS.map((m) =>
      `<tr><td><i class="sw" style="background:${METRIC_COLORS[m]}"></i>${METRIC_LABELS[m]}</td><td>${cell(m, ab[m])}</td><td>${cell(m, ba[m])}</td><td>${normalize(ab[m].value, ranges[m]).toFixed(2)}</td></tr>`).join(''));
    const notes = [];
    if (ab.seq.value !== ba.seq.value) notes.push(`d_seq is asymmetric here: ${fmt('seq', ab.seq.value)} ≠ ${fmt('seq', ba.seq.value)}`);
    if (a.distanceTo(b) <= EPSILON) notes.push(`A = B, yet d_L = ${ab.task.value.toFixed(1)} m > 0`);
    if (ab.seq.nodes.length > 1) notes.push(`d_seq route: ${ab.seq.nodes.map((n) => n.replace('Gallery ', 'g')).join(' → ')}`);
    if (ab.task.nodes.length) notes.push(`d_L order: ${ab.task.nodes.map((n) => n.replace('Exhibit ', '')).join(' → ')}`);
    setHTML(out('m-notes'), notes.map((n) => `<div>${esc(n)}</div>`).join(''));

    setHTML(out('m-bars'), barsSVG(METRICS.map((m) => ({
      m, label: METRIC_LABELS[m], color: METRIC_COLORS[m],
      ab: { raw: ab[m].value, norm: normalize(ab[m].value, ranges[m]) },
      ba: { raw: ba[m].value, norm: normalize(ba[m].value, ranges[m]) },
    }))));

    // Every agent → B, each in its own role (R13, R14, R19).
    const near = Object.fromEntries(METRICS.map((m) => [m, []]));
    const found = [];
    const pts = [];
    for (const v of model.visitors.values()) {
      const prof = {};
      for (const m of METRICS) {
        const raw = measure(plan, m, v.position, b, v.role, state.strict).value;
        prof[m] = [raw, normalize(raw, ranges[m])];
        if (prof[m][1] <= NEAR + EPSILON) near[m].push(v.userId);
      }
      let flag = false;
      for (const m1 of METRICS) for (const m2 of METRICS) {
        if (m1 !== m2 && prof[m1][1] <= NEAR + EPSILON && prof[m2][1] >= FAR - EPSILON) {
          found.push({ userId: v.userId, nearMetric: m1, farMetric: m2, nearValue: prof[m1][0], farValue: prof[m2][0] });
          flag = true;
        }
      }
      pts.push({ id: v.userId, e: prof.euclidean[1], seq: prof.seq[1], task: prof.task[1], rawE: prof.euclidean[0], rawSeq: prof.seq[0], rawTask: prof.task[0], flag });
    }
    setHTML(out('m-scatter'), scatterSVG(pts));
    const chips = (ids) => (ids.length ? ids.map((id) => `<span class="chip visitor" data-locate="${esc(id)}">${esc(id)}</span>`).join('') : '<span class="rel">nobody</span>');
    setHTML(out('m-occ'), METRICS.map((m) => `<div class="m-occ-row"><span><i class="sw" style="background:${METRIC_COLORS[m]}"></i>${METRIC_LABELS[m]}</span><span>${chips(near[m])}</span></div>`).join(''));
    setHTML(out('m-disc'), found.length
      ? found.map((d) => `<div class="m-disc-row">⚠ ${esc(discText(d, bName))}</div>`).join('')
      : '<span class="rel">none: every metric agrees on near and far for B</span>');

    trackDiscrepancies(found, bName, dt);
  }

  // R22: log a discrepancy once it has held for 0.5 s; changing B or the valve mode starts afresh.
  function trackDiscrepancies(found, bName, dt) {
    const key = `${state.b}|${state.strict}|${state.point?.x},${state.point?.y}`;
    const by = new Map();
    for (const d of found) {
      if (!by.has(d.userId)) by.set(d.userId, []);
      by.get(d.userId).push(d);
    }
    const fresh = key !== state.discKey;
    state.discKey = key;
    for (const uid of new Set([...model.visitors.keys(), ...state.disc.keys()])) {
      const list = by.get(uid) ?? [];
      const value = list.map((d) => `${d.nearMetric}>${d.farMetric}`).sort().join(',');
      let s = state.disc.get(uid);
      if (!s || fresh) { state.disc.set(uid, { current: value, pending: null, t: 0, list }); continue; }
      s.list = list;
      if (value === s.current) { s.pending = null; continue; }
      if (value !== s.pending) { s.pending = value; s.t = 0; continue; }
      s.t += dt;
      if (s.t >= 0.5) {
        const before = new Set(s.current.split(',').filter(Boolean));
        s.current = value; s.pending = null;
        for (const d of list) if (!before.has(`${d.nearMetric}>${d.farMetric}`)) log(esc(discText(d, bName)), 'disc');
      }
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------
  q('[data-out="m-axioms"]').innerHTML =
    `d_seq: ${axioms.seq_asymmetric_pairs} asymmetric node pairs, d(a,a) = 0 ${axioms.seq_self_zero ? '✓' : '✗'}, triangle ${axioms.seq_triangle ? '✓' : '✗'}.<br>` +
    `d_L: d(x,x) = ${selfLoop.value.toFixed(1)} m > 0 ${axioms.task_self_positive ? '✓' : '✗'}, symmetric ${axioms.task_symmetric ? '✓' : '✗'}, ` +
    `p(a,a) ≤ p(a,b) ${axioms.task_small_self_distance ? '✓' : '✗ (the pinned band breaks it)'}.`;
  for (const [k, v] of Object.entries(state.show)) {
    const box = q(`[data-met-show="${k}"]`);
    if (box) box.checked = v;
  }
  drawCase2();
  drawCase3();

  return {
    render,
    ranges,
    axioms,
    state,
    /** Metric overlays show only while the Metrics tab is in use. */
    setSceneVisible(v) {
      for (const g of [pathGroup, case2Group, case3Group]) {
        g.visible = v;
        // CSS2D labels follow their own visible flag, not their parent's.
        g.traverse((o) => { if (o.isCSS2DObject) o.visible = v; });
      }
    },
    setPoint(locn) { state.point = new Location(locn.x, locn.y); agentIds = ''; state.b = '@point'; render(0); },
    setA(userId) { state.a = `agent:${userId}`; setRoleFromA(); render(0); },
    reset() {
      Object.assign(state, { a: 'agent:bob', b: 'place:Gallery 1', point: null, role: 'visitor', strict: false });
      q('[data-met="strict"]').checked = false;
      state.disc.clear();
      agentIds = '';
      lastPathKey = '';
      drawCase2();
      render(0);
    },
  };
}
