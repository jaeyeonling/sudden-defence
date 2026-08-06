/**
 * Gate for `src/core/command.js` — input tick sequencing.
 *
 * This is the only harness in the suite that needs no browser. `command.js`
 * imports nothing (not even `three`), which is deliberate: the thing that
 * decides what the simulation consumes should be checkable without a GPU, in
 * under a second, on every commit.
 *
 * It exists because the end-to-end harnesses structurally cannot see the bug
 * this file was written to kill. `playtest.mjs` presses a key for 300 ms and
 * checks the player moved; a press dropped inside three 240 fps frames, or one
 * counted twice across two 60 fps substeps, is invisible at that resolution.
 * The failure is a mismatch between the frame rate and the tick rate, so the
 * test has to be able to *set* both, which only a fake device allows.
 *
 * Every case below is a real defect that existed before the stream:
 *   - tap inside one frame at 240 fps  -> crouch never happened
 *   - one press across two substeps    -> crouch toggled twice, i.e. never
 *   - fast tap (down+up same frame)    -> jump silently lost
 */

import { CommandStream, BTN, CMD_HISTORY } from '../src/core/command.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

/** Stand-in for `core/input.js`, with the two edge sets driven by hand. */
class FakeInput {
  constructor() {
    this.frozen = false;
    this.enabled = true;
    this.held = new Set();
    this.pressed = new Set();
    this.move = { x: 0, y: 0 };
  }
  /** Press for exactly one frame, the way `beginFrame` would report it. */
  tap(name) {
    this.held.add(name);
    this.pressed.add(name);
  }
  /** A press so fast it goes down AND up inside a single frame. */
  flick(name) {
    this.pressed.add(name);
  }
  release(name) {
    this.held.delete(name);
  }
  frame() {
    this.pressed.clear();
  }
  action(n) {
    return this.held.has(n);
  }
  actionPressed(n) {
    return this.pressed.has(n);
  }
  moveVector(out) {
    out.x = this.move.x;
    out.y = this.move.y;
    return out;
  }
}

/** Run one tick: build, let gameplay push its view, close. */
const tick = (s, seq, yaw = 0, pitch = 0) => {
  const c = s.build(seq, 1 / 120);
  s.setView(yaw, pitch);
  s.endTick();
  return c;
};

/* ------------------------------------------------------- 240 fps: no loss */
{
  const s = new CommandStream();
  const i = new FakeInput();

  // Three frames with no tick between them — what a 240 fps machine does.
  i.tap('crouch');
  s.sample(i);
  i.frame();
  i.release('crouch'); // pressed and released before any step ran
  s.sample(i);
  i.frame();
  s.sample(i);
  i.frame();

  const c = tick(s, 0);
  check('240 fps: a press between ticks survives to the next tick', (c.edge & BTN.crouch) !== 0);
  check('240 fps: the key is correctly reported as no longer held', (c.held & BTN.crouch) === 0);
}

/* ------------------------------------------------- 60 fps: no double count */
{
  const s = new CommandStream();
  const i = new FakeInput();

  i.tap('crouch');
  s.sample(i); // one frame...
  const a = tick(s, 0); // ...two substeps
  const b = tick(s, 1);

  check('60 fps: the first substep gets the press', (a.edge & BTN.crouch) !== 0);
  check('60 fps: the second substep does NOT', (b.edge & BTN.crouch) === 0);
  check('60 fps: held is a level, so it persists across both', (b.held & BTN.crouch) !== 0);
}

/* --------------------------------------------------------- the fast flick */
{
  const s = new CommandStream();
  const i = new FakeInput();

  // Down and up inside one frame: `held` is already false by the time anything
  // looks. The old latch computed `jump && !prevJump` and saw `false && …`.
  i.flick('jump');
  s.sample(i);
  const c = tick(s, 0);

  check('a down+up inside one frame still produces a jump', (c.edge & BTN.jump) !== 0);
}

/* ------------------------------------------------------ sequence + history */
{
  const s = new CommandStream();
  const i = new FakeInput();

  const total = CMD_HISTORY + 40;
  for (let n = 0; n < total; n++) {
    s.sample(i);
    tick(s, n, n * 0.01, 0);
  }

  const last = total - 1;
  check('seq is the tick number', s.current.seq === last, `got ${s.current.seq}`);
  check('the newest command is addressable', s.get(last)?.seq === last);
  check(
    'the oldest still-held command is addressable',
    s.get(last - CMD_HISTORY + 1)?.seq === last - CMD_HISTORY + 1
  );
  check('a command older than the ring returns null, not a stale hit', s.get(0) === null);
  check('history kept the view angle it was issued under', s.get(last).yaw === last * 0.01);
}

/* ----------------------------------------------------- history is immutable */
{
  const s = new CommandStream();
  const i = new FakeInput();

  s.sample(i);
  const c = tick(s, 0, 1.234, 0);
  // A frame with no tick integrates look in update(). That must not rewrite a
  // command the simulation has already consumed.
  s.setView(9.9, 9.9);

  check('setView after endTick does not rewrite history', c.yaw === 1.234, `got ${c.yaw}`);

  s.sample(i);
  const next = s.build(1, 1 / 120);
  check('but the pending state did advance', next.yaw === 9.9, `got ${next.yaw}`);
  s.endTick();
}

/* ------------------------------------------------------------- the override */
{
  const s = new CommandStream();
  const i = new FakeInput();

  i.move.y = 1;
  i.tap('jump');
  s.sample(i);

  s.override = { moveX: 0, moveY: -1, held: BTN.crouch, edge: BTN.crouch };
  const c = tick(s, 0);

  check('override replaces the device entirely', c.moveY === -1 && c.held === BTN.crouch);
  check('the local keyboard is ignored while it is set', (c.edge & BTN.jump) === 0);
  check('override edges are a pulse too', s.override.edge === 0);

  s.override = null;
  s.sample(i);
  i.frame();
  const back = tick(s, 1);
  check('clearing it hands control back to the device', back.moveY === 1);
}

/* ------------------------------------------------------------- frozen input */
{
  const s = new CommandStream();
  const i = new FakeInput();

  i.move.y = 1;
  i.tap('jump');
  i.frozen = true; // what `?capture=1` does
  s.sample(i);
  const c = tick(s, 0);

  check('a frozen device yields a neutral command', c.moveY === 0 && c.held === 0 && c.edge === 0);
}

/* ------------------------------------------------------ no per-frame garbage */
{
  const s = new CommandStream();
  const i = new FakeInput();

  // Hard rule 6. Commands come out of a ring, so a thousand ticks must hand back
  // the same objects — not a thousand new ones.
  const seen = new Set();
  for (let n = 0; n < 1000; n++) {
    s.sample(i);
    seen.add(tick(s, n));
  }
  check(`the ring reuses its ${CMD_HISTORY} objects`, seen.size === CMD_HISTORY, `got ${seen.size}`);
}

console.log(failures === 0 ? '\nCMDSTREAM PASS' : `\nCMDSTREAM FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
