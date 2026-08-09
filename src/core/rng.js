/**
 * Deterministic PRNG (xoshiro128**). Gameplay randomness — recoil patterns,
 * spread, particle jitter, AI timing — must run through this so capture mode
 * produces byte-identical frames.
 *
 * WHY `fork` DEMANDS AN ANSWER
 *
 * Netcode step 5 rewinds the world to a tick and replays the commands since.
 * Rewinding a stream means restoring its state, so every stream splits into two
 * populations: the ones a snapshot must carry, and the ones it must not. Get it
 * wrong in either direction and you lose — a missed simulation stream diverges
 * on replay, an included presentation stream bloats the snapshot with the
 * particle jitter of things that were never simulated in the first place.
 *
 * There are 29 `fork()` sites. Nothing at any of them said which population it
 * belonged to, so the answer lived in one hand-written table in a handoff
 * document — and that table was wrong twice, listing two streams as simulation
 * that no line of code ever reads. A comment cannot be wrong loudly. A required
 * argument can: the throw below is what a table cannot do.
 *
 * The flag asks the question it decides — "does this need saving and
 * restoring" — not the category it correlates with. `world`'s stream is
 * simulation by any reasonable reading (its bake decides what bullets hit) and
 * is still `snapshot: false`, because it is frozen after boot. Naming the flag
 * `sim` would have forced a lie about that one either way.
 */
export class Rng {
  constructor(seed = 0x9e3779b9) {
    this.seed(seed);

    /**
     * Root-only. Every descendant forked with `snapshot: true` registers here,
     * in creation order, so a snapshot can enumerate its targets instead of
     * trusting each subsystem to remember its own streams.
     *
     * This is deliberately redundant with the per-subsystem `captureState`
     * hooks: the gate cross-checks the two, and a stream present here but
     * missing from the capture is exactly the failure the hooks cannot report
     * about themselves.
     */
    this._snapshotForks = null;
    /** The root of this stream's fork tree. Null on a root. */
    this._root = null;
  }

  seed(s) {
    // SplitMix32 to spread one 32-bit seed across the four state words.
    let z = s >>> 0;
    const next = () => {
      z = (z + 0x9e3779b9) >>> 0;
      let x = z;
      x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
      x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
      return (x ^ (x >>> 15)) >>> 0;
    };
    this.s0 = next();
    this.s1 = next();
    this.s2 = next();
    this.s3 = next();
    // `gauss` caches the second Box-Muller sample here, so it is state as much
    // as the four words are. Leaving it across a reseed made the same seed
    // produce different normals depending on whether the previous stream had
    // drawn an odd number of them.
    this._spare = undefined;
    return this;
  }

  /** Uniform uint32. */
  u32() {
    const rot = (x, k) => ((x << k) | (x >>> (32 - k))) >>> 0;
    const result = Math.imul(rot(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = rot(this.s3, 11);
    return result;
  }

  /** Uniform [0,1). */
  float() {
    return this.u32() / 4294967296;
  }

  /** Uniform [min,max). */
  range(min, max) {
    return min + (max - min) * this.float();
  }

  /** Uniform integer [min,max]. */
  int(min, max) {
    return min + (this.u32() % (max - min + 1));
  }

  /** Uniform [-1,1]. */
  signed() {
    return this.float() * 2 - 1;
  }

  /** Standard normal via Box–Muller (one sample; the pair's second is cached). */
  gauss() {
    if (this._spare !== undefined) {
      const v = this._spare;
      this._spare = undefined;
      return v;
    }
    let u = 0;
    while (u === 0) u = this.float();
    const r = Math.sqrt(-2 * Math.log(u));
    const th = 2 * Math.PI * this.float();
    this._spare = r * Math.sin(th);
    return r * Math.cos(th);
  }

  pick(arr) {
    return arr[this.u32() % arr.length];
  }

  /** Point uniformly inside the unit disc — bullet spread, particle emission. */
  disc(out = { x: 0, y: 0 }) {
    const r = Math.sqrt(this.float());
    const a = this.float() * Math.PI * 2;
    out.x = Math.cos(a) * r;
    out.y = Math.sin(a) * r;
    return out;
  }

  /**
   * Independent stream derived from this one — lets a subsystem randomise
   * without perturbing another subsystem's sequence.
   *
   * `snapshot` is required, and is the caller's answer to: if the world rewinds
   * to an earlier tick and replays, must this stream rewind with it?
   *
   *   true  — the stream feeds simulation. Its state is snapshot state.
   *   false — presentation, or frozen after boot. Excluded, and the excluding
   *           is the point: a snapshot that carried every muzzle-flash stream
   *           would be larger and no more correct.
   *
   * Omitting it throws rather than defaulting. A default is a vote cast on
   * behalf of whoever adds the next fork, and the two dead streams this
   * argument uncovered survived precisely because forking cost nothing.
   */
  fork({ snapshot } = {}) {
    if (typeof snapshot !== 'boolean') {
      throw new TypeError(
        'Rng.fork requires { snapshot: boolean } — does this stream rewind with the world? ' +
          'See the class comment; there is no correct default.'
      );
    }
    const child = new Rng(this.u32());
    // Link every child to the root, not just the registered ones. A presentation
    // stream is allowed to fork a simulation stream — `ai.fxRng` is one branch
    // away from being that — and if the link were conditional, such a grandchild
    // would register on its own parent and `snapshotForks()` would never see it.
    // A registry that silently omits is worse than no registry.
    const root = this._root ?? this;
    child._root = root;
    if (snapshot) (root._snapshotForks ??= []).push(child);
    return child;
  }

  /**
   * Every descendant stream that answered `snapshot: true`, in creation order.
   * Root-only; a fork's own list is always empty because registration walks to
   * the root.
   */
  snapshotForks() {
    return this._snapshotForks ?? EMPTY;
  }

  /**
   * This stream's mutable state, written into `out`.
   *
   * Five fields, not four. `_spare` is the Box-Muller carry and is `undefined`
   * half the time, which is why it is written explicitly: a capture built by
   * walking own-keys would drop the key entirely on those passes, and a diff
   * that compares key sets would then call two different states equal.
   */
  captureState(out = {}) {
    out.s0 = this.s0;
    out.s1 = this.s1;
    out.s2 = this.s2;
    out.s3 = this.s3;
    out.spare = this._spare ?? null;
    return out;
  }

  /** Inverse of `captureState`. */
  restoreState(s) {
    this.s0 = s.s0 >>> 0;
    this.s1 = s.s1 >>> 0;
    this.s2 = s.s2 >>> 0;
    this.s3 = s.s3 >>> 0;
    this._spare = s.spare === null ? undefined : s.spare;
    return this;
  }
}

const EMPTY = Object.freeze([]);
