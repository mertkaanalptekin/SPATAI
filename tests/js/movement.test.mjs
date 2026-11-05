// Tests for MovementTracker (docs/MOVEMENT_PREPOSITIONS.md M2, M5, M6).
// Run: node --test tests/js/movement.test.mjs
// (classify() itself is covered against Python by tests/test_js_parity.py.)

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MovementTracker, SAMPLE_HZ, describe, primary } from '../../js/movement.js';

const DT = 1 / SAMPLE_HZ;

function run(tracker, seconds, agentsAt, fixed = []) {
  const events = [];
  for (let i = 0; i <= seconds * SAMPLE_HZ; i++) events.push(...tracker.sample(i * DT, agentsAt(i * DT), fixed));
  return events;
}

test('a walker toward a screen is logged once, after the settle', () => {
  const tr = new MovementTracker();
  const events = run(tr, 4, (t) => [{ id: 'bob', x: t, y: 0 }], [{ id: 'g2-screen', kind: 'screen', x: 6, y: 0 }]);
  assert.deepEqual(events.map((e) => e.text), ['bob walks toward g2-screen']);
  assert.equal(tr.primaryOf('bob').preposition, 'toward');
});

test('orbiting an artwork is "around", with its direction', () => {
  const tr = new MovementTracker();
  const events = run(tr, 4, (t) => [{ id: 'carol', x: 24 + 1.6 * Math.cos(0.6 * t), y: 16.5 + 1.6 * Math.sin(0.6 * t) }],
    [{ id: 'Installation g8', kind: 'artwork', x: 24, y: 16.5 }]);
  assert.ok(events.some((e) => e.text === 'carol walks around Installation g8 (anticlockwise)'));
});

test('agents are compared with each other by their own movement', () => {
  const tr = new MovementTracker();
  const events = run(tr, 3, (t) => [{ id: 'sam', x: 0, y: 0 }, { id: 'bob', x: 3.5 - t, y: 0 }]);
  assert.deepEqual(events.map((e) => e.text), ['bob walks toward sam']);
  assert.deepEqual(tr.relationsOf('sam'), []);
});

test('the same relation is not logged again within 6 s', () => {
  const tr = new MovementTracker();
  const scr = [{ id: 's', kind: 'screen', x: 0, y: 0 }];
  // toward for 2 s, stand still for 3 s (the relation lapses), toward again
  const x = (t) => (t < 2 ? 5 - t : t < 5 ? 3 : 3 - (t - 5) * 0.8);
  const events = run(tr, 7, (t) => [{ id: 'a', x: x(t), y: 0 }], scr);
  assert.deepEqual(events.map((e) => e.text), ['a walks toward s']);
  // a different relation is logged straight away
  const away = run(tr, 3, (t) => [{ id: 'a', x: 1.4 + t, y: 0 }], scr);
  assert.deepEqual(away.map((e) => e.text), ['a walks away from s']);
});

test('removed agents are forgotten', () => {
  const tr = new MovementTracker();
  run(tr, 2, (t) => [{ id: 'v', x: t, y: 0 }], [{ id: 's', kind: 'screen', x: 4, y: 0 }]);
  tr.sample(10, [], []);
  assert.equal(tr.tracks.size, 0);
  assert.deepEqual(tr.relationsOf('v'), []);
});

test('primary and describe', () => {
  const rels = [
    { entity: 'b', preposition: 'away', distance: 1 },
    { entity: 'a', preposition: 'toward', distance: 3 },
    { entity: 'c', preposition: 'toward', distance: 2 },
  ];
  assert.equal(primary(rels).entity, 'c');
  assert.equal(describe('x', { entity: 'y', preposition: 'away', direction: null }), 'x walks away from y');
});
