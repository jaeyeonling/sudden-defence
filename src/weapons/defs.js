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
 * Band edges are SOLVED from the falloff curve (`tools/lethality.mjs`), not read
 * off a grid of sample ranges — the grid this table used to quote ran 5/15/25/35
 * and straddled every edge that matters. RPM and TTK are MEASURED through the
 * fire path at 60 fps, not copied from the `rpm` field below; see the note on
 * `_advanceFireTimer` for the two years in which those were different numbers.
 *
 *   M4A1   802 rpm   4 shots to kill at EVERY range, 1-tap head everywhere.
 *                    224 ms. The weapon with no bad matchup and no best one.
 *   MPX-9  951 rpm   4 shots to 15.8 m, then 5 to 23.6, 6 to 27.7, 7 beyond.
 *                    189 ms close — the fastest kill in the game — and useless
 *                    down a lane. 1-tap head to 15.8 m.
 *   P-19   460 rpm   4 shots to 18.5 m, 1-tap head to the same 18.5, 391 ms.
 *                    Precise when tapped, punishing when mashed.
 *
 * The four-round band and the one-tap head range are ALWAYS the same distance:
 * both ask for 25 damage on the round (4 x 25 = 100 = 1 x 4 x 25). They are one
 * fact wearing two hats, so nothing can move one without moving the other.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE THREE SPRAYS, as measured
 * ────────────────────────────────────────────────────────────────────────────
 *
 *                climb   worst shot   lateral (R / L)    kill burst off line
 *   M4A1        15.4°       0.82°      1.8° (1.25/0.56)        0.009°
 *   MPX-9        8.1°       0.31°      5.3° (2.65/2.66)        2.27°
 *   P-19        15.3°       1.00°      0.5° (0.44/0.04)        0.37°
 *
 * Read across the rows rather than down the columns: the M4A1 and the P-19
 * climb the same total and are nothing alike, because one pays it over thirty
 * rounds and the other over seventeen. That is the axis this table used to be
 * flat on — every weapon landed between 11 and 15 degrees of climb and the
 * differences that were supposed to separate them lived in the horizontal,
 * which nobody controlled.
 *
 * Each weapon now declares its shape in `recoil.signature` and
 * `tools/ballistics.mjs` holds it to it. Verified by breaking all three: gating
 * the rifle's horizontal on from round one puts 0.19° into its killing burst,
 * restoring the SMG's old seed drops its balance to 0.04, and softening the
 * P-19's kick fails both the climb and the per-shot band.
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
      drift: 0.5, // horizontal wander — low: this gun goes UP, not sideways
      /**
       * Dead straight for the first three rounds, then it hooks.
       *
       * This is the half of the "7" that was missing. Four rounds is a kill at
       * every range (see the STK table), so the first four are the ones every
       * engagement is actually fought with — and a weapon whose killing burst
       * also wanders sideways is one you cannot aim by memory, however
       * learnable the rest of the magazine is. Gate the horizontal off until
       * the burst is over, and the pull-down a player learns is a straight
       * line for exactly as long as it matters.
       */
      driftShape: [0, 0, 0.08, 0.22, 0.45, 0.72, 1],
      /** Right. The stroke of the 7, and a choice rather than a seed draw. */
      driftBias: 1.15,
      /**
       * What this pattern CLAIMS to be, checked by `tools/ballistics.mjs`.
       *
       * A shape chosen in prose and tuned by four numbers is a shape that goes
       * quietly wrong the next time any of the four moves — and the gate that
       * existed measured only total climb, which all three weapons passed while
       * being far less distinct than their comments said. Writing the intent
       * down as data is what makes "the M4A1 is the straight one" falsifiable.
       */
      signature: {
        climbDeg: [13, 18],
        lateralDeg: [1.2, 2.6],
        /** The killing burst has to be a straight line. That is the point. */
        killBurstLateralDeg: 0.15,
        lean: 'right',
      },
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
    /* 29, up from 27, up from 24.
     *
     * Four rounds is the entire reason to carry this: at 950 rpm that is 189 ms,
     * the fastest kill in the game, against the M4A1's 225 ms. 24 needed five
     * (253 ms), which was slower than the rifle while also being less accurate.
     * 27 fixed that arithmetic and left the real problem, which is that "four
     * rounds" is not a property of the gun — it is a property of the DISTANCE,
     * and nothing had ever measured the distances this map actually produces.
     *
     * It does now. `tools/botfight.mjs` records the shooter-to-impact distance
     * of every hit, and across three bot fights the median engagement came out
     * at 13.0, 14.7 and 15.4 m. At 27 damage the four-round band closed at ~12:
     *
     *     27 dmg   5m:4  10m:4  15m:5  25m:6  35m:8
     *
     * So the fastest kill in the game was unavailable at the distance people
     * actually fight at. The advantage covered roughly the closest tenth of
     * engagements and the penalty covered more than half of them, which is not a
     * close-range specialist — it is a trap pick.
     *
     * 29 puts the crossover ON the median instead of in front of it:
     *
     *     29 dmg   5m:4  14m:4  16m:5  20m:5  25m:6  35m:7
     *
     * Inside ~15 m the MPX-9 kills in 189 ms and the M4A1 in 225. Outside it the
     * MPX-9 needs five (253 ms) and loses; past 25 m it is not in the fight.
     * `falloffRange` stays at 30 precisely so that collapse stays sharp —
     * widening the range would buy the same four-round band by making the gun
     * mediocre everywhere instead of decisive somewhere.
     *
     * Re-derive before touching it: the median moves if the map does.
     *
     * ── RE-DERIVED after the fire-rate fix (`_advanceFireTimer`) ─────────────
     *
     * The 189 / 225 ms pair above was never what the game did. `_fireTimer`
     * rounded every interval up to a whole frame, so at 60 fps the MPX-9 ran at
     * 900 rpm and the M4A1 at 720 — 200 against 250 ms. The SMG's close-range
     * edge was therefore 50 ms in play while this comment argued from 36, and
     * fixing the timer took 14 ms of real advantage off this gun without anyone
     * touching its damage. That is the whole reason to re-check: the argument
     * was made against numbers the code did not produce.
     *
     * It survives, and not narrowly. Eight bot fights pooled — 255 hits, not the
     * 20-40 a single fight yields, which is a sample too small to site a
     * crossover with — give p25 9.3, p50 14.4, p75 19.8 m. Against that
     * distribution, the four-round band covers:
     *
     *     26 dmg -> band  8.3 m -> 22 % of hits
     *     27 dmg -> band 11.5 m -> 29 %
     *     28 dmg -> band 13.9 m -> 43 %
     *     29 dmg -> band 15.8 m -> 60 %      <- here
     *     30 dmg -> band 17.3 m -> 73 %
     *
     * 29 sits on the steepest step of that curve and puts the edge just past the
     * median rather than in front of it. 27 was worse than this comment claimed
     * — "roughly the closest tenth" was optimistic; it was 29 % — and 30 starts
     * to make the gun simply better than the rifle across most of the map, which
     * is the failure in the other direction.
     *
     * What the fire-rate fix DID cost is real and is the trade: inside 15.8 m
     * the MPX-9 now kills 35 ms faster than the M4A1 rather than 50, in 60 % of
     * engagements, and is strictly worse in the other 40 % — five rounds against
     * four, through a wider cone. That is a specialist. */
    damage: 29,
    penetration: 0.45,
    /* The steepest curve of the three, and the shortest reach. 4 shots to kill
     * out to 15.8 m, 5 to 23.6, 6 to 27.7, 7 beyond — the SMG loses a lane fight
     * and is supposed to. Head is a one-tap inside that same 15.8 m, necessarily
     * (see the header). This paragraph read "5 at 15 m ... 8 at 35 m ... one-tap
     * inside ~11 m" until the ladder was solved rather than sampled: those are
     * the 27-damage numbers, left behind when the damage moved to 29. */
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
      /* 0.0044, down from 0.0058. "Low and wide" is one statement about two
       * axes and the low half was never done: this gun climbed 11.0 degrees
       * against the rifle's 15.4, which is lower but not by enough to read as a
       * different weapon. 8.3 is. What it trades for that is the widest
       * horizontal in the game — see `drift` below. */
      pitch: 0.0044,
      yaw: 0.0026,
      kickBack: 0.0135,
      kickUp: 0.0052,
      roll: 0.026,
      punch: 0.24,
      freq: 10.5,
      damping: 0.4,
      patternLength: 32,
      /* Chosen, not inherited. `driftBias` sets which way a pattern leans but
       * not where its snake STARTS, and the starting phase is the seed's — so
       * at 0x9ac31f this weapon swept 4.99 degrees left and 0.18 right while
       * claiming to be the gun you counter by sweeping across a body. Searched
       * 40k seeds for one that is wide, crosses the centre at least twice, and
       * is symmetric about it; this one is 2.65 right against 2.66 left. */
      patternSeed: 0x102d32,
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
      /** Widest of the three, and it starts wide — no straight phase at all. */
      drift: 1.75,
      driftShape: [1],
      /**
       * No bias, deliberately. The rifle hooks one way and is countered by a
       * pull; this one has to be countered by a SWEEP, and a sweep only reads
       * as a sweep if the muzzle goes both ways. Leaving the seeded draw in
       * would put a net lean on it that nobody chose.
       */
      driftBias: 0,
      /** Half the rifle's climb, three times its width, and even about centre. */
      signature: {
        climbDeg: [7, 10],
        lateralDeg: [4.5, 6.5],
        killBurstLateralDeg: null, // wandering inside the burst IS this weapon
        lean: 'both',
      },
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
      /* 0.0158, up from 0.0125, and the largest per-shot kick in the game by a
       * wide margin — 0.90 degrees against the M4A1's 0.83 on its hardest round
       * and 0.25 on its softest. This is the whole punishment model for a
       * semi-automatic: there is no spray to learn, so the cost of mashing has
       * to be paid per shot, and the reward for waiting is that the spring has
       * cleared it by the time a deliberate second shot goes. */
      pitch: 0.0158,
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
      /**
       * Almost none. A semi-only weapon has no spray to sweep, so horizontal
       * wander is not a pattern to learn — it is just a shot you did not
       * deserve to miss. What punishes mashing here is the per-shot kick
       * (`pitch`, the largest of the three), which walks the muzzle straight up
       * fast and recovers fast if you let it.
       */
      drift: 0.22,
      driftShape: [1],
      driftBias: 0,
      /**
       * Straight, and paid for per shot rather than per magazine. The lateral
       * band is the tight one here; `perShotClimbDeg` is the floor that keeps
       * the "mashing costs you" half honest if `pitch` is ever softened.
       */
      signature: {
        climbDeg: [13, 18],
        lateralDeg: [0, 1.0],
        killBurstLateralDeg: 0.6,
        perShotClimbDeg: [0.85, 1.15],
        lean: 'either',
      },
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
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THERE ARE TWO HORIZONTAL KNOBS AND NOT ONE
 * ────────────────────────────────────────────────────────────────────────────
 *
 * `climbShape` has always let a weapon say WHEN it climbs. The horizontal had
 * no equivalent: the snake's starting phase and the net `bias` were both drawn
 * from the seed, so a weapon could not say "no sideways for the first four
 * rounds" or "hook right" — only "reroll and see". That is not a small gap,
 * because the horizontal signature is most of what distinguishes one spray from
 * another, and it meant the three weapons' directions were an accident: the
 * M4A1 drifted only left, the P-19 only right, and nobody had chosen either.
 *
 *   `driftShape`  a per-shot gate on the horizontal, same convention as
 *                 `climbShape` (last entry repeats). `[0, 0, 0.5, 1]` climbs
 *                 dead straight for two rounds before it starts to wander.
 *   `driftBias`   the net direction, in roughly [-1, 1]. Positive is right.
 *                 Omit it to keep the seeded draw, which is a symmetric snake.
 *
 * Both are optional; a weapon that sets neither behaves exactly as before.
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
  // Drawn unconditionally even when `driftBias` overrides it, so the number of
  // draws — and therefore every later value in the stream — does not depend on
  // which fields a weapon happens to set.
  const drawnBias = rng.signed();
  const bias = (r.driftBias ?? drawnBias) * 0.35;
  for (let i = 0; i < n; i++) {
    const shot = i;
    const climb = r.climbShape[Math.min(shot, r.climbShape.length - 1)];
    // Vertical: strong early, tapering, with a per-shot signature bump.
    const sig = 0.88 + rng.float() * 0.24;
    out[i * 2] = r.pitch * climb * sig;
    // Horizontal: a smooth snake plus a fixed per-shot signature, gated by
    // `driftShape` so a weapon can climb straight before it starts to wander.
    const t = i / Math.max(1, n - 1);
    const snake =
      Math.sin(phase + t * Math.PI * 2.6) * 0.75 + Math.sin(phase2 + t * Math.PI * 5.1) * 0.35;
    const gate = r.driftShape
      ? r.driftShape[Math.min(shot, r.driftShape.length - 1)]
      : 1;
    out[i * 2 + 1] = r.yaw * gate * (snake * r.drift * 3.2 + bias + rng.signed() * 0.25);
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
