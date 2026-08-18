import { box, latheZ, tubeZ, knurlBand, mlokSlot, mergeAll } from './geometry.js';
import { dcos, dsin } from '../core/dmath.js';
import { TAU, MUZZLE_LEN, addScrew } from './parts.js';

/** Barrel, gas block, muzzle device, handguard. */

/**
 * Stepped barrel with a chamber shoulder, a gas journal and a knurled section.
 * Returns the muzzle Z so the device can be bolted onto the crown.
 */
export function addBarrel(asm, matSteel, matCavity, o) {
  const y = o.y ?? 0;
  const zBreech = o.zBreech;
  const zMuzzle = o.zMuzzle;
  const rChamber = o.rChamber ?? 0.0112;
  const rBore = o.rBarrel ?? 0.0072;
  const rGas = o.rGas ?? 0.0092;
  const len = zBreech - zMuzzle;
  const gasAt = o.gasAt ?? zMuzzle + len * 0.34;

  const profile = [
    [0, 0],
    [0, rChamber + 0.0018],
    [0.004, rChamber + 0.0022],
    [0.02, rChamber + 0.0022],
    [0.022, rChamber],
    [len * 0.24, rChamber],
    [len * 0.26, rBore + 0.0012],
    [zBreech - gasAt - 0.012, rBore + 0.0012],
    [zBreech - gasAt - 0.01, rGas],
    [zBreech - gasAt + 0.012, rGas],
    [zBreech - gasAt + 0.014, rBore],
    [len - 0.014, rBore],
    [len - 0.012, rBore + 0.0009],
    [len - 0.001, rBore + 0.0009],
    [len, rBore * 0.72],
  ];
  // Authored from the breech forward; flip so +axial runs toward -Z.
  const g = latheZ(profile, o.seg ?? 22);
  asm.add(g, matSteel, { y, z: zBreech, ry: Math.PI });
  g.dispose();

  // Bore: a real dark tube so the crown does not read as a painted dot.
  const bore = tubeZ(rBore * 0.7, rBore * 0.42, len * 0.5, 14, 0.0002);
  asm.add(bore, matCavity, { y, z: zMuzzle + len * 0.25 });
  bore.dispose();

  // Knurled section behind the muzzle threads.
  if (o.knurl !== false) {
    const k = knurlBand(rBore + 0.0006, 0.012, 26, 0.00035, 3);
    asm.add(k, matSteel, { y, z: zMuzzle + 0.026 });
    k.dispose();
  }
  return { gasAt, rBore };
}

/**
 * Gas block + gas tube. Low-profile block with two set screws and the tube
 * running back over the barrel into the receiver.
 */
export function addGasBlock(asm, matSteel, o) {
  const y = o.y ?? 0;
  const z = o.z;
  const r = o.rBarrel ?? 0.0072;
  const w = o.w ?? 0.021;
  const h = o.h ?? 0.019;
  const bodyG = box(w, h, o.len ?? 0.026, 0.0008, 2);
  asm.add(bodyG, matSteel, { y: y - 0.0015, z });
  bodyG.dispose();
  addScrew(asm, matSteel, 0, y - h / 2 + 0.0015, z - 0.007, 0.0022, 'y', 0.006);
  addScrew(asm, matSteel, 0, y - h / 2 + 0.0015, z + 0.007, 0.0022, 'y', 0.006);
  // gas tube back to the receiver
  const tubeLen = o.tubeTo - z;
  const t = tubeZ(0.0026, 0.0014, Math.abs(tubeLen), 10, 0.0002);
  asm.add(t, matSteel, { y: y + r + 0.0052, z: z + tubeLen / 2 });
  t.dispose();
}

/**
 * Muzzle devices. All of them get a real bore, a crush washer, chamfered ports
 * and a crowned exit — the muzzle is the part the player stares at while firing.
 */
export function addMuzzleDevice(asm, matSteel, matCavity, kind, zBarrelEnd, rBarrel, y = 0) {
  const parts = [];
  const len = MUZZLE_LEN[kind] ?? 0.05;
  const rOut = rBarrel + 0.0038;
  // The device threads onto the barrel, so its rear face sits at the barrel end
  // and the crown ends up `len` further forward.
  const zCrown = zBarrelEnd - len;

  if (kind === 'brake') {
    parts.push(
      latheZ(
        [
          [0, rBarrel + 0.0012],
          [0.006, rBarrel + 0.0022],
          [0.008, rOut],
          [len - 0.01, rOut],
          [len - 0.008, rOut * 0.96],
          [len - 0.002, rOut * 0.96],
          [len, rOut * 0.8],
          [len, rBarrel * 0.66],
          [len - 0.006, rBarrel * 0.62],
        ],
        20
      )
    );
    // three pairs of side ports, chamfered, plus a top pair for muzzle rise
    for (let i = 0; i < 3; i++) {
      const z = 0.016 + i * 0.013;
      const port = box(rOut * 2.4, 0.0055, 0.0072, 0.0006, 1);
      const g1 = port.clone();
      g1.translate(0, 0, z);
      parts.push(g1);
      port.dispose();
    }
  } else if (kind === 'a2') {
    // A2 birdcage: closed bottom, five slots
    parts.push(
      latheZ(
        [
          [0, rBarrel + 0.001],
          [0.005, rBarrel + 0.002],
          [0.007, rOut * 0.92],
          [0.012, rOut],
          [len - 0.004, rOut],
          [len, rOut * 0.86],
          [len, rBarrel * 0.6],
          [len - 0.005, rBarrel * 0.58],
        ],
        20
      )
    );
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI * 0.44 + (i / 4) * Math.PI * 0.88;
      const slot = box(0.0032, 0.0075, 0.021, 0.0005, 1);
      slot.translate(0, rOut * 0.82, 0);
      slot.rotateZ(a);
      slot.translate(0, 0, 0.03);
      parts.push(slot);
    }
  } else if (kind === 'comp') {
    // linear compensator / blast can
    parts.push(
      latheZ(
        [
          [0, rBarrel + 0.0012],
          [0.005, rBarrel + 0.003],
          [0.008, rOut + 0.0016],
          [0.03, rOut + 0.0016],
          [0.031, rOut + 0.0022],
          [len - 0.003, rOut + 0.0022],
          [len, rOut + 0.0006],
          [len, rBarrel * 0.7],
          [len - 0.007, rBarrel * 0.66],
        ],
        20
      )
    );
    const k = knurlBand(rOut + 0.0018, 0.018, 30, 0.0003, 4);
    k.translate(0, 0, 0.018);
    parts.push(k);
  } else {
    // tri-lug / flash hider for the SMG class
    parts.push(
      latheZ(
        [
          [0, rBarrel + 0.0014],
          [0.004, rBarrel + 0.0026],
          [0.006, rOut],
          [0.024, rOut],
          [0.026, rOut - 0.0012],
          [len - 0.002, rOut - 0.0012],
          [len, rOut - 0.003],
          [len, rBarrel * 0.62],
          [len - 0.005, rBarrel * 0.6],
        ],
        18
      )
    );
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU;
      const lug = box(0.0042, 0.0038, 0.012, 0.0005, 1);
      lug.translate(0, rOut + 0.0012, 0);
      lug.rotateZ(a);
      lug.translate(0, 0, 0.008);
      parts.push(lug);
    }
  }

  const g = mergeAll(parts);
  // Authored breech-to-crown along +Z, so flip it onto the muzzle.
  asm.add(g, matSteel, { y, z: zCrown + len, ry: Math.PI });
  g.dispose();

  // crush washer
  const washer = latheZ(
    [
      [0, rBarrel + 0.0012],
      [0, rBarrel + 0.0032],
      [0.0018, rBarrel + 0.0032],
      [0.0018, rBarrel + 0.0012],
    ],
    16
  );
  asm.add(washer, matSteel, { y, z: zCrown + len });
  washer.dispose();

  // the bore itself, and the dark expansion chamber behind it
  const bore = tubeZ(rBarrel * 0.66, rBarrel * 0.4, len * 0.9, 14, 0.0002);
  asm.add(bore, matCavity, { y, z: zCrown + len * 0.5 });
  bore.dispose();
  return { len, crownZ: zCrown };
}

/* -------------------------------------------------------------------------- */
/*  handguard                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Free-float handguard built from longitudinal slats with real gaps, so the
 * barrel and gas block are visible through it and the silhouette breaks up.
 */
export function addHandguard(asm, matAlu, o) {
  /**
   * MATERIAL SPLIT. The barrel nut, the ring braces and the end cap are machined
   * aluminium (they carry the barrel); the slats and their M-LOK slots are a
   * moulded polymer panel set. That is a real product configuration, and it is
   * also the only place on the gun where the two dielectric classes sit directly
   * against each other over a large area — which is what makes the class break
   * legible at hipfire framing instead of theoretical.
   */
  const matPanel = o.matPanel ?? matAlu;
  const yb = o.y ?? 0;
  const z0 = o.z0; // receiver end (rear, larger z)
  const z1 = o.z1; // muzzle end
  const len = z0 - z1;
  const rOut = o.r ?? 0.0235;
  const sides = o.sides ?? 8;
  const slatW = o.slatW ?? 0.0135;
  const slatT = o.slatT ?? 0.0032;
  const cz = (z0 + z1) / 2;

  // barrel nut / rear collar
  const collar = latheZ(
    [
      [0, rOut * 0.72],
      [0, rOut + 0.0018],
      [0.0025, rOut + 0.0026],
      [0.014, rOut + 0.0026],
      [0.0165, rOut + 0.0012],
      [0.0165, rOut * 0.72],
    ],
    18
  );
  asm.add(collar, matAlu, { y: yb, z: z0 - 0.0165 });
  collar.dispose();
  const nutKnurl = knurlBand(rOut + 0.0028, 0.011, 34, 0.00035, 3);
  asm.add(nutKnurl, matAlu, { y: yb, z: z0 - 0.0085 });
  nutKnurl.dispose();

  const slat = box(slatW, slatT, len - 0.019, 0.0006, 1);
  /**
   * mlokSlot is authored as a flat plate in XY extruded along +Z, so its pocket
   * recesses along -Z and its long axis is X. Assembly composes its Euler in
   * 'XYZ' order, which APPLIES rz first, so a single add() cannot both roll the
   * plate onto the barrel axis and spin it round to the slat's clock position.
   * Bake the axis roll into the geometry once: normal -> +X (radial), long axis
   * -> Z (along the barrel). Then `rz: a` alone puts it on any slat.
   *
   * Left unrolled the plates lay in the XY plane and read as loose diamond tabs
   * standing off the handguard, which is exactly what they were doing.
   */
  const slotGeo = mlokSlot(0.026, 0.0072, 0.0018);
  slotGeo.rotateY(Math.PI / 2);
  // The top slat is normally the rail's job. `topFrom`/`topTo` let a caller ask
  // for a bare polymer top over the section the support hand actually grips, so
  // the fingers can close over the handguard instead of through a rail.
  const topFrom = o.topFrom ?? null;
  const topTo = o.topTo ?? null;
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * TAU + Math.PI / sides;
    const isTop = Math.abs(dsin(a) - 1) < 0.35;
    const y = dsin(a) * (rOut - slatT * 0.5);
    const x = dcos(a) * (rOut - slatT * 0.5);
    if (isTop) {
      if (topFrom === null) continue;
      const tLen = Math.abs(topFrom - topTo);
      const top = box(slatW, slatT, tLen, 0.0006, 1);
      asm.add(top, matPanel, {
        x,
        y: yb + y,
        z: (topFrom + topTo) / 2,
        rz: a - Math.PI / 2,
      });
      top.dispose();
      continue;
    }
    asm.add(slat, matPanel, { x, y: yb + y, z: cz - 0.0095, rz: a - Math.PI / 2 });
    // M-LOK slots on the 3/6/9-o'clock slats only, like the real thing
    const cardinal = Math.abs(dcos(a)) > 0.85 || dsin(a) < -0.85;
    if (cardinal) {
      for (let s = 0; s < (o.slots ?? 3); s++) {
        const sz = cz + len * 0.5 - 0.045 - s * 0.038;
        if (sz < z1 + 0.02) break;
        asm.add(slotGeo, matPanel, { x: x * 1.005, y: yb + y * 1.005, z: sz, rz: a });
        // The pocket floor: a dark recess so the slot is a hole in the panel and
        // not a raised lozenge that catches the same light as the panel face.
        const pocket = box(0.0012, 0.0052, 0.0232, 0.0002, 1);
        asm.add(pocket, 'cavity', { x: x * 0.955, y: yb + y * 0.955, z: sz, rz: a });
        pocket.dispose();
      }
    }
  }
  slat.dispose();
  slotGeo.dispose();

  // ring braces tie the slats together
  const braceCount = o.braces ?? 3;
  for (let i = 0; i < braceCount; i++) {
    const z = z0 - 0.03 - (i / Math.max(1, braceCount - 1)) * (len - 0.07);
    const brace = latheZ(
      [
        [0, rOut - slatT],
        [0, rOut + 0.0006],
        [0.0035, rOut + 0.0006],
        [0.0035, rOut - slatT],
      ],
      Math.max(10, sides * 2)
    );
    asm.add(brace, matAlu, { y: yb, z });
    brace.dispose();
  }

  // anti-rotation index tabs at the front, and a chamfered end cap ring
  const cap = latheZ(
    [
      [0, rOut - slatT - 0.0008],
      [0, rOut - 0.0002],
      [0.0022, rOut - 0.0012],
      [0.0022, rOut - slatT - 0.0008],
    ],
    Math.max(10, sides * 2)
  );
  asm.add(cap, matAlu, { y: yb, z: z1 + 0.001 });
  cap.dispose();
}

/* -------------------------------------------------------------------------- */
/*  receiver                                                                  */
/* -------------------------------------------------------------------------- */

