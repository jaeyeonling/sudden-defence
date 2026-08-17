import * as THREE from 'three';
import { dsin } from '../core/dmath.js';
import { clothGeometry } from './util-cloth.js';
import { plainBox } from './util.js';
import { _e, _q, _p, _s, LL, BOX, BOX_FINE, BOX_SOFT, BOX_THIN, PANE } from './kit-base.js';

/** Windows, doors and shopfronts — every hole in a facade and what fills it. */

// =================================================================== window ==
/**
 * The per-window states. A facade where every opening is the same glazed panel
 * is the single loudest tell of procedural architecture — real streets have
 * open windows, boarded windows, shuttered windows and the odd lit room, and the
 * variation is what makes the wall read as a building people live in.
 *
 * `windowState(rng, f, damage)` picks one; `buildFacade` hands it straight to
 * `windowUnit`, which turns it into geometry.
 */
export function windowState(rng, floor = 1, damage = 0.2, opts = {}) {
  const r = rng.float();
  // Ground-floor openings are shopfronts and barred windows, not open sashes;
  // upper floors are where laundry, shutters and open casements live.
  const upper = floor > 0;
  if (r < 0.07 + damage * 0.25) return 'boarded';
  if (r < 0.2 + damage * 0.5) return 'open';
  if (upper && r < 0.42) return 'shuttered';
  if (upper && r < 0.52) return 'ajar';
  if (r < 0.6) return 'curtain';
  if (opts.allowLit !== false && r < 0.66) return 'lit';
  return 'glazed';
}

/**
 * Window unit: recessed frame, mullions, glass (or blown out), stone sill,
 * lintel, optional shutters / grille / curtain — and, crucially, a DARK
 * INTERIOR BACKING PLANE set back behind the glass.
 *
 * That backing is what separates a window from a rectangle of paint. The glass
 * sits at `depth` inside the reveal as a low-roughness specular sheet that picks
 * up the sky; 15-25 cm behind it sits a `window_void` plane at ~0.03 linear
 * albedo. From the street you therefore see: a bright sky glint on the pane, a
 * dark core behind it, and the reveal shadow crossing the two at a different
 * parallax as the camera moves.
 */
export function windowUnit(A, pm, o, rng, opts = {}) {
  const t = opts.t ?? 0.34;
  const frameKey = opts.frameKey ?? 'wood_dark';
  const depth = opts.depth ?? t * 0.62; // how far in from the outer face
  const w = o.w;
  const h = o.h;
  const x = o.x;
  const y = o.y;
  const fw = 0.055; // frame member thickness
  const fd = 0.075;
  const state = opts.state ?? (opts.broken ? 'open' : 'glazed');
  const broken = opts.broken ?? state === 'open';
  const boarded = state === 'boarded';
  const open = state === 'open' || state === 'ajar';
  const lit = state === 'lit';
  const box = BOX_THIN(A);

  // ---- the dark room behind the opening -----------------------------------
  // Set back from the glass so the reveal shadows onto it and the two planes
  // parallax against each other. `back:false` is for enterable buildings, which
  // have a real furnished room behind the wall already.
  if (opts.back !== false) {
    const bd = depth + (open ? 0.26 : opts.backSet ?? 0.19);
    // Slightly oversized so the reveal never shows daylight round the edge.
    A.add(lit ? 'window_glow' : 'window_void', PANE(A), LL(pm, x, y, bd, 0, w + 0.14, h + 0.14, 1), {
      masks: lit ? [0.2, 0.4, 0.1] : [0.15, 0.9, 0.95],
    });
    // A sliver of side wall inside the opening: gives the void a second value
    // and a real corner rather than reading as one flat card.
    if (!boarded) {
      A.add('window_void', box, LL(pm, x - w / 2 - 0.03, y, bd - 0.09, 0, 0.05, h + 0.1, 0.2), {
        masks: [0.1, 0.95, 1.0],
      });
      A.add('window_void', box, LL(pm, x, y + h / 2 + 0.03, bd - 0.09, 0, w + 0.1, 0.05, 0.2), {
        masks: [0.1, 0.95, 1.0],
      });
    }
  }

  // frame: four members inside the reveal. These are 5 cm members repeated
  // several hundred times across the level, so they use the 12-tri box.
  A.add(frameKey, box, LL(pm, x, y + h / 2 - fw / 2, depth, 0, w - 0.02, fw, fd), null);
  A.add(frameKey, box, LL(pm, x, y - h / 2 + fw / 2, depth, 0, w - 0.02, fw, fd), null);
  A.add(frameKey, box, LL(pm, x - w / 2 + fw / 2, y, depth, 0, fw, h - 0.02, fd), null);
  A.add(frameKey, box, LL(pm, x + w / 2 - fw / 2, y, depth, 0, fw, h - 0.02, fd), null);
  // mullion + transom, or swung-in casement leaves
  let openL = false;
  let openR = false;
  if (!open) {
    A.add(frameKey, box, LL(pm, x, y, depth, 0, 0.045, h - 0.1, fd * 0.85), null);
    A.add(frameKey, box, LL(pm, x, y + h * 0.16, depth, 0, w - 0.1, 0.04, fd * 0.85), null);
  } else {
    // An open casement: the sash swung inward off its hinge, catching light on
    // its edge against the dark room behind it.
    openL = true;
    openR = state === 'open' || rng.float() < 0.4;
    const sw = w / 2 - 0.03;
    const sash = A.cache(`sash:${sw.toFixed(2)}:${h.toFixed(2)}`, () => sashLeaf(sw, h - 0.06));
    A.add(
      frameKey,
      sash,
      LL(pm, x - w / 2 + 0.04, y, depth + 0.02, rng.range(-1.35, -0.75), 1, 1, 1),
      { masks: [0.8, 0.45, 0.2] }
    );
    if (openR) {
      A.add(
        frameKey,
        sash,
        LL(pm, x + w / 2 - 0.04, y, depth + 0.02, rng.range(0.75, 1.35), 1, 1, 1),
        { masks: [0.8, 0.45, 0.2] }
      );
    } else {
      A.add(frameKey, box, LL(pm, x, y, depth, 0, 0.045, h - 0.1, fd * 0.85), null);
    }
  }

  // ---- plywood board nailed over the opening ------------------------------
  if (boarded) {
    const n = rng.int(3, 5);
    for (let i = 0; i < n; i++) {
      const bh = (h + 0.05) / n;
      A.add(
        'plywood',
        box,
        LL(
          pm,
          x + rng.range(-0.04, 0.04),
          y - (h + 0.05) / 2 + (i + 0.5) * bh,
          depth - 0.05,
          0,
          w - 0.02,
          bh - 0.012,
          0.026,
          0,
          rng.range(-0.02, 0.02)
        ),
        { masks: [0.75, 0.55, 0.25] }
      );
    }
    // a gap left at the top where a board is missing, showing the dark room
    if (rng.float() < 0.5) {
      A.add('metal_rust', box, LL(pm, x, y + h / 2 - 0.1, depth - 0.08, 0, w * 0.5, 0.03, 0.02), {
        masks: [0.9, 0.6, 0],
      });
    }
  }

  // glass: four panes, some missing
  if (!opts.noGlass && !boarded) {
    const panes = [
      [x - w / 4, y + h * 0.33, w / 2 - 0.09, h * 0.3],
      [x + w / 4, y + h * 0.33, w / 2 - 0.09, h * 0.3],
      [x - w / 4, y - h * 0.17, w / 2 - 0.09, h * 0.6],
      [x + w / 4, y - h * 0.17, w / 2 - 0.09, h * 0.6],
    ];
    for (let i = 0; i < panes.length; i++) {
      const [px, py, pw, ph] = panes[i];
      // A swung-open leaf takes its glazing with it; the closed half keeps its.
      if (px < x ? openL : openR) continue;
      if (broken && rng.float() < 0.55) continue;
      A.add('window_glass', PANE(A), LL(pm, px, py, depth, 0, pw, ph, 1), {
        masks: [0.1, 0.3, 0],
      });
    }
    if (broken) {
      // a couple of shards still in the frame
      for (let i = 0; i < 3; i++) {
        const sw = rng.range(0.08, 0.26);
        A.add(
          'glass',
          box,
          LL(
            pm,
            x + rng.range(-w / 2 + 0.1, w / 2 - 0.1),
            y + h / 2 - sw * rng.range(0.4, 0.9),
            depth,
            0,
            sw,
            sw * rng.range(0.6, 1.4),
            0.01,
            0,
            rng.range(-0.5, 0.5)
          ),
          null
        );
      }
    }
  }

  // stone sill, protruding and dripping dirt
  if (opts.sill !== false) {
    A.add(
      'concrete',
      BOX_SOFT(A),
      LL(pm, x, y - h / 2 - 0.045, -0.045, 0, w + 0.26, 0.09, t * 0.55),
      { masks: [0.5, 0.35, 0.2] }
    );
  }
  // lintel
  if (opts.lintel !== false) {
    A.add('concrete', BOX(A), LL(pm, x, y + h / 2 + 0.055, 0.02, 0, w + 0.18, 0.11, t * 0.42), {
      masks: [0.35, 0.5, 0.3],
    });
  }

  // metal grille on some ground-floor windows
  if (opts.grille) {
    const bar = BOX_THIN(A);
    const n = Math.max(3, Math.round(w / 0.16));
    for (let i = 0; i < n; i++) {
      const gx = x - w / 2 + 0.08 + (i / (n - 1)) * (w - 0.16);
      A.add('metal_rust', bar, LL(pm, gx, y, 0.055, 0, 0.022, h - 0.06, 0.022), {
        masks: [0.8, 0.5, 0],
      });
    }
    for (let i = 0; i < 2; i++) {
      A.add(
        'metal_rust',
        bar,
        LL(pm, x, y - h / 4 + (i * h) / 2, 0.055, 0, w - 0.05, 0.022, 0.022),
        { masks: [0.8, 0.5, 0] }
      );
    }
  }

  // shutters — one closed, one hanging open at an angle
  if (opts.shutters) {
    const key = opts.shutterKey ?? 'metal_blue';
    const sw = w / 2 - 0.01;
    const louvre = A.cache(`shutter:${sw.toFixed(2)}:${h.toFixed(2)}`, () =>
      shutterLeaf(sw, h - 0.03)
    );
    // `state:'shuttered'` means shut for the afternoon — both leaves flat on the
    // reveal, which is a completely different silhouette from a half-open pair.
    const shut = state === 'shuttered';
    const swungL = shut ? false : rng.float() < 0.45;
    const swungR = shut ? false : rng.float() < 0.45;
    A.add(
      key,
      louvre,
      LL(
        pm,
        x - w / 2 + (swungL ? 0.02 : sw / 2),
        y,
        -0.03,
        swungL ? rng.range(0.9, 1.5) : 0,
        1,
        1,
        1
      ),
      { masks: [0.9, 0.4, 0] }
    );
    A.add(
      key,
      louvre,
      LL(
        pm,
        x + w / 2 - (swungR ? 0.02 : sw / 2),
        y,
        -0.03,
        swungR ? -rng.range(0.9, 1.5) : 0,
        1,
        1,
        1
      ),
      { masks: [0.9, 0.4, 0] }
    );
  }

  // interior curtain / cloth, visible from the street
  if (opts.curtain) {
    const c = clothGeometry(w * 0.92, h * 0.95, {
      segX: 7,
      segY: 7,
      sag: 0.05,
      wrinkle: 0.055,
      twist: 0.05,
      fray: 0.012,
      rng,
    });
    A.addOnce(
      opts.curtainKey ?? 'fabric_cream',
      c,
      LL(pm, x + w * 0.03, y, depth + 0.09, 0, 1, 1, 1),
      { masks: [0.1, 0.35, 0.1] }
    );
  }
  return o;
}

/**
 * A glazed casement leaf, hinged at its LEFT edge (origin on the hinge) so it can
 * be swung by a single Y rotation. Stiles, rails, a centre bar and a thin glazed
 * infill — enough that an open window shows a rectangle of frame catching the sun
 * against the dark room instead of just an empty hole.
 */
function sashLeaf(w, h) {
  const parts = [];
  const push = (sx, sy, sz, x, y, z) => {
    const g = plainBox();
    g.scale(sx, sy, sz);
    g.translate(x, y, z);
    parts.push(g);
  };
  push(0.05, h, 0.032, 0.025, 0, 0);
  push(0.05, h, 0.032, w - 0.025, 0, 0);
  push(w, 0.05, 0.032, w / 2, h / 2 - 0.025, 0);
  push(w, 0.05, 0.032, w / 2, -h / 2 + 0.025, 0);
  push(w - 0.08, 0.038, 0.026, w / 2, h * 0.14, 0);
  // the pane, inset into the rebate — a thin sheet, not a solid slab
  push(w - 0.09, h - 0.09, 0.008, w / 2, 0, -0.006);
  const merged = mergeSimple(parts);
  for (const g of parts) g.dispose();
  return merged;
}

/** A louvred shutter leaf: stiles, rails and slats. Origin at leaf centre. */
function shutterLeaf(w, h) {
  const parts = [];
  const push = (sx, sy, sz, x, y, z, rx = 0) => {
    const g = plainBox();
    g.scale(sx, sy, sz);
    const m = new THREE.Matrix4();
    _e.set(rx, 0, 0);
    _q.setFromEuler(_e);
    _p.set(x, y, z);
    _s.set(1, 1, 1);
    m.compose(_p, _q, _s);
    g.applyMatrix4(m);
    parts.push(g);
  };
  push(0.05, h, 0.035, -w / 2 + 0.025, 0, 0);
  push(0.05, h, 0.035, w / 2 - 0.025, 0, 0);
  push(w, 0.05, 0.035, 0, h / 2 - 0.025, 0);
  push(w, 0.05, 0.035, 0, -h / 2 + 0.025, 0);
  push(w, 0.05, 0.035, 0, 0, 0);
  const slats = Math.max(4, Math.floor((h - 0.16) / 0.115));
  for (let i = 0; i < slats; i++) {
    const y = -h / 2 + 0.09 + (i / (slats - 1)) * (h - 0.18);
    if (Math.abs(y) < 0.04) continue;
    push(w - 0.08, 0.06, 0.014, 0, y, 0.006, -0.5);
  }
  const merged = mergeSimple(parts);
  for (const g of parts) g.dispose();
  return merged;
}

/** Minimal geometry merge for kit sub-parts (all chamferBox, same attributes). */
export function mergeSimple(list) {
  let vc = 0;
  let ic = 0;
  for (const g of list) {
    vc += g.getAttribute('position').count;
    ic += g.index ? g.index.count : g.getAttribute('position').count;
  }
  const pos = new Float32Array(vc * 3);
  const nrm = new Float32Array(vc * 3);
  const uv = new Float32Array(vc * 2);
  const col = new Float32Array(vc * 3);
  const idx = vc > 65535 ? new Uint32Array(ic) : new Uint16Array(ic);
  let vo = 0;
  let io = 0;
  for (const g of list) {
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const u = g.getAttribute('uv');
    const c = g.getAttribute('color');
    pos.set(p.array, vo * 3);
    if (n) nrm.set(n.array, vo * 3);
    if (u) uv.set(u.array, vo * 2);
    if (c) col.set(c.array, vo * 3);
    if (g.index) {
      const a = g.index.array;
      for (let i = 0; i < a.length; i++) idx[io + i] = vo + a[i];
      io += a.length;
    } else {
      for (let i = 0; i < p.count; i++) idx[io + i] = vo + i;
      io += p.count;
    }
    vo += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}


// =============================================================== shopfront ==
/** Wide ground-floor opening with a roller shutter part-way down. */
export function shopfront(A, pm, o, rng, opts = {}) {
  const t = opts.t ?? 0.34;
  const { x, y, w, h } = o;
  const box = BOX(A);
  // lintel beam over the opening
  A.add('concrete', box, LL(pm, x, y + h / 2 + 0.11, t * 0.5, 0, w + 0.5, 0.22, t), {
    masks: [0.4, 0.55, 0.35],
  });
  // shutter housing
  A.add('metal_dark', box, LL(pm, x, y + h / 2 - 0.09, 0.06, 0, w + 0.12, 0.18, 0.16), {
    masks: [0.85, 0.5, 0.1],
  });
  const drop = opts.drop ?? rng.range(0.15, 0.85);
  if (drop > 0.02) {
    const sh = h * drop;
    const shutter = A.cache(`roller:${w.toFixed(2)}`, () => rollerShutter(w, 1));
    A.add(
      'corrugated',
      shutter,
      LL(pm, x, y + h / 2 - 0.18 - sh / 2, 0.05, 0, 1, sh, 1),
      { masks: [0.85, 0.6, 0.15] }
    );
    // collision for the closed part
    A.slabBox('metal', pm, x, y + h / 2 - 0.18 - sh / 2, w, sh, 0.12);
  }
  // stall counter in the opening
  if (opts.counter !== false) {
    A.add('wood_dark', box, LL(pm, x, 0.42, t + 0.28, 0, w * 0.82, 0.08, 0.7), {
      masks: [0.8, 0.5, 0.2],
    });
    A.add('wood_dark', box, LL(pm, x - w * 0.34, 0.21, t + 0.28, 0, 0.09, 0.42, 0.62), {
      masks: [0.7, 0.6, 0.3],
    });
    A.add('wood_dark', box, LL(pm, x + w * 0.34, 0.21, t + 0.28, 0, 0.09, 0.42, 0.62), {
      masks: [0.7, 0.6, 0.3],
    });
    A.slabBox('wood', pm, x, 0.25, w * 0.82, 0.5, t + 0.6);
  }

  /**
   * Inside dressing beside the opening. The wall a shop is seen through is the
   * biggest surface in any interior shot, and bare render there is the fastest
   * way to make an interior look like an empty box.
   */
  if (opts.inside !== false) {
    const thin = BOX_THIN(A);
    for (const sx of [-1, 1]) {
      const bx = x + sx * (w / 2 + 0.75);
      // wall shelf with goods
      const sy = 1.35 + (rng?.range ? rng.range(-0.1, 0.25) : 0);
      A.add('wood_prop', BOX_FINE(A), LL(pm, bx, sy, t + 0.17, 0, 1.3, 0.045, 0.34), {
        masks: [0.85, 0.4, 0.15],
      });
      for (const b of [-1, 1]) {
        A.add(
          'metal_rust',
          thin,
          LL(pm, bx + b * 0.5, sy - 0.12, t + 0.09, 0, 0.03, 0.24, 0.18),
          { masks: [0.9, 0.6, 0.2] }
        );
      }
      // conduit up the wall into a junction box
      A.add('metal_dark', thin, LL(pm, bx + 0.62, 1.5, t + 0.03, 0, 0.045, 2.6, 0.045), {
        masks: [0.7, 0.5, 0.2],
      });
      A.add('metal_dark', BOX_FINE(A), LL(pm, bx + 0.62, 1.42, t + 0.06, 0, 0.16, 0.22, 0.09), {
        masks: [0.8, 0.5, 0.2],
      });
    }
    // a bolt of cloth hung on the inside wall over the counter
    if (rng && rng.float() < 0.7) {
      const c = clothGeometry(rng.range(0.9, 1.5), rng.range(1.1, 1.7), {
        segX: 7,
        segY: 8,
        sag: 0.05,
        wrinkle: 0.055,
        twist: 0.06,
        thickness: 0.003,
        fray: 0.02,
        rng,
      });
      A.addOnce(
        rng.pick(['fabric_red', 'fabric_teal', 'fabric_cream']),
        c,
        LL(pm, x + (rng.float() < 0.5 ? -1 : 1) * (w / 2 + rng.range(0.9, 1.5)), 1.75, t + 0.08, Math.PI),
        { masks: [0.3, 0.45, 0.2] }
      );
    }
  }
  return o;
}

/** Corrugated roller shutter, 1 m tall, scaled by the caller. */
function rollerShutter(w, h) {
  const g = new THREE.PlaneGeometry(w, h, 2, 14);
  const pa = g.getAttribute('position');
  for (let i = 0; i < pa.count; i++) {
    const y = pa.getY(i);
    pa.setZ(i, dsin(y * 90) * 0.008);
  }
  g.computeVertexNormals();
  const g2 = g.clone();
  g2.rotateY(Math.PI);
  const out = mergeSimple([g, g2]);
  g.dispose();
  g2.dispose();
  return out;
}

