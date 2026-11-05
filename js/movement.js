// Prepositions of movement: toward, away from, around (docs/MOVEMENT_PREPOSITIONS.md).
//
// classify() ports spatai/movement.py (tests/test_js_parity.py checks they agree).
// MovementTracker samples agents, classifies every agent against the screens, artworks
// and other agents in reach, and emits the M6 start events. No three.js here.

export const REACH = { screen: 6.0, artwork: 5.0, agent: 4.0 };   // M1
export const SAMPLE_HZ = 4;                                         // M2
export const WINDOW_S = 3.0;
export const WINDOW_N = Math.round(WINDOW_S * SAMPLE_HZ) + 1;       // 13 samples
export const MIN_PATH = 0.3;                                        // M4
export const AROUND_SWEEP = (45 * Math.PI) / 180;
export const MIN_RADIAL = 0.3;
export const RADIAL_SHARE = 0.4;
export const MIN_STEP = 0.02;
export const MIN_DIST = 0.3;
export const PREPOSITIONS = ['around', 'toward', 'away'];           // M5 priority order
export const SETTLE_SAMPLES = 2;                                    // M6
export const QUIET_S = 6;

/** M9: colours (validated as a set on the dark surface) and glyphs. */
export const PREP_STYLE = {
  toward: { color: '#199e70', glyph: '→', verb: 'toward' },
  away: { color: '#d95926', glyph: '←', verb: 'away from' },
  around: { color: '#9085e9', glyph: '↻', verb: 'around' },
};

function measures(agent, entity) {
  const n = agent.length;
  let path = 0, radial = 0, sweep = 0, turn = 0, prev = null;
  for (let i = 0; i < n - 1; i++) {
    const ax = agent[i + 1][0] - agent[i][0], ay = agent[i + 1][1] - agent[i][1];
    const step = Math.sqrt(ax * ax + ay * ay);
    path += step;
    const rx = entity[i][0] - agent[i][0], ry = entity[i][1] - agent[i][1];
    const d = Math.sqrt(rx * rx + ry * ry);
    if (d > 1e-9) {
      radial += (ax * rx + ay * ry) / d;
      sweep += (-rx * ay + ry * ax) / d / Math.max(d, MIN_DIST);   // anticlockwise positive
    }
    if (step > MIN_STEP) {
      if (prev !== null) turn += Math.atan2(prev[0] * ay - prev[1] * ax, prev[0] * ax + prev[1] * ay);
      prev = [ax, ay];
    }
  }
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += Math.sqrt((entity[i][0] - agent[i][0]) ** 2 + (entity[i][1] - agent[i][1]) ** 2);
  }
  return { path, radial, sweep, turn, distance: sum / n };
}

/** M3-M4. `agent` and `entity` are [x, y] samples over the same window, oldest first. */
export function classify(agent, entity, reach) {
  if (agent.length < 3 || agent.length !== entity.length) return null;
  const m = measures(agent, entity);
  if (m.path < MIN_PATH || m.distance > reach) return null;
  if (Math.abs(m.sweep) >= AROUND_SWEEP && m.sweep * m.turn > 0 && Math.abs(m.turn) >= 0.5 * Math.abs(m.sweep)
      && Math.abs(m.radial) <= 0.5 * m.path) {
    return { preposition: 'around', direction: m.sweep > 0 ? 'anticlockwise' : 'clockwise', ...m };
  }
  if (m.radial >= RADIAL_SHARE * m.path && m.radial >= MIN_RADIAL) return { preposition: 'toward', direction: null, ...m };
  if (-m.radial >= RADIAL_SHARE * m.path && -m.radial >= MIN_RADIAL) return { preposition: 'away', direction: null, ...m };
  return null;
}

/** M5: around before toward before away, then nearest, then entity ID. */
export function primary(relations) {
  let best = null;
  for (const r of relations) {
    const k = [PREPOSITIONS.indexOf(r.preposition), r.distance, r.entity];
    if (!best || k[0] < best.k[0] || (k[0] === best.k[0] && (k[1] < best.k[1] || (k[1] === best.k[1] && k[2] < best.k[2])))) best = { r, k };
  }
  return best ? best.r : null;
}

export function describe(agentId, rel) {
  const s = PREP_STYLE[rel.preposition];
  return `${agentId} walks ${s.verb} ${rel.entity}${rel.direction ? ` (${rel.direction})` : ''}`;
}

/**
 * M2/M6. Call sample() SAMPLE_HZ times a second with every agent's position and the
 * fixed entities. It keeps each agent's last WINDOW_N positions, works out the current
 * relations (relationsOf) and returns the relations that have just started.
 */
export class MovementTracker {
  constructor() {
    this.tracks = new Map();     // agent → [[x, y], ...]
    this.current = new Map();    // agent → [{ entity, kind, preposition, direction, distance, ... }]
    this.state = new Map();      // `${agent}|${entity}` → { preposition, count }
    this.lastLogged = new Map(); // `${agent}|${entity}|${preposition}` → time
  }

  relationsOf(agentId) { return this.current.get(agentId) ?? []; }

  primaryOf(agentId) { return primary(this.relationsOf(agentId)); }

  reset() { this.tracks.clear(); this.current.clear(); this.state.clear(); this.lastLogged.clear(); }

  /** agents: [{ id, x, y }]; fixed: [{ id, kind: 'screen' | 'artwork', x, y }]. */
  sample(time, agents, fixed) {
    const ids = new Set(agents.map((a) => a.id));
    for (const id of [...this.tracks.keys()]) if (!ids.has(id)) { this.tracks.delete(id); this.current.delete(id); }
    for (const a of agents) {
      if (!this.tracks.has(a.id)) this.tracks.set(a.id, []);
      const t = this.tracks.get(a.id);
      t.push([a.x, a.y]);
      if (t.length > WINDOW_N) t.shift();
    }

    const events = [];
    const seen = new Set();
    for (const a of agents) {
      const track = this.tracks.get(a.id);
      const rels = [];
      if (track.length >= 3) {
        const consider = (entity, kind, etrack) => {
          const k = Math.min(track.length, etrack.length);
          const r = classify(track.slice(-k), etrack.slice(-k), REACH[kind]);
          if (r) rels.push({ entity, kind, ...r });
        };
        const here = track[track.length - 1];
        for (const f of fixed) {
          if (Math.hypot(f.x - here[0], f.y - here[1]) <= REACH[f.kind] + 3) {
            consider(f.id, f.kind, Array(track.length).fill([f.x, f.y]));
          }
        }
        for (const b of agents) {
          if (b.id === a.id || Math.hypot(b.x - here[0], b.y - here[1]) > REACH.agent + 3) continue;
          consider(b.id, 'agent', this.tracks.get(b.id));
        }
      }
      this.current.set(a.id, rels);
      for (const r of rels) {
        const key = `${a.id}|${r.entity}`;
        seen.add(key);
        let s = this.state.get(key);
        if (!s || s.preposition !== r.preposition) { s = { preposition: r.preposition, count: 0 }; this.state.set(key, s); }
        s.count++;
        if (s.count === SETTLE_SAMPLES) {
          const lk = `${key}|${r.preposition}`;
          if (time - (this.lastLogged.get(lk) ?? -Infinity) >= QUIET_S) {
            this.lastLogged.set(lk, time);
            events.push({ agent: a.id, ...r, text: describe(a.id, r) });
          }
        }
      }
    }
    for (const key of [...this.state.keys()]) if (!seen.has(key)) this.state.delete(key);
    return events;
  }
}
