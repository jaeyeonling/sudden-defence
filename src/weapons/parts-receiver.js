import { box, latheZ, rodZ, extrude, roundRect, mergeAll } from './geometry.js';
import { dsin } from '../core/dmath.js';
import { addPin, addRail } from './parts.js';

/** Upper, lower, bolt carrier, selector, trigger, charging handle, rollmark. */

/**
 * AR-pattern upper receiver: a flat-top tube with the rail on the crest, the
 * forward assist and brass deflector at the rear right, a recessed ejection
 * port, and the charging-handle channel.
 */
export function addUpperReceiver(asm, mat, matSteel, matCavity, o) {
  const zRear = o.zRear;
  const zFront = o.zFront;
  const bore = o.bore;
  const r = o.r ?? 0.0192;
  const len = zRear - zFront;
  const cz = (zRear + zFront) / 2;

  // Main tube, flattened on top where the rail sits.
  //
  // Both ends are CLOSED (radius 0). An annular end face leaves a 19 mm hole
  // straight down the receiver, and in ADS the eye is 0.2 m behind it looking
  // right in: you see the bolt carrier and the chambered round floating in a
  // black pipe. Nothing inside the receiver is ever meant to be visible except
  // through the ejection-port cavity.
  const body = latheZ(
    [
      [0, 0],
      [0, r * 0.98],
      [0.0022, r],
      [len * 0.52, r],
      [len * 0.54, r * 0.985],
      [len - 0.004, r * 0.985],
      [len, r * 0.93],
      [len, 0],
    ],
    22
  );
  asm.add(body, mat, { y: bore, z: zRear, ry: Math.PI });
  body.dispose();

  // Flat top deck the rail is machined onto.
  const deck = box(0.0235, 0.008, len - 0.002, 0.0008, 1);
  asm.add(deck, mat, { y: bore + r - 0.0025, z: cz });
  deck.dispose();

  // Charging-handle raceway hump at the rear.
  const hump = box(0.0245, 0.011, 0.05, 0.0012, 2);
  asm.add(hump, mat, { y: bore + r - 0.0075, z: zRear - 0.024 });
  hump.dispose();

  // Forward assist boss (rear right) — a real stepped cylinder with a pad.
  const fa = latheZ(
    [
      [0, 0],
      [0, 0.0055],
      [0.0015, 0.0062],
      [0.006, 0.0062],
      [0.007, 0.0048],
      [0.019, 0.0048],
      [0.019, 0],
    ],
    14
  );
  asm.add(fa, mat, { x: 0.0115, y: bore - 0.004, z: zRear - 0.006, rz: 0, ry: 0, rx: 0.35 });
  fa.dispose();
  const faPad = box(0.0085, 0.0085, 0.0035, 0.0008, 2);
  asm.add(faPad, matSteel, { x: 0.0132, y: bore - 0.0025, z: zRear + 0.0025, rx: 0.35 });
  faPad.dispose();

  // Brass deflector: the little wedge behind the port.
  const defl = extrude(
    [
      [0, 0],
      [0.013, 0.004],
      [0.013, 0.019],
      [0, 0.017],
    ],
    0.016,
    { bevel: 0.0009 }
  );
  asm.add(defl, mat, { x: r - 0.001, y: bore - 0.006, z: zRear - 0.045, ry: Math.PI / 2 });
  defl.dispose();

  // Ejection port: a recessed cavity with a hinged dust cover just below.
  const portW = 0.032;
  const portH = 0.019;
  const cav = box(portH, 0.012, portW, 0.0008, 1);
  asm.add(cav, matCavity, { x: r - 0.0075, y: bore + 0.001, z: o.portZ, ry: Math.PI / 2 });
  cav.dispose();
  // port lip
  const lip = extrude(roundRect(portW + 0.005, portH + 0.005, 0.0022, 3), 0.0022, { bevel: 0.0006 });
  const lipInner = extrude(roundRect(portW, portH, 0.0018, 3), 0.003, { bevel: 0.0005 });
  asm.add(lip, mat, { x: r - 0.0022, y: bore + 0.001, z: o.portZ, ry: Math.PI / 2 });
  asm.add(lipInner, matCavity, { x: r - 0.0042, y: bore + 0.001, z: o.portZ, ry: Math.PI / 2 });
  lip.dispose();
  lipInner.dispose();

  /**
   * DUST COVER, hung open.
   *
   * The port on its own is a dark rectangle and reads as a decal. What makes it
   * read as a mechanism is the cover: a stamped panel with a RAISED LIP around
   * three edges (that lip is the stiffening flange, and it is the only part of
   * the cover that ever catches a highlight), sprung open on a hinge rod below
   * the port so it hangs down and rearward off the receiver flank. Two separate
   * masses — the rod and the flanged panel — where there used to be none.
   */
  const hingeY = bore - 0.0092;
  const hingeX = r - 0.0035;
  const rod = rodZ(0.0016, 0.0016, portW + 0.014, 10, 0.0003);
  asm.add(rod, matSteel, { x: hingeX, y: hingeY, z: o.portZ });
  rod.dispose();
  // The panel swings open about the rod: 1.35 rad puts it hanging down-outboard,
  // clear of the magwell, which is where a sprung cover actually sits.
  const coverOpen = 1.35;
  const coverParts = [];
  const panel = box(portH + 0.004, 0.0014, portW + 0.006, 0.0005, 1);
  coverParts.push(panel);
  // Stiffening flange: proud 1.2 mm on the two long edges and the free edge.
  for (const sz of [-1, 1]) {
    const f = box(portH + 0.004, 0.0032, 0.0016, 0.0004, 1);
    f.translate(0, 0.0009, sz * (portW * 0.5 + 0.0022));
    coverParts.push(f);
  }
  const freeEdge = box(0.0018, 0.0034, portW + 0.006, 0.0004, 1);
  freeEdge.translate((portH + 0.004) * 0.5 - 0.0009, 0.001, 0);
  coverParts.push(freeEdge);
  const cover = mergeAll(coverParts);
  // Author it lying in the XZ plane hinged along -X, then swing it open.
  cover.translate((portH + 0.004) * 0.5, 0, 0);
  cover.rotateZ(-coverOpen);
  asm.add(cover, mat, { x: hingeX, y: hingeY, z: o.portZ });
  cover.dispose();

  // Rail on the crest.
  addRail(asm, mat, zFront + 0.002, zRear - 0.002, o.railTop);

  // Receiver pins.
  addPin(asm, matSteel, 0, bore - r + 0.004, zFront + 0.014, 0.0024, r * 2 - 0.004);
  return { railTop: o.railTop };
}

/**
 * Bolt carrier group seen through the ejection port, and the case in the
 * chamber. Returned as its own assembly because it cycles.
 */
export function addBoltCarrier(asm, matSteel, o) {
  const y = o.y ?? 0;
  const r = o.r ?? 0.0155;
  const len = o.len ?? 0.09;
  const body = latheZ(
    [
      [0, r * 0.6],
      [0, r],
      [0.002, r + 0.0004],
      [len * 0.45, r + 0.0004],
      [len * 0.47, r],
      [len, r],
      [len, r * 0.5],
    ],
    18
  );
  asm.add(body, matSteel, { y, z: o.z, ry: Math.PI });
  body.dispose();
  // cam pin track + gas key
  const key = box(0.011, 0.0075, 0.016, 0.0006, 1);
  asm.add(key, matSteel, { y: y + r + 0.0026, z: o.z + len * 0.25 });
  key.dispose();
  const lug = box(0.006, 0.005, 0.03, 0.0005, 1);
  asm.add(lug, matSteel, { x: r * 0.78, y: y + r * 0.42, z: o.z + len * 0.1, rz: 0.5 });
  lug.dispose();
}

/**
 * AR lower receiver: magwell, trigger guard, grip boss, selector, mag release,
 * bolt catch, takedown pins.
 */
export function addLowerReceiver(asm, mat, matSteel, o) {
  const bore = o.bore;
  const zRear = o.zRear;
  const zFront = o.zFront;
  const w = o.w ?? 0.0245;
  const magW = o.magW ?? 0.0295;
  const magD = o.magD ?? 0.0685;
  const magTop = o.magTop ?? bore - 0.014;
  const magBottom = o.magBottom ?? bore - 0.062;
  const magZ = o.magZ;
  const magTilt = o.magTilt ?? 0.09;

  // Receiver body — the flat-sided box under the upper.
  const bodyH = 0.026;
  const bodyG = box(w, bodyH, zRear - zFront, 0.0016, 2);
  asm.add(bodyG, mat, { y: bore - 0.014, z: (zRear + zFront) / 2 });
  bodyG.dispose();

  // Magwell: a genuinely hollow tube (so the well is a hole when the magazine
  // drops out during a reload), tilted forward like the real one.
  const wellH = magTop - magBottom;
  const well = extrude(roundRect(magW, magD, 0.0075, 5), wellH, {
    bevel: 0.0012,
    holes: [roundRect(magW - 0.005, magD - 0.005, 0.006, 5)],
  });
  asm.add(well, mat, {
    y: (magTop + magBottom) / 2,
    z: magZ,
    rx: Math.PI / 2 + magTilt,
  });
  well.dispose();
  const liner = extrude(roundRect(magW - 0.0052, magD - 0.0052, 0.006, 5), wellH - 0.004, {
    bevel: 0.0006,
    holes: [roundRect(magW - 0.0082, magD - 0.0082, 0.005, 5)],
  });
  asm.add(liner, 'cavity', {
    y: (magTop + magBottom) / 2,
    z: magZ,
    rx: Math.PI / 2 + magTilt,
  });
  liner.dispose();
  const mouth = extrude(roundRect(magW + 0.004, magD + 0.005, 0.008, 5), 0.006, {
    bevel: 0.0012,
    holes: [roundRect(magW - 0.003, magD - 0.003, 0.006, 5)],
  });
  asm.add(mouth, mat, {
    y: magBottom + 0.002,
    z: magZ + dsin(magTilt) * wellH * 0.5,
    rx: Math.PI / 2 + magTilt,
  });
  mouth.dispose();

  // Rear takedown lug + buffer tower.
  const tower = box(w - 0.001, 0.03, 0.026, 0.0014, 2);
  asm.add(tower, mat, { y: bore - 0.0155, z: zRear - 0.012 });
  tower.dispose();

  // Trigger guard: a bevelled loop under the receiver.
  //
  // The outline is authored in the weapon's SIDE plane — the first coordinate is
  // fore/aft, the second is up/down — and then rotated so the extrusion runs
  // across the receiver. Extruding the outline straight out of the XY plane
  // would stand the loop up across the gun like a trigger-shaped cattle guard,
  // which is invisible from the side and wrong from every other angle.
  // +X in the outline is the muzzle side, so it maps to -Z below.
  const guardOuter = [
    [-0.028, 0],
    [0.03, 0],
    [0.032, -0.006],
    [0.028, -0.0225],
    [0.018, -0.0275],
    [-0.02, -0.0275],
    [-0.028, -0.021],
  ];
  const guardInner = [
    [-0.0225, -0.003],
    [0.0245, -0.003],
    [0.0255, -0.008],
    [0.022, -0.0205],
    [0.015, -0.0235],
    [-0.0165, -0.0235],
    [-0.0225, -0.019],
  ];
  const guard = extrude(guardOuter, 0.0172, {
    bevel: 0.0011,
    bevelSegments: 2,
    holes: [guardInner],
  });
  guard.rotateY(Math.PI / 2); // outline-X -> -Z (forward), extrusion -> across
  asm.add(guard, mat, { y: bore - 0.026, z: o.triggerZ });
  guard.dispose();

  // Grip boss + screw.
  const bossG = box(0.028, 0.012, 0.03, 0.0012, 2);
  asm.add(bossG, mat, { y: bore - 0.0255, z: zRear - 0.028, rx: -o.gripAngle * 0.5 });
  bossG.dispose();

  // Selector lever: a real paddle with a detent boss, both sides.
  return { magTop, magBottom, magZ, magTilt, wellH, magW, magD };
}

/** Ambidextrous safety selector — the paddle rotates around the X axis. */
export function selectorPart(matAlu, matSteel, r = 0.006) {
  const parts = [];
  const shaft = rodZ(r * 0.62, r * 0.62, 0.03, 12, 0.0004);
  shaft.rotateY(Math.PI / 2);
  parts.push(shaft);
  const boss = latheZ(
    [
      [0, 0],
      [0, r],
      [0.0012, r * 1.1],
      [0.005, r * 1.1],
      [0.005, 0],
    ],
    12
  );
  boss.rotateY(-Math.PI / 2);
  boss.translate(0.0135, 0, 0);
  parts.push(boss);
  const paddle = extrude(
    [
      [0, -0.0035],
      [0.021, -0.006],
      [0.024, 0.0],
      [0.02, 0.005],
      [0, 0.0045],
    ],
    0.0042,
    { bevel: 0.0008 }
  );
  paddle.rotateY(Math.PI / 2);
  paddle.translate(0.0185, 0, 0);
  parts.push(paddle);
  return { geo: mergeAll(parts), mat: matAlu };
}

/**
 * Curved trigger blade with a serrated face; pivots about its pin.
 *
 * The outline is a SIDE view: +X is rearward (the face the finger presses),
 * -Y is down. The whole blade is rotated at the end so that outline-X becomes
 * +Z and the 7 mm extrusion becomes the blade's width across the receiver —
 * without that the blade is a plate standing across the trigger guard.
 */
export function triggerPart(matSteel) {
  const blade = extrude(
    [
      [-0.0045, 0.0045],
      [0.0048, 0.0045],
      [0.0056, -0.008],
      [0.0044, -0.0158],
      [0.0016, -0.0202],
      [-0.0032, -0.0192],
      [-0.0055, -0.011],
      [-0.006, -0.002],
    ],
    0.0072,
    { bevel: 0.0007, bevelSegments: 2 }
  );
  const parts = [blade];
  // Serrations across the face the finger pad sits on.
  for (let i = 0; i < 6; i++) {
    const g = box(0.0015, 0.0011, 0.0066, 0.0003, 1);
    // Spin in place first, THEN place: rotating after the translate would swing
    // the serration around the blade's pivot instead of tilting it.
    g.rotateZ(-0.2 - i * 0.05);
    g.translate(0.0049 - i * 0.0004, -0.0045 - i * 0.0026, 0);
    parts.push(g);
  }
  const geo = mergeAll(parts);
  geo.rotateY(-Math.PI / 2); // outline-X -> +Z (rearward), extrusion -> across
  return { geo, mat: matSteel };
}

/* -------------------------------------------------------------------------- */
/*  grip / stock                                                              */
/* -------------------------------------------------------------------------- */


/**
 * Engraved rollmark / calibre stamp.
 *
 * A machined receiver always carries one, and it is one of the very few cues that
 * tells the eye the surface is metal that has been through a press rather than a
 * moulded shell. It is modelled as real recessed strokes in the part's own local
 * space — not a projected decal — precisely because the viewmodel translates and
 * rotates every frame: anything sampled in world space swims across the receiver.
 *
 * At 0.35 m a 4 mm rollmark is ~12 px tall, so what has to be right is the RHYTHM
 * of the strokes and the underline, not the letterforms. The pattern is fixed, so
 * the mark is byte-identical every boot (capture reproducibility).
 */
export function addRollmark(asm, mat, o) {
  const h = o.h ?? 0.0036;
  const stroke = o.stroke ?? 0.0006;
  const depth = o.depth ?? 0.0008;
  const pitch = o.pitch ?? 0.0017;
  const pat = o.pattern ?? [3, 2, 3, 3, 1, 0, 2, 3, 2, 3, 0, 3, 1, 2, 3, 2, 0, 3, 3, 2];
  const n = o.count ?? pat.length;
  const parts = [];
  for (let i = 0; i < n; i++) {
    const p = pat[i % pat.length];
    if (p === 0) continue;
    const bh = h * (0.52 + p * 0.16);
    const b = box(depth, bh, stroke, 0.00008, 1);
    b.translate(0, (h - bh) * 0.5, -i * pitch);
    parts.push(b);
    if (p === 3) {
      // a crossbar, so a run of strokes reads as letters and not as a comb
      const c = box(depth, stroke * 0.85, pitch * 0.72, 0.00008, 1);
      c.translate(0, (h - bh) * 0.5 + bh * 0.16, -i * pitch - pitch * 0.3);
      parts.push(c);
    }
  }
  const line = box(depth, stroke * 0.9, (n - 1) * pitch, 0.00008, 1);
  line.translate(0, -h * 0.55, -(n - 1) * pitch * 0.5);
  parts.push(line);
  const g = mergeAll(parts);
  if (o.sx) g.scale(o.sx, 1, 1);
  asm.add(g, mat, { x: o.x, y: o.y, z: o.z });
  g.dispose();
}


/** AR charging handle: latch, T-bar, ridged wings. Moves as one part. */
export function chargingHandlePart() {
  const parts = [];
  const bar = box(0.028, 0.0055, 0.052, 0.0008, 1);
  bar.translate(0, 0, 0.012);
  parts.push(bar);
  const shaftG = rodZ(0.0055, 0.0055, 0.07, 12, 0.0005);
  shaftG.translate(0, -0.0022, -0.02);
  parts.push(shaftG);
  // T-handle wings with grip ridges
  const wing = extrude(
    [
      [0, -0.005],
      [0.02, -0.0075],
      [0.024, -0.002],
      [0.024, 0.004],
      [0.0, 0.004],
    ],
    0.0055,
    { bevel: 0.0007 }
  );
  const wR = wing.clone();
  wR.rotateY(Math.PI / 2);
  wR.rotateZ(0);
  wR.translate(0.012, 0.0, 0.034);
  parts.push(wR);
  const wL = wing.clone();
  wL.rotateY(-Math.PI / 2);
  wL.translate(-0.012, 0.0, 0.034);
  parts.push(wL);
  wing.dispose();
  for (let i = 0; i < 3; i++) {
    for (const sx of [-1, 1]) {
      const r = box(0.0022, 0.0075, 0.0016, 0.0003, 1);
      r.translate(sx * (0.017 + i * 0.003), 0.0, 0.031 + i * 0.0022);
      parts.push(r);
    }
  }
  /**
   * THE LATCH. A charging handle without one is a T-shaped tab and reads as a
   * moulded lug; the latch is what says "this part is a mechanism that has to be
   * released before it moves". It is a separate hooked lever on the LEFT wing —
   * the side that faces the camera in the hipfire pose — pivoting on a visible
   * roll pin, with the hook standing proud of the wing so it breaks the
   * silhouette rather than being a groove in it.
   */
  const latchBody = extrude(
    [
      [0, -0.0032],
      [0.0165, -0.0042],
      [0.0205, -0.0018],
      [0.0205, 0.0026],
      [0.0155, 0.0042],
      [0, 0.0034],
    ],
    0.0042,
    { bevel: 0.0006 }
  );
  latchBody.rotateY(-Math.PI / 2);
  latchBody.translate(-0.0125, 0.0012, 0.0335);
  parts.push(latchBody);
  // The hook that engages the receiver shelf: proud 1.6 mm, pointing forward.
  const hook = box(0.0038, 0.0052, 0.0032, 0.0005, 1);
  hook.translate(-0.0295, 0.0006, 0.0292);
  parts.push(hook);
  // Pivot pin through the wing, and the finger pad on the lever's tail.
  const pin = rodZ(0.0011, 0.0011, 0.0072, 8, 0.0002);
  pin.rotateY(Math.PI / 2);
  pin.translate(-0.0135, 0.0012, 0.0356);
  parts.push(pin);
  const pad = box(0.0028, 0.0062, 0.0075, 0.0004, 1);
  pad.translate(-0.0316, 0.0014, 0.0345);
  parts.push(pad);
  return mergeAll(parts);
}

