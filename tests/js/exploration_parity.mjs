// Replay the parity spec (JSON on stdin) with js/exploration.js and print the results as JSON.
// tests/test_js_parity.py runs the same spec through spatai.exploration.
import { buildFloorplan } from '../../js/exhibition.js';
import * as X from '../../js/exploration.js';

let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  const spec = JSON.parse(input);
  const plan = buildFloorplan();
  const out = { walls: {}, runs: [], interests: [], routes: [] };
  for (const role of ['visitor', 'staff']) {
    const w = X.buildWalls(plan, role);
    out.walls[role] = {
      nx: w.nx, ny: w.ny, blockE: [...w.blockE], blockN: [...w.blockN], room: w.room,
      doorEdges: Object.fromEntries([...w.doorEdges].map(([k, v]) => [k, v])),
    };
  }
  const walls = X.buildWalls(plan);
  const entities = new Map(Object.entries(spec.entities));
  const artworks = new Map(Object.entries(spec.artworks));
  for (const run of spec.runs) {
    const cmap = X.newMap(walls);
    const steps = [];
    for (const s of run) {
      const o = X.observe(walls, cmap, s.pos, s.gaze, entities);
      const rec = { obs: o, coverage: X.coverage(cmap) };
      if (s.query) {
        const blocked = X.keepout(walls, cmap, artworks);
        rec.keepout = [...blocked].reduce((a, b) => a + b, 0);
        rec.frontiers = X.frontiers(walls, cmap, blocked);
        rec.next = X.nextFrontier(walls, cmap, s.pos, s.heading, blocked);
        const goal = s.goal % (walls.nx * walls.ny);
        const seenCells = [];
        for (let k = 0; k < cmap.size; k++) if (cmap.seen[k] && !blocked[k]) seenCells.push(k);
        const g = seenCells.length ? seenCells[goal % seenCells.length] : 0;
        const p = X.pathCells(walls, cmap, s.pos, g, blocked);
        rec.path = p;
        rec.smooth = p ? X.smooth(walls, cmap, s.pos, p[0], blocked) : null;
        rec.view = Object.keys(spec.artworks).sort().map((a) => X.viewpoint(walls, cmap, blocked, spec.artworks[a], s.pos));
      }
      steps.push(rec);
    }
    out.runs.push({ steps, rooms: cmap.rooms, doors: cmap.doors, viewTime: Object.fromEntries(cmap.viewTime) });
  }
  for (const c of spec.interests) {
    out.interests.push(X.chooseInterests(new Map(Object.entries(c.view)), new Map(Object.entries(c.taste)), new Map(Object.entries(c.visits)), c.k));
  }
  for (const d of spec.routes) out.routes.push(X.orderRoute(d));
  process.stdout.write(JSON.stringify(out));
});
