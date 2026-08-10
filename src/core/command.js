/**
 * Input tick sequencing — one numbered command per fixed step.
 *
 * WHY THIS EXISTS
 *
 * Before this file, gameplay read the input device directly and latched it once
 * per *rendered frame*. A rendered frame contains 0..N fixed steps, so the two
 * rates disagreed in both directions and both directions lost information:
 *
 *   60 fps  -> 2 steps per frame. One press, two steps. `Movement.step` had to
 *              carry an `_edgeFrame` guard so the second step did not crouch a
 *              second time and thereby cancel the crouch.
 *   240 fps -> 3 frames in a row with no step at all. Those frames latched a
 *              command that nothing consumed, so a crouch pressed and released
 *              inside them never happened. Jump survived only because
 *              `latchInput` also poked `_jumpBuffer` on the side.
 *
 * Both symptoms are the same bug: the edge lived on the frame, and the frame is
 * not the thing that simulates. Here the edge lives on the TICK. Presses are
 * OR-accumulated as frames go by and consumed exactly once, by the next step.
 * The `_edgeFrame` guard and the jump-buffer poke are both deleted as a result.
 *
 * WHAT IT IS GROUNDWORK FOR
 *
 * This is netcode step 2. Step 1 (`05a452d`) put bots on a fixed tick. A server
 * does not receive "what key is down right now" — it receives a numbered command
 * per tick, and client-side prediction replays the local ones after a
 * correction. Both need commands to be *addressable*, which is why they are kept
 * in a ring keyed by sequence rather than overwritten in place.
 *
 * Step 3 was the AIM (`710c630`): `weapons.tryFire` read the composed camera,
 * which is written after every fixed step, so a shot could not be a function of
 * a tick no matter what the trigger did. `player` owns `aimOrigin`/`aimForward`
 * on the tick now.
 *
 * Step 4 is this file gaining `fire` and `reload`, and `weapons` gaining a
 * `fixedUpdate` that reads them. The bits were deliberately left out until
 * something read them — an unread bit is a claim that the work is done.
 *
 * What is still on the rendered frame, and should be: the viewmodel animation,
 * muzzle flash, brass, tracers, weapon selection, fire-mode cycling and inspect.
 * None of them decide where a round goes or when it leaves.
 */

/**
 * Button bits. Held state and press edges use the same layout, in two fields:
 * `held` is a level, `edge` is a one-tick pulse.
 */
export const BTN = Object.freeze({
  jump: 1 << 0,
  crouch: 1 << 1,
  fire: 1 << 2,
  reload: 1 << 3,
});

/**
 * Commands kept addressable by sequence. Must be a power of two — `seq` is
 * masked, not divided. At 120 Hz this is 1.07 s of history, which is longer than
 * any round-trip a browser game will tolerate before it gives up on the server.
 */
export const CMD_HISTORY = 128;

/** One tick's worth of intent. Pre-allocated; never constructed per frame. */
class Command {
  constructor() {
    this.seq = -1;
    this.dt = 0;
    /** Move axes, already clamped to the unit disc by `Input.moveVector`. */
    this.moveX = 0;
    this.moveY = 0;
    /** View angles at the moment this tick simulated, pushed in by gameplay. */
    this.yaw = 0;
    this.pitch = 0;
    /** BTN bitfields. */
    this.held = 0;
    this.edge = 0;
  }
}

export class CommandStream {
  constructor() {
    this._ring = new Array(CMD_HISTORY);
    for (let i = 0; i < CMD_HISTORY; i++) this._ring[i] = new Command();

    /** The command being simulated right now. Null before the first tick. */
    this.current = null;
    this.seq = -1;

    /**
     * The bit names, reachable from an instance.
     *
     * Anything that writes `override` has to name the bits, and the two callers
     * that do — a future server and the harnesses in `tools/` — reach this
     * object without being able to import from `src`. Duplicating `1 << 2` at
     * each of those sites is how a bit layout drifts.
     */
    this.BTN = BTN;

    /**
     * Replace the local device as the source of commands. Set to an object
     * shaped `{ moveX, moveY, held, edge }` and the sampled keyboard is ignored.
     * This is the seam a server plugs into, and the one the observation harness
     * already uses to walk the player around without synthesising key events.
     */
    this.override = null;

    this._axisX = 0;
    this._axisY = 0;
    this._held = 0;
    this._edge = 0;
    this._viewYaw = 0;
    this._viewPitch = 0;
    this._open = false;
    this._move = { x: 0, y: 0 };
    /**
     * Replay: while this is set, `build` hands back the command already in the
     * ring instead of sealing a new one. -1 when playing live.
     *
     * This is the consumer `get(seq)` was written for and did not have. The ring
     * has been keyed by `seq` since `2201a0e` for exactly one reason — so a tick
     * can be addressed after the fact — and until now nothing addressed one.
     */
    this._replayUntil = -1;
  }

  /** True while the stream is feeding recorded commands rather than the device. */
  get replaying() {
    return this._replayUntil >= 0;
  }

  /**
   * Feed recorded commands up to and including `untilSeq`.
   *
   * The pending device state is cleared rather than left alone: a held key or a
   * buffered edge surviving into a replay would be live input leaking into
   * history, and it would show up as a divergence in whatever the replay is
   * being compared against — blamed, almost certainly, on the last thing anyone
   * changed rather than on this.
   */
  beginReplay(untilSeq) {
    this._replayUntil = untilSeq;
    this._axisX = 0;
    this._axisY = 0;
    this._held = 0;
    this._edge = 0;
  }

  endReplay() {
    this._replayUntil = -1;
  }

  /**
   * Fold one rendered frame of device state into the pending command. Called
   * once per frame, immediately after `Input.beginFrame` — which is the only
   * place `pressed` is valid (hard rule 7), and the reason gameplay no longer
   * has to care about that rule at all.
   */
  sample(input) {
    if (!input || input.frozen || input.enabled === false) {
      this._axisX = 0;
      this._axisY = 0;
      this._held = 0;
      this._edge = 0;
      return;
    }

    const mv = input.moveVector(this._move);
    this._axisX = mv.x;
    this._axisY = mv.y;

    let held = 0;
    if (input.action('jump')) held |= BTN.jump;
    if (input.action('crouch')) held |= BTN.crouch;
    // `fire` is the mouse, not an action binding — see `Input.fire`.
    if (input.fire) held |= BTN.fire;
    if (input.action('reload')) held |= BTN.reload;
    this._held = held;

    // OR, not assign. A frame that produces no tick must hand its press to the
    // frame that does, or fast machines quietly eat inputs.
    if (input.actionPressed('jump')) this._edge |= BTN.jump;
    if (input.actionPressed('crouch')) this._edge |= BTN.crouch;
    // The one that made a semi-automatic worth doing this for: a click that
    // began and ended inside a frame with no tick used to be a round that never
    // left. `firePressed` is a frame-scoped edge, so it has to be caught here.
    if (input.firePressed) this._edge |= BTN.fire;
    if (input.actionPressed('reload')) this._edge |= BTN.reload;
  }

  /**
   * Seal the pending state into command `seq` and return it. Called once per
   * fixed step, before any subsystem's `fixedUpdate`.
   */
  build(seq, dt) {
    const c = this._ring[seq & (CMD_HISTORY - 1)];

    // Replay: return what was recorded, write nothing. If the ring has rolled
    // past this seq the honest answer is to fail loudly — a replay that quietly
    // simulated a stale command would produce a divergence at the far end and
    // no clue that the input, not the world, was what differed.
    if (this._replayUntil >= 0) {
      if (c.seq !== seq) {
        throw new Error(
          `replay wanted command ${seq} and the ring holds ${c.seq} — ` +
            `history is ${CMD_HISTORY} ticks and the rewind reached further back than that`
        );
      }
      this.seq = seq;
      this.current = c;
      this._open = true;
      return c;
    }

    const o = this.override;

    c.seq = seq;
    c.dt = dt;
    c.moveX = o ? o.moveX ?? 0 : this._axisX;
    c.moveY = o ? o.moveY ?? 0 : this._axisY;
    c.held = o ? o.held ?? 0 : this._held;
    c.edge = o ? o.edge ?? 0 : this._edge;
    c.yaw = this._viewYaw;
    c.pitch = this._viewPitch;

    // Edges are a pulse: whoever built this tick owns them, nobody else.
    this._edge = 0;
    if (o) o.edge = 0;

    this.seq = seq;
    this.current = c;
    this._open = true;
    return c;
  }

  /**
   * Close the tick. After this the command is history and cannot be edited —
   * which is the only property that makes a replay mean anything. Called by the
   * engine once every subsystem's `fixedUpdate` has run.
   */
  endTick() {
    this._open = false;
  }

  /**
   * Gameplay pushes the view angles it just integrated. Back-patches `current`
   * as well as the pending state, because the push happens *inside* the tick
   * (from `player.fixedUpdate`) and a command that recorded last tick's aim
   * would be a lie to any future server reading it.
   *
   * Only while the tick is open. Above ~120 fps a frame contains no tick at all
   * and look is integrated in `update()` instead; patching there would rewrite a
   * command that has already been simulated.
   *
   * Engine-layer rule 3 is why this is a push and not a `peek('player')`.
   */
  setView(yaw, pitch) {
    this._viewYaw = yaw;
    this._viewPitch = pitch;
    // Never during a replay. `player.fixedUpdate` pushes here every tick, and a
    // correct replay would push the same angles back — but "would" is the whole
    // problem: if the replay has diverged, this quietly rewrites the recorded
    // input to match the divergence, and the comparison at the far end then has
    // nothing left to notice. History has to be read-only for the replay to be
    // evidence of anything.
    if (this._replayUntil >= 0) return;
    const c = this.current;
    if (c && this._open) {
      c.yaw = yaw;
      c.pitch = pitch;
    }
  }

  /** The command for `seq`, or null once the ring has rolled past it. */
  get(seq) {
    const c = this._ring[seq & (CMD_HISTORY - 1)];
    return c.seq === seq ? c : null;
  }
}
