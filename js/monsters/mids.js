/* Containment Breach - mid-tier specimens.
 * Classic script, three.js r128, no modules, no addons, seeded rng only.
 */
(function () {
  'use strict';

  window.ContainmentBreach = window.ContainmentBreach || {};
  window.ContainmentBreach.monsters = window.ContainmentBreach.monsters || {};
  var REG = window.ContainmentBreach.monsters;

  /* ======================= shared local helpers ======================= */

  function qLevel(q) { return q === 'low' ? 0 : (q === 'high' ? 2 : 1); }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
  function smooth(v) { v = clamp01(v); return v * v * (3 - 2 * v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function rr(rng, a, b) { return a + (b - a) * rng(); }
  function ri(rng, a, b) { var v = Math.floor(a + (b - a + 1) * rng()); return v > b ? b : v; }

  function jit(hex, rng, h, l) {
    return new THREE.Color(hex).offsetHSL(
      (rng() - 0.5) * (h === undefined ? 0.06 : h), 0,
      (rng() - 0.5) * (l === undefined ? 0.12 : l));
  }

  /* per-instance resource bag -> makes dispose() trivially correct */
  function Bag() { this.geos = []; this.mats = []; this.count = 0; }

  function mkMat(bag, color, o) {
    o = o || {};
    var m = new THREE.MeshStandardMaterial({
      color: color,
      roughness: o.rough === undefined ? 0.88 : o.rough,
      metalness: o.metal === undefined ? 0.04 : o.metal,
      flatShading: o.flat !== false,
      emissive: o.emissive === undefined ? 0x000000 : o.emissive,
      emissiveIntensity: o.ei === undefined ? 1.0 : o.ei,
      transparent: !!o.transparent,
      opacity: o.opacity === undefined ? 1 : o.opacity,
      side: o.side === undefined ? THREE.FrontSide : o.side
    });
    m.userData.baseEI = m.emissiveIntensity;
    bag.mats.push(m);
    return m;
  }

  function glowMat(bag, color, ei, o) {
    o = o || {};
    return mkMat(bag, o.color === undefined ? color : o.color, {
      rough: o.rough === undefined ? 0.55 : o.rough,
      metal: 0.0,
      flat: o.flat,
      emissive: color,
      ei: ei === undefined ? 1.4 : ei,
      transparent: o.transparent,
      opacity: o.opacity,
      side: o.side
    });
  }

  function mesh(bag, geo, mat, parent) {
    if (bag.geos.indexOf(geo) === -1) bag.geos.push(geo);
    var m = new THREE.Mesh(geo, mat);
    bag.count++;
    if (parent) parent.add(m);
    return m;
  }

  function box(bag, w, h, d, mat, parent) {
    return mesh(bag, new THREE.BoxGeometry(w, h, d), mat, parent);
  }
  function sph(bag, r, seg, mat, parent) {
    return mesh(bag, new THREE.SphereGeometry(r, seg, Math.max(3, Math.round(seg * 0.5))), mat, parent);
  }
  function cone(bag, r, h, seg, mat, parent) {
    return mesh(bag, new THREE.ConeGeometry(r, h, seg), mat, parent);
  }
  function cyl(bag, rt, rb, h, seg, mat, parent, open) {
    return mesh(bag, new THREE.CylinderGeometry(rt, rb, h, seg, 1, !!open), mat, parent);
  }

  /* A single bone. Grows along +Y (dir 1) or -Y (dir -1) from its own origin.
   * r0 = radius at the root end, r1 = radius at the tip end.
   * Returns { g (pivot), tip (group at the far end), mesh, len }. */
  function strut(bag, parent, o) {
    var dir = o.dir === -1 ? -1 : 1;
    var rTop = dir > 0 ? o.r1 : o.r0;
    var rBot = dir > 0 ? o.r0 : o.r1;
    var g = new THREE.Group();
    if (parent) parent.add(g);
    var m = mesh(bag, new THREE.CylinderGeometry(
      Math.max(rTop, 0.008), Math.max(rBot, 0.008), o.len, o.radial || 6, 1), o.mat, g);
    m.position.y = dir * o.len * 0.5;
    if (o.flatZ) m.scale.z = o.flatZ;
    var tip = new THREE.Group();
    tip.position.y = dir * o.len;
    g.add(tip);
    return { g: g, tip: tip, mesh: m, len: o.len };
  }

  /* Nested chain of segments -> tendrils, necks, IV tubes, cabling.
   * Each segment is its own pivot group so a travelling sine can run down it. */
  function segmentChain(bag, parent, o) {
    var n = Math.max(1, o.count | 0);
    var dir = o.dir === -1 ? -1 : 1;
    var segLen = o.length / n;
    var root = new THREE.Group();
    if (parent) parent.add(root);
    var segs = [];
    var cur = root;
    for (var i = 0; i < n; i++) {
      var g = new THREE.Group();
      g.position.y = (i === 0 ? 0 : dir * segLen);
      g.userData.bx = 0; g.userData.by = 0; g.userData.bz = 0; g.userData.po = 0;
      cur.add(g);
      var ra = o.r0 + (o.r1 - o.r0) * (i / n);
      var rb = o.r0 + (o.r1 - o.r0) * ((i + 1) / n);
      var s = strut(bag, g, {
        dir: dir, len: segLen * (o.overlap === undefined ? 1.08 : o.overlap),
        r0: ra, r1: rb, mat: o.mat, radial: o.radial || 5, flatZ: o.flatZ
      });
      s.g.position.y = 0;
      segs.push(g);
      cur = g;
    }
    var tip = new THREE.Group();
    tip.position.y = dir * segLen;
    cur.add(tip);
    return { root: root, segs: segs, tip: tip, segLen: segLen, n: n };
  }

  /* rest pose of a chain: fx/fz get (i, n) and return radians */
  function chainRest(ch, fx, fz, phaseOff) {
    for (var i = 0; i < ch.segs.length; i++) {
      var s = ch.segs[i];
      s.userData.bx = fx ? fx(i, ch.n) : 0;
      s.userData.bz = fz ? fz(i, ch.n) : 0;
      s.userData.po = phaseOff || 0;
      s.rotation.x = s.userData.bx;
      s.rotation.z = s.userData.bz;
    }
  }

  /* travelling sine down a chain, driven by `phase` radians */
  function waveChain(ch, phase, ampX, ampZ, perSeg, tipBias) {
    var n = ch.segs.length;
    for (var i = 0; i < n; i++) {
      var s = ch.segs[i];
      var u = n > 1 ? i / (n - 1) : 1;
      var w = tipBias === undefined ? 1 : lerp(1 - tipBias * 0.75, 1 + tipBias, u);
      var p = phase - i * perSeg + s.userData.po;
      s.rotation.x = s.userData.bx + Math.sin(p) * (ampX || 0) * w;
      s.rotation.z = s.userData.bz + Math.cos(p * 0.83) * (ampZ || 0) * w;
      s.rotation.y = s.userData.by;
    }
  }

  /* attack curve: wind-up through 40%, strike at ~55%, recover.
   * -1 at full wind-up, +1.6 peak on the strike, 0 at rest. */
  function swingCurve(t) {
    t = clamp01(t);
    if (t < 0.4) return -smooth(t / 0.4);
    if (t < 0.58) return -1 + smooth((t - 0.4) / 0.18) * 2.6;
    return 1.6 - smooth((t - 0.58) / 0.42) * 1.6;
  }

  function makeDispose(bag) {
    return function () {
      var i;
      for (i = 0; i < bag.geos.length; i++) if (bag.geos[i] && bag.geos[i].dispose) bag.geos[i].dispose();
      for (i = 0; i < bag.mats.length; i++) if (bag.mats[i] && bag.mats[i].dispose) bag.mats[i].dispose();
      bag.geos.length = 0;
      bag.mats.length = 0;
    };
  }

  /* group -> scaleRoot -> bodyGroup(animated) */
  function makeRig(s) {
    var group = new THREE.Group();
    var root = new THREE.Group();
    root.scale.setScalar(s);
    group.add(root);
    var body = new THREE.Group();
    root.add(body);
    return { group: group, root: root, body: body };
  }

  function anchor(root, y, z) {
    var a = new THREE.Object3D();
    a.position.set(0, y, z || 0);
    root.add(a);
    return a;
  }

  /* ===================================================================== */
  /* 1. SECURITY HUSK                                                      */
  /* ===================================================================== */

  REG['security_husk'] = {
    id: 'security_husk',
    name: 'SECURITY HUSK',
    tier: 'mid',
    size: { height: 2.3, radius: 0.9 },
    build: function (opts) {
      var rng = opts.rng, P = opts.palette, q = qLevel(opts.quality);
      var bag = new Bag();
      var S = rr(rng, 0.88, 1.12);
      var seg = q === 0 ? 6 : (q === 1 ? 8 : 10);

      var mFlesh = mkMat(bag, jit(P.flesh, rng), { rough: 0.93 });
      var mFlesh2 = mkMat(bag, jit(P.flesh2, rng), { rough: 0.96 });
      var mArmor = mkMat(bag, jit(P.metal, rng, 0.04, 0.10), { rough: 0.5, metal: 0.55, flat: false });
      var mArmor2 = mkMat(bag, jit(P.metal, rng, 0.04, 0.10).multiplyScalar(0.62), { rough: 0.62, metal: 0.5, flat: false });
      var mVisor = mkMat(bag, 0x121820, { rough: 0.25, metal: 0.4, flat: false, transparent: true, opacity: 0.62 });
      var mEye = glowMat(bag, P.glow, 2.2, { color: 0x121212 });
      var mStrap = mkMat(bag, 0x23232a, { rough: 0.9, flat: false });
      var mCard = glowMat(bag, P.glow2, 0.9, { color: 0x2a3a40 });
      var mBone = mkMat(bag, jit(P.bone, rng, 0.03, 0.08), { rough: 0.7 });

      var rig = makeRig(S), group = rig.group, body = rig.body;

      /* ---- legs ---- */
      var hipY = 1.11;
      var legs = [];
      for (var li = 0; li < 2; li++) {
        var sx = li === 0 ? -1 : 1;
        var hip = new THREE.Group();
        hip.position.set(sx * 0.21, hipY, 0);
        body.add(hip);
        var thigh = strut(bag, hip, { dir: -1, len: 0.44, r0: 0.17, r1: 0.13, mat: mFlesh, radial: seg - 2 });
        var gre = box(bag, 0.26, 0.28, 0.26, mArmor, thigh.g);
        gre.position.set(0, -0.19, 0.02);
        var shin = strut(bag, thigh.tip, { dir: -1, len: 0.50, r0: 0.13, r1: 0.105, mat: mFlesh2, radial: seg - 2 });
        var kn = box(bag, 0.22, 0.14, 0.22, mArmor2, thigh.tip);
        kn.position.set(0, -0.04, 0.05);
        var boot = box(bag, 0.24, 0.17, 0.34, mArmor, shin.tip);
        boot.position.set(0, -0.085, 0.05);
        var toe = box(bag, 0.20, 0.09, 0.10, mArmor2, shin.tip);
        toe.position.set(0, -0.125, 0.21);
        legs.push({ hip: hip, knee: thigh.tip, ankle: shin.tip, s: sx });
      }

      /* ---- torso ---- */
      var waist = new THREE.Group();
      waist.position.set(0, hipY, 0);
      body.add(waist);

      var gut = sph(bag, 0.34, seg, mFlesh, waist);
      gut.position.y = 0.22; gut.scale.set(1.12, 0.92, 0.88);
      var chest = sph(bag, 0.38, seg, mFlesh, waist);
      chest.position.y = 0.56; chest.scale.set(1.18, 1.02, 0.9);
      var lump = sph(bag, rr(rng, 0.10, 0.17), seg - 2, mFlesh2, waist);
      lump.position.set(rr(rng, -0.3, 0.3), rr(rng, 0.35, 0.62), rr(rng, -0.34, -0.2));

      var plate = box(bag, 0.62, 0.50, 0.17, mArmor, waist);
      plate.position.set(0, 0.55, 0.28);
      var plate2 = box(bag, 0.50, 0.12, 0.14, mArmor2, waist);
      plate2.position.set(0, 0.26, 0.28);
      var plate3 = box(bag, 0.44, 0.11, 0.13, mArmor2, waist);
      plate3.position.set(0, 0.13, 0.27);
      var backPl = box(bag, 0.52, 0.44, 0.14, mArmor2, waist);
      backPl.position.set(0, 0.52, -0.28);

      var nRib = q === 0 ? 1 : 2;
      for (var rb2 = 0; rb2 < nRib; rb2++) {
        var rbm = box(bag, 0.14, 0.05, 0.05, mBone, waist);
        rbm.position.set(rr(rng, -0.34, -0.2), 0.40 + rb2 * 0.12, 0.24);
        rbm.rotation.z = rr(rng, -0.5, 0.5);
      }

      /* dead radio + keycard lanyards */
      var radio = box(bag, 0.15, 0.11, 0.08, mArmor2, waist);
      radio.position.set(-0.24, 0.42, 0.33);
      var ant = cyl(bag, 0.012, 0.018, 0.26, 4, mStrap, waist);
      ant.position.set(-0.28, 0.58, 0.32); ant.rotation.z = 0.25;
      var led = sph(bag, 0.022, 5, mCard, waist);
      led.position.set(-0.19, 0.46, 0.38);

      var lanyards = [];
      var nLan = 1 + (q > 0 ? 1 : 0);
      for (var ln = 0; ln < nLan; ln++) {
        var lc = segmentChain(bag, waist, {
          dir: -1, count: 3, length: rr(rng, 0.26, 0.36), r0: 0.013, r1: 0.010,
          mat: mStrap, radial: 4
        });
        lc.root.position.set(rr(rng, 0.06, 0.26) * (ln ? -1 : 1), 0.66, 0.26);
        chainRest(lc, function (i) { return 0.10 + i * 0.06; }, null, rng() * 6.28);
        var card = box(bag, 0.10, 0.14, 0.012, mCard, lc.tip);
        card.position.y = -0.07;
        lanyards.push(lc);
      }

      /* ---- arms ---- */
      var shoulders = [];
      for (var ai = 0; ai < 2; ai++) {
        var asx = ai === 0 ? -1 : 1;
        var sh = new THREE.Group();
        sh.position.set(asx * 0.40, 0.56, 0);
        waist.add(sh);
        var pauld = box(bag, 0.30, 0.24, 0.34, mArmor, sh);
        pauld.position.set(asx * 0.06, 0.06, 0);
        var up = strut(bag, sh, { dir: -1, len: 0.44, r0: 0.125, r1: 0.10, mat: mFlesh, radial: seg - 2 });
        var vam = box(bag, 0.20, 0.16, 0.20, mArmor2, up.g);
        vam.position.y = -0.30;
        var fore = strut(bag, up.tip, { dir: -1, len: 0.40, r0: 0.105, r1: 0.085, mat: mFlesh2, radial: seg - 2 });
        shoulders.push({ sh: sh, el: up.tip, wr: fore.tip, s: asx });
      }
      var batonArm = rng() < 0.5 ? shoulders[0] : shoulders[1];
      var freeArm = batonArm === shoulders[0] ? shoulders[1] : shoulders[0];

      /* fused hand-and-baton */
      var fused = mesh(bag, new THREE.IcosahedronGeometry(rr(rng, 0.15, 0.19), 0), mFlesh, batonArm.wr);
      fused.position.y = -0.08;
      fused.scale.set(1, 0.9, 1.15);
      var baton = cyl(bag, 0.045, 0.06, rr(rng, 0.42, 0.56), 6, mArmor2, batonArm.wr);
      baton.position.set(0, -0.32, 0.06);
      baton.rotation.x = 0.16;
      var batonCap = box(bag, 0.09, 0.07, 0.09, mArmor, batonArm.wr);
      batonCap.position.set(0, -0.54, 0.09);
      var spur = cone(bag, 0.035, 0.12, 5, mBone, batonArm.wr);
      spur.position.set(batonArm.s * 0.12, -0.14, 0.02);
      spur.rotation.z = batonArm.s * -1.1;

      /* normal-ish hand */
      var palm = box(bag, 0.13, 0.17, 0.10, mFlesh2, freeArm.wr);
      palm.position.y = -0.09;
      var fing = box(bag, 0.11, 0.10, 0.05, mFlesh2, freeArm.wr);
      fing.position.set(0, -0.20, 0.03);

      /* ---- head ---- */
      var neckG = new THREE.Group();
      neckG.position.set(0, 0.70, 0);
      waist.add(neckG);
      var neck = cyl(bag, 0.11, 0.13, 0.14, 6, mFlesh2, neckG);
      neck.position.y = 0.04;

      var head = new THREE.Group();
      head.position.y = 0.12;
      neckG.add(head);
      var helm = box(bag, 0.37, 0.34, 0.37, mArmor, head);
      helm.position.y = 0.16;
      var crest = box(bag, 0.09, 0.11, 0.33, mArmor2, head);
      crest.position.y = 0.34;
      var brow = box(bag, 0.39, 0.07, 0.10, mArmor2, head);
      brow.position.set(0, 0.28, 0.16);
      var visor = box(bag, 0.32, 0.15, 0.06, mVisor, head);
      visor.position.set(0, 0.14, 0.18);
      var crack1 = box(bag, 0.015, 0.14, 0.02, mArmor2, head);
      crack1.position.set(rr(rng, -0.09, 0.09), 0.14, 0.215);
      crack1.rotation.z = rr(rng, -0.6, 0.6);
      var crack2 = box(bag, 0.13, 0.013, 0.02, mArmor2, head);
      crack2.position.set(rr(rng, -0.05, 0.05), 0.11, 0.215);
      crack2.rotation.z = rr(rng, -0.5, 0.5);
      var eyeGeo = new THREE.SphereGeometry(0.038, 6, 4);
      var eyeL = mesh(bag, eyeGeo, mEye, head);
      eyeL.position.set(-0.085, 0.145, 0.145);
      var eyeR = mesh(bag, eyeGeo, mEye, head);
      eyeR.position.set(0.085, 0.145, 0.145);
      var jaw = box(bag, 0.24, 0.10, 0.22, mFlesh2, head);
      jaw.position.set(0, -0.02, 0.07);

      var headAnchor = anchor(rig.root, 2.66);

      /* ---- animation ---- */
      var t = 0, walkPh = rng() * 6.28, breathPh = rng() * 6.28;
      var eiEye = mEye.emissiveIntensity, eiCard = mCard.emissiveIntensity;

      return {
        group: group,
        headAnchor: headAnchor,
        materials: bag.mats,
        hitPoints: [head, chest, gut, batonArm.wr],
        update: function (dt, ctx) {
          ctx = ctx || {};
          t += dt;
          var st = ctx.state || 'idle';
          var ms = ctx.moveSpeed || 0;
          var sp = ctx.spawnT === undefined ? 1 : clamp01(ctx.spawnT);
          var hp = ctx.hpFrac === undefined ? 1 : clamp01(ctx.hpFrac);
          var hurt = clamp01(ctx.hurtT || 0);
          var walking = st === 'walk';
          walkPh += dt * (walking ? (2.0 + ms * 2.6) : 0.55);

          var br = Math.sin(t * 1.35 + breathPh);
          var i;

          /* reset */
          body.position.set(0, 0, 0);
          body.rotation.set(0, 0, 0);
          body.scale.set(1, 1, 1);
          waist.rotation.set(0, 0, 0);
          head.rotation.set(0, 0, 0);
          for (i = 0; i < 2; i++) {
            legs[i].hip.rotation.set(0, 0, 0);
            legs[i].knee.rotation.set(0, 0, 0);
            legs[i].ankle.rotation.set(0, 0, 0);
            shoulders[i].sh.rotation.set(0, 0, 0);
            shoulders[i].el.rotation.set(0, 0, 0);
          }

          /* idle breathing */
          chest.scale.set(1.18 + br * 0.035, 1.02 + br * 0.03, 0.9 + br * 0.03);
          gut.scale.set(1.12 + br * 0.03, 0.92 - br * 0.02, 0.88 + br * 0.025);
          head.rotation.x = Math.sin(t * 0.7 + 1.1) * 0.05;
          head.rotation.y = Math.sin(t * 0.43) * 0.13;
          waist.rotation.x = -0.05 + br * 0.02;
          body.position.y = br * 0.012;

          /* locomotion */
          if (walking || ms > 0.01) {
            var amp = walking ? 1 : 0.25;
            for (i = 0; i < 2; i++) {
              var ph = walkPh + (i === 0 ? 0 : Math.PI);
              var sw = Math.sin(ph);
              legs[i].hip.rotation.x = sw * 0.42 * amp;
              legs[i].knee.rotation.x = (Math.max(0, -Math.cos(ph)) * 0.62 + 0.10) * amp;
              legs[i].ankle.rotation.x = -sw * 0.18 * amp - 0.06 * amp;
              shoulders[i].sh.rotation.x = -sw * 0.30 * amp;
              shoulders[i].sh.rotation.z = shoulders[i].s * (0.14 + Math.abs(sw) * 0.05) * amp;
              shoulders[i].el.rotation.x = (0.35 + Math.max(0, sw) * 0.25) * amp;
            }
            body.position.y += Math.abs(Math.sin(walkPh)) * 0.065 * amp - 0.03 * amp;
            body.rotation.z = Math.sin(walkPh) * 0.055 * amp;
            body.rotation.x = 0.055 * amp;
            waist.rotation.y = Math.sin(walkPh) * 0.11 * amp;
            head.rotation.y += Math.sin(walkPh) * -0.07 * amp;
          } else {
            for (i = 0; i < 2; i++) {
              shoulders[i].sh.rotation.x = Math.sin(t * 0.9 + i) * 0.05;
              shoulders[i].sh.rotation.z = shoulders[i].s * 0.16;
              shoulders[i].el.rotation.x = 0.30 + Math.sin(t * 0.8 + i * 2.1) * 0.05;
              legs[i].knee.rotation.x = 0.08;
            }
          }

          /* attack: heavy overhead baton smash */
          if (st === 'attack') {
            var sc = swingCurve(ctx.attackT || 0);
            batonArm.sh.rotation.x = -sc * 1.15 - 0.15;
            batonArm.sh.rotation.z = batonArm.s * (0.30 - Math.max(0, sc) * 0.22);
            batonArm.el.rotation.x = 0.55 - Math.max(0, sc) * 0.55 + Math.max(0, -sc) * 0.6;
            freeArm.sh.rotation.x = sc * 0.30;
            waist.rotation.y = batonArm.s * sc * 0.34;
            waist.rotation.x = -0.05 + sc * 0.22;
            body.position.z = Math.max(0, sc) * 0.16;
            head.rotation.x = sc * 0.18;
          }

          /* hurt recoil */
          if (hurt > 0.001) {
            var hh = hurt * hurt;
            body.rotation.x -= hh * 0.26;
            body.position.z -= hh * 0.14;
            head.rotation.x -= hh * 0.30;
            for (i = 0; i < 2; i++) shoulders[i].sh.rotation.x += hh * 0.35;
          }

          /* spawn */
          if (sp < 0.999) {
            var e = smooth(sp);
            body.position.y -= 2.4 * (1 - e);
            body.rotation.x += (1 - e) * 0.55;
            var s2 = 0.55 + 0.45 * e;
            body.scale.set(s2, s2, s2);
            head.rotation.x += (1 - e) * 0.7;
          }

          /* death */
          if (st === 'die') {
            var d = smooth(clamp01(ctx.dieT || 0));
            body.rotation.x = d * 1.42;
            body.rotation.z = d * 0.32;
            body.position.y = -d * 0.62;
            waist.rotation.x = -0.05 - d * 0.5;
            head.rotation.x = d * 0.8;
            for (i = 0; i < 2; i++) {
              legs[i].hip.rotation.x = d * 0.9;
              legs[i].knee.rotation.x = d * 1.5;
              shoulders[i].sh.rotation.x = -d * 0.7;
              shoulders[i].el.rotation.x = d * 0.4;
            }
          }

          var flick = 0.8 + 0.2 * Math.sin(t * 9.3) * Math.sin(t * 3.1);
          var dieFade = st === 'die' ? Math.max(0, 1 - clamp01(ctx.dieT || 0) * 1.6) : 1;
          mEye.emissiveIntensity = eiEye * flick * (1 + (1 - hp) * 1.1) * dieFade;
          mCard.emissiveIntensity = eiCard * (0.6 + 0.4 * Math.sin(t * 1.7));

          for (i = 0; i < lanyards.length; i++) {
            waveChain(lanyards[i], walkPh * 1.1 + i * 2.0, 0.22, 0.16, 0.8, 0.5);
          }
        },
        dispose: makeDispose(bag)
      };
    }
  };

  /* ===================================================================== */
  /* 2. TENDRIL STALK                                                      */
  /* ===================================================================== */

  REG['tendril_stalk'] = {
    id: 'tendril_stalk',
    name: 'TENDRIL STALK',
    tier: 'mid',
    size: { height: 3.0, radius: 0.85 },
    build: function (opts) {
      var rng = opts.rng, P = opts.palette, q = qLevel(opts.quality);
      var bag = new Bag();
      var S = rr(rng, 0.88, 1.12);
      var seg = q === 0 ? 6 : (q === 1 ? 8 : 10);

      var mFlesh = mkMat(bag, jit(P.flesh, rng, 0.08, 0.14), { rough: 0.85 });
      var mFlesh2 = mkMat(bag, jit(P.flesh2, rng, 0.08, 0.14), { rough: 0.9 });
      var mTend = mkMat(bag, jit(P.accent, rng, 0.07, 0.16), { rough: 0.8 });
      var mNode = glowMat(bag, P.glow, 1.9, { color: 0x1b2a12 });
      var mMaw = glowMat(bag, P.accent, 0.9, { color: jit(P.accent, rng).multiplyScalar(0.5) });
      var mTooth = mkMat(bag, jit(P.bone, rng, 0.03, 0.08), { rough: 0.6 });
      var mGoo = glowMat(bag, P.goo, 1.5, { color: 0x24341a });

      var rig = makeRig(S), group = rig.group, body = rig.body;

      /* ---- root base ---- */
      var baseG = new THREE.Group();
      body.add(baseG);
      var bulb = sph(bag, 0.44, seg, mFlesh2, baseG);
      bulb.position.y = 0.198;
      bulb.scale.set(1.0, 0.45, 1.05);
      var nProng = q === 0 ? 3 : ri(rng, 3, 4);
      var prongs = [];
      for (var pi = 0; pi < nProng; pi++) {
        var pg = new THREE.Group();
        pg.rotation.y = (pi / nProng) * Math.PI * 2 + rr(rng, -0.3, 0.3);
        pg.position.y = 0.11;
        baseG.add(pg);
        var pr = cone(bag, 0.095, rr(rng, 0.36, 0.52), 5, mFlesh2, pg);
        pr.rotation.x = Math.PI * 0.5;
        pr.position.z = 0.30;
        prongs.push(pg);
      }

      /* ---- stalk ---- */
      var nStalk = q === 0 ? 6 : (q === 1 ? 7 : 8);
      var stalk = segmentChain(bag, body, {
        count: nStalk, length: 2.26, r0: 0.30, r1: 0.115, mat: mFlesh, radial: seg - 2
      });
      stalk.root.position.y = 0.30;
      /* gentle organic S-curve; net lean stays near zero so it reads upright */
      chainRest(stalk, function (i) { return 0.035 * Math.sin(i * 1.1) - 0.006; }, null, 0);

      /* bioluminescent nodules up the stalk */
      var nodes = [];
      var nNode = q === 0 ? 4 : 5;
      for (var ni = 0; ni < nNode; ni++) {
        var si = Math.min(nStalk - 1, Math.floor(ni * (nStalk / nNode)));
        var nd = sph(bag, rr(rng, 0.045, 0.085), 6, mNode, stalk.segs[si]);
        var ang = rng() * Math.PI * 2;
        var rad = 0.24 - si * 0.02;
        nd.position.set(Math.sin(ang) * rad, stalk.segLen * rr(rng, 0.25, 0.8), Math.cos(ang) * rad);
        nd.userData.ph = rng() * 6.28;
        nodes.push(nd);
      }

      /* ---- crown ---- */
      var crown = new THREE.Group();
      stalk.tip.add(crown);
      var crownBulb = sph(bag, 0.25, seg, mFlesh, crown);
      crownBulb.position.y = 0.08;
      crownBulb.scale.set(1.05, 1.0, 1.0);

      /* vertical toothed maw */
      var maw = new THREE.Group();
      maw.position.set(0, 0.12, 0.10);
      crown.add(maw);
      var gullet = cone(bag, 0.11, 0.30, 6, mMaw, maw);
      gullet.rotation.x = Math.PI * 0.5;
      gullet.position.z = -0.10;
      var lips = [];
      for (var lp = 0; lp < 2; lp++) {
        var lsx = lp === 0 ? -1 : 1;
        var lg = new THREE.Group();
        maw.add(lg);
        var lipM = cone(bag, 0.13, 0.54, 4, mFlesh2, lg);
        lipM.scale.set(0.55, 1.0, 1.0);
        lipM.position.set(lsx * 0.045, 0.02, 0.02);
        var nT = 3;
        for (var ti = 0; ti < nT; ti++) {
          var tooth = cone(bag, 0.026, rr(rng, 0.07, 0.12), 4, mTooth, lg);
          tooth.position.set(lsx * 0.035, -0.16 + ti * 0.11, 0.075);
          tooth.rotation.z = lsx * -1.25;
          tooth.rotation.x = -0.25;
        }
        lg.userData.s = lsx;
        lips.push(lg);
      }

      /* crown tendrils */
      var nTend = q === 0 ? ri(rng, 5, 6) : (q === 1 ? ri(rng, 6, 7) : ri(rng, 7, 9));
      var tendSegs = 3;
      var tendrils = [];
      for (var td = 0; td < nTend; td++) {
        var a2 = (td / nTend) * Math.PI * 2 + rr(rng, -0.18, 0.18);
        var tch = segmentChain(bag, crown, {
          count: tendSegs, length: rr(rng, 0.55, 0.70), r0: rr(rng, 0.05, 0.065), r1: 0.012,
          mat: mTend, radial: 4
        });
        tch.root.position.set(Math.sin(a2) * 0.14, 0.14, Math.cos(a2) * 0.14);
        tch.root.rotation.y = a2;
        var tilt = rr(rng, 0.45, 0.65);
        chainRest(tch, (function (tl) {
          return function (i) { return tl + i * 0.34; };
        })(tilt), null, rng() * 6.28);
        tch.phase = rng() * 6.28;
        tch.rate = rr(rng, 0.8, 1.5);
        if (td < 3) {
          var tipBall = sph(bag, 0.028, 5, mGoo, tch.tip);
        }
        tendrils.push(tch);
      }

      var headAnchor = anchor(rig.root, 3.25);

      /* ---- animation ---- */
      var t = 0, walkPh = rng() * 6.28, mawPh = rng() * 6.28;
      var eiNode = mNode.emissiveIntensity, eiMaw = mMaw.emissiveIntensity;

      return {
        group: group,
        headAnchor: headAnchor,
        materials: bag.mats,
        hitPoints: [crownBulb, stalk.segs[Math.floor(nStalk / 2)], bulb],
        update: function (dt, ctx) {
          ctx = ctx || {};
          t += dt;
          var st = ctx.state || 'idle';
          var ms = ctx.moveSpeed || 0;
          var sp = ctx.spawnT === undefined ? 1 : clamp01(ctx.spawnT);
          var hp = ctx.hpFrac === undefined ? 1 : clamp01(ctx.hpFrac);
          var hurt = clamp01(ctx.hurtT || 0);
          var walking = st === 'walk';
          var i;

          walkPh += dt * (walking ? (1.5 + ms * 2.9) : 0.7);
          mawPh += dt * (1.1 + (1 - hp) * 1.4 + (walking ? ms * 0.5 : 0));

          body.position.set(0, 0, 0);
          body.rotation.set(0, 0, 0);
          body.scale.set(1, 1, 1);
          crown.rotation.set(0, 0, 0);
          crown.scale.set(1, 1, 1);
          maw.rotation.set(0, 0, 0);

          /* idle: slow breathing undulation of the whole stalk */
          var idleAmp = 0.055 + (1 - hp) * 0.02;
          waveChain(stalk, t * 1.05, idleAmp, idleAmp * 0.7, 0.55, 0.9);
          bulb.scale.set(1.0 + Math.sin(t * 1.2) * 0.03, 0.45 + Math.sin(t * 1.2) * 0.02, 1.05 + Math.sin(t * 1.2) * 0.03);
          crown.rotation.y = Math.sin(t * 0.5) * 0.25;
          crown.rotation.x = Math.sin(t * 0.77) * 0.07;

          /* walk: travelling whip wave + lurching root drag */
          if (walking || ms > 0.01) {
            var amp = walking ? 1 : 0.3;
            var wamp = (0.13 + ms * 0.05) * amp;
            waveChain(stalk, walkPh * 1.6, wamp, wamp * 0.45, 0.85, 1.1);
            var lurch = (walkPh * 0.5) % 1;
            var drag = lurch < 0.55 ? smooth(lurch / 0.55) : 1 - smooth((lurch - 0.55) / 0.45);
            body.position.z = (drag - 0.5) * 0.16 * amp;
            body.position.y = Math.abs(Math.sin(walkPh * 0.5)) * 0.05 * amp;
            body.rotation.x = 0.08 * amp + Math.sin(walkPh * 0.5) * 0.06 * amp;
            body.rotation.z = Math.sin(walkPh * 0.5 + 1.0) * 0.07 * amp;
            for (i = 0; i < prongs.length; i++) {
              prongs[i].rotation.x = Math.sin(walkPh * 1.6 + i * 1.3) * 0.28 * amp;
            }
            crown.rotation.y = Math.sin(walkPh * 0.4) * 0.35;
          } else {
            for (i = 0; i < prongs.length; i++) {
              prongs[i].rotation.x = Math.sin(t * 0.9 + i * 1.7) * 0.06;
            }
          }

          /* maw open/close */
          var open = 0.5 + 0.5 * Math.sin(mawPh * 1.7);
          open = open * open * (0.35 + (1 - hp) * 0.3);

          /* attack: rear back, then whip the crown forward and gape */
          if (st === 'attack') {
            var sc = swingCurve(ctx.attackT || 0);
            var a3 = clamp01(ctx.attackT || 0);
            for (i = 0; i < stalk.segs.length; i++) {
              var u = i / Math.max(1, stalk.segs.length - 1);
              stalk.segs[i].rotation.x = stalk.segs[i].userData.bx + sc * (0.10 + u * 0.30);
              stalk.segs[i].rotation.z = stalk.segs[i].userData.bz + Math.sin(u * 3.0 + sc * 2.0) * 0.05;
            }
            open = a3 < 0.45 ? smooth(a3 / 0.45) * 0.35 : (a3 < 0.62 ? 0.35 + smooth((a3 - 0.45) / 0.17) * 0.65 : 1 - smooth((a3 - 0.62) / 0.38) * 0.85);
            crown.rotation.x = sc * 0.30;
            crown.scale.set(1 + Math.max(0, sc) * 0.16, 1 + Math.max(0, sc) * 0.10, 1 + Math.max(0, sc) * 0.2);
            body.position.z = Math.max(0, sc) * 0.18;
          }

          for (i = 0; i < 2; i++) {
            var lsx2 = lips[i].userData.s;
            lips[i].position.x = lsx2 * (0.02 + open * 0.15);
            lips[i].rotation.y = -lsx2 * open * 0.55;
            lips[i].rotation.z = lsx2 * open * 0.12;
          }
          mMaw.emissiveIntensity = eiMaw * (0.5 + open * 2.0);

          /* tendrils, each with its own phase */
          for (i = 0; i < tendrils.length; i++) {
            var tc = tendrils[i];
            var tAmp = 0.22 + (walking ? 0.12 : 0) + (1 - hp) * 0.10;
            if (st === 'attack') tAmp += 0.35 * Math.max(0, swingCurve(ctx.attackT || 0));
            waveChain(tc, t * (2.0 * tc.rate) + tc.phase + walkPh * 0.5, tAmp, tAmp * 0.8, 1.15, 1.3);
          }

          /* nodules pulse */
          var nGlow = (0.6 + 0.4 * Math.sin(t * 2.2)) * (1 + (1 - hp) * 1.2);
          mNode.emissiveIntensity = eiNode * nGlow;
          for (i = 0; i < nodes.length; i++) {
            var s3 = 1 + Math.sin(t * 2.6 + nodes[i].userData.ph) * 0.14;
            nodes[i].scale.set(s3, s3, s3);
          }

          /* hurt: whole stalk snaps back and coils */
          if (hurt > 0.001) {
            var hh = hurt * hurt;
            for (i = 0; i < stalk.segs.length; i++) {
              stalk.segs[i].rotation.x -= hh * 0.22 * (0.3 + i / stalk.segs.length);
            }
            crown.scale.multiplyScalar(1 - hh * 0.12);
            body.position.z -= hh * 0.10;
          }

          /* spawn: bursts up out of the floor, uncoiling */
          if (sp < 0.999) {
            var e = smooth(sp);
            body.position.y -= 2.9 * (1 - e);
            var sy = 0.25 + 0.75 * e;
            body.scale.set(0.6 + 0.4 * e, sy, 0.6 + 0.4 * e);
            for (i = 0; i < stalk.segs.length; i++) {
              stalk.segs[i].rotation.x += (1 - e) * 0.30 * Math.sin(i * 1.4);
              stalk.segs[i].rotation.z += (1 - e) * 0.30 * Math.cos(i * 1.1);
            }
            for (i = 0; i < tendrils.length; i++) {
              for (var k = 0; k < tendrils[i].segs.length; k++) {
                tendrils[i].segs[k].rotation.x += (1 - e) * 0.8;
              }
            }
          }

          /* death: stalk buckles and folds to the floor */
          if (st === 'die') {
            var d = smooth(clamp01(ctx.dieT || 0));
            for (i = 0; i < stalk.segs.length; i++) {
              stalk.segs[i].rotation.x = stalk.segs[i].userData.bx + d * (0.25 + (i / stalk.segs.length) * 0.55);
              stalk.segs[i].rotation.z = stalk.segs[i].userData.bz + d * 0.10;
            }
            for (i = 0; i < tendrils.length; i++) {
              for (var k2 = 0; k2 < tendrils[i].segs.length; k2++) {
                tendrils[i].segs[k2].rotation.x = tendrils[i].segs[k2].userData.bx + d * 0.9;
              }
            }
            body.position.y = -d * 0.35;
            body.scale.set(1 + d * 0.1, 1 - d * 0.3, 1 + d * 0.1);
            crown.rotation.x = d * 0.6;
            mNode.emissiveIntensity = eiNode * Math.max(0, 1 - d * 1.5);
            mMaw.emissiveIntensity = eiMaw * Math.max(0, 1 - d * 1.5);
          }
        },
        dispose: makeDispose(bag)
      };
    }
  };

  /* ===================================================================== */
  /* 3. VAT-GROWN                                                          */
  /* ===================================================================== */

  REG['vat_grown'] = {
    id: 'vat_grown',
    name: 'VAT-GROWN',
    tier: 'mid',
    size: { height: 2.6, radius: 0.8 },
    build: function (opts) {
      var rng = opts.rng, P = opts.palette, q = qLevel(opts.quality);
      var bag = new Bag();
      var S = rr(rng, 0.88, 1.12);
      var seg = q === 0 ? 6 : (q === 1 ? 8 : 10);

      var pale = jit(P.flesh, rng, 0.05, 0.10).lerp(new THREE.Color(0xd8d0cc), 0.35);
      var mFlesh = mkMat(bag, pale, { rough: 0.72 });
      var mFlesh2 = mkMat(bag, jit(P.flesh2, rng, 0.06, 0.12), { rough: 0.8 });
      var mGlass = mkMat(bag, 0x9fd8e4, {
        rough: 0.12, metal: 0.1, flat: false, transparent: true, opacity: 0.22,
        emissive: P.glow2, ei: 0.35, side: THREE.DoubleSide
      });
      var mShard = mkMat(bag, 0xbfe6ef, {
        rough: 0.1, metal: 0.1, transparent: true, opacity: 0.45, emissive: P.glow2, ei: 0.4
      });
      var mTube = mkMat(bag, jit(P.metal, rng, 0.05, 0.12), { rough: 0.6, metal: 0.3, flat: false });
      var mFluid = glowMat(bag, P.goo, 1.8, { color: 0x2c3a1c });
      var mMetal = mkMat(bag, jit(P.metal, rng, 0.04, 0.10), { rough: 0.45, metal: 0.65, flat: false });
      var mEye = glowMat(bag, P.glow2, 2.0, { color: 0x14202a });
      var mCable = mkMat(bag, 0x2b2b33, { rough: 0.9, flat: false });

      var rig = makeRig(S), group = rig.group, body = rig.body;

      /* ---- legs ---- */
      var hipY = 1.20;
      var legs = [];
      for (var li = 0; li < 2; li++) {
        var sx = li === 0 ? -1 : 1;
        var hip = new THREE.Group();
        hip.position.set(sx * 0.17, hipY, 0);
        body.add(hip);
        var thigh = strut(bag, hip, { dir: -1, len: 0.52, r0: 0.135, r1: 0.105, mat: mFlesh, radial: seg - 2 });
        var shin = strut(bag, thigh.tip, { dir: -1, len: 0.53, r0: 0.105, r1: 0.075, mat: mFlesh, radial: seg - 2 });
        var foot = box(bag, 0.16, 0.15, 0.28, mFlesh2, shin.tip);
        foot.position.set(0, -0.075, 0.05);
        legs.push({ hip: hip, knee: thigh.tip, ankle: shin.tip, s: sx });
      }

      /* severed cabling trailing from the feet */
      var cables = [];
      var nCab = 2;
      for (var ci = 0; ci < nCab; ci++) {
        var host = legs[ci % 2];
        var cc = segmentChain(bag, host.ankle, {
          count: 3, length: rr(rng, 0.45, 0.68), r0: 0.026, r1: 0.014, mat: mCable, radial: 4
        });
        cc.root.position.set(rr(rng, -0.05, 0.05), -0.06, -0.06);
        cc.root.rotation.x = -Math.PI * 0.5 + rr(rng, 0.18, 0.34);
        cc.root.rotation.z = rr(rng, -0.4, 0.4);
        chainRest(cc, function (i) { return -0.10 - i * 0.05; }, null, rng() * 6.28);
        cc.phase = rng() * 6.28;
        var plug = box(bag, 0.05, 0.05, 0.07, mMetal, cc.tip);
        cables.push(cc);
      }

      /* ---- torso ---- */
      var waist = new THREE.Group();
      waist.position.set(0, hipY, 0);
      body.add(waist);
      var pelvis = sph(bag, 0.24, seg, mFlesh, waist);
      pelvis.position.y = 0.06; pelvis.scale.set(1.15, 0.85, 0.9);
      var spineG = new THREE.Group();
      spineG.position.y = 0.10;
      waist.add(spineG);
      var abdo = sph(bag, 0.27, seg, mFlesh, spineG);
      abdo.position.y = 0.16; abdo.scale.set(1.05, 1.0, 0.85);
      var chest = sph(bag, 0.33, seg, mFlesh, spineG);
      chest.position.y = 0.48; chest.scale.set(1.2, 1.0, 0.82);
      var halfRib = box(bag, 0.30, 0.06, 0.05, mFlesh2, spineG);
      halfRib.position.set(rr(rng, -0.12, 0.12), rr(rng, 0.38, 0.52), 0.26);
      halfRib.rotation.z = rr(rng, -0.35, 0.35);

      /* ---- shattered growth tank ---- */
      var tank = new THREE.Group();
      tank.position.y = 0.30;
      spineG.add(tank);
      var tubeR = rr(rng, 0.40, 0.48);
      var glass = cyl(bag, tubeR, tubeR, 1.02, q === 0 ? 8 : 12, mGlass, tank, true);
      glass.position.y = 0.06;
      var nShard = q === 0 ? 4 : 6;
      for (var sh2 = 0; sh2 < nShard; sh2++) {
        var sa = (sh2 / nShard) * Math.PI * 2 + rr(rng, -0.2, 0.2);
        var up = sh2 % 2 === 0;
        var shd = cone(bag, rr(rng, 0.05, 0.09), rr(rng, 0.14, 0.30), 3, mShard, tank);
        shd.position.set(Math.sin(sa) * tubeR, up ? 0.62 : -0.50, Math.cos(sa) * tubeR);
        shd.rotation.x = rr(rng, -0.3, 0.3) + (up ? 0 : Math.PI);
        shd.rotation.z = rr(rng, -0.35, 0.35);
      }
      var collar = cyl(bag, tubeR + 0.03, tubeR + 0.03, 0.09, q === 0 ? 8 : 12, mMetal, tank, true);
      collar.position.y = -0.46;

      /* ---- nutrient tubes into spine and skull ---- */
      var tubes = [];
      var nTube = 2;
      for (var tu = 0; tu < nTube; tu++) {
        var tc = segmentChain(bag, spineG, {
          count: 3, length: rr(rng, 0.42, 0.60), r0: 0.032, r1: 0.022, mat: mTube, radial: 4
        });
        tc.root.position.set(rr(rng, -0.16, 0.16), 0.30 + tu * 0.20, -0.22);
        tc.root.rotation.x = rr(rng, -0.75, -0.40);
        tc.root.rotation.z = rr(rng, -0.35, 0.35);
        chainRest(tc, function (i) { return -0.12 + i * 0.10; }, null, rng() * 6.28);
        tc.phase = rng() * 6.28;
        var port = box(bag, 0.07, 0.05, 0.07, mMetal, tc.root);
        tubes.push(tc);
      }

      /* ---- arms ---- */
      var shoulders = [];
      for (var ai = 0; ai < 2; ai++) {
        var asx = ai === 0 ? -1 : 1;
        var sh = new THREE.Group();
        sh.position.set(asx * 0.34, 0.52, 0);
        spineG.add(sh);
        var upA = strut(bag, sh, { dir: -1, len: 0.46, r0: 0.095, r1: 0.078, mat: mFlesh, radial: seg - 2 });
        var foreA = strut(bag, upA.tip, { dir: -1, len: 0.44, r0: 0.078, r1: 0.06, mat: mFlesh, radial: seg - 2 });
        shoulders.push({ sh: sh, el: upA.tip, wr: foreA.tip, s: asx });
      }
      var paddleArm = rng() < 0.5 ? shoulders[0] : shoulders[1];
      var handArm = paddleArm === shoulders[0] ? shoulders[1] : shoulders[0];
      var paddle = box(bag, 0.20, 0.26, 0.055, mFlesh, paddleArm.wr);
      paddle.position.y = -0.12;
      paddle.rotation.z = paddleArm.s * 0.12;
      var palm2 = box(bag, 0.11, 0.14, 0.07, mFlesh, handArm.wr);
      palm2.position.y = -0.08;
      for (var fg = 0; fg < 2; fg++) {
        var fgm = box(bag, 0.032, 0.11, 0.034, mFlesh, handArm.wr);
        fgm.position.set((fg - 0.5) * 0.05, -0.19, 0.01);
        fgm.rotation.x = rr(rng, -0.25, 0.25);
      }

      /* ---- half-formed head ---- */
      var neckG = new THREE.Group();
      neckG.position.y = 0.66;
      spineG.add(neckG);
      var neck2 = cyl(bag, 0.08, 0.10, 0.12, 6, mFlesh, neckG);
      neck2.position.y = 0.04;
      var head = new THREE.Group();
      head.position.y = 0.11;
      neckG.add(head);
      var skull = sph(bag, 0.21, seg, mFlesh, head);
      skull.position.y = 0.16; skull.scale.set(0.95, 1.1, 1.0);
      var faceSmear = sph(bag, 0.15, seg - 2, mFlesh, head);
      faceSmear.position.set(rr(rng, -0.03, 0.03), 0.12, 0.13);
      faceSmear.scale.set(1.0, 0.85, 0.6);
      var oneEye = sph(bag, 0.045, 6, mEye, head);
      oneEye.position.set(rr(rng, 0.03, 0.09) * (rng() < 0.5 ? -1 : 1), rr(rng, 0.16, 0.22), 0.17);
      var socket = sph(bag, 0.035, 6, mFlesh2, head);
      socket.position.set(-oneEye.position.x * rr(rng, 0.8, 1.2), rr(rng, 0.13, 0.19), 0.17);
      var lowJaw = box(bag, 0.15, 0.07, 0.14, mFlesh2, head);
      lowJaw.position.set(0, 0.02, 0.10);
      var electrode = cyl(bag, 0.018, 0.018, 0.14, 4, mMetal, head);
      electrode.position.set(rr(rng, -0.1, 0.1), 0.33, -0.03);
      electrode.rotation.z = rr(rng, -0.3, 0.3);

      /* skull tube */
      var skullTube = segmentChain(bag, head, {
        count: 3, length: 0.42, r0: 0.028, r1: 0.018, mat: mTube, radial: 4
      });
      skullTube.root.position.set(rr(rng, -0.06, 0.06), 0.30, -0.10);
      skullTube.root.rotation.x = -0.95;
      chainRest(skullTube, function (i) { return -0.05 + i * 0.15; }, null, rng() * 6.28);
      skullTube.phase = rng() * 6.28;
      tubes.push(skullTube);

      /* ---- amniotic drips ---- */
      var drips = [];
      var nDrip = q === 0 ? 4 : (q === 1 ? 5 : 6);
      var dripGeo = new THREE.SphereGeometry(0.035, 5, 4);
      for (var dr = 0; dr < nDrip; dr++) {
        var dm = mesh(bag, dripGeo, mFluid, body);
        var da = rng() * Math.PI * 2;
        var drad = rr(rng, 0.12, 0.42);
        dm.userData.x = Math.sin(da) * drad;
        dm.userData.z = Math.cos(da) * drad * 0.7;
        dm.userData.y0 = rr(rng, 0.95, 1.85);
        dm.userData.sp = rr(rng, 0.35, 0.8);
        dm.userData.ph = rng();
        dm.userData.sc = rr(rng, 0.6, 1.25);
        dm.position.set(dm.userData.x, dm.userData.y0, dm.userData.z);
        dm.scale.setScalar(dm.userData.sc);
        drips.push(dm);
      }

      var headAnchor = anchor(rig.root, 2.95);

      /* ---- animation ---- */
      var t = 0, walkPh = rng() * 6.28, bob = rng() * 6.28;
      var eiFluid = mFluid.emissiveIntensity, eiEye = mEye.emissiveIntensity;
      var eiGlass = mGlass.emissiveIntensity;

      return {
        group: group,
        headAnchor: headAnchor,
        materials: bag.mats,
        hitPoints: [head, chest, tank, legs[0].knee],
        update: function (dt, ctx) {
          ctx = ctx || {};
          t += dt;
          var st = ctx.state || 'idle';
          var ms = ctx.moveSpeed || 0;
          var sp = ctx.spawnT === undefined ? 1 : clamp01(ctx.spawnT);
          var hp = ctx.hpFrac === undefined ? 1 : clamp01(ctx.hpFrac);
          var hurt = clamp01(ctx.hurtT || 0);
          var walking = st === 'walk';
          var i;

          /* deliberately slow, underwater rates */
          walkPh += dt * (walking ? (1.15 + ms * 1.5) : 0.35);
          var drift = Math.sin(t * 0.62 + bob);
          var drift2 = Math.sin(t * 0.41 + bob * 1.7);

          body.position.set(0, 0, 0);
          body.rotation.set(0, 0, 0);
          body.scale.set(1, 1, 1);
          waist.rotation.set(0, 0, 0);
          spineG.rotation.set(0, 0, 0);
          head.rotation.set(0, 0, 0);
          for (i = 0; i < 2; i++) {
            legs[i].hip.rotation.set(0, 0, 0);
            legs[i].knee.rotation.set(0, 0, 0);
            legs[i].ankle.rotation.set(0, 0, 0);
            shoulders[i].sh.rotation.set(0, 0, 0);
            shoulders[i].el.rotation.set(0, 0, 0);
          }

          /* idle: floating, lolling */
          body.position.y = drift * 0.035;
          spineG.rotation.x = -0.06 + drift * 0.05;
          spineG.rotation.y = drift2 * 0.09;
          head.rotation.x = 0.12 + drift2 * 0.12;
          head.rotation.z = drift * 0.13;
          head.rotation.y = Math.sin(t * 0.33) * 0.2;
          chest.scale.set(1.2 + drift * 0.03, 1.0 + drift * 0.035, 0.82 + drift * 0.02);
          for (i = 0; i < 2; i++) {
            shoulders[i].sh.rotation.z = shoulders[i].s * (0.20 + drift * 0.10);
            shoulders[i].sh.rotation.x = -0.10 + Math.sin(t * 0.55 + i * 2.2) * 0.16;
            shoulders[i].el.rotation.x = 0.30 + Math.sin(t * 0.47 + i * 1.4) * 0.18;
          }

          /* walk: slow wading stride */
          if (walking || ms > 0.01) {
            var amp = walking ? 1 : 0.3;
            for (i = 0; i < 2; i++) {
              var ph = walkPh + (i === 0 ? 0 : Math.PI);
              var sw = Math.sin(ph);
              legs[i].hip.rotation.x = sw * 0.34 * amp;
              legs[i].knee.rotation.x = (Math.max(0, -Math.cos(ph)) * 0.5 + 0.08) * amp;
              legs[i].ankle.rotation.x = -sw * 0.14 * amp;
              shoulders[i].sh.rotation.x += -sw * 0.22 * amp;
            }
            body.position.y += Math.abs(Math.sin(walkPh)) * 0.05 * amp - 0.02 * amp;
            body.rotation.z = Math.sin(walkPh) * 0.045 * amp;
            body.rotation.x = 0.04 * amp;
            spineG.rotation.y += Math.sin(walkPh) * 0.10 * amp;
          } else {
            for (i = 0; i < 2; i++) legs[i].knee.rotation.x = 0.06;
          }

          /* attack: slow floating rear-back then a heavy paddle slam */
          if (st === 'attack') {
            var sc = swingCurve(ctx.attackT || 0);
            paddleArm.sh.rotation.x = -sc * 1.35 - 0.10;
            paddleArm.sh.rotation.z = paddleArm.s * (0.25 - Math.max(0, sc) * 0.30);
            paddleArm.el.rotation.x = 0.45 + Math.max(0, -sc) * 0.55 - Math.max(0, sc) * 0.40;
            handArm.sh.rotation.x = sc * 0.35;
            handArm.el.rotation.x = 0.4;
            spineG.rotation.y = paddleArm.s * sc * 0.30;
            spineG.rotation.x = -0.06 + sc * 0.20;
            head.rotation.x = 0.12 + sc * 0.22;
            body.position.z = Math.max(0, sc) * 0.14;
          }

          /* hurt */
          if (hurt > 0.001) {
            var hh = hurt * hurt;
            spineG.rotation.x -= hh * 0.30;
            head.rotation.x -= hh * 0.35;
            body.position.z -= hh * 0.12;
            for (i = 0; i < 2; i++) shoulders[i].sh.rotation.x += hh * 0.30;
          }

          /* spawn: rises with the tank, unfolding */
          if (sp < 0.999) {
            var e = smooth(sp);
            body.position.y -= 2.7 * (1 - e);
            var s4 = 0.6 + 0.4 * e;
            body.scale.set(s4, s4, s4);
            spineG.rotation.x -= (1 - e) * 0.65;
            head.rotation.x += (1 - e) * 0.9;
            for (i = 0; i < 2; i++) {
              shoulders[i].sh.rotation.x += (1 - e) * 0.9;
              legs[i].knee.rotation.x += (1 - e) * 0.9;
            }
          }

          /* die: folds up and sinks, fluid light fails */
          var dieF = 1;
          if (st === 'die') {
            var d = smooth(clamp01(ctx.dieT || 0));
            dieF = Math.max(0, 1 - d * 1.5);
            body.rotation.x = -d * 0.35;
            body.position.y = -d * 0.75;
            spineG.rotation.x = -0.06 - d * 0.9;
            head.rotation.x = 0.12 + d * 1.0;
            for (i = 0; i < 2; i++) {
              legs[i].hip.rotation.x = -d * 0.8;
              legs[i].knee.rotation.x = d * 1.7;
              shoulders[i].sh.rotation.x = d * 0.5;
              shoulders[i].el.rotation.x = d * 0.9;
            }
          }

          /* nutrient tubes + trailing cable sway */
          for (i = 0; i < tubes.length; i++) {
            waveChain(tubes[i], t * 1.25 + tubes[i].phase + walkPh * 0.6, 0.16, 0.12, 0.95, 0.8);
          }
          for (i = 0; i < cables.length; i++) {
            waveChain(cables[i], t * 1.0 + cables[i].phase + walkPh * 1.3, 0.13, 0.20, 1.0, 0.9);
          }

          /* amniotic drips fall and reset */
          for (i = 0; i < drips.length; i++) {
            var dm2 = drips[i], ud = dm2.userData;
            var u2 = (t * ud.sp + ud.ph) % 1;
            var fall = ud.y0 - 0.06;
            dm2.position.set(ud.x, ud.y0 - u2 * fall, ud.z);
            var ds = ud.sc * (1 - u2 * 0.5) * (u2 > 0.94 ? (1 - u2) * 16 : 1);
            dm2.scale.set(ds * (1 - u2 * 0.25), ds * (1 + u2 * 0.5), ds * (1 - u2 * 0.25));
          }

          mFluid.emissiveIntensity = eiFluid * (0.75 + 0.25 * Math.sin(t * 1.9)) * dieF;
          mEye.emissiveIntensity = eiEye * (0.7 + 0.3 * Math.sin(t * 1.3)) * (1 + (1 - hp) * 0.8) * dieF;
          mGlass.emissiveIntensity = eiGlass * (0.8 + 0.2 * Math.sin(t * 0.9)) * dieF;
        },
        dispose: makeDispose(bag)
      };
    }
  };

  /* ===================================================================== */
  /* 4. CHIMERA                                                            */
  /* ===================================================================== */

  REG['chimera_pack'] = {
    id: 'chimera_pack',
    name: 'CHIMERA',
    tier: 'mid',
    size: { height: 2.2, radius: 1.5 },
    build: function (opts) {
      var rng = opts.rng, P = opts.palette, q = qLevel(opts.quality);
      var bag = new Bag();
      var S = rr(rng, 0.88, 1.12);
      var seg = q === 0 ? 6 : (q === 1 ? 8 : 10);

      var mFur = mkMat(bag, jit(P.flesh, rng, 0.07, 0.14), { rough: 0.92 });
      var mChit = mkMat(bag, jit(P.flesh2, rng, 0.07, 0.14), { rough: 0.45, metal: 0.25 });
      var mRaw = mkMat(bag, jit(P.accent, rng, 0.06, 0.14), { rough: 0.8 });
      var mStaple = mkMat(bag, jit(P.metal, rng, 0.03, 0.08), { rough: 0.35, metal: 0.8, flat: false });
      var mSuture = mkMat(bag, 0x37303a, { rough: 0.9, flat: false });
      var mBone = mkMat(bag, jit(P.bone, rng, 0.03, 0.08), { rough: 0.6 });
      var mEyeA = glowMat(bag, P.glow, 2.1, { color: 0x151a10 });
      var mEyeB = glowMat(bag, P.glow2, 2.1, { color: 0x101a1e });

      var rig = makeRig(S), group = rig.group, body = rig.body;

      var spineY = 1.02;
      var core = new THREE.Group();
      core.position.y = spineY;
      body.add(core);

      /* ---- front half: big cat ---- */
      var chest = sph(bag, 0.42, seg, mFur, core);
      chest.position.set(0, 0.02, 0.42);
      chest.scale.set(0.98, 0.98, 1.22);
      var shoulderHump = sph(bag, 0.26, seg - 2, mFur, core);
      shoulderHump.position.set(0, 0.20, 0.30);
      shoulderHump.scale.set(1.1, 0.75, 1.0);

      /* ---- rear half: insectile ---- */
      var abdo = mesh(bag, new THREE.IcosahedronGeometry(0.40, 0), mChit, core);
      abdo.position.set(0, -0.02, -0.52);
      abdo.scale.set(0.95, 0.92, 1.25);
      var abdoTail = cone(bag, 0.18, 0.44, 6, mChit, core);
      abdoTail.position.set(0, 0.02, -1.02);
      abdoTail.rotation.x = -Math.PI * 0.5;

      /* ---- surgical seam down the spine ---- */
      var seam = cyl(bag, 0.16, 0.18, 0.18, 8, mRaw, core);
      seam.position.set(0, 0.10, -0.06);
      seam.rotation.x = Math.PI * 0.5;
      var nStaple = q === 0 ? 5 : (q === 1 ? 7 : 8);
      var staples = [];
      for (var si = 0; si < nStaple; si++) {
        var u = si / (nStaple - 1);
        var stp = box(bag, 0.13, 0.035, 0.028, mStaple, core);
        stp.position.set(rr(rng, -0.02, 0.02), 0.18 + Math.sin(u * Math.PI) * 0.06, lerp(0.34, -0.66, u));
        stp.rotation.z = rr(rng, -0.25, 0.25);
        staples.push(stp);
      }
      var nSut = q === 0 ? 3 : 5;
      for (var su = 0; su < nSut; su++) {
        var sut = box(bag, 0.24, 0.016, 0.016, mSuture, core);
        sut.position.set(0, 0.14 + rr(rng, -0.04, 0.04), lerp(0.24, -0.54, su / Math.max(1, nSut - 1)));
        sut.rotation.z = rr(rng, 0.5, 1.1) * (su % 2 ? 1 : -1);
      }

      /* ---- front cat legs ---- */
      var frontLegs = [];
      for (var fi = 0; fi < 2; fi++) {
        var fsx = fi === 0 ? -1 : 1;
        var fa = new THREE.Group();
        fa.position.set(fsx * 0.28, -0.01, 0.50);
        core.add(fa);
        var fUp = strut(bag, fa, { dir: -1, len: 0.46, r0: 0.125, r1: 0.095, mat: mFur, radial: seg - 2 });
        var fLo = strut(bag, fUp.tip, { dir: -1, len: 0.41, r0: 0.09, r1: 0.065, mat: mFur, radial: seg - 2 });
        var paw = box(bag, 0.17, 0.14, 0.24, mFur, fLo.tip);
        paw.position.set(0, -0.07, 0.04);
        for (var cl = 0; cl < 2; cl++) {
          var claw = cone(bag, 0.026, 0.11, 4, mBone, fLo.tip);
          claw.position.set((cl - 0.5) * 0.08, -0.10, 0.16);
          claw.rotation.x = 1.5;
        }
        frontLegs.push({ hip: fa, knee: fUp.tip, ankle: fLo.tip, s: fsx });
      }

      /* ---- hind insect legs (knee above the body) ---- */
      var hindLegs = [];
      var femTilt = rr(rng, 0.46, 0.56);
      var femLen = rr(rng, 0.52, 0.60);
      for (var hi = 0; hi < 2; hi++) {
        var hsx = hi === 0 ? -1 : 1;
        var ha = new THREE.Group();
        ha.position.set(hsx * 0.30, -0.01, -0.60);
        core.add(ha);
        var femG = new THREE.Group();
        femG.rotation.z = -hsx * femTilt;
        ha.add(femG);
        var fem = strut(bag, femG, { dir: 1, len: femLen, r0: 0.085, r1: 0.06, mat: mChit, radial: 5 });
        /* knee height above ground, in body space */
        var kneeY = spineY - 0.01 + femLen * Math.cos(femTilt);
        var tibTilt = 0.13;
        var tibLen = (kneeY - 0.09) / Math.cos(tibTilt);
        var tibG = new THREE.Group();
        tibG.rotation.z = hsx * (tibTilt + femTilt);
        fem.tip.add(tibG);
        var tib = strut(bag, tibG, { dir: -1, len: tibLen, r0: 0.055, r1: 0.032, mat: mChit, radial: 5 });
        var spike = cone(bag, 0.035, 0.09, 4, mBone, tib.tip);
        spike.position.y = -0.045;
        spike.rotation.x = Math.PI;
        var spur2 = cone(bag, 0.028, 0.10, 4, mChit, fem.tip);
        spur2.position.y = 0.04;
        hindLegs.push({ hip: ha, fem: femG, tib: tibG, tip: tib.tip, s: hsx, kneeY: kneeY });
      }

      /* ---- two heads on long necks ---- */
      function buildHead(kind, sx) {
        var neck = segmentChain(bag, core, {
          count: 3, length: rr(rng, 0.70, 0.82), r0: 0.105, r1: 0.07, mat: kind === 0 ? mFur : mRaw, radial: 5
        });
        neck.root.position.set(sx * 0.19, 0.22, 0.48);
        neck.root.rotation.y = sx * rr(rng, 0.10, 0.28);
        var tilt = rr(rng, 0.36, 0.50);
        chainRest(neck, (function (tt) {
          return function (i) { return -tt + i * 0.10; };
        })(tilt), (function (s2) {
          return function (i) { return s2 * 0.06; };
        })(sx), rng() * 6.28);

        var hg = new THREE.Group();
        neck.tip.add(hg);
        var jaw = new THREE.Group();
        hg.add(jaw);
        if (kind === 0) {
          /* canine */
          var sk = sph(bag, 0.17, seg - 2, mFur, hg);
          sk.position.y = 0.06; sk.scale.set(0.9, 0.95, 1.05);
          var snout = box(bag, 0.15, 0.13, 0.28, mFur, hg);
          snout.position.set(0, 0.01, 0.20);
          var lowJ = box(bag, 0.13, 0.07, 0.24, mRaw, jaw);
          lowJ.position.set(0, -0.07, 0.20);
          for (var ea = 0; ea < 2; ea++) {
            var earM = cone(bag, 0.06, 0.16, 4, mFur, hg);
            earM.position.set((ea ? 1 : -1) * 0.09, 0.20, -0.02);
            earM.rotation.z = (ea ? 1 : -1) * 0.25;
          }
          for (var fa2 = 0; fa2 < 2; fa2++) {
            var fang = cone(bag, 0.022, 0.09, 4, mBone, hg);
            fang.position.set((fa2 ? 1 : -1) * 0.05, -0.05, 0.30);
            fang.rotation.x = Math.PI;
          }
          var eg = new THREE.SphereGeometry(0.033, 6, 4);
          var e1 = mesh(bag, eg, mEyeA, hg); e1.position.set(-0.075, 0.09, 0.12);
          var e2 = mesh(bag, eg, mEyeA, hg); e2.position.set(0.075, 0.09, 0.12);
        } else {
          /* primate-ish */
          var sk2 = sph(bag, 0.185, seg - 2, mRaw, hg);
          sk2.position.y = 0.08; sk2.scale.set(1.0, 1.05, 0.95);
          var face = sph(bag, 0.13, seg - 2, mFur, hg);
          face.position.set(0, 0.0, 0.13); face.scale.set(0.95, 0.9, 0.8);
          var brow = box(bag, 0.22, 0.05, 0.09, mBone, hg);
          brow.position.set(0, 0.10, 0.15);
          var lowJ2 = box(bag, 0.15, 0.09, 0.13, mFur, jaw);
          lowJ2.position.set(0, -0.10, 0.12);
          var teethB = box(bag, 0.12, 0.035, 0.03, mBone, hg);
          teethB.position.set(0, -0.045, 0.20);
          var eg2 = new THREE.SphereGeometry(0.036, 6, 4);
          var e3 = mesh(bag, eg2, mEyeB, hg); e3.position.set(-0.062, 0.04, 0.20);
          var e4 = mesh(bag, eg2, mEyeB, hg); e4.position.set(0.062, 0.04, 0.20);
          var stapleH = box(bag, 0.10, 0.028, 0.024, mStaple, hg);
          stapleH.position.set(0, 0.19, 0.04);
        }
        return {
          neck: neck, head: hg, jaw: jaw,
          ph: rng() * 6.28, rate: rr(rng, 0.7, 1.35), snapOff: rng() * 0.5
        };
      }
      var headA = buildHead(0, rng() < 0.5 ? -1 : 1);
      var headB = buildHead(1, -Math.sign(headA.neck.root.position.x) || 1);
      headB.neck.root.position.x = -headA.neck.root.position.x;
      var heads = [headA, headB];

      var headAnchor = anchor(rig.root, 2.45, 0.35);

      /* ---- animation ---- */
      var t = 0, gaitPh = rng() * 6.28;
      var eiA = mEyeA.emissiveIntensity, eiB = mEyeB.emissiveIntensity;
      /* four-beat gait offsets: FL, FR, HL, HR */
      var beat = [0, 0.5, 0.25, 0.75];

      return {
        group: group,
        headAnchor: headAnchor,
        materials: bag.mats,
        hitPoints: [headA.head, headB.head, chest, abdo],
        update: function (dt, ctx) {
          ctx = ctx || {};
          t += dt;
          var st = ctx.state || 'idle';
          var ms = ctx.moveSpeed || 0;
          var sp = ctx.spawnT === undefined ? 1 : clamp01(ctx.spawnT);
          var hp = ctx.hpFrac === undefined ? 1 : clamp01(ctx.hpFrac);
          var hurt = clamp01(ctx.hurtT || 0);
          var walking = st === 'walk';
          var i, h;

          gaitPh += dt * (walking ? (1.9 + ms * 2.4) : 0.5);
          var br = Math.sin(t * 1.6);

          body.position.set(0, 0, 0);
          body.rotation.set(0, 0, 0);
          body.scale.set(1, 1, 1);
          core.rotation.set(0, 0, 0);
          for (i = 0; i < 2; i++) {
            frontLegs[i].hip.rotation.set(0, 0, 0);
            frontLegs[i].knee.rotation.set(0, 0, 0);
            frontLegs[i].ankle.rotation.set(0, 0, 0);
            hindLegs[i].hip.rotation.set(0, 0, 0);
          }

          /* idle: breathing flanks, low prowl sway */
          chest.scale.set(0.98 + br * 0.03, 0.98 + br * 0.03, 1.22);
          abdo.scale.set(0.95 + br * 0.025, 0.92 + br * 0.03, 1.25);
          core.rotation.z = Math.sin(t * 0.55) * 0.035;
          core.rotation.y = Math.sin(t * 0.37) * 0.05;
          body.position.y = br * 0.018;
          for (i = 0; i < 2; i++) {
            frontLegs[i].knee.rotation.x = 0.10;
            frontLegs[i].hip.rotation.x = -0.05;
          }

          /* four-beat prowl */
          if (walking || ms > 0.01) {
            var amp = walking ? 1 : 0.3;
            for (i = 0; i < 2; i++) {
              var fp = (gaitPh + beat[i] * Math.PI * 2);
              var fsw = Math.sin(fp);
              frontLegs[i].hip.rotation.x = fsw * 0.46 * amp - 0.05;
              frontLegs[i].knee.rotation.x = (Math.max(0, -Math.cos(fp)) * 0.55 + 0.10) * amp;
              frontLegs[i].ankle.rotation.x = -fsw * 0.22 * amp;
              var hpp = (gaitPh + beat[i + 2] * Math.PI * 2);
              var hsw = Math.sin(hpp);
              hindLegs[i].hip.rotation.x = hsw * 0.30 * amp;
              hindLegs[i].fem.rotation.x = Math.max(0, -Math.cos(hpp)) * 0.26 * amp;
              hindLegs[i].tib.rotation.x = -hsw * 0.18 * amp;
            }
            body.position.y += Math.abs(Math.sin(gaitPh * 2)) * 0.045 * amp;
            core.rotation.z += Math.sin(gaitPh) * 0.06 * amp;
            core.rotation.x = Math.sin(gaitPh * 2) * 0.035 * amp - 0.03 * amp;
            core.rotation.y += Math.sin(gaitPh * 0.5) * 0.05 * amp;
          } else {
            for (i = 0; i < 2; i++) {
              hindLegs[i].fem.rotation.x = Math.sin(t * 0.6 + i) * 0.04;
              hindLegs[i].tib.rotation.x = 0;
            }
          }

          /* heads scan independently, snap at different times */
          var atk = st === 'attack' ? clamp01(ctx.attackT || 0) : -1;
          for (h = 0; h < 2; h++) {
            var hd = heads[h];
            var hph = t * hd.rate + hd.ph;
            waveChain(hd.neck, hph * 1.25 + gaitPh * 0.6, 0.11, 0.13, 0.75, 0.7);
            hd.head.rotation.x = Math.sin(hph * 0.9) * 0.22 + 0.10;
            hd.head.rotation.y = Math.sin(hph * 0.63 + h * 2.1) * 0.55;
            hd.head.rotation.z = Math.sin(hph * 0.5 + h) * 0.14;
            var chew = 0.5 + 0.5 * Math.sin(hph * 3.1 + h * 1.9);
            hd.jaw.rotation.x = chew * 0.18;

            if (atk >= 0) {
              /* each head lunges on its own offset window */
              var la = clamp01((atk - hd.snapOff * 0.35) / 0.8);
              var lc = swingCurve(la);
              for (var k = 0; k < hd.neck.segs.length; k++) {
                var uu = k / Math.max(1, hd.neck.segs.length - 1);
                hd.neck.segs[k].rotation.x = hd.neck.segs[k].userData.bx + lc * (0.14 + uu * 0.34);
                hd.neck.segs[k].rotation.z = hd.neck.segs[k].userData.bz;
              }
              hd.head.rotation.y = Math.sin(hph * 0.4) * 0.12;
              hd.head.rotation.x = 0.10 + lc * 0.30;
              hd.jaw.rotation.x = (la < 0.45 ? smooth(la / 0.45) : 1 - smooth((la - 0.45) / 0.55)) * 0.85;
            }
          }

          if (atk >= 0) {
            var sc = swingCurve(atk);
            core.rotation.x += sc * 0.14;
            body.position.z = Math.max(0, sc) * 0.22;
            for (i = 0; i < 2; i++) {
              frontLegs[i].hip.rotation.x += -sc * 0.30;
              hindLegs[i].fem.rotation.x += Math.max(0, sc) * 0.18;
            }
          }

          /* hurt: whole frame flinches sideways, heads rear */
          if (hurt > 0.001) {
            var hh = hurt * hurt;
            core.rotation.x -= hh * 0.22;
            core.rotation.z += hh * 0.18;
            body.position.z -= hh * 0.14;
            body.position.y -= hh * 0.05;
            for (h = 0; h < 2; h++) {
              for (var k3 = 0; k3 < heads[h].neck.segs.length; k3++) {
                heads[h].neck.segs[k3].rotation.x -= hh * 0.28;
              }
              heads[h].jaw.rotation.x += hh * 0.5;
            }
          }

          /* spawn: drags itself up out of the floor */
          if (sp < 0.999) {
            var e = smooth(sp);
            body.position.y -= 1.9 * (1 - e);
            var s5 = 0.55 + 0.45 * e;
            body.scale.set(s5, s5, s5);
            core.rotation.x -= (1 - e) * 0.4;
            for (i = 0; i < 2; i++) {
              frontLegs[i].hip.rotation.x -= (1 - e) * 0.8;
              frontLegs[i].knee.rotation.x += (1 - e) * 1.1;
              hindLegs[i].fem.rotation.x += (1 - e) * 0.5;
            }
            for (h = 0; h < 2; h++) {
              for (var k4 = 0; k4 < heads[h].neck.segs.length; k4++) {
                heads[h].neck.segs[k4].rotation.x += (1 - e) * 0.55;
              }
            }
          }

          /* die: legs splay, body flops onto its side */
          var dieF = 1;
          if (st === 'die') {
            var d = smooth(clamp01(ctx.dieT || 0));
            dieF = Math.max(0, 1 - d * 1.5);
            body.position.y = -d * 0.55;
            body.rotation.z = d * 0.85;
            body.rotation.x = d * 0.20;
            core.rotation.x = -d * 0.25;
            for (i = 0; i < 2; i++) {
              frontLegs[i].hip.rotation.x = -d * 0.9 * (i ? 1 : -1);
              frontLegs[i].knee.rotation.x = d * 1.3;
              hindLegs[i].fem.rotation.x = d * 0.8;
              hindLegs[i].tib.rotation.x = -d * 0.7;
              hindLegs[i].hip.rotation.z = hindLegs[i].s * d * 0.5;
            }
            for (h = 0; h < 2; h++) {
              for (var k5 = 0; k5 < heads[h].neck.segs.length; k5++) {
                heads[h].neck.segs[k5].rotation.x = heads[h].neck.segs[k5].userData.bx + d * (0.5 + k5 * 0.25);
              }
              heads[h].jaw.rotation.x = d * 0.6;
              heads[h].head.rotation.z = d * 0.7 * (h ? -1 : 1);
            }
          }

          var rage = 1 + (1 - hp) * 1.2;
          mEyeA.emissiveIntensity = eiA * (0.75 + 0.25 * Math.sin(t * 4.1)) * rage * dieF;
          mEyeB.emissiveIntensity = eiB * (0.75 + 0.25 * Math.sin(t * 3.3 + 1.7)) * rage * dieF;
        },
        dispose: makeDispose(bag)
      };
    }
  };

  /* ===================================================================== */
  /* 5. SWARM MOTHER                                                       */
  /* ===================================================================== */

  REG['swarm_mother'] = {
    id: 'swarm_mother',
    name: 'SWARM MOTHER',
    tier: 'mid',
    size: { height: 2.8, radius: 1.25 },
    build: function (opts) {
      var rng = opts.rng, P = opts.palette, q = qLevel(opts.quality);
      var bag = new Bag();
      var S = rr(rng, 0.88, 1.12);
      var seg = q === 0 ? 7 : (q === 1 ? 9 : 11);

      var mFlesh = mkMat(bag, jit(P.flesh, rng, 0.07, 0.14), { rough: 0.9 });
      var mFlesh2 = mkMat(bag, jit(P.flesh2, rng, 0.07, 0.14), { rough: 0.92 });
      var mLeg = mkMat(bag, jit(P.flesh2, rng, 0.05, 0.16).multiplyScalar(0.85), { rough: 0.55, metal: 0.2 });
      var broodHue = rng() < 0.5 ? P.glow : P.glow2;
      var mSac = mkMat(bag, jit(broodHue, rng, 0.05, 0.10), {
        rough: 0.35, flat: false, transparent: true, opacity: 0.30,
        emissive: broodHue, ei: 0.9
      });
      var mBrood = glowMat(bag, broodHue, 2.2, { color: 0x22301a });
      var mCore = glowMat(bag, P.goo, 1.3, { color: 0x1c2a14, transparent: true, opacity: 0.55 });
      var mVent = mkMat(bag, jit(P.accent, rng, 0.06, 0.14), {
        rough: 0.7, emissive: broodHue, ei: 0.5
      });
      var mEye = glowMat(bag, P.accent, 1.8, { color: 0x1a0d0c });
      var mMetal = mkMat(bag, jit(P.metal, rng, 0.03, 0.08), { rough: 0.4, metal: 0.7, flat: false });

      var rig = makeRig(S), group = rig.group, body = rig.body;

      var mount = new THREE.Group();
      mount.position.y = 1.86;
      body.add(mount);

      /* ---- brood chamber ---- */
      var sacG = new THREE.Group();
      sacG.position.set(0, 0.10, -0.12);
      mount.add(sacG);
      var sacR = rr(rng, 0.60, 0.70);
      var shell = sph(bag, sacR, seg, mSac, sacG);
      shell.scale.set(1.0, 0.88, 1.15);
      var coreBlob = sph(bag, sacR * 0.55, seg - 2, mCore, sacG);
      coreBlob.scale.set(1.0, 0.85, 1.1);

      var brood = [];
      var nBrood = q === 0 ? 5 : (q === 1 ? 7 : 9);
      var broodGeo = new THREE.IcosahedronGeometry(1, 0);
      for (var bi = 0; bi < nBrood; bi++) {
        var bm = mesh(bag, broodGeo, mBrood, sacG);
        var ba = rng() * Math.PI * 2;
        var bel = rr(rng, -0.7, 0.7);
        var brad = sacR * rr(rng, 0.25, 0.62);
        bm.userData.hx = Math.sin(ba) * brad * Math.cos(bel);
        bm.userData.hy = Math.sin(bel) * brad * 0.72;
        bm.userData.hz = Math.cos(ba) * brad * 1.05;
        bm.userData.ph = rng() * 6.28;
        bm.userData.rate = rr(rng, 0.8, 1.8);
        bm.userData.s = rr(rng, 0.055, 0.105);
        bm.position.set(bm.userData.hx, bm.userData.hy, bm.userData.hz);
        bm.scale.setScalar(bm.userData.s);
        brood.push(bm);
      }

      /* ---- vent ring ---- */
      var vents = [];
      var nVent = q === 0 ? 5 : (q === 1 ? 7 : 8);
      for (var vi = 0; vi < nVent; vi++) {
        var va = (vi / nVent) * Math.PI * 2 + rr(rng, -0.12, 0.12);
        var vg = new THREE.Group();
        vg.position.set(Math.sin(va) * sacR * 0.94, rr(rng, -0.14, 0.10), Math.cos(va) * sacR * 1.08);
        vg.rotation.y = va;
        vg.rotation.x = Math.PI * 0.5;
        sacG.add(vg);
        var vm = cone(bag, rr(rng, 0.055, 0.085), rr(rng, 0.10, 0.16), 5, mVent, vg);
        vm.position.y = 0.05;
        vg.userData.ph = rng();
        vg.userData.rate = rr(rng, 0.45, 0.8);
        vents.push(vg);
      }

      /* ---- thorax + vestigial head ---- */
      var thorax = sph(bag, 0.26, seg - 2, mFlesh, mount);
      thorax.position.set(0, -0.02, 0.50);
      thorax.scale.set(1.0, 0.9, 1.05);
      var neckG = new THREE.Group();
      neckG.position.set(0, -0.06, 0.66);
      mount.add(neckG);
      var neck = cyl(bag, 0.07, 0.10, 0.16, 6, mFlesh2, neckG);
      neck.rotation.x = 1.15;
      neck.position.set(0, -0.02, 0.06);
      var head = new THREE.Group();
      head.position.set(0, -0.09, 0.19);
      neckG.add(head);
      var skull = sph(bag, 0.135, seg - 2, mFlesh2, head);
      skull.scale.set(1.0, 0.85, 1.1);
      var snout = cone(bag, 0.07, 0.16, 5, mFlesh2, head);
      snout.position.z = 0.14; snout.rotation.x = Math.PI * 0.5;
      var mand = box(bag, 0.11, 0.03, 0.09, mFlesh, head);
      mand.position.set(0, -0.06, 0.12);
      var egeo = new THREE.SphereGeometry(0.028, 5, 4);
      var eL = mesh(bag, egeo, mEye, head); eL.position.set(-0.055, 0.045, 0.09);
      var eR = mesh(bag, egeo, mEye, head); eR.position.set(0.055, 0.045, 0.09);
      var clamp = cyl(bag, 0.10, 0.10, 0.05, 8, mMetal, mount, true);
      clamp.position.set(0, -0.04, 0.60);
      clamp.rotation.x = 1.3;

      /* ---- four thin stilt legs ---- */
      var legs = [];
      var femLen = rr(rng, 0.98, 1.12);
      var femTilt = rr(rng, 0.38, 0.48);
      var attachY = 1.86;
      for (var lg2 = 0; lg2 < 4; lg2++) {
        var lsx = lg2 % 2 === 0 ? -1 : 1;
        var lsz = lg2 < 2 ? 1 : -1;
        var ha2 = new THREE.Group();
        ha2.position.set(lsx * 0.36, 0, lsz * 0.42);
        mount.add(ha2);
        var coxa = sph(bag, 0.10, 6, mFlesh2, ha2);
        var femG = new THREE.Group();
        femG.rotation.z = -lsx * femTilt;
        femG.rotation.x = -lsz * 0.10;
        ha2.add(femG);
        var fem = strut(bag, femG, { dir: 1, len: femLen, r0: 0.065, r1: 0.042, mat: mLeg, radial: 5 });
        var kneeY = attachY + femLen * Math.cos(femTilt);
        var tibTilt = 0.11;
        var tibLen = (kneeY - 0.085) / Math.cos(tibTilt);
        var tibG = new THREE.Group();
        tibG.rotation.z = lsx * (tibTilt + femTilt);
        tibG.rotation.x = lsz * 0.10;
        fem.tip.add(tibG);
        var tib = strut(bag, tibG, { dir: -1, len: tibLen, r0: 0.042, r1: 0.022, mat: mLeg, radial: 5 });
        var foot = cone(bag, 0.03, 0.085, 4, mLeg, tib.tip);
        foot.position.y = -0.0425;
        foot.rotation.x = Math.PI;
        legs.push({ hip: ha2, fem: femG, tib: tibG, s: lsx, z: lsz, beat: (lg2 === 0 || lg2 === 3) ? 0 : 0.5 });
      }

      var headAnchor = anchor(rig.root, 3.10, 0.1);

      /* ---- animation ---- */
      var t = 0, gaitPh = rng() * 6.28, bob = rng() * 6.28;
      var eiBrood = mBrood.emissiveIntensity, eiSac = mSac.emissiveIntensity;
      var eiCore = mCore.emissiveIntensity, eiVent = mVent.emissiveIntensity;
      var eiEye = mEye.emissiveIntensity;

      return {
        group: group,
        headAnchor: headAnchor,
        materials: bag.mats,
        hitPoints: [shell, head, thorax, legs[0].fem],
        update: function (dt, ctx) {
          ctx = ctx || {};
          t += dt;
          var st = ctx.state || 'idle';
          var ms = ctx.moveSpeed || 0;
          var sp = ctx.spawnT === undefined ? 1 : clamp01(ctx.spawnT);
          var hp = ctx.hpFrac === undefined ? 1 : clamp01(ctx.hpFrac);
          var hurt = clamp01(ctx.hurtT || 0);
          var walking = st === 'walk';
          var rage = 1 + (1 - hp) * 1.6;
          var i;

          gaitPh += dt * (walking ? (1.6 + ms * 2.2) : 0.4);
          var br = Math.sin(t * 1.15 + bob);

          body.position.set(0, 0, 0);
          body.rotation.set(0, 0, 0);
          body.scale.set(1, 1, 1);
          mount.rotation.set(0, 0, 0);
          sacG.rotation.set(0, 0, 0);
          neckG.rotation.set(0, 0, 0);
          head.rotation.set(0, 0, 0);
          for (i = 0; i < 4; i++) {
            legs[i].hip.rotation.set(0, 0, 0);
            legs[i].fem.rotation.x = -legs[i].z * 0.10;
            legs[i].fem.rotation.z = -legs[i].s * femTilt;
            legs[i].tib.rotation.x = legs[i].z * 0.10;
          }

          /* idle: sac swells and settles, head twitches */
          var swell = 1 + br * 0.035;
          shell.scale.set(1.0 * swell, 0.88 * swell, 1.15 * swell);
          coreBlob.scale.set(swell, 0.85 * swell, 1.1 * swell);
          sacG.rotation.z = Math.sin(t * 0.47) * 0.05;
          sacG.rotation.x = br * 0.04;
          body.position.y = br * 0.03;
          mount.rotation.z = Math.sin(t * 0.39 + 1.2) * 0.035;
          head.rotation.y = Math.sin(t * 1.9) * 0.25;
          head.rotation.x = Math.sin(t * 2.7 + 0.8) * 0.16;
          neckG.rotation.x = Math.sin(t * 0.8) * 0.08;

          /* walk: alternating diagonal stilt steps, sac swings */
          if (walking || ms > 0.01) {
            var amp = walking ? 1 : 0.3;
            for (i = 0; i < 4; i++) {
              var lp = gaitPh + legs[i].beat * Math.PI * 2;
              var lsw = Math.sin(lp);
              var lift = Math.max(0, -Math.cos(lp));
              legs[i].hip.rotation.x = lsw * 0.20 * amp;
              legs[i].fem.rotation.x += (lift * 0.30 - lsw * 0.10) * amp;
              legs[i].fem.rotation.z += -legs[i].s * lift * 0.14 * amp;
              legs[i].tib.rotation.x += (-lsw * 0.16 - lift * 0.18) * amp;
            }
            body.position.y += Math.sin(gaitPh * 2) * 0.05 * amp;
            body.rotation.z = Math.sin(gaitPh) * 0.05 * amp;
            body.rotation.x = 0.03 * amp;
            sacG.rotation.z += Math.sin(gaitPh - 0.7) * 0.11 * amp;
            sacG.rotation.x += Math.sin(gaitPh * 2 - 0.4) * 0.07 * amp;
            mount.rotation.y = Math.sin(gaitPh * 0.5) * 0.06 * amp;
          }

          /* attack: rears on the back legs, then slams the abdomen forward */
          var ventBoost = 0;
          if (st === 'attack') {
            var a = clamp01(ctx.attackT || 0);
            var sc = swingCurve(a);
            mount.rotation.x = -sc * 0.30;
            body.position.y += Math.max(0, -sc) * 0.22;
            body.position.z = Math.max(0, sc) * 0.26;
            sacG.rotation.x += sc * 0.35;
            neckG.rotation.x += sc * 0.4;
            head.rotation.x = sc * 0.5;
            for (i = 0; i < 4; i++) {
              var front = legs[i].z > 0;
              legs[i].fem.rotation.x += (front ? -sc : sc * 0.4) * 0.32;
              legs[i].tib.rotation.x += (front ? sc : -sc * 0.3) * 0.26;
            }
            ventBoost = Math.max(0, sc) * 1.4;
          }

          /* hurt: whole sac jolts, legs stagger */
          if (hurt > 0.001) {
            var hh = hurt * hurt;
            body.position.y -= hh * 0.10;
            body.position.z -= hh * 0.12;
            mount.rotation.x += hh * 0.20;
            sacG.rotation.x -= hh * 0.22;
            sacG.rotation.z += hh * 0.16;
            head.rotation.x -= hh * 0.4;
            for (i = 0; i < 4; i++) {
              legs[i].fem.rotation.z += legs[i].s * hh * 0.16;
              legs[i].tib.rotation.x -= hh * 0.12;
            }
          }

          /* spawn: unfolds its legs and rises out of the floor */
          if (sp < 0.999) {
            var e = smooth(sp);
            body.position.y -= 2.3 * (1 - e);
            var s6 = 0.5 + 0.5 * e;
            body.scale.set(s6, s6, s6);
            for (i = 0; i < 4; i++) {
              legs[i].fem.rotation.z += -legs[i].s * (1 - e) * 0.85;
              legs[i].tib.rotation.x += (1 - e) * 0.7;
              legs[i].hip.rotation.x += (1 - e) * 0.3;
            }
            sacG.rotation.x -= (1 - e) * 0.3;
            var ss = 0.45 + 0.55 * e;
            sacG.scale.set(ss, ss, ss);
          } else {
            sacG.scale.set(1, 1, 1);
          }

          /* die: legs buckle outward, sac deflates and drops */
          var dieF = 1;
          if (st === 'die') {
            var d = smooth(clamp01(ctx.dieT || 0));
            dieF = Math.max(0, 1 - d * 1.4);
            body.position.y = -d * 1.55;
            body.rotation.z = d * 0.35;
            body.rotation.x = d * 0.18;
            for (i = 0; i < 4; i++) {
              legs[i].fem.rotation.z = -legs[i].s * (femTilt + d * 0.95);
              legs[i].tib.rotation.x = d * 0.9 * legs[i].z;
              legs[i].hip.rotation.x = d * 0.4 * legs[i].z;
            }
            var ds2 = 1 - d * 0.42;
            sacG.scale.set(1 + d * 0.12, ds2, 1 + d * 0.12);
            sacG.rotation.x = d * 0.4;
            neckG.rotation.x = d * 0.9;
            head.rotation.x = d * 0.7;
          }

          /* brood squirm: faster and brighter as hp drops */
          var squirm = (1.6 + (1 - hp) * 3.4) * (st === 'die' ? 0.3 : 1);
          for (i = 0; i < brood.length; i++) {
            var bm2 = brood[i], ud = bm2.userData;
            var p1 = t * squirm * ud.rate + ud.ph;
            var wob = 0.055 + (1 - hp) * 0.05;
            bm2.position.set(
              ud.hx + Math.sin(p1) * wob,
              ud.hy + Math.sin(p1 * 1.37 + 1.1) * wob,
              ud.hz + Math.cos(p1 * 0.91) * wob * 1.1);
            bm2.rotation.x = p1 * 0.6;
            bm2.rotation.y = p1 * 0.41;
            var bs = ud.s * (1 + Math.sin(p1 * 1.7) * 0.18) * (1 + (1 - hp) * 0.15);
            bm2.scale.set(bs, bs, bs);
          }

          /* vents puff */
          for (i = 0; i < vents.length; i++) {
            var vg2 = vents[i];
            var vu = (t * vg2.userData.rate + vg2.userData.ph) % 1;
            var puff = vu < 0.14 ? Math.sin((vu / 0.14) * Math.PI) : 0;
            puff = Math.max(puff, ventBoost * 0.7);
            vg2.scale.set(1 + puff * 0.75, 1 + puff * 1.5, 1 + puff * 0.75);
          }

          var pulse = 0.75 + 0.25 * Math.sin(t * (2.0 + (1 - hp) * 3.0));
          mBrood.emissiveIntensity = eiBrood * pulse * rage * dieF;
          mSac.emissiveIntensity = eiSac * pulse * rage * dieF;
          mCore.emissiveIntensity = eiCore * (0.8 + 0.2 * Math.sin(t * 1.6)) * rage * dieF;
          mVent.emissiveIntensity = eiVent * (0.6 + 0.4 * pulse) * rage * dieF;
          mEye.emissiveIntensity = eiEye * (0.7 + 0.3 * Math.sin(t * 5.1)) * dieF;
        },
        dispose: makeDispose(bag)
      };
    }
  };

}());
