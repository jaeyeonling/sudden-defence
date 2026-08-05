import { DEG } from './mathx.js';

/**
 * Weapon data.
 *
 * Rates of fire and magazine capacities are the real ones (an M4A1 is 800 rpm).
 * Damage, falloff and spread are NOT — they are tuned against this map and this
 * game's rules, and `tools/ballistics.mjs` is what says whether the tuning
 * worked. Run it before and after touching anything below.
 *
 * Recoil is split in two, exactly as a modern shooter does it:
 *   - `pattern`  a DETERMINISTIC per-shot camera climb a player can memorise
 *                and counter. Generated once from a fixed seed.
 *   - `spread`   a random cone that grows with sustained fire and shrinks when
 *                crouched or still. This is the part you cannot learn.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE M7 RECALIBRATION — three measured faults, and what was done about them
 * ────────────────────────────────────────────────────────────────────────────
 *
 * All three came from numbers inherited from a 120 m outdoor sandbox with ADS,
 * carried onto a 48x36 m depot without ADS. None of them are visible by reading
 * the table; all three fell out of `tools/ballistics.mjs` in one run.
 *
 * 1. FALLOFF WAS INERT. Damage is `1 - (1 - dropoff) * (travelled/maxRange)^2`.
 *    With `maxRange` at 420/240/180 m, a 35 m shot — near the longest this map
 *    affords — had travelled 8%, 14% and 19% of that, which is the flat part of
 *    the parabola. Measured: the rifle did 33.0 at 5 m and 32.9 at 35 m. Every
 *    weapon did full damage everywhere, so the range axis, the thing that is
 *    supposed to make an SMG different from a carbine, did not exist. The SMG
 *    was simply a worse rifle: less damage, more spread, no compensating
 *    strength anywhere on the map.
 *
 *    `maxRange` is now the distance at which a weapon reaches its damage floor,
 *    scaled to the map (longest sightline ~36 m, diagonal 60 m). It is no longer
 *    "how far the round flies" — the trace still reaches, the damage does not.
 *
 * 2. THE HIPFIRE CONE WAS THREE TIMES A TORSO. `spreadHip` is a HALF-angle
 *    applied as `tan(spread) * disc`, so 2.05 degrees is 0.72 m of radius at
 *    20 m. Measured standing still, 90% of rifle rounds landed inside 0.556 m
 *    at 20 m against a 0.2 m torso half-width — the first shot was a coin flip.
 *    That is a reasonable number for a game where hipfire is the panic option
 *    and ADS is the real one. Here hipfire is the ONLY option, and it was never
 *    re-derived after ADS was removed.
 *
 *    The floors are now set so that standing still puts 90% of rounds inside
 *    ~0.14 m at 20 m — comfortably on a torso — and crouching tightens it
 *    further. Movement and jumping are where the cone bites.
 *
 * 3. THE CONE COULD NOT GROW. Gain is per shot, decay is per second, so a held
 *    trigger only opens the cone when `spreadPerShot > spreadDecay / (rpm/60)`.
 *    The SMG was at 0.26 against 0.278 and the pistol at 0.42 against 0.678:
 *    both had a sustained-fire penalty that mathematically never applied.
 *
 * WHAT THE SPRAY PENALTY ACTUALLY IS. Even fixed, the cone is the SECONDARY
 * punishment. The primary one is the recoil pattern — 15 degrees of climb over
 * a rifle magazine, deterministic and learnable, which is the model this game
 * declares in ARCHITECTURE.md. So `spreadPerShot` is set just above break-even:
 * enough that holding the trigger visibly costs you, not so much that the
 * four-round burst that kills someone is a lottery. A tap-firing player sits at
 * the floor, because decay clears one shot's worth between deliberate shots.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE THREE ROLES, as measured (100 HP, head x4)
 * ────────────────────────────────────────────────────────────────────────────
 *
 *   M4A1   800 rpm   4 shots to kill at EVERY range, 1-tap head everywhere.
 *                    225 ms. The weapon with no bad matchup and no best one.
 *   MPX-9  950 rpm   4 shots inside ~10 m falling to 8 at 35 m. 189 ms close —
 *                    the fastest kill in the game — and useless down a lane.
 *   P-19   460 rpm   4 shots close, 1-tap head to ~18 m, 391 ms. Precise when
 *                    tapped, punishing when mashed. A sidearm that can win.
 */

export const WEAPON_DEFS = {
  rifle: {
    id: 'rifle',
    label: 'M4A1',
    class: 'carbine',
    caliber: '5.56x45',
    /* --- fire control --- */
    rpm: 800,
    modes: ['auto', 'burst', 'semi'],
    burstCount: 3,
    burstRpm: 950,
    burstDelay: 0.16,
    /* --- ammunition --- */
    magSize: 30,
    reserve: 210,
    /* --- terminal ballistics (hitscan; muzzleVelocity is tracer speed only) --- */
    muzzleVelocity: 880,
    damage: 33,
    penetration: 1.0,
    /* Range-STABLE, and that is the rifle's whole identity: 4 shots to kill and
     * a one-tap head at any distance this map contains. 55 m is just past the
     * longest sightline, so the curve is felt (30.6 damage at 35 m) without ever
     * costing a fourth-shot kill or the headshot. */
    dropoff: 0.82,
    falloffRange: 55,
    /* How far the round travels. A performance bound, not a balance number —
     * see the note in physics/penetration.js on why these are two fields. */
    maxRange: 200,
    tracerEvery: 3,
    /* --- accuracy (half-angle, degrees) ---
     * 0.48 x 0.82 (still) = 0.39 deg = 0.137 m of 90th-percentile radius at
     * 20 m, against a 0.2 m torso half-width. Crouched, 0.107 m. */
    spreadHip: 0.48,
    /* Break-even at 800 rpm is 3.4/13.33 = 0.255, so this is +0.045 deg of net
     * growth per held round: the cone reaches its cap around round 25 of 30.
     * The recoil pattern below is what actually punishes a long spray. */
    spreadPerShot: 0.3,
    spreadMax: 1.6,
    spreadDecay: 3.4,
    /* --- recoil --- */
    recoil: {
      pitch: 0.0085, // radians of camera climb per shot
      yaw: 0.0022,
      kickBack: 0.019, // metres the viewmodel travels rearward
      kickUp: 0.0072,
      roll: 0.032,
      punch: 0.35,
      freq: 8.5,
      damping: 0.42,
      patternLength: 30,
      patternSeed: 0x4d34a1,
      /**
       * ═══ SPRAY SHAPE — the memorable part of this weapon ═══
       *
       * A hard vertical for the first five rounds, then flat. That front-loading
       * is deliberate and it is what makes the rifle a BURST weapon: the first
       * four rounds, which are the four that kill somebody, are also the four
       * that climb hardest, so the pull-down you learn is short and steep rather
       * than a long slow drag. Round 5 onward the muzzle stops rising and starts
       * to snake sideways, which is where the magazine stops being useful and
       * you are meant to let go.
       */
      climbShape: [1.7, 1.45, 1.2, 1.05, 1.0], // per-shot multiplier on `pitch`
      drift: 0.55, // horizontal wander — low: this gun goes UP, not sideways
    },
    /* --- handling (seconds) --- */
    reloadTac: 2.1,
    reloadEmpty: 2.9,
    inspectTime: 3.2,
    drawTime: 0.62,
    holsterTime: 0.4,
    /* --- pose ---
     * Weapon-local origin is the web of the shooting hand (top of the grip).
     * The butt pad is at z=+0.245, the muzzle crown at z=-0.502, the optic
     * ocular at (0, 0.142, +0.006) and the mag floorplate ~150 mm below origin.
     *
     * RE-SOLVED FOR HIPFIRE-ONLY. The inherited pose was derived for a weapon
     * that was about to be shouldered: held close (z = -0.30), canted 7.7 deg
     * and toed 4.6 deg left so the receiver flank faced the camera and the
     * muzzle swept up-left toward the crosshair. That reads well for half a
     * second before an ADS transition takes over. It is the wrong pose when
     * hipfire is the ONLY way to shoot, for two reasons:
     *
     *   1. It eats the lower-right quadrant. In a game where every engagement
     *      is fought over the bare crosshair, the weapon is pure occlusion —
     *      an enemy at 15 m stands about 190 px tall, which the old receiver
     *      covered outright.
     *   2. It puts the support hand across the frame. The handguard sits
     *      up-LEFT of a weapon held that far right, so the left forearm cuts a
     *      diagonal through the middle of the screen.
     *
     * Constraints now, in order:
     *   1. bore within 2 deg of view-forward — the gun visibly points where the
     *      crosshair is, because that is now literally where rounds go
     *   2. z = -0.38: 27 % further out than before, which drops the weapon's
     *      screen footprint by ~40 % and pulls the support hand back inside the
     *      lower third. Still 190 mm inside the 572 mm arm budget.
     *   3. cant reduced to 5.2 deg — enough to keep the rail edge-on and off
     *      the specular top face, not enough to swing the handguard left
     *   4. muzzle crown stays visible, low and just right of centre
     *   5. nothing above the horizontal midline of the frame
     */
    hipPos: [0.105, -0.202, -0.38],
    hipRot: [-0.03, 0.048, -0.091],
    /* Eye to the rear lens.
     *
     * MEASURED FROM THE ADS FRAME, not chosen for realism. Two numbers have to
     * come out right and they pull in opposite directions:
     *
     *   housing size     the 31 mm tube's outer rim subtends rOuter/relief. At
     *                    0.078 that was 256 px of radius — a 512 px ring, HALF
     *                    the frame height, and every critic called the optic
     *                    oversized. 0.115 puts it at 168 px (336 px across,
     *                    31% of frame height), which is where a modern shooter
     *                    frames a tube sight.
     *   sight picture    is stopped by the objective bore at (relief + len), so a
     *                    LONGER relief improves the picture-to-housing ratio:
     *                    (relief)/(relief+len) goes from 0.53 to 0.69.
     *
     * So both wanted the same thing and the old value was simply too close. With
     * the 52 mm tube and the flared bore (see parts.js buildOptic) this lands the
     * clear aperture at 115 px against a 168 px housing. */
    /* Sprint: gun dropped and angled across the body, muzzle down-left.
     * Carried over by the same delta as the hip pose so the blend does not
     * translate the weapon 90 mm sideways on the way into a sprint. */
    swayScale: 1,
    bobScale: 1,
    magLen: 0.212,
  },

  smg: {
    id: 'smg',
    label: 'MPX-9',
    class: 'smg',
    caliber: '9x19',
    rpm: 950,
    modes: ['auto', 'semi'],
    burstCount: 2,
    burstRpm: 1100,
    burstDelay: 0.14,
    magSize: 32,
    reserve: 224,
    muzzleVelocity: 400,
    /* 27, up from 24. Four rounds is 108, so the SMG kills in four inside its
     * effective range — at 950 rpm that is 189 ms, the fastest kill in the game
     * and the entire reason to carry it. 24 needed five rounds (253 ms), which
     * was slower than the rifle's four while also being less accurate. */
    damage: 27,
    penetration: 0.45,
    /* The steepest curve of the three, and the shortest reach. 4 shots to kill
     * close, 5 at 15 m, 6 at 25 m, 8 at 35 m — the SMG loses a lane fight and
     * is supposed to. Head is a one-tap only inside ~11 m. */
    dropoff: 0.5,
    falloffRange: 30,
    maxRange: 200,
    tracerEvery: 4,
    /* Looser at rest than the rifle (0.168 m at 20 m standing, against 0.137),
     * and it opens faster under fire — 0.075 deg net per round against the
     * rifle's 0.045. This is the gun you hold the trigger on, and it is the gun
     * that punishes you for holding it too long. */
    spreadHip: 0.62,
    spreadPerShot: 0.34,
    spreadMax: 2.4,
    spreadDecay: 4.2,
    recoil: {
      pitch: 0.0058,
      yaw: 0.0026,
      kickBack: 0.0135,
      kickUp: 0.0052,
      roll: 0.026,
      punch: 0.24,
      freq: 10.5,
      damping: 0.4,
      patternLength: 32,
      patternSeed: 0x9ac31f,
      /**
       * ═══ SPRAY SHAPE ═══
       *
       * The opposite of the rifle: a soft climb that never front-loads, and
       * nearly twice the horizontal wander. The SMG's pattern is a WIDE SNAKE
       * rather than a vertical pull — you counter it by sweeping across a body
       * instead of dragging down, which is why it reads as a room-clearing gun
       * and why the same muscle memory does not transfer between the two.
       */
      climbShape: [1.25, 1.15, 1.08, 1.0],
      drift: 1.05,
    },
    reloadTac: 1.85,
    reloadEmpty: 2.5,
    inspectTime: 2.9,
    drawTime: 0.52,
    holsterTime: 0.34,
    /* Solved from the bore axis exactly as the rifle's is (see there): 4.1 deg of
     * convergence, 2.9 deg nose-down, 7.5 deg of outboard roll, and far enough
     * out that the muzzle of a 210 mm barrel is on screen up-left of the optic. */
    hipPos: [0.1, -0.178, -0.362],
    hipRot: [-0.03, 0.045, -0.088],
    /* Same aperture-budget derivation as the rifle (see there): the 27.6 mm tube's
     * outer rim wants to land near 165 px of radius and the 44 mm bore wants the
     * eye far enough back that the objective is not the stop. */
    swayScale: 0.92,
    bobScale: 0.95,
    magLen: 0.192,
  },

  pistol: {
    id: 'pistol',
    label: 'P-19',
    class: 'pistol',
    caliber: '9x19',
    rpm: 460,
    modes: ['semi'],
    burstCount: 1,
    burstRpm: 460,
    burstDelay: 0.1,
    magSize: 17,
    reserve: 68,
    muzzleVelocity: 360,
    damage: 28,
    penetration: 0.35,
    /* Between the other two: 4 shots to kill out to ~20 m, then a real decline.
     * The one-tap head reaches ~18 m, which is further than the SMG's — a
     * pistol that rewards a still, deliberate shot is worth carrying. */
    dropoff: 0.55,
    falloffRange: 38,
    maxRange: 200,
    tracerEvery: 5,
    /* Tighter at rest than the SMG. Semi-only at 460 rpm means break-even is a
     * huge 0.704 deg per round, so `spreadPerShot` has to be larger than the
     * other two to mean anything at all — and the consequence is exactly the
     * pistol's character: deliberate fire (decay clears 0.8 deg in 0.15 s) sits
     * at the floor, mashing the trigger throws rounds away. */
    spreadHip: 0.55,
    spreadPerShot: 0.8,
    spreadMax: 2.8,
    spreadDecay: 5.4,
    recoil: {
      pitch: 0.0125,
      yaw: 0.0032,
      kickBack: 0.012,
      kickUp: 0.0105,
      roll: 0.018,
      punch: 0.3,
      freq: 9.0,
      damping: 0.45,
      patternLength: 17,
      patternSeed: 0x1f77bc,
      /**
       * ═══ SPRAY SHAPE ═══
       *
       * Flat. No front-loading at all, because a semi-only weapon has no spray
       * to learn — every shot is a decision, and a first-shot multiplier would
       * only mean "your deliberate shots kick harder than your careless ones",
       * which is backwards. The per-shot kick is the largest of the three
       * (0.0125 rad) so that mashing walks the muzzle off the target fast; the
       * wide drift means it does not walk in a straight, correctable line.
       */
      climbShape: [1.0],
      drift: 1.2,
    },
    reloadTac: 1.6,
    reloadEmpty: 2.2,
    inspectTime: 2.6,
    drawTime: 0.42,
    holsterTime: 0.3,
    /* A pistol is held out on the arms rather than braced on the shoulder, so
     * the hip pose is FURTHER from the eye than a carbine's and the ADS eye
     * relief is most of an arm's length. 0.34 m keeps both elbows visibly bent;
     * past ~0.40 m the two-bone solve hits full extension and they lock. */
    hipPos: [0.098, -0.162, -0.4],
    hipRot: [-0.028, 0.042, -0.075],
    swayScale: 1.15,
    bobScale: 1.1,
    magLen: 0.108,
  },
};

/**
 * Generate the deterministic recoil pattern for a weapon.
 *
 * The shape is what a player learns: a strong vertical climb for the first few
 * shots, then the vertical settles while the muzzle starts to wander sideways
 * in a smooth, repeatable S. Everything comes from one fixed seed so the same
 * weapon always kicks the same way — including in capture mode.
 *
 * @returns {Float32Array} pairs of [pitch, yaw] in radians, length n*2.
 */
export function buildRecoilPattern(def, Rng) {
  const r = def.recoil;
  const n = r.patternLength;
  const rng = new Rng(r.patternSeed);
  const out = new Float32Array(n * 2);
  // Two out-of-phase wanders make the horizontal read as a learnable snake
  // rather than as noise.
  const phase = rng.float() * Math.PI * 2;
  const phase2 = rng.float() * Math.PI * 2;
  const bias = rng.signed() * 0.35;
  for (let i = 0; i < n; i++) {
    const shot = i;
    const climb = r.climbShape[Math.min(shot, r.climbShape.length - 1)];
    // Vertical: strong early, tapering, with a per-shot signature bump.
    const sig = 0.88 + rng.float() * 0.24;
    out[i * 2] = r.pitch * climb * sig;
    // Horizontal: a smooth snake plus a fixed per-shot signature.
    const t = i / Math.max(1, n - 1);
    const snake =
      Math.sin(phase + t * Math.PI * 2.6) * 0.75 + Math.sin(phase2 + t * Math.PI * 5.1) * 0.35;
    out[i * 2 + 1] = r.yaw * (snake * r.drift * 3.2 + bias + rng.signed() * 0.25);
  }
  return out;
}

/**
 * Multipliers on `spreadHip`, the whole accuracy model in five numbers.
 *
 * `airborne` at 2.0 is the load-bearing one: it is what stops jump-spam from
 * being a winning duel option, which matters far more here than in a game where
 * ADS gave you a precise option anyway.
 */
export const SPREAD_MODS = {
  crouch: 0.78,
  still: 0.82,
  walking: 1.15,
  airborne: 2.0,
};

export const DEG2RAD = DEG;
