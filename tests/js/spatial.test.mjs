// Tests for the JavaScript-only parts of js/spatial.js. Run: node --test tests/js/spatial.test.mjs
// (Everything shared with Python is covered by tests/test_js_parity.py.)

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildScene } from '../../js/scene.js';
import { Location, Visitor, findId, resolveDescription } from '../../js/spatial.js';

const placeFor = (text) => {
  const { world } = buildScene();
  return resolveDescription(world, text)?.place?.name ?? null;
};

test('near a display resolves to the place containing it', () => {
  assert.equal(placeFor('near gallery-screen'), 'Gallery Corner');
  assert.equal(placeFor('near welcome-screen'), 'Main Lobby');
  assert.equal(placeFor('next to the gallery screen'), 'Gallery Corner');
});

test('relative phrases step 1.5 m from the display along its facing', () => {
  const { world } = buildScene();
  const front = resolveDescription(world, 'in front of gallery-screen');
  assert.equal(front.place.name, 'Gallery Corner');
  assert.ok(Math.abs(front.location.x - 16) < 1e-9 && Math.abs(front.location.y - 9.5) < 1e-9);
  assert.equal(placeFor('behind welcome-screen'), 'Entrance');
  assert.equal(placeFor('behind gallery-screen'), null); // beyond the north wall
  assert.equal(placeFor('left of gallery-screen'), 'Gallery Corner');
  assert.equal(placeFor('to the right of welcome-screen'), 'Main Lobby');
});

test('place names, prefixes and visitors resolve', () => {
  assert.equal(placeFor('Reception Desk'), 'Reception Desk');
  assert.equal(placeFor('reception'), 'Reception Desk');
  assert.equal(placeFor('where is bob'), 'Gallery Corner');
  assert.equal(placeFor('carol'), 'Reception Desk');
  assert.equal(placeFor('lobby'), 'Main Lobby'); // the zone's centre
});

test('unknown or empty text resolves to nothing', () => {
  assert.equal(resolveDescription(buildScene().world, 'near the fountain'), null);
  assert.equal(resolveDescription(buildScene().world, '   '), null);
  assert.equal(findId(buildScene().world, ''), null);
});

test('remove unregisters visitors and displays', () => {
  const { world } = buildScene();
  world.addVisitor(new Visitor('dave', new Location(1, 1)));
  world.remove('dave');
  assert.equal(world.visitors.has('dave'), false);
  world.remove('gallery-screen');
  assert.deepEqual([...world.zones.get('lobby').displayIds], ['welcome-screen']);
  assert.throws(() => world.remove('Main Lobby'), /child places/);
  assert.throws(() => world.remove('nobody'), /Unknown ID/);
});
