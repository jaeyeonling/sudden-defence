import { box, extrude, roundRect, mergeAll } from './geometry.js';
import { datan2 } from '../core/dmath.js';
import { cartridge } from './parts.js';

/** Magazine body, follower and the rounds you can see in it. */

/**
 * Polymer box magazine. Slight curve, moulded ribs, witness holes, a floor
 * plate with a finger ledge, feed lips and a visible top round.
 * Built in its own space: origin at the top of the feed lips, +Y up, body down.
 */
export function buildMagazine(asm, mats, o) {
  const w = o.w ?? 0.0255;
  const d = o.d ?? 0.0655;
  const len = o.len ?? 0.215;
  /** Sagitta of the feed curve in METRES over the magazine's length. */
  const curve = o.curve ?? 0.028;
  const segs = o.segs ?? 8;
  const poly = o.poly ?? 'polymer';

  // Arc: y runs down, z bows forward (-Z), and each slice is rotated to the
  // local tangent so the stack reads as one continuous curved body.
  const at = (t) => ({
    y: -t * len,
    z: -curve * t * t,
    tilt: datan2(2 * curve * t, len),
  });

  const bodyParts = [];
  const ribParts = [];
  const step = len / segs;
  for (let i = 0; i < segs; i++) {
    const t = (i + 0.5) / segs;
    const p = at(t);
    const taper = 1 - t * 0.04;
    const seg = extrude(roundRect(w * taper, d * taper, 0.0055, 5), step * 1.06, {
      bevel: 0.0008,
    });
    seg.rotateX(Math.PI / 2 + p.tilt);
    seg.translate(0, p.y, p.z);
    bodyParts.push(seg);

    // Moulded grip ribs down the flanks.
    if (i > 0 && i < segs - 1) {
      for (const sx of [-1, 1]) {
        const rib = box(0.0018, step * 0.62, d * 0.66, 0.0005, 1);
        rib.rotateX(p.tilt);
        rib.translate(sx * (w * taper * 0.5), p.y, p.z);
        ribParts.push(rib);
      }
    }
  }

  // Feed lips: two rails either side of the mouth, plus the rear catch notch.
  const lip = extrude(
    [
      [-0.0032, 0],
      [0.0032, 0],
      [0.0026, 0.009],
      [-0.0026, 0.009],
    ],
    d * 0.9,
    { bevel: 0.0005 }
  );
  lip.rotateY(Math.PI / 2);
  for (const sx of [-1, 1]) {
    const g = lip.clone();
    g.translate(sx * (w * 0.5 - 0.0032), -0.0015, 0);
    bodyParts.push(g);
  }
  lip.dispose();
  const notch = box(0.008, 0.0075, 0.0055, 0.0009, 1);
  notch.translate(0, -0.03, d * 0.5 + 0.0015);
  bodyParts.push(notch);

  // Floor plate + finger ledge, on the arc's tangent.
  const end = at(1);
  const plate = extrude(roundRect(w + 0.0026, d * 0.97, 0.004, 4), 0.01, { bevel: 0.001 });
  plate.rotateX(Math.PI / 2 + end.tilt);
  plate.translate(0, end.y - 0.0035, end.z);
  bodyParts.push(plate);
  const ledge = box(w + 0.0034, 0.007, 0.013, 0.0016, 2);
  ledge.rotateX(end.tilt);
  ledge.translate(0, end.y - 0.007, end.z - d * 0.4);
  bodyParts.push(ledge);
  // Base pad, a slightly different polymer batch.
  const pad = extrude(roundRect(w + 0.003, d * 0.9, 0.004, 4), 0.005, { bevel: 0.0009 });
  pad.rotateX(Math.PI / 2 + end.tilt);
  pad.translate(0, end.y - 0.0105, end.z);

  const body = mergeAll(bodyParts);
  asm.add(body, poly, {});
  body.dispose();
  const ribs = mergeAll(ribParts);
  if (ribs) {
    asm.add(ribs, poly, {});
    ribs.dispose();
  }
  asm.add(pad, 'rubber', {});
  pad.dispose();

  // Witness holes: recessed dark slots down both sides.
  const holes = o.witness ?? 4;
  for (let i = 0; i < holes; i++) {
    const t = 0.26 + (i / Math.max(1, holes - 1)) * 0.56;
    const p = at(t);
    for (const sx of [-1, 1]) {
      const h = extrude(roundRect(0.0085, 0.0044, 0.0018, 3), 0.004, { bevel: 0.0004 });
      h.rotateY(Math.PI / 2);
      h.rotateX(p.tilt);
      h.translate(sx * (w * 0.5 - 0.0006), p.y, p.z);
      asm.add(h, 'cavity', {});
      h.dispose();
    }
  }

  // The top round under the feed lips — the detail everyone notices.
  // It lies along the magazine's DEPTH axis (bullet forward, -Z) like a real
  // stack, not across its width; the cartridge is authored base-at-0 running
  // +Z, so ry=PI turns it muzzle-forward and the case head ends up at the rear
  // wall. Rotated the other way it lances straight out through the mag's flank.
  const caseLen = o.caseLen ?? 0.0446;
  const bulletLen = o.bulletLen ?? 0.019;
  const c = cartridge(caseLen, o.rimR ?? 0.00495, bulletLen);
  const cz = Math.min(d * 0.5 - 0.0025, caseLen + bulletLen - d * 0.5 + 0.0015);
  asm.add(c.brass, 'brass', { y: -0.0085, z: cz, ry: Math.PI });
  asm.add(c.bullet, 'copper', { y: -0.0085, z: cz, ry: Math.PI });
  c.brass.dispose();
  c.bullet.dispose();

  return { len, w, d };
}

/* -------------------------------------------------------------------------- */
/*  optics + sights                                                           */
/* -------------------------------------------------------------------------- */

