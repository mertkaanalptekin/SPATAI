// Tests for ArtworkGuard, the staff-call state machine (docs/PROXIMITY_RULES.md P7-P9).
// Run: node --test tests/js/proximity.test.mjs
// (The pure rules are covered against Python by tests/test_js_parity.py.)

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildExhibition } from '../../js/exhibition.js';
import { ArtworkGuard, STEP_BACK_TO_M } from '../../js/proximity.js';
import { Location, Visitor } from '../../js/spatial.js';

function scene(agents) {
  const { world, plan } = buildExhibition();
  for (const id of [...world.visitors.keys()]) world.remove(id);
  for (const [id, x, y, role = 'visitor'] of agents) world.addVisitor(new Visitor(id, new Location(x, y), { role }));
  return { world, plan };
}

/** Run the guard, teleporting staff to their goals and visitors to their step-back points. */
function run(guard, world, plan, ticks = 6) {
  const log = [];
  for (let i = 0; i < ticks; i++) {
    const o = guard.update(plan, world);
    log.push(...o.events.map((e) => e.text));
    for (const [id, loc] of o.goTo) world.visitors.get(id).position = loc;
    for (const [id, loc] of o.stepBack) world.visitors.get(id).position = loc;
  }
  return log;
}

test('a breach dispatches the nearest staff, who makes the visitor step back', () => {
  const { world, plan } = scene([['carol', 24, 15.7], ['sam', 14.5, 6.5, 'staff'], ['kim', 28.5, 13, 'staff']]);
  const guard = new ArtworkGuard();
  const log = run(guard, world, plan);
  assert.deepEqual(log, [
    'carol is 0.8 m from Installation g8 → kim dispatched',
    'kim reached carol; carol steps back from Installation g8',
    'carol is 1.6 m from Installation g8 → kim returns to post',
  ]);
  const d = world.visitors.get('carol').position.distanceTo(plan.artworks.get('Installation g8'));
  assert.ok(Math.abs(d - STEP_BACK_TO_M) < 1e-9);
  assert.equal(guard.calls.size, 0);
});

test('release names the staff member once the call ends', () => {
  const { world, plan } = scene([['carol', 24, 15.7], ['kim', 28.5, 13, 'staff']]);
  const guard = new ArtworkGuard();
  const released = [];
  for (let i = 0; i < 6; i++) {
    const o = guard.update(plan, world);
    released.push(...o.release);
    for (const [id, loc] of o.goTo) world.visitors.get(id).position = loc;
    for (const [id, loc] of o.stepBack) world.visitors.get(id).position = loc;
  }
  assert.deepEqual(released, ['kim']);
});

test('a visitor who leaves on their own cancels the call', () => {
  const { world, plan } = scene([['carol', 24, 15.7], ['sam', 14.5, 6.5, 'staff']]);
  const guard = new ArtworkGuard();
  const first = guard.update(plan, world);
  assert.equal(first.events[0].text, 'carol is 0.8 m from Installation g8 → sam dispatched');
  assert.ok(first.goTo.has('sam'));
  world.visitors.get('carol').position = new Location(24, 14);
  const next = guard.update(plan, world);
  assert.deepEqual(next.events.map((e) => e.text), ['carol moved away from Installation g8 → sam stands down']);
  assert.deepEqual(next.release, ['sam']);
});

test('with one staff member and two breaches, the second waits', () => {
  const { world, plan } = scene([['ann', 24, 15.7], ['ben', 6, 4.8], ['sam', 14.5, 6.5, 'staff']]);
  const guard = new ArtworkGuard();
  const o = guard.update(plan, world);
  const texts = o.events.map((e) => e.text);
  assert.ok(texts.includes('ben is 0.7 m from Installation g1 → sam dispatched'));
  assert.ok(texts.includes('ann is 0.8 m from Installation g8 → no staff free, waiting'));
  const log = run(guard, world, plan, 10);
  assert.ok(log.includes('sam dispatched to ann at Installation g8'));
  assert.equal(guard.calls.size, 0);
});

test('staff on a call and visitors stepping back are exempt from personal space', () => {
  const { world, plan } = scene([['carol', 24, 15.7], ['kim', 28.5, 13, 'staff']]);
  const guard = new ArtworkGuard();
  guard.update(plan, world);
  assert.deepEqual([...guard.exempt()], ['kim']);
  world.visitors.get('kim').position = new Location(24, 14.4);
  guard.update(plan, world);
  assert.deepEqual([...guard.exempt()].sort(), ['carol', 'kim']);
});

test('staff are never in breach', () => {
  const { world, plan } = scene([['kim', 24, 16.4, 'staff']]);
  assert.deepEqual(new ArtworkGuard().update(plan, world).events, []);
});
