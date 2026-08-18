/**
 * WIRE — state serialization that survives the numbers JSON silently destroys.
 *
 * `JSON.stringify(Infinity)` is the string "null", and the first run of
 * `tools/netsim.mjs`'s handoff phase found out what that costs: a bot that has
 * never seen anyone carries `lastKnownAge: Infinity`, the sink restored it as
 * `null`, the next tick's `+= dt` turned null into 0.0166 — and every agent on
 * the receiving side believed it had spotted an enemy sixteen milliseconds
 * ago. Perception, aim and squad contact all diverged on the very first
 * post-handoff checkpoint.
 *
 * So: the three non-finite numbers ride as tagged strings. The tag opens with
 * U+0000, which cannot appear in game state (no string field stores control
 * characters), so a legitimate string can never collide with a token.
 *
 * This is the wire format for snapshots (server -> joining client,
 * server -> mispredicted client) and for the desync hash. It is NOT a general
 * serializer: state is plain objects, arrays and numbers by construction —
 * `captureState()` builds it that way, and replay.mjs's layer-2 audit fails
 * the run if a field exists that capture does not cover.
 */

const INF = '\u0000inf';
const NINF = '\u0000-inf';
const NAN = '\u0000nan';

/** JSON.stringify, but Infinity/-Infinity/NaN survive the trip. */
export function stringifyState(value) {
  return JSON.stringify(value, (_k, v) => {
    if (v === Infinity) return INF;
    if (v === -Infinity) return NINF;
    if (typeof v === 'number' && Number.isNaN(v)) return NAN;
    return v;
  });
}

/** The inverse of stringifyState. */
export function parseState(text) {
  return JSON.parse(text, (_k, v) => {
    if (v === INF) return Infinity;
    if (v === NINF) return -Infinity;
    if (v === NAN) return NaN;
    return v;
  });
}

/* ========================================================================== */
/* Command wire format                                                        */
/* ========================================================================== */

/**
 * One command on the wire: seq u32 · dt f64 · moveX/moveY/yaw/pitch f64 ·
 * held/edge u8. 46 bytes, little-endian.
 *
 * The floats stay Float64 ON PURPOSE. A predicting client re-simulates the
 * exact ticks the server will, and the whole determinism budget (dmath.js,
 * crossengine) is spent making that re-simulation bit-identical — quantising
 * the inputs to f32 on the wire would throw that away at the first byte.
 * Bandwidth is not the pressure: 46 bytes x 120 Hz is ~5.5 KB/s per player.
 */
export const COMMAND_WIRE_BYTES = 46;

/** Encode into `view` (a DataView over >= COMMAND_WIRE_BYTES) at `offset`. */
export function encodeCommand(cmd, view, offset = 0) {
  view.setUint32(offset, cmd.seq >>> 0, true);
  view.setFloat64(offset + 4, cmd.dt, true);
  view.setFloat64(offset + 12, cmd.moveX, true);
  view.setFloat64(offset + 20, cmd.moveY, true);
  view.setFloat64(offset + 28, cmd.yaw, true);
  view.setFloat64(offset + 36, cmd.pitch, true);
  view.setUint8(offset + 44, cmd.held & 0xff);
  view.setUint8(offset + 45, cmd.edge & 0xff);
  return COMMAND_WIRE_BYTES;
}

/** Decode from `view` at `offset` into `out` (reused, never allocated here). */
export function decodeCommand(view, out, offset = 0) {
  out.seq = view.getUint32(offset, true);
  out.dt = view.getFloat64(offset + 4, true);
  out.moveX = view.getFloat64(offset + 12, true);
  out.moveY = view.getFloat64(offset + 20, true);
  out.yaw = view.getFloat64(offset + 28, true);
  out.pitch = view.getFloat64(offset + 36, true);
  out.held = view.getUint8(offset + 44);
  out.edge = view.getUint8(offset + 45);
  return out;
}
