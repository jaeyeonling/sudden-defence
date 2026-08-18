/** Binary heap for A*. Split out of nav.js; NavGrid is its only caller. */

/* ------------------------------------------------------------------ */
/* Binary heap for A*                                                  */
/* ------------------------------------------------------------------ */

export class Heap {
  constructor(cap) {
    this.idx = new Int32Array(cap);
    this.key = new Float32Array(cap);
    this.n = 0;
  }

  clear() {
    this.n = 0;
  }

  /**
   * Grow rather than DROP when the open list is full.
   *
   * This used to `return` silently on overflow, and the capacity was one entry
   * per grid cell. That looks sufficient and is not: A* here has no decrease-key,
   * it re-pushes a cell every time it finds a cheaper route to it, so the open
   * list routinely holds more entries than the grid holds cells. Every dropped
   * entry is a cell the search will never expand, and the failure it produces is
   * indistinguishable from "there is no route" — `findPath` returns 0, `_goTo`
   * reports the destination unreachable, and `_combat` stands still. Measured
   * after the region and height fixes, this was the whole of the remainder: 225
   * failures in 75 s, every one of them start and goal in the SAME region.
   *
   * Doubling is amortised and one-off: the arrays survive between searches, so a
   * grid settles at its working size within the first few paths and never
   * allocates again. That keeps the per-frame allocation rule intact.
   */
  push(i, k) {
    if (this.n >= this.idx.length) {
      const cap = this.idx.length * 2;
      const idx = new Int32Array(cap);
      idx.set(this.idx);
      const key = new Float32Array(cap);
      key.set(this.key);
      this.idx = idx;
      this.key = key;
    }
    let c = this.n++;
    this.idx[c] = i;
    this.key[c] = k;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (this.key[p] <= this.key[c]) break;
      const ti = this.idx[p], tk = this.key[p];
      this.idx[p] = this.idx[c]; this.key[p] = this.key[c];
      this.idx[c] = ti; this.key[c] = tk;
      c = p;
    }
  }

  pop() {
    const top = this.idx[0];
    this.n--;
    if (this.n > 0) {
      this.idx[0] = this.idx[this.n];
      this.key[0] = this.key[this.n];
      let c = 0;
      for (;;) {
        const l = c * 2 + 1, r = l + 1;
        let m = c;
        if (l < this.n && this.key[l] < this.key[m]) m = l;
        if (r < this.n && this.key[r] < this.key[m]) m = r;
        if (m === c) break;
        const ti = this.idx[m], tk = this.key[m];
        this.idx[m] = this.idx[c]; this.key[m] = this.key[c];
        this.idx[c] = ti; this.key[c] = tk;
        c = m;
      }
    }
    return top;
  }
}

