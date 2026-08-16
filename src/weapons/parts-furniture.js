import { box, blob, latheZ, tubeZ, dome, extrude, roundRect, mergeAll } from './geometry.js';
import { dcos, dsin } from '../core/dmath.js';
import { TAU, addScrew, addQdSocket, addSlingLoop } from './parts.js';

/** Grip, stock, fore grip, slide. */

/**
 * Pistol grip with a palm swell, finger grooves, a beavertail and moulded
 * texture panels. Built along its own axis then rotated by `angle`.
 */
export function addPistolGrip(asm, matPoly, matRubber, o) {
  const len = o.len ?? 0.108;
  const w = o.w ?? 0.031;
  const angle = o.angle ?? 0.38; // rake: positive tilts the BOTTOM rearward
  const oy = o.y ?? 0;
  const oz = o.z ?? 0;

  // Side profile in (z, y), authored as one closed outline and extruded across
  // the grip's width. A single solid cannot develop the seams a lofted stack of
  // slices does, and the outline is where the shape actually lives: a swept
  // front strap with finger relief, a straight back strap, a beavertail.
  const zf = -0.0155; // front strap
  const zb = 0.0155; // back strap
  const profile = [
    [zb + 0.004, 0.008],
    [zf - 0.002, 0.007],
    [zf - 0.0035, -0.006],
    [zf - 0.0015, -0.02],
    [zf - 0.003, -0.034],
    [zf - 0.0005, -0.05],
    [zf - 0.002, -0.064],
    [zf + 0.001, -0.08],
    [zf + 0.0035, -len + 0.004],
    [zf + 0.008, -len],
    [zb - 0.006, -len],
    [zb - 0.001, -len + 0.006],
    [zb + 0.001, -0.06],
    [zb + 0.0025, -0.03],
    [zb + 0.006, -0.012],
  ];
  const core = extrude(profile, w, { bevel: 0.0035, bevelSegments: 3, curveSegments: 4 });
  core.rotateY(Math.PI / 2);
  asm.add(core, matPoly, { y: oy, z: oz, rx: -angle });
  core.dispose();

  // Palm swell on both flanks so the grip is not a slab.
  const swell = blob(0.008, len * 0.62, 0.03, 0.006, 3);
  for (const sx of [-1, 1]) {
    asm.add(swell, matPoly, {
      x: sx * (w * 0.5 - 0.0015),
      y: oy - len * 0.42,
      z: oz + 0.0035,
      rx: -angle,
    });
  }
  swell.dispose();

  // Beavertail behind the trigger, blending into the receiver.
  const beaver = blob(w * 0.96, 0.02, 0.024, 0.006, 3);
  asm.add(beaver, matPoly, { y: oy + 0.005, z: oz + 0.012, rx: -angle * 0.6 });
  beaver.dispose();

  // Rubberised over-mould: side panels plus the front-strap finger swells.
  const panel = blob(w * 1.03, len * 0.58, 0.019, 0.005, 3);
  asm.add(panel, matRubber, { y: oy - len * 0.44, z: oz + 0.0025, rx: -angle });
  panel.dispose();
  // Finger swells on the front strap: shallow cross-wise ridges, not rings.
  for (let i = 0; i < 4; i++) {
    const t = 0.15 + i * 0.2;
    const ridge = blob(w * 0.9, 0.011, 0.007, 0.003, 3);
    const yy = oy - t * len;
    const zz = oz + zf + 0.001 + dsin(t * Math.PI) * 0.001;
    // Rotate into the raked frame by hand so the ridge hugs the strap.
    const cs = dcos(-angle);
    const sn = dsin(-angle);
    asm.add(ridge, matRubber, {
      y: oy + (yy - oy) * cs - (zz - oz) * sn,
      z: oz + (yy - oy) * sn + (zz - oz) * cs,
      rx: -angle,
    });
    ridge.dispose();
  }

  // Grip cap with its screw.
  const capY = oy - dcos(angle) * len;
  const capZ = oz + dsin(angle) * len;
  const cap = blob(w * 0.92, 0.007, 0.031, 0.0025, 2);
  asm.add(cap, matPoly, { y: capY + 0.001, z: capZ, rx: -angle });
  cap.dispose();
  addScrew(asm, matRubber, 0, capY - 0.0015, capZ, 0.0026, 'y', 0.006);
}

/**
 * Collapsible carbine stock on a mil-spec receiver extension: 6 detent
 * positions, cheek weld, sling loop, adjustment lever and a rubber butt pad.
 */
export function addCarbineStock(asm, matAlu, matPoly, matRubber, o) {
  const bore = o.bore;
  const zRear = o.zRear; // butt
  const zFront = o.zFront; // receiver face
  const yAxis = o.y ?? bore - 0.012;
  const tubeR = 0.0146;
  const len = zRear - zFront;

  // receiver extension
  const ext = tubeZ(tubeR, tubeR - 0.0022, len - 0.004, 18, 0.0004);
  asm.add(ext, matAlu, { y: yAxis, z: (zRear + zFront) / 2 });
  ext.dispose();
  // castle nut + end plate
  const nut = latheZ(
    [
      [0, tubeR],
      [0, tubeR + 0.0034],
      [0.0016, tubeR + 0.0038],
      [0.0085, tubeR + 0.0038],
      [0.01, tubeR + 0.003],
      [0.01, tubeR],
    ],
    18
  );
  asm.add(nut, matAlu, { y: yAxis, z: zFront });
  nut.dispose();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    const notch = box(0.0022, 0.0034, 0.006, 0.0004, 1);
    notch.translate(0, tubeR + 0.0032, 0);
    notch.rotateZ(a);
    notch.translate(0, yAxis, zFront + 0.005);
    asm.add(notch, matAlu, {});
    notch.dispose();
  }
  // detent notches along the bottom of the tube
  for (let i = 0; i < 6; i++) {
    const z = zFront + 0.026 + i * 0.018;
    if (z > zRear - 0.02) break;
    const n = box(0.0075, 0.0032, 0.0075, 0.0006, 1);
    asm.add(n, matAlu, { y: yAxis - tubeR + 0.0008, z });
    n.dispose();
  }

  // Stock body: a side profile extruded across the width, so the comb slopes
  // and the toe kicks down the way a collapsible carbine stock actually does.
  const bodyLen = 0.104;
  const bz = zRear - bodyLen / 2;
  const combY = yAxis + 0.026;
  const toeY = yAxis - 0.042;
  const outline = [
    [-bodyLen * 0.5, yAxis + 0.004],
    [-bodyLen * 0.5 + 0.012, yAxis + 0.017],
    [-bodyLen * 0.5 + 0.03, combY - 0.002],
    [bodyLen * 0.5 - 0.012, combY],
    [bodyLen * 0.5, combY - 0.006],
    [bodyLen * 0.5, toeY + 0.008],
    [bodyLen * 0.5 - 0.008, toeY],
    [-bodyLen * 0.5 + 0.028, toeY + 0.006],
    [-bodyLen * 0.5 + 0.008, yAxis - 0.02],
    [-bodyLen * 0.5, yAxis - 0.009],
  ];
  const shellParts = [];
  const shell = extrude(outline, 0.043, { bevel: 0.0035, bevelSegments: 2 });
  shell.rotateY(Math.PI / 2);
  shellParts.push(shell);
  // Cheek weld ridge along the comb.
  const cheek = blob(0.047, 0.012, bodyLen * 0.66, 0.005, 3);
  cheek.translate(0, combY - 0.002, -0.006);
  shellParts.push(cheek);
  // Lightening scallops on both flanks.
  for (const sx of [-1, 1]) {
    const sc = blob(0.005, 0.024, 0.052, 0.005, 3);
    sc.translate(sx * 0.0205, yAxis - 0.012, 0.004);
    shellParts.push(sc);
  }
  const body = mergeAll(shellParts);
  asm.add(body, matPoly, { z: bz });
  body.dispose();

  // adjustment lever under the stock
  const lever = extrude(
    [
      [-0.014, 0],
      [0.016, 0],
      [0.018, -0.007],
      [0.012, -0.011],
      [-0.012, -0.011],
      [-0.016, -0.005],
    ],
    0.014,
    { bevel: 0.0008 }
  );
  asm.add(lever, matPoly, { y: yAxis - 0.036, z: bz + 0.012 });
  lever.dispose();

  // Butt pad — rubber, with real grooves, following the comb-to-toe rake.
  const pad = blob(0.045, 0.072, 0.013, 0.0045, 3);
  asm.add(pad, matRubber, { y: yAxis - 0.008, z: zRear - 0.004, rx: 0.06 });
  pad.dispose();
  for (let i = 0; i < 5; i++) {
    const g = box(0.043, 0.0035, 0.005, 0.0012, 2);
    asm.add(g, matRubber, { y: yAxis + 0.02 - i * 0.0125, z: zRear + 0.0026, rx: 0.06 });
    g.dispose();
  }

  // sling loop + QD socket
  addSlingLoop(asm, matAlu, 0.0225, yAxis - 0.026, bz - 0.03, 0.0075, { ry: Math.PI / 2 });
  addQdSocket(asm, matPoly, matAlu, -0.0215, yAxis - 0.014, bz - 0.026, 'x', 0.005);
}

/* -------------------------------------------------------------------------- */
/*  magazine                                                                  */
/* -------------------------------------------------------------------------- */


/** Vertical / angled foregrip for the SMG. */
export function addForeGrip(asm, matPoly, matRubber, o) {
  const len = o.len ?? 0.062;
  const parts = [];
  for (let i = 0; i < 5; i++) {
    const t = i / 4;
    const g = blob(0.026 - t * 0.003, len / 5 + 0.003, 0.03 - t * 0.004, 0.005, 3);
    g.translate(0, -t * len, t * 0.008);
    parts.push(g);
  }
  const core = mergeAll(parts);
  asm.add(core, matPoly, { y: o.y, z: o.z, rx: o.angle ?? 0.25 });
  core.dispose();
  const gripParts = [];
  for (let i = 0; i < 4; i++) {
    const t = 0.15 + i * 0.23;
    const gr = box(0.024, 0.006, 0.0055, 0.002, 2);
    gr.translate(0, -t * len, -0.013);
    gripParts.push(gr);
  }
  const grips = mergeAll(gripParts);
  asm.add(grips, matRubber, { y: o.y, z: o.z, rx: o.angle ?? 0.25 });
  grips.dispose();
}


/**
 * Pistol slide: a machined block with front and rear grasping serrations, a
 * lightening cut, the ejection port, a chamber hood, sight dovetails and a
 * breech face. Built in slide space with the origin at the bore axis, so the
 * rig can cycle it straight back along +Z.
 */
export function buildSlide(asm, o) {
  const w = o.w ?? 0.0262;
  const h = o.h ?? 0.0248;
  const len = o.len ?? 0.183;
  const mat = o.mat ?? 'steel';
  const zRear = o.zRear ?? 0.052;
  const zFront = zRear - len;
  const cz = (zRear + zFront) / 2;
  const bore = 0;

  // Main body: chamfered block with a top rib.
  const bodyG = box(w, h, len, 0.0016, 2);
  asm.add(bodyG, mat, { y: bore + 0.0015, z: cz });
  bodyG.dispose();
  const rib = box(w - 0.008, 0.004, len - 0.02, 0.0012, 2);
  asm.add(rib, mat, { y: bore + h * 0.5 + 0.0025, z: cz - 0.004 });
  rib.dispose();
  // front taper / nose bevel
  const nose = extrude(
    [
      [-w * 0.5, -h * 0.5],
      [w * 0.5, -h * 0.5],
      [w * 0.5, h * 0.34],
      [w * 0.36, h * 0.5],
      [-w * 0.36, h * 0.5],
      [-w * 0.5, h * 0.34],
    ],
    0.016,
    { bevel: 0.0012 }
  );
  asm.add(nose, mat, { y: bore + 0.0015, z: zFront + 0.008 });
  nose.dispose();

  // Grasping serrations, front and rear.
  for (const [z0, count] of [
    [zRear - 0.006, 7],
    [zFront + 0.03, 5],
  ]) {
    for (let i = 0; i < count; i++) {
      const z = z0 - i * 0.0052;
      const g = box(w + 0.0006, h * 0.62, 0.0026, 0.0006, 1);
      asm.add(g, mat, { y: bore + 0.0015, z });
      g.dispose();
    }
  }

  // Lightening cuts on the flanks.
  for (const sx of [-1, 1]) {
    const cut = extrude(roundRect(0.042, h * 0.4, 0.004, 3), 0.0016, { bevel: 0.0005 });
    asm.add(cut, mat, { x: sx * (w * 0.5 - 0.0004), y: bore + 0.001, z: cz - 0.012, ry: Math.PI / 2 });
    cut.dispose();
  }

  // Ejection port with a real cavity and a chamber hood.
  const portW = 0.036;
  const portH = 0.0135;
  const cav = box(0.01, portH, portW, 0.0008, 1);
  asm.add(cav, 'cavity', { x: w * 0.5 - 0.006, y: bore + 0.004, z: zRear - 0.05, ry: Math.PI / 2 });
  cav.dispose();
  const lip = extrude(roundRect(portW + 0.004, portH + 0.004, 0.002, 3), 0.002, {
    bevel: 0.0005,
    holes: [roundRect(portW, portH, 0.0016, 3)],
  });
  asm.add(lip, mat, { x: w * 0.5 - 0.0009, y: bore + 0.004, z: zRear - 0.05, ry: Math.PI / 2 });
  lip.dispose();

  // Breech face + extractor.
  const breech = box(w - 0.006, h - 0.008, 0.004, 0.0008, 1);
  asm.add(breech, 'steel_bright', { y: bore + 0.001, z: zRear - 0.032 });
  breech.dispose();

  // Sights: front post with a dot, rear notch with two.
  const rear = extrude(
    [
      [-0.009, 0],
      [0.009, 0],
      [0.009, 0.0055],
      [0.0022, 0.0055],
      [0.0022, 0.0022],
      [-0.0022, 0.0022],
      [-0.0022, 0.0055],
      [-0.009, 0.0055],
    ],
    0.0055,
    { bevel: 0.0004 }
  );
  asm.add(rear, 'steel_bright', { y: bore + h * 0.5 + 0.0045, z: zRear - 0.012 });
  rear.dispose();
  for (const sx of [-1, 1]) {
    const dot = dome(0.0011, 8, 0.5);
    asm.add(dot, 'steel_bright', { x: sx * 0.0055, y: bore + h * 0.5 + 0.0075, z: zRear - 0.0148, ry: Math.PI });
    dot.dispose();
  }
  const front = box(0.0035, 0.0062, 0.0042, 0.0004, 1);
  asm.add(front, 'steel_bright', { y: bore + h * 0.5 + 0.0055, z: zFront + 0.014 });
  front.dispose();
  const fdot = dome(0.0013, 8, 0.5);
  asm.add(fdot, 'steel_bright', { y: bore + h * 0.5 + 0.0058, z: zFront + 0.0118, ry: Math.PI });
  fdot.dispose();

  return { zRear, zFront, w, h, len, sightY: bore + h * 0.5 + 0.0065 };
}

