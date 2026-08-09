/**
 * ===========================================================================
 * HUD / UI subsystem
 * ===========================================================================
 *
 * A DOM+CSS overlay (see style.js for the design system) driven entirely from
 * `lateUpdate`, after the camera has reached its final transform for the frame.
 *
 * NOTHING ANIMATES ON A CSS KEYFRAME OR TRANSITION. Every value is integrated
 * from `dt` here. That is what makes the capture harness deterministic — a CSS
 * transition runs on wall-clock time, so a pumped frame would find it in a
 * different place depending on how fast the machine was — and it is also what
 * makes the whole HUD stop correctly when the game is paused.
 *
 * ---------------------------------------------------------------------------
 * WHAT CHANGED FROM THE SHOOTER THIS CAME FROM
 * ---------------------------------------------------------------------------
 * Removed: `minimap.js` (603 lines) and `Compass`. A 48x36 m symmetric depot
 * with three lanes is a map you learn in two rounds; a minimap of it is a
 * second screen showing you what the first screen already does, and a compass
 * strip is a heading readout for a level with no navigation problem. Both cost
 * frame time and, more expensively, attention.
 *
 * Removed: `demo.js`, the scripted firefight timeline. It existed to give
 * screenshots a HUD with numbers in it back when nothing drove the HUD. Now
 * `match` does, and a debug timeline that overwrites live match state with
 * invented scores is a way to photograph a game that is not happening.
 *
 * Added: `matchbar.js` (the upstream shell, finally wired), `scoreboard.js`,
 * `spectate.js`.
 *
 * ---------------------------------------------------------------------------
 * PUBLIC API — `const ui = ctx.get('ui')`
 * ---------------------------------------------------------------------------
 *   ui.hitmarker(kind)                  'hit' | 'head' | 'kill'
 *   ui.damageNumber(worldPos, n, kind)  'hit' | 'hs' | 'kill'
 *   ui.hurt(amount, dirX, dirZ)         directional arc + flash + flinch
 *   ui.killfeed.push({attacker,victim,headshot,mine,attackerFriendly})
 *   ui.banner.show(title, sub, life)
 *   ui.setPrompt({key,text,sub,progress}) / ui.clearPrompt()
 *   ui.setHudVisible(bool)
 *   ui.pause() / ui.resume() / ui.menu.toggle()
 *   ui.debugState('clean')
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SUBSYSTEM READS (all optional, all duck-typed)
 * ---------------------------------------------------------------------------
 *   weapons.getHudState() -> { name, mode, ammo, reserve, magSize, reloading,
 *                              reloadProgress, spread }
 *   player.getHudState()  -> { health, maxHealth, move, crouch, airborne,
 *                              position, dead }
 *   player.spectateTarget -> Combatant | null
 *   match                 -> phase, scores, round, combatants, TEAMS
 *   audio.playUi(id, gain)
 *
 * `match` is a hard dependency, not a peek. Everything at the top of the screen
 * comes from it, and a HUD that silently renders 0-0 forever because a `peek`
 * came back null is worse than one that fails to boot.
 *
 * Events consumed: weapon:fire, weapon:reload, damage:dealt, damage:taken,
 * combatant:death, round:start, round:end, match:end, explosion, player:state.
 * Events emitted:  ui:pause, ui:quality, ui:sensitivity, ui:fov, ui:setting.
 */

import * as THREE from 'three';
import { installStyles, removeStyles } from './style.js';
import { el, clamp, clamp01, damp, setStyle, setText } from './util.js';
import { Crosshair } from './crosshair.js';
import { Hitmarkers } from './hitmarkers.js';
import { DamageArcs } from './damage.js';
import { HealthFx } from './health.js';
import { AmmoPanel } from './ammo.js';
import { Killfeed } from './killfeed.js';
import { MatchBar } from './matchbar.js';
import { Scoreboard } from './scoreboard.js';
import { SpectateOverlay } from './spectate.js';
import { WorldMarkers } from './markers.js';
import { Prompt, Banner } from './prompts.js';
import { PauseMenu } from './menu.js';

/** Phase -> what the round-end banner says when a side takes the round. */
const RESULT = {
  elimination: 'ELIMINATED',
  time: 'TIME',
  draw: 'DRAW',
};

export class UiSystem {
  static id = 'ui';
  static deps = ['render', 'match'];

  async init(ctx) {
    this.ctx = ctx;
    this.rng = ctx.rng.fork({ snapshot: false });
    this.match = ctx.get('match');
    installStyles();

    const host = document.getElementById('ui') ?? document.body;
    this.root = el('div', 'ow-hud', host);

    // Stacking order: hurt overlays under the HUD, the menu over everything.
    this.hurtLayer = el('div', 'ow-layer', this.root);
    this.worldLayer = el('div', 'ow-layer', this.root);
    this.centreLayer = el('div', 'ow-layer', this.root);
    this.chromeLayer = el('div', 'ow-layer', this.root);

    this.health = new HealthFx(this.hurtLayer, this.chromeLayer);
    this.markers = new WorldMarkers(this.worldLayer, this.rng.fork({ snapshot: false }));
    this.arcs = new DamageArcs(this.centreLayer);
    this.crosshair = new Crosshair(this.centreLayer);
    this.hit = new Hitmarkers(this.centreLayer);
    this.matchBar = new MatchBar(this.chromeLayer);
    this.killfeed = new Killfeed(this.chromeLayer);
    this.ammo = new AmmoPanel(this.chromeLayer);
    this.spectate = new SpectateOverlay(this.chromeLayer);
    this.prompt = new Prompt(this.chromeLayer);
    this.banner = new Banner(this.chromeLayer);
    /**
     * The freeze countdown: one big number, dead centre, last three seconds.
     *
     * On the CENTRE layer rather than with the banner, because it has to sit
     * where the crosshair is — a player waiting for a round to start is looking
     * at the door they are about to go through, not at the chrome.
     */
    this.countdown = el('div', 'ow-countdown', this.centreLayer, '');
    setStyle(this.countdown, 'display', 'none');
    /** Last whole second announced, so each tick fires exactly once. */
    this._countdownAt = -1;
    this._lastPhase = null;
    this.scoreboard = new Scoreboard(this.root);
    this.menu = new PauseMenu(this.root, ctx);

    this.health.onBeat = (i) => this.sfx('heartbeat', 0.35 + i * 0.5);

    /** Single source of truth for everything the HUD draws. */
    this.state = {
      health: 100,
      maxHealth: 100,
      ammo: 30,
      reserve: 210,
      magSize: 30,
      reloading: false,
      reloadProgress: 0,
      weaponName: 'M4A1',
      fireMode: 'AUTO',
      move: 0,
      crouch: false,
      airborne: false,
      baseSpread: 5.5,
      dead: false,
      // round block, filled from `match` every frame
      scoreUs: 0,
      scoreThem: 0,
      timeLeft: 0,
      phase: 'idle',
      round: 0,
      roundsToWin: 5,
      roundResult: '',
      time: 0,
    };

    this.k = 1;
    this.vw = 1920;
    this.vh = 1080;
    this.hudVisible = 1;
    this.hudTarget = 1;
    this._lastRaw = ctx.time.raw;
    this._hadPointerLock = false;

    this._pos = new THREE.Vector3();
    this._prevPos = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._objectives = [];

    this._unsubs = [];
    const on = (type, fn) => this._unsubs.push(ctx.events.on(type, fn));

    on('weapon:fire', (e) => {
      // Bots fire this event too — `ai` emits it for every muzzle flash in the
      // level. Only the player's rifle should kick the player's reticle.
      if (e?.weapon === 'ai_rifle') return;
      this.crosshair.onFire(e?.recoil ?? 1);
    });

    on('weapon:reload', (e) => {
      const s = this.state;
      if (e?.weapon === 'ai_rifle') return;
      if (e?.phase === 'start') {
        s.reloading = true;
        s.reloadProgress = 0;
      } else if (e?.phase === 'end') {
        s.reloading = false;
      }
    });

    // ---- hitmarkers -------------------------------------------------------
    //
    // Gated on `source`, not on `target`. Upstream this asked "is the target
    // NOT the player", which was a correct test in a game with one shooter and
    // is a bug in one with sixteen: every round a bot lands on another bot
    // would draw the player a hitmarker and a damage number for a fight
    // happening across the map.
    on('damage:dealt', (e) => {
      if (!e || !this._isPlayer(e.source)) return;
      const kind = e.killed ? 'kill' : e.headshot ? 'head' : 'hit';
      this.hitmarker(kind);
      if (e.point) {
        // `e.target` is the accumulation key, not a thing `ui` reads: numbers
        // for one victim count up in place instead of stacking illegibly.
        this.damageNumber(
          e.point,
          e.amount ?? 0,
          e.killed ? 'kill' : e.headshot ? 'hs' : 'hit',
          e.target
        );
      }
    });

    on('damage:taken', (e) => {
      const amount = e?.amount ?? 10;
      if (e?.health !== undefined) this.state.health = e.health;
      let dx = 0;
      let dz = 1;
      if (e?.from) {
        this._tmp.copy(e.from).sub(this._playerPos());
        dx = this._tmp.x;
        dz = this._tmp.z;
      }
      this.hurt(amount, dx, dz);
    });

    // ---- killfeed ---------------------------------------------------------
    //
    // One row per death, emitted by `match` — which is the only thing that
    // knows both ends of a kill. The upstream HUD built its feed from two
    // different events (`damage:dealt` for the player's kills, `actor:death`
    // for everyone else's) and de-duplicated them with a 0.3 s window, which is
    // a race dressed as a heuristic.
    on('combatant:death', (e) => {
      const victim = e?.combatant;
      if (!victim) return;
      const killer = e.source ?? null;
      const mine = !!killer?.isPlayer;
      this.killfeed.push({
        attacker: killer?.name ?? 'WORLD',
        victim: victim.name,
        headshot: !!e.headshot,
        mine,
        attackerFriendly: killer ? killer.team === this._myTeam() : false,
      });
      if (mine) {
        this.banner.show('Enemy Eliminated', e.headshot ? 'HEADSHOT' : '');
      }
    });

    on('round:end', (e) => {
      const won = e?.winner && e.winner === this._myTeam();
      const label = e?.winner ? `${this.match.TEAMS[e.winner]?.name ?? e.winner} WINS` : 'DRAW';
      this.state.roundResult = e?.winner ? label : RESULT.draw;
      this.banner.show(label, RESULT[e?.reason] ?? '', 3.4);
      if (won) this.sfx('round_win', 0.8);
    });

    /**
     * THE BOUNDARY BETWEEN PHASES, made into a moment.
     *
     * `round:phase` has been emitted since the round machine was written and
     * nothing subscribed to it. The only announcement a phase change made was
     * `MatchBar` swapping a small label at the top of the screen — so the
     * transition a player most needs to feel, freeze becoming live, arrived
     * with no sound, no flash and nothing in the middle of the screen.
     *
     * Three cues, in rising order of how much they interrupt:
     *
     *   banner     every transition gets a title, so the change is named
     *   countdown  the last 3 s of freeze get a big centred number and a tick
     *              that climbs — the boundary is visible BEFORE it arrives,
     *              which is what makes it possible to be ready for it
     *   bell       live gets its own sound and a crosshair kick, so the moment
     *              itself lands even if the player is looking at a doorway
     *
     * The countdown is the load-bearing one. A banner at the instant of the
     * change tells you it has already happened.
     */
    on('round:phase', (e) => {
      const p = e?.phase;
      if (p === this._lastPhase) return;
      this._lastPhase = p;
      this._countdownAt = -1;
      switch (p) {
        case 'warmup':
          this.banner.show('Warm Up', 'Match starting', 2.4);
          break;
        case 'freeze':
          // Round N is announced HERE rather than at `live`: by the time the
          // bell goes the player should be aiming, not reading.
          this.banner.show(`Round ${e?.round ?? 1}`, 'Get Ready', 1.8);
          this.sfx('round_freeze', 0.7);
          break;
        case 'live':
          this.banner.show('Fight', '', 1.1);
          this.sfx('round_go', 0.95);
          // A kick on the crosshair, because that is where the eyes already are.
          this.crosshair.onFlinch?.(0.5);
          break;
        default:
          // `roundEnd` and `matchEnd` already have banners of their own, from
          // `round:end` and `match:end`, which carry the result. A second one
          // here would talk over them.
          break;
      }
    });

    on('round:start', () => {
      this.state.roundResult = '';
      this.killfeed.clear();
      this.arcs.clear();
      this.hit.clear();
      this.markers.clear();
    });

    on('match:end', (e) => {
      const label = e?.winner ? `${this.match.TEAMS[e.winner]?.name ?? e.winner} TAKES THE MATCH` : 'DRAWN MATCH';
      this.banner.show(label, `${e?.scores?.alpha ?? 0} — ${e?.scores?.bravo ?? 0}`, 6);
    });

    on('explosion', (e) => {
      if (!e?.position) return;
      this._tmp.copy(e.position).sub(this._playerPos());
      const d = this._tmp.length();
      if (d < (e.radius ?? 6) * 2.5) this.crosshair.onFlinch(0.6);
    });

    on('player:state', (e) => {
      if (!e) return;
      if (e.stance !== undefined) this.state.crouch = e.stance === 'crouch';
    });

    this.resize(ctx.canvas.clientWidth || innerWidth, ctx.canvas.clientHeight || innerHeight, ctx);
    this._prevPos.copy(this._playerPos());
  }

  /* ------------------------------------------------------------- helpers -- */

  _weaponState() {
    const w = this.ctx.peek('weapons');
    if (!w) return null;
    const s = typeof w.getHudState === 'function' ? w.getHudState() : w.hudState ?? null;
    return s && typeof s === 'object' ? s : null;
  }

  _playerState() {
    const p = this.ctx.peek('player');
    if (!p) return null;
    const s = typeof p.getHudState === 'function' ? p.getHudState() : p.hudState ?? null;
    return s && typeof s === 'object' ? s : null;
  }

  /** True when `c` is the local player, given either a Combatant or a host. */
  _isPlayer(c) {
    if (!c) return false;
    return c.isPlayer === true || c === this.ctx.peek('player');
  }

  _myTeam() {
    return this.ctx.peek('player')?.team ?? this.match.TEAM_IDS[0];
  }

  _playerPos() {
    const p = this.ctx.peek('player');
    const pos = p?.position;
    if (pos && pos.isVector3) return this._pos.copy(pos);
    return this._pos.copy(this.ctx.camera.position);
  }

  /** Fire-and-forget audio; the audio subsystem may not exist yet. */
  /**
   * The last three seconds of freeze, counted out loud and in the middle of the
   * screen.
   *
   * This is the part that actually answers "the boundaries are hard to feel".
   * A cue AT the transition tells a player it has already happened; a countdown
   * lets them be ready for it, which is the whole reason a freeze phase exists.
   *
   * Driven off `state.timeLeft` rather than off a timer of its own, so it cannot
   * drift from the round machine — and gated on the whole second changing, so
   * the tick fires once per number however many frames that number spans.
   *
   * @param {object} s  the HUD state; `phase` and `timeLeft` are the round's own
   */
  _updateCountdown(s) {
    const arm = s.phase === 'freeze' || s.phase === 'warmup';
    const left = s.timeLeft ?? 0;
    if (!arm || left > 3.001 || left <= 0) {
      // Hidden unconditionally, NOT guarded on `_countdownAt`.
      //
      // Two places were using that field for two different things: this one as
      // "is the element on screen", and the `round:phase` handler as "forget the
      // last number announced". The handler zeroed it first, so by the time the
      // round went live this branch decided there was nothing to hide and the
      // number stayed sitting over the crosshair for the whole round.
      this._countdownAt = -1;
      setStyle(this.countdown, 'display', 'none');
      return;
    }
    const n = Math.ceil(left);
    setStyle(this.countdown, 'display', '');
    if (n === this._countdownAt) return;
    this._countdownAt = n;
    setText(this.countdown, String(n));
    // `step` rises 0,1,2 as the count falls 3,2,1, so the pitch climbs into the
    // bell rather than sitting flat under it.
    this.sfx('round_tick', 0.55 + (3 - n) * 0.12, { step: 3 - n });
  }

  sfx(id, gain = 1, opts = null) {
    const a = this.ctx.peek('audio');
    if (!a) return;
    try {
      // `opts` is optional and only the newest adapter takes it, so it is passed
      // through the richest path available and dropped by the others rather than
      // making a caller check which audio system it got.
      if (typeof a.ui === 'function' && opts) a.ui(id, gain, opts);
      else if (typeof a.playUi === 'function') a.playUi(id, gain);
      else if (typeof a.play === 'function') a.play(id, { gain });
      else if (typeof a.sfx === 'function') a.sfx(id, gain);
    } catch {
      /* audio is optional feedback — never let it break the HUD */
    }
  }

  /* ---------------------------------------------------------------- api --- */

  hitmarker(kind = 'hit') {
    this.hit.spawn(kind);
    this.crosshair.onHit();
    this.sfx(kind === 'kill' ? 'hit_kill' : kind === 'head' ? 'hit_head' : 'hit_flesh',
      kind === 'kill' ? 1 : 0.7);
  }

  damageNumber(worldPos, amount, kind = 'hit', key = null) {
    this.markers.spawnDamage(worldPos, amount, kind, key);
  }

  /** Incoming damage: arc toward the source, screen flash, reticle flinch. */
  hurt(amount = 10, dirX = 0, dirZ = 1) {
    const i = clamp01(amount / 40);
    this.arcs.spawn(dirX, dirZ, 0.45 + i * 0.55);
    this.health.onDamage(i);
    this.crosshair.onFlinch(0.5 + i);
    this.sfx('player_hurt', 0.6 + i * 0.4);
  }

  setPrompt(p) {
    this.prompt.set(p);
  }

  clearPrompt() {
    this.prompt.clear();
  }

  setObjectives(list) {
    this._objectives = list ?? [];
  }

  setHudVisible(v) {
    this.hudTarget = v ? 1 : 0;
  }

  pause() {
    this.menu.show();
  }

  resume() {
    this.menu.close();
  }

  /**
   * Named states for the capture harness. Only 'clean' and 'menu' survive: the
   * scripted combat timeline is gone (see the header), because the HUD now has
   * real state to draw and inventing a second one would photograph a match that
   * is not being played.
   */
  debugState(name = 'clean') {
    if (name === 'menu') {
      this.menu.show();
      return { state: 'menu' };
    }
    if (name === 'scoreboard') {
      this._forceScoreboard = true;
      return { state: 'scoreboard' };
    }
    this._forceScoreboard = false;
    this.menu.close();
    this.killfeed.clear();
    this.arcs.clear();
    this.hit.clear();
    this.markers.clear();
    this.clearPrompt();
    return { state: 'clean' };
  }

  /* -------------------------------------------------------------- frame --- */

  lateUpdate(dt, ctx) {
    const t = ctx.time;
    const rawDt = clamp(t.raw - this._lastRaw, 0, 0.1);
    this._lastRaw = t.raw;
    const s = this.state;
    s.time = t.elapsed;

    // ---- pause + scoreboard ---------------------------------------------
    let wantScores = !!this._forceScoreboard;
    if (ctx.input.enabled && !ctx.input.frozen) {
      if (ctx.input.actionPressed('pause')) this.menu.toggle();
      if (ctx.input.action('scoreboard')) wantScores = true;
      // Losing pointer lock mid-match is the same intent as pressing Escape.
      //
      // The flag means "we held the lock while PLAYING", and it has to be
      // cleared while the menu is up rather than left standing, or resuming is
      // impossible. `menu.close()` calls `input.requestPointerLock()`, and a
      // browser refuses that when the exit it is undoing was the user's own
      // Escape — `input.js` documents the refusal and swallows it, correctly,
      // because failing to lock is not a game error. But with the flag still
      // set, the very next frame saw an unlocked pointer and a closed menu and
      // read it as intent to pause: measured, the menu reopened and `time.scale`
      // went back to 0 three frames after closing. Escape and the resume button
      // both bounced straight off.
      //
      // Cleared here, a refused re-lock simply leaves the match running with a
      // free cursor, and the next click locks it (`input.js` requests on
      // mousedown). Losing a lock we actually HELD still raises the menu, which
      // is the alt-tab case this rule exists for.
      if (this.menu.open) this._hadPointerLock = false;
      else if (ctx.input.pointerLocked) this._hadPointerLock = true;
      else if (this._hadPointerLock) {
        this._hadPointerLock = false;
        this.menu.show();
      }
    }
    this.menu.update(rawDt);

    // ---- weapon ----------------------------------------------------------
    const ws = this._weaponState();
    if (ws) {
      if (ws.name) s.weaponName = ws.name;
      if (ws.mode) s.fireMode = ws.mode;
      if (ws.ammo !== undefined) s.ammo = ws.ammo;
      if (ws.reserve !== undefined) s.reserve = ws.reserve;
      if (ws.magSize !== undefined) s.magSize = ws.magSize;
      if (ws.reloading !== undefined) s.reloading = !!ws.reloading;
      if (ws.reloadProgress !== undefined) s.reloadProgress = ws.reloadProgress;
      if (ws.spread !== undefined) s.baseSpread = 4 + ws.spread * 40;
    }

    // ---- player ----------------------------------------------------------
    const ps = this._playerState();
    if (ps) {
      if (ps.health !== undefined) s.health = ps.health;
      if (ps.maxHealth !== undefined) s.maxHealth = ps.maxHealth;
      if (ps.move !== undefined) s.move = ps.move;
      if (ps.crouch !== undefined) s.crouch = !!ps.crouch;
      if (ps.airborne !== undefined) s.airborne = !!ps.airborne;
      if (ps.dead !== undefined) s.dead = !!ps.dead;
    }

    // ---- match -----------------------------------------------------------
    const m = this.match;
    const mine = this._myTeam();
    const other = mine === m.TEAM_IDS[0] ? m.TEAM_IDS[1] : m.TEAM_IDS[0];
    s.scoreUs = m.scores[mine] ?? 0;
    s.scoreThem = m.scores[other] ?? 0;
    s.phase = m.phase;
    s.round = m.round.round;
    s.timeLeft = m.round.remaining;
    s.roundsToWin = m.round.tempo.roundsToWin;

    // ---- movement-derived reticle bloom, when nothing else supplies it ----
    const pos = this._playerPos();
    if (!ps) {
      this._dir.copy(pos).sub(this._prevPos);
      this._dir.y = 0;
      const speed = dt > 0 ? this._dir.length() / dt : 0;
      s.move = damp(s.move, clamp01(speed / 6.2), 12, Math.max(rawDt, 1e-3));
    }
    this._prevPos.copy(pos);

    // ---- camera basis ----------------------------------------------------
    const mw = ctx.camera.matrixWorld.elements;
    let rx = mw[0];
    let rz = mw[2];
    let fx = -mw[8];
    let fz = -mw[10];
    const rl = Math.hypot(rx, rz) || 1;
    const fl = Math.hypot(fx, fz) || 1;
    rx /= rl; rz /= rl; fx /= fl; fz /= fl;

    // ---- widgets ---------------------------------------------------------
    const hudGoal = this.hudTarget * (this.menu.open ? 0.15 : 1);
    this.hudVisible = damp(this.hudVisible, hudGoal, 10, rawDt);
    const op = this.hudVisible.toFixed(3);
    setStyle(this.chromeLayer, 'opacity', op);
    setStyle(this.worldLayer, 'opacity', op);
    setStyle(this.centreLayer, 'opacity', op);

    // Dead men do not aim.
    //
    // The first version of this called `setVisible` optionally (`?.`) on
    // widgets that did not have the method, so it silently did nothing — a real
    // death frame showed the corpse a 0/100 health bar and a red PRESS R TO
    // RELOAD. Optional chaining on a method YOU are responsible for providing
    // is not defensive, it is a way to not find out.
    const alive = !s.dead;
    this.crosshair.setVisible(alive);
    this.ammo.setVisible(alive);
    this.health.setVisible(alive);
    // The centre layer also carries hitmarkers and the damage arcs, which are
    // likewise statements about a body you are no longer in.
    setStyle(this.centreLayer, 'display', alive ? '' : 'none');

    this.crosshair.update(dt, s);
    this.hit.update(dt);
    this.arcs.update(dt, rx, rz, fx, fz);
    this.health.update(dt, s);
    this.ammo.update(dt, s);
    this.killfeed.update(dt);
    this.matchBar.update(s);
    this.prompt.update(dt);
    this.banner.update(dt);
    this._updateCountdown(s);

    const player = ctx.peek('player');
    this.spectate.update(player?.spectateTarget ?? null, s.dead);

    this.scoreboard.setOpen(wantScores || s.dead);
    this.scoreboard.update(m, mine);

    this.markers.updateObjectives(this._objectives, ctx.camera, this.vw, this.vh, this.k);
    this.markers.updateGrenades(dt, ctx.camera, this.vw, this.vh, this.k);
    this.markers.updateDamage(dt, ctx.camera, this.vw, this.vh, this.k);
  }

  resize(w, h) {
    this.vw = w;
    this.vh = h;
    this.k = clamp(h / 1080, 0.62, 2.4);
    this.root.style.setProperty('--k', this.k.toFixed(4));
    this.crosshair.setScale(this.k);
  }

  dispose() {
    for (const off of this._unsubs) off();
    this._unsubs.length = 0;
    this.crosshair.dispose();
    this.hit.dispose();
    this.arcs.dispose();
    this.health.dispose();
    this.ammo.dispose();
    this.killfeed.dispose();
    this.matchBar.dispose();
    this.scoreboard.dispose();
    this.spectate.dispose();
    this.markers.dispose();
    this.prompt.dispose();
    this.banner.dispose();
    this.menu.dispose();
    this.root.remove();
    removeStyles();
  }
}
