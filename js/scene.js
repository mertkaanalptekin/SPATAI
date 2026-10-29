// The demo scene from demo.py, built with the JavaScript port of the model.
// tests/test_js_parity.py checks that both builds produce the same scene.

import {
  Circle, Location, Place, Rect, ReferenceFrame, SmartDisplay, SpatialZone, Visitor, World,
} from './spatial.js';

/**
 * A 20 m x 12 m lobby with four places, two displays and three visitors.
 *
 * Each display sits at the origin of its own frame, facing that frame's +x
 * axis, so a position in a display's frame reads as (metres ahead, metres left).
 */
export function buildScene() {
  const world = new World();
  world.addZone(new SpatialZone('lobby', new Rect(0, 0, 20, 12), { ambientLight: 320 }));

  const main = world.addPlace(new Place('Main Lobby', new Rect(0, 0, 20, 12)));
  world.addPlace(new Place('Entrance', new Rect(0, 4, 1.5, 8), main));
  world.addPlace(new Place('Reception Desk', new Circle(new Location(10, 3), 1.5), main));
  world.addPlace(new Place('Gallery Corner', new Rect(13, 7, 20, 12), main));

  const frames = {
    // On the west wall, facing east into the lobby.
    'welcome-screen': new ReferenceFrame('welcome-screen', { origin: [2, 6], rotation: 0 }),
    // On the north wall of the gallery corner, facing south.
    'gallery-screen': new ReferenceFrame('gallery-screen', { origin: [16, 11], rotation: -90 }),
  };
  for (const [displayId, frame] of Object.entries(frames)) {
    world.addDisplay(new SmartDisplay(displayId, new Location(0, 0, frame)), 'lobby');
  }

  world.addVisitor(new Visitor('alice', new Location(3.5, 6.5), { dwellTime: 12 }));
  world.addVisitor(new Visitor('bob', new Location(14, 8), { dwellTime: 40 }));
  world.addVisitor(new Visitor('carol', new Location(10.5, 3.5), { dwellTime: 95 }));
  return { world, frames };
}
