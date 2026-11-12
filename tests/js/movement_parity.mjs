// Classify the tracks in the parity spec (JSON on stdin) with js/movement.js and print the
// results as JSON. tests/test_js_parity.py runs the same tracks through spatai.movement.
import { classify } from '../../js/movement.js';

let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  const cases = JSON.parse(input);
  const out = cases.map(({ agent, entity, reach }) => {
    const r = classify(agent, entity, reach);
    return r && [r.preposition, r.direction, r.path, r.radial, r.sweep, r.turn, r.distance];
  });
  process.stdout.write(JSON.stringify(out));
});
