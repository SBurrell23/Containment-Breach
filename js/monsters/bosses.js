/* Cave Typer — BOSS monsters (tier: 'boss')
 * Classic script. THREE is a global (r128). No modules, no addons, seeded rng only.
 * Contains: patient_zero, hive_reactor, the_cultivar, warden_prime
 */
(function () {
  'use strict';

  window.CaveTyper = window.CaveTyper || {};
  window.CaveTyper.monsters = window.CaveTyper.monsters || {};

  var TAU = Math.PI * 2;
  var PI = Math.PI;

  var DEF_PAL = {
    flesh: 0x8a6a72, flesh2: 0x5c4450, accent: 0xb8452f, glow: 0x7dff4a,
    glow2: 0x36e0ff, bone: 0xd9d2bd, metal: 0x6b7076, goo: 0x9bff2e
  };

  /* ---------------------------------------------------------------- math */

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smooth(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
  function ease3(t) { t = clamp(t, 0, 1); return 1 - Math.pow(1 - t, 3); }
  function easeIn3(t) { t = clamp(t, 0, 1); return t * t * t; }
  function bump(t) { return Math.sin(clamp(t, 0, 1) * PI); }
  function subT(v, a, b) { return clamp((v - a) / (b - a || 1e-6), 0, 1); }
  /* double-thump heartbeat envelope, p in cycles */
  function thump(p) {
    p = p - Math.floor(p);
    var a = Math.exp(-p * 9.0) * Math.sin(clamp(p, 0, 0.34) * PI * 3.0);
    var b = Math.exp(-Math.max(0, p - 0.3) * 11.0) * Math.sin(clamp(p - 0.3, 0, 0.24) * PI * 4.2);
    return clamp(Math.max(a, b * 0.72), 0, 1);
  }
  /* telegraphed attack curve: slow wind-up to 45%, strike ~58%, slow recover */
  function windUp(at) { return smooth(subT(at, 0.0, 0.45)); }
  function strike(at) {
    if (at < 0.45) return 0;
    if (at < 0.58) return easeIn3(subT(at, 0.45, 0.58));
    return 1 - smooth(subT(at, 0.58, 1.0));
  }

  /* ----------------------------------------------------------------- kit */

  function Kit(opts) {
    opts = opts || {};
    this.rng = (typeof opts.rng === 'function') ? opts.rng : function () { return 0.5; };
    var p = opts.palette || {};
    var pal = {};
    for (var k in DEF_PAL) { if (DEF_PAL.hasOwnProperty(k)) pal[k] = (p[k] != null) ? p[k] : DEF_PAL[k]; }
    this.pal = pal;
    this.ql = (opts.quality === 'low') ? 0 : (opts.quality === 'high' ? 2 : 1);
    this.geos = [];
    this.mats = [];
    this.meshCount = 0;
  }
  Kit.prototype.r = function () { return this.rng(); };
  Kit.prototype.rr = function (a, b) { return a + this.rng() * (b - a); };
  Kit.prototype.ri = function (a, b) { return a + Math.floor(this.rng() * (b - a + 1 - 1e-9)); };
  Kit.prototype.jit = function (v, f) { return v * (1 + (this.rng() - 0.5) * 2 * (f == null ? 0.1 : f)); };
  Kit.prototype.pick = function (lo, mid, hi) { return this.ql === 0 ? lo : (this.ql === 2 ? hi : mid); };
  Kit.prototype.geo = function (g) { this.geos.push(g); return g; };
  Kit.prototype.col = function (hex) {
    return new THREE.Color(hex).offsetHSL((this.rng() - 0.5) * 0.06, 0, (this.rng() - 0.5) * 0.12);
  };
  Kit.prototype.mat = function (hex, o) {
    o = o || {};
    var m = new THREE.MeshStandardMaterial({
      color: this.col(hex),
      roughness: o.rough == null ? 0.85 : o.rough,
      metalness: o.metal == null ? 0.05 : o.metal,
      flatShading: o.flat !== false
    });
    if (o.emissive != null) { m.emissive = new THREE.Color(o.emissive); m.emissiveIntensity = o.ei == null ? 1 : o.ei; }
    if (o.transparent) { m.transparent = true; m.opacity = o.opacity == null ? 0.5 : o.opacity; }
    if (o.side) m.side = o.side;
    this.mats.push(m);
    return m;
  };
  /* organic: flat shaded, matte */
  Kit.prototype.organic = function (hex, o) {
    o = o || {};
    return this.mat(hex, {
      rough: o.rough == null ? 0.88 : o.rough, metal: o.metal == null ? 0.04 : o.metal,
      flat: true, emissive: o.emissive, ei: o.ei, transparent: o.transparent, opacity: o.opacity
    });
  };
  /* machined metal: smooth shaded */
  Kit.prototype.metal = function (hex, o) {
    o = o || {};
    return this.mat(hex, {
      rough: o.rough == null ? 0.38 : o.rough, metal: o.metal == null ? 0.82 : o.metal,
      flat: false, emissive: o.emissive, ei: o.ei, transparent: o.transparent, opacity: o.opacity
    });
  };
  Kit.prototype.glow = function (colHex, emisHex, inten, o) {
    o = o || {};
    var m = new THREE.MeshStandardMaterial({
      color: this.col(colHex),
      emissive: new THREE.Color(emisHex),
      emissiveIntensity: inten == null ? 1 : inten,
      roughness: o.rough == null ? 0.5 : o.rough,
      metalness: o.metal == null ? 0.0 : o.metal,
      flatShading: o.flat !== false
    });
    if (o.transparent) { m.transparent = true; m.opacity = o.opacity == null ? 0.5 : o.opacity; }
    this.mats.push(m);
    return m;
  };
  Kit.prototype.mesh = function (geo, mat, parent) {
    var m = new THREE.Mesh(geo, mat);
    if (parent) parent.add(m);
    this.meshCount++;
    return m;
  };

  /* ------------------------------------------------------------- helpers */

  /* cylinder stretched between two local points (wiring, tubes, braces) */
  var _a = new THREE.Vector3(), _b = new THREE.Vector3(), _d = new THREE.Vector3();
  var _up = new THREE.Vector3(0, 1, 0);
  function strut(kit, parent, ax, ay, az, bx, by, bz, r, mat, radial) {
    _a.set(ax, ay, az); _b.set(bx, by, bz); _d.subVectors(_b, _a);
    var len = _d.length() || 0.001;
    var g = kit.geo(new THREE.CylinderGeometry(r, r, len, radial || 5, 1));
    var m = kit.mesh(g, mat, parent);
    m.position.set(ax + _d.x * 0.5, ay + _d.y * 0.5, az + _d.z * 0.5);
    _d.normalize();
    m.quaternion.setFromUnitVectors(_up, _d);
    return m;
  }

  /* nested pivot chain growing along local +Y. Bend by setting joints[i].rotation */
  function segmentChain(kit, parent, cfg) {
    var count = cfg.count, taper = cfg.taper == null ? 0.86 : cfg.taper;
    var joints = [], meshes = [], lens = [];
    var node = parent, prevLen = 0;
    for (var i = 0; i < count; i++) {
      var j = new THREE.Object3D();
      j.position.y = (i === 0) ? (cfg.baseY || 0) : prevLen;
      node.add(j);
      var f = Math.pow(taper, i);
      var len = cfg.len * f;
      var ra = cfg.r * f;
      var rb = ra * taper;
      var g;
      if (cfg.shape === 'box') g = kit.geo(new THREE.BoxGeometry(ra * 2, len, ra * 1.7));
      else g = kit.geo(new THREE.CylinderGeometry(rb, ra, len, cfg.radial || 6, 1));
      var m = kit.mesh(g, (cfg.mats && cfg.mats[i % cfg.mats.length]) || cfg.mat, j);
      m.position.y = len * 0.5;
      joints.push(j); meshes.push(m); lens.push(len);
      node = j; prevLen = len;
    }
    var tip = new THREE.Object3D();
    tip.position.y = prevLen;
    node.add(tip);
    return { joints: joints, meshes: meshes, lens: lens, tip: tip, total: count };
  }

  /* hinged plates around the Y axis; rotate hinge.rotation.x negative to crack open */
  function plateRing(kit, parent, cfg) {
    var hinges = [];
    var g = kit.geo(new THREE.BoxGeometry(cfg.w, cfg.h, cfg.d));
    for (var i = 0; i < cfg.count; i++) {
      var yaw = new THREE.Object3D();
      yaw.rotation.y = (i / cfg.count) * TAU + (cfg.offset || 0);
      yaw.position.y = cfg.y;
      parent.add(yaw);
      var hinge = new THREE.Object3D();
      hinge.position.z = cfg.radius;
      hinge.userData.baseZ = cfg.radius;
      yaw.add(hinge);
      var m = kit.mesh(g, cfg.mat, hinge);
      m.position.y = cfg.h * 0.5;
      hinges.push(hinge);
    }
    return hinges;
  }

  /* telescoping piston leg: hip -> thigh(+piston sleeve/rod) -> knee -> shin -> ankle -> foot */
  function pistonLeg(kit, parent, cfg) {
    var root = new THREE.Object3D();
    root.position.set(cfg.x, cfg.y, cfg.z);
    parent.add(root);
    var r = cfg.r;
    var ballG = kit.geo(new THREE.SphereGeometry(r * 1.3, 8, 6));
    kit.mesh(ballG, cfg.mat, root);
    var hip = new THREE.Object3D(); root.add(hip);
    var tg = kit.geo(new THREE.CylinderGeometry(r * 0.78, r, cfg.thigh, 8, 1));
    var thighM = kit.mesh(tg, cfg.mat, hip); thighM.position.y = -cfg.thigh * 0.5;
    var sleeveG = kit.geo(new THREE.CylinderGeometry(r * 0.44, r * 0.44, cfg.thigh * 0.58, 8, 1));
    var sleeve = kit.mesh(sleeveG, cfg.pistonMat, hip);
    sleeve.position.set(0, -cfg.thigh * 0.36, r * 0.92);
    var rodG = kit.geo(new THREE.CylinderGeometry(r * 0.2, r * 0.2, cfg.thigh * 0.62, 6, 1));
    var rod = kit.mesh(rodG, cfg.rodMat, sleeve);
    rod.position.y = -cfg.thigh * 0.42;
    var knee = new THREE.Object3D(); knee.position.y = -cfg.thigh; hip.add(knee);
    var kg = kit.geo(new THREE.SphereGeometry(r * 0.82, 8, 6));
    kit.mesh(kg, cfg.pistonMat, knee);
    var sg = kit.geo(new THREE.CylinderGeometry(r * 0.5, r * 0.72, cfg.shin, 7, 1));
    var shinM = kit.mesh(sg, cfg.mat, knee); shinM.position.y = -cfg.shin * 0.5;
    var ankle = new THREE.Object3D(); ankle.position.y = -cfg.shin; knee.add(ankle);
    var footH = r * 0.55;
    var fg = kit.geo(new THREE.BoxGeometry(r * 2.1, footH, r * 2.9));
    var foot = kit.mesh(fg, cfg.footMat, ankle);
    foot.position.set(0, -footH * 0.5, r * 0.4);
    return {
      root: root, hip: hip, knee: knee, ankle: ankle, rod: rod, foot: foot,
      thigh: cfg.thigh, shin: cfg.shin, footH: footH, hipY: cfg.y
    };
  }

  /* half-swallowed humanish face: skin plate + 2 glowing eyes + hinged jaw */
  function facePlate(kit, parent, cfg) {
    var g = new THREE.Group();
    parent.add(g);
    var r = cfg.r;
    var sg = kit.geo(new THREE.SphereGeometry(r, 8, 6));
    var skin = kit.mesh(sg, cfg.skin, g);
    skin.scale.set(1, 1.22, 0.62);
    var eg = kit.geo(new THREE.SphereGeometry(r * 0.22, 6, 4));
    var e1 = kit.mesh(eg, cfg.eye, g); e1.position.set(-r * 0.36, r * 0.3, r * 0.48);
    var e2 = kit.mesh(eg, cfg.eye, g); e2.position.set(r * 0.36, r * 0.3, r * 0.48);
    var jaw = new THREE.Object3D();
    jaw.position.set(0, -r * 0.2, r * 0.22);
    g.add(jaw);
    var mg = kit.geo(new THREE.BoxGeometry(r * 0.72, r * 0.52, r * 0.42));
    var mouth = kit.mesh(mg, cfg.mouth, jaw);
    mouth.position.y = -r * 0.26;
    return { group: g, eyes: [e1, e2], jaw: jaw };
  }

  /* scatter flat-shaded lumps over a host mesh's surface */
  function lumps(kit, parent, cfg) {
    var out = [];
    var g = kit.geo(new THREE.IcosahedronGeometry(1, 0));
    for (var i = 0; i < cfg.count; i++) {
      var a = kit.rr(0, TAU), b = kit.rr(cfg.yMin == null ? -0.3 : cfg.yMin, 1);
      var m = kit.mesh(g, cfg.mat, parent);
      var s = kit.rr(cfg.sMin || 0.12, cfg.sMax || 0.3);
      m.scale.set(s, s * kit.rr(0.7, 1.2), s);
      var rad = cfg.radius * kit.rr(0.72, 1.0);
      m.position.set(Math.cos(a) * rad, cfg.y + b * (cfg.yh || 0.4), Math.sin(a) * rad);
      m.rotation.set(kit.rr(0, TAU), kit.rr(0, TAU), kit.rr(0, TAU));
      out.push(m);
    }
    return out;
  }

  function disposerFor(kit) {
    return function () {
      var i;
      for (i = 0; i < kit.geos.length; i++) { if (kit.geos[i] && kit.geos[i].dispose) kit.geos[i].dispose(); }
      for (i = 0; i < kit.mats.length; i++) { if (kit.mats[i] && kit.mats[i].dispose) kit.mats[i].dispose(); }
      kit.geos.length = 0;
      kit.mats.length = 0;
    };
  }

  /* rib arc geometry: unit radius, hinged at local origin (the spine), sweeping
     forward around side s (+1 right / -1 left) to the sternum line. */
  function ribGeo(kit, s, tube, seg) {
    var g = new THREE.TorusGeometry(1, tube, 4, seg, PI * 0.82);
    var m = new THREE.Matrix4();
    m.set(0, s, 0, 0,
          0, 0, -s, 0,
          -1, 0, 0, 0,
          0, 0, 0, 1);
    g.applyMatrix4(m);
    g.translate(0, 0, 1);
    return kit.geo(g);
  }

  /* ================================================================== #1
   * PATIENT ZERO
   * ================================================================= */
  function buildPatientZero(opts) {
    var kit = new Kit(opts), P = kit.pal;
    var group = new THREE.Group();
    var body = new THREE.Group();
    group.add(body);

    var SEG = kit.pick(6, 8, 10);
    var SEG2 = kit.pick(5, 6, 8);

    var mFlesh = kit.organic(P.flesh);
    var mFlesh2 = kit.organic(P.flesh2);
    var mMuscle = kit.organic(P.accent, { rough: 0.72 });
    var mBone = kit.organic(P.bone, { rough: 0.6 });
    var mMetal = kit.metal(P.metal);
    var mCore = kit.glow(P.accent, P.glow, 1.2, { rough: 0.35 });
    var mCoreShell = kit.glow(P.flesh2, P.glow, 0.4, { transparent: true, opacity: 0.4 });
    var mEye = kit.glow(P.glow2, P.glow2, 1.6, { rough: 0.3 });
    var mWound = kit.glow(P.accent, P.glow, 0.15);
    var mMaw = kit.glow(P.flesh2, P.accent, 0.3);
    var mWire = kit.metal(P.metal, { rough: 0.55, metal: 0.55 });

    /* ---- base mound of fused, half-absorbed bodies ---- */
    var moundR = kit.jit(1.82, 0.08);
    var moundH = kit.jit(0.95, 0.1);
    var moundG = kit.geo(new THREE.IcosahedronGeometry(1, 1));
    var mound = kit.mesh(moundG, mFlesh2, body);
    mound.scale.set(moundR, moundH, moundR * 0.88);
    mound.position.y = moundH;
    mound.rotation.y = kit.rr(0, TAU);

    lumps(kit, body, {
      count: kit.pick(3, 4, 5), mat: mFlesh, radius: moundR * 0.76,
      y: moundH * 0.85, yh: 0.45, sMin: 0.2, sMax: 0.4
    });

    /* wound patches that light up as it is damaged */
    var wounds = [];
    var woundG = kit.geo(new THREE.SphereGeometry(0.22, 6, 5));
    for (var wi = 0; wi < 4; wi++) {
      var wa = kit.rr(0, TAU);
      var wm = kit.mesh(woundG, mWound, body);
      wm.position.set(Math.cos(wa) * moundR * 0.7, kit.rr(0.5, 1.3), Math.sin(wa) * moundR * 0.6);
      wm.scale.set(kit.rr(0.8, 1.5), kit.rr(0.6, 1.1), kit.rr(0.8, 1.5));
      wounds.push(wm);
    }

    /* embedded partial limbs + faces (5-8 embedded parts total) */
    var embLimbs = [], embFaces = [];
    var nLimb = kit.ri(3, 4);
    var nFace = kit.ri(2, 4);
    for (var li = 0; li < nLimb; li++) {
      var la = kit.rr(0, TAU);
      var lroot = new THREE.Object3D();
      lroot.position.set(Math.cos(la) * moundR * 0.66, kit.rr(0.5, 1.25), Math.sin(la) * moundR * 0.58);
      lroot.rotation.y = -la + PI * 0.5;
      lroot.rotation.z = kit.rr(-0.5, 0.5);
      body.add(lroot);
      var ch = segmentChain(kit, lroot, {
        count: 2, len: kit.rr(0.4, 0.62), r: kit.rr(0.1, 0.15), taper: 0.8,
        radial: SEG2, mat: (li % 2) ? mFlesh : mFlesh2
      });
      ch.joints[0].rotation.x = kit.rr(-0.9, -0.2);
      ch.joints[1].rotation.x = kit.rr(0.4, 1.3);
      var handG = kit.geo(new THREE.IcosahedronGeometry(0.13, 0));
      var hand = kit.mesh(handG, mFlesh, ch.tip);
      hand.scale.set(1, 1.5, 0.7);
      embLimbs.push({ ch: ch, ph: kit.rr(0, TAU) });
    }
    for (var fi = 0; fi < nFace; fi++) {
      var fa = (fi / nFace) * PI * 1.4 - PI * 0.6 + kit.rr(-0.2, 0.2);
      var f = facePlate(kit, body, { r: kit.rr(0.2, 0.3), skin: mFlesh, eye: mEye, mouth: mMaw });
      f.group.position.set(Math.sin(fa) * moundR * 0.74, kit.rr(0.45, 1.2), Math.cos(fa) * moundR * 0.66);
      f.group.rotation.y = fa;
      f.group.rotation.z = kit.rr(-0.6, 0.6);
      embFaces.push({ f: f, ph: kit.rr(0, TAU) });
    }

    /* ---- torso erupting out of the mound ---- */
    var torso = new THREE.Object3D();
    torso.position.y = moundH * 1.2;
    body.add(torso);

    var hipG = kit.geo(new THREE.IcosahedronGeometry(0.95, 1));
    var hips = kit.mesh(hipG, mFlesh, torso);
    hips.scale.set(1.05, 0.78, 0.92);
    hips.position.y = 0.3;

    var chest = new THREE.Object3D();
    chest.position.y = 0.62;
    torso.add(chest);

    var trunkG = kit.geo(new THREE.CylinderGeometry(0.96, 1.02, 1.72, SEG, 1));
    var trunk = kit.mesh(trunkG, mFlesh, chest);
    trunk.position.y = 0.78;
    trunk.scale.z = 0.82;

    var yokeG = kit.geo(new THREE.IcosahedronGeometry(1.08, 1));
    var yoke = kit.mesh(yokeG, mMuscle, chest);
    yoke.position.y = 1.66;
    yoke.scale.set(1.15, 0.62, 0.78);

    /* ---- ribcage split open like double doors ---- */
    var ribRows = kit.pick(4, 5, 5);
    var doors = [], ribMeshes = [];
    for (var s = -1; s <= 1; s += 2) {
      var door = new THREE.Object3D();
      door.position.set(0, 0.55, -0.44);
      chest.add(door);
      var rg = ribGeo(kit, s, 0.055, kit.pick(7, 9, 11));
      for (var ri = 0; ri < ribRows; ri++) {
        var rm = kit.mesh(rg, mBone, door);
        var k = 0.54 * (1 - ri * 0.075) * kit.jit(1, 0.05);
        rm.scale.set(k, k * 0.8, k);
        rm.position.y = ri * 0.26 - 0.1;
        ribMeshes.push({ m: rm, i: ri, side: s, base: rm.position.y });
      }
      doors.push(door);
    }
    /* surgical staples down the sternum line */
    var stapG = kit.geo(new THREE.BoxGeometry(0.1, 0.035, 0.24));
    for (var si = 0; si < 3; si++) {
      var stp = kit.mesh(stapG, mMetal, chest);
      stp.position.set(0, 0.42 + si * 0.34, 0.52);
      stp.rotation.x = kit.rr(-0.2, 0.2);
    }

    /* ---- heart core suspended in wiring ---- */
    var coreRig = new THREE.Object3D();
    coreRig.position.set(0, 0.88, 0.02);
    chest.add(coreRig);
    var coreG = kit.geo(new THREE.IcosahedronGeometry(0.4, 1));
    var core = kit.mesh(coreG, mCore, coreRig);
    core.scale.set(1, 1.15, 0.95);
    var shellG = kit.geo(new THREE.IcosahedronGeometry(0.58, 1));
    kit.mesh(shellG, mCoreShell, coreRig);
    for (var ci = 0; ci < 6; ci++) {
      var ca = (ci / 6) * TAU + kit.rr(-0.3, 0.3);
      strut(kit, coreRig, 0, 0, 0,
        Math.cos(ca) * 0.72, Math.sin(ca) * 0.6, kit.rr(-0.45, 0.2), 0.026, mWire, 4);
    }

    /* ---- head ---- */
    var neck = new THREE.Object3D();
    neck.position.y = 2.1;
    chest.add(neck);
    var neckG = kit.geo(new THREE.CylinderGeometry(0.24, 0.34, 0.4, SEG2, 1));
    var neckM = kit.mesh(neckG, mMuscle, neck); neckM.position.y = 0.2;

    var head = new THREE.Object3D();
    head.position.y = 0.5;
    neck.add(head);
    var skullG = kit.geo(new THREE.IcosahedronGeometry(0.54, 1));
    var skull = kit.mesh(skullG, mBone, head);
    skull.scale.set(0.95, 1.4, 1.1);
    skull.position.y = 0.32;
    var browG = kit.geo(new THREE.BoxGeometry(0.62, 0.14, 0.3));
    var brow = kit.mesh(browG, mBone, head);
    brow.position.set(0, 0.3, 0.44);
    var jaw = new THREE.Object3D();
    jaw.position.set(0, 0.06, 0.1);
    head.add(jaw);
    var jawG = kit.geo(new THREE.BoxGeometry(0.46, 0.3, 0.42));
    var jawM = kit.mesh(jawG, mMaw, jaw); jawM.position.set(0, -0.15, 0.2);
    var hEyeG = kit.geo(new THREE.SphereGeometry(0.085, 6, 5));
    var eyeL = kit.mesh(hEyeG, mEye, head); eyeL.position.set(-0.19, 0.22, 0.46);
    var eyeR = kit.mesh(hEyeG, mEye, head); eyeR.position.set(0.19, 0.22, 0.46);

    /* cranial electrode cage bolted through the skull */
    var haloG = kit.geo(new THREE.TorusGeometry(0.5, 0.045, 4, 12));
    var halo = kit.mesh(haloG, mMetal, head);
    halo.position.y = 0.54; halo.rotation.x = PI * 0.5;
    var nEle = kit.pick(4, 5, 6);
    var eleG = kit.geo(new THREE.CylinderGeometry(0.035, 0.05, 0.68, 5, 1));
    var tipG = kit.geo(new THREE.SphereGeometry(0.06, 5, 4));
    for (var ei = 0; ei < nEle; ei++) {
      var ea = (ei / nEle) * TAU + kit.rr(-0.2, 0.2);
      var el = kit.mesh(eleG, mMetal, head);
      el.position.set(Math.cos(ea) * 0.38, 0.84, Math.sin(ea) * 0.38);
      el.rotation.z = -Math.cos(ea) * 0.45;
      el.rotation.x = Math.sin(ea) * 0.45;
      var etip = kit.mesh(tipG, mEye, el);
      etip.position.y = 0.36;
    }

    /* IV tubes trailing off the spine */
    for (var ti = 0; ti < 3; ti++) {
      strut(kit, chest, kit.rr(-0.5, 0.5), 1.35, -0.62,
        kit.rr(-1.0, 1.0), kit.rr(1.7, 2.15), kit.rr(-1.2, -0.7), 0.035, mWire, 4);
    }

    /* ---- two overlong bone-blade arms ---- */
    var arms = [];
    for (var ai = 0; ai < 2; ai++) {
      var sd = ai === 0 ? -1 : 1;
      var sh = new THREE.Object3D();
      sh.position.set(sd * kit.jit(1.04, 0.06), 1.62, 0);
      chest.add(sh);
      var shG = kit.geo(new THREE.IcosahedronGeometry(0.34, 1));
      kit.mesh(shG, mMuscle, sh);

      var upLen = kit.jit(1.26, 0.1), foLen = kit.jit(1.34, 0.1);
      var upG = kit.geo(new THREE.CylinderGeometry(0.19, 0.28, upLen, SEG2, 1));
      var up = kit.mesh(upG, mFlesh, sh); up.position.y = -upLen * 0.5;
      var clampG = kit.geo(new THREE.TorusGeometry(0.24, 0.05, 4, 8));
      var clamp1 = kit.mesh(clampG, mMetal, sh);
      clamp1.position.y = -upLen * 0.55; clamp1.rotation.x = PI * 0.5;

      var elbow = new THREE.Object3D(); elbow.position.y = -upLen; sh.add(elbow);
      var elG = kit.geo(new THREE.IcosahedronGeometry(0.22, 0));
      kit.mesh(elG, mBone, elbow);
      var foG = kit.geo(new THREE.CylinderGeometry(0.14, 0.21, foLen, SEG2, 1));
      var fo = kit.mesh(foG, mFlesh, elbow); fo.position.y = -foLen * 0.5;

      var wrist = new THREE.Object3D(); wrist.position.y = -foLen; elbow.add(wrist);
      var bladeLen = kit.jit(0.9, 0.12);
      var blG = kit.geo(new THREE.ConeGeometry(0.2, bladeLen, 4, 1));
      var blade = kit.mesh(blG, mBone, wrist);
      blade.position.y = -bladeLen * 0.5; blade.rotation.x = PI;
      blade.scale.set(1.0, 1, 0.34);
      var bl2 = kit.mesh(blG, mBone, wrist);
      bl2.position.set(sd * 0.12, -bladeLen * 0.35, 0.05);
      bl2.rotation.set(PI, 0, sd * 0.45);
      bl2.scale.set(0.6, 0.65, 0.26);
      var spurG = kit.geo(new THREE.ConeGeometry(0.1, 0.36, 4, 1));
      var spur = kit.mesh(spurG, mBone, elbow);
      spur.position.set(0, 0.02, -0.22);
      spur.rotation.x = -PI * 0.55;

      arms.push({ sh: sh, elbow: elbow, wrist: wrist, sd: sd });
    }

    /* rest pose */
    for (var q = 0; q < 2; q++) {
      arms[q].sh.rotation.set(0.22, 0, arms[q].sd * -0.26);
      arms[q].elbow.rotation.set(-1.3, 0, 0);
      arms[q].wrist.rotation.set(0.72, 0, 0);
    }
    doors[0].rotation.y = 0.3; doors[1].rotation.y = -0.3;

    var headAnchor = new THREE.Object3D();
    headAnchor.position.y = 6.35;
    group.add(headAnchor);

    /* ------------------------------------------------------- animation */
    var walkPhase = kit.rr(0, TAU);
    var flick = 0;
    var TOTAL_H = 6.0;

    function update(dt, ctx) {
      ctx = ctx || {};
      var t = ctx.time || 0;
      var st = ctx.state || 'idle';
      var hp = clamp(ctx.hpFrac == null ? 1 : ctx.hpFrac, 0, 1);
      var dmg = 1 - hp;
      var sp = clamp(ctx.spawnT == null ? 1 : ctx.spawnT, 0, 1);
      var at = clamp(ctx.attackT || 0, 0, 1);
      var ht = clamp(ctx.hurtT || 0, 0, 1);
      var dq = clamp(ctx.dieT || 0, 0, 1);
      var ms = ctx.moveSpeed || 0;
      var i;
      walkPhase += dt * (0.55 + ms * 1.35);
      flick += dt * (7 + dmg * 22);

      var rage = 1 + dmg * 1.25;
      var beat = thump(t * (0.95 + dmg * 1.85));
      var br = Math.sin(t * 1.15 * rage);

      /* --- core: the health readout --- */
      var cs = 1 + beat * (0.16 + dmg * 0.22);
      core.scale.set(cs, cs * 1.15, cs * 0.95);
      mCore.emissiveIntensity = 0.9 + beat * (1.4 + dmg * 2.6) + dmg * 1.9;
      mCoreShell.emissiveIntensity = 0.25 + beat * 0.7 + dmg * 1.1;
      mCoreShell.opacity = clamp(0.4 - dmg * 0.28, 0.08, 0.5);
      coreRig.position.z = 0.02 + dmg * 0.18 + beat * 0.03;
      coreRig.rotation.y = Math.sin(t * 0.4) * 0.25;

      /* --- rib doors swing wider as it is damaged --- */
      var open = 0.28 + dmg * 1.04 + beat * 0.07;
      doors[0].rotation.y = open;
      doors[1].rotation.y = -open;
      doors[0].rotation.x = dmg * 0.12;
      doors[1].rotation.x = dmg * 0.12;
      for (i = 0; i < ribMeshes.length; i++) {
        var R = ribMeshes[i];
        var droop = Math.max(0, dmg - 0.45 - R.i * 0.07) * 1.5;
        R.m.rotation.z = droop * R.side;
        R.m.position.y = R.base - droop * 0.1;
      }

      /* --- wounds, embedded bodies --- */
      for (i = 0; i < wounds.length; i++) {
        wounds[i].scale.y = 0.6 + dmg * 0.9 + Math.sin(flick * 0.4 + i) * 0.06;
      }
      mWound.emissiveIntensity = 0.1 + dmg * 2.6 + (Math.sin(flick) * 0.5 + 0.5) * dmg * 0.9;
      mEye.emissiveIntensity = 1.1 + dmg * 2.0 + (Math.sin(flick * 1.7) * 0.5 + 0.5) * (0.2 + dmg);
      mMaw.emissiveIntensity = 0.25 + dmg * 1.4;

      for (i = 0; i < embFaces.length; i++) {
        var EF = embFaces[i];
        EF.f.jaw.rotation.x = (0.1 + dmg * 0.5) * (Math.sin(t * 1.6 * rage + EF.ph) * 0.5 + 0.5);
        EF.f.group.rotation.x = Math.sin(t * 0.9 + EF.ph) * 0.12;
      }
      for (i = 0; i < embLimbs.length; i++) {
        var EL = embLimbs[i];
        var tw = Math.sin(t * (1.1 + dmg * 1.6) + EL.ph);
        EL.ch.joints[0].rotation.z = tw * (0.12 + dmg * 0.25);
        EL.ch.joints[1].rotation.x = 0.85 + tw * (0.2 + dmg * 0.4);
      }

      /* --- body pose --- */
      var bobY = 0, lean = 0, twist = 0, hunch = 0, headP = 0;
      var armSw = 0, armRaise = 0, bladeStrike = 0, sway = 0;
      var spawning = (st === 'spawn');

      if (spawning) {
        var e = ease3(sp);
        body.position.y = -TOTAL_H * (1 - e) * 1.05;
        body.scale.set(lerp(0.62, 1, smooth(sp)), lerp(1.3, 1, smooth(sp)), lerp(0.62, 1, smooth(sp)));
        body.rotation.y = (1 - e) * 1.7;
        body.rotation.z = Math.sin(sp * 14) * 0.08 * (1 - sp);
        hunch = (1 - smooth(subT(sp, 0.25, 0.9))) * 0.85;
        var unfurl = smooth(subT(sp, 0.35, 1.0));
        doors[0].rotation.y = open * unfurl;
        doors[1].rotation.y = -open * unfurl;
        mCore.emissiveIntensity *= smooth(subT(sp, 0.45, 1.0));
        mEye.emissiveIntensity *= smooth(subT(sp, 0.55, 1.0));
        armRaise = (1 - unfurl) * 1.9;
        headP = (1 - smooth(subT(sp, 0.55, 1.0))) * 0.9;
      } else {
        body.scale.set(1, 1, 1);
        body.rotation.y = 0;
      }

      if (st === 'idle') {
        bobY = (Math.sin(t * 1.15 * rage) * 0.5 + 0.5) * 0.07;
        hunch = 0.06 + br * 0.05 + dmg * 0.16;
        sway = Math.sin(t * 0.47) * 0.06;
        headP = Math.sin(t * 0.8 + 1) * 0.1 - dmg * 0.18;
        armSw = Math.sin(t * 0.9) * 0.08;
      } else if (st === 'walk') {
        var wp = walkPhase;
        bobY = (Math.sin(wp * 2) * 0.5 + 0.5) * 0.16;
        sway = Math.sin(wp) * (0.13 + dmg * 0.06);
        hunch = 0.16 + Math.sin(wp * 2 + 0.6) * 0.06 + dmg * 0.18;
        twist = Math.sin(wp) * 0.18;
        armSw = Math.sin(wp) * 0.5;
        headP = Math.sin(wp * 2) * 0.07 - dmg * 0.2;
      } else if (st === 'attack') {
        var wu = windUp(at), sk = strike(at);
        bobY = wu * 0.22 - sk * 0.18;
        hunch = -wu * 0.42 + sk * 0.72;
        armRaise = wu * 2.3 - sk * 2.6;
        bladeStrike = sk;
        twist = wu * 0.3 - sk * 0.5;
        headP = -wu * 0.45 + sk * 0.5;
        mCore.emissiveIntensity += (wu * 0.6 + bump(subT(at, 0.4, 0.72)) * 0.9) * (2.2 + dmg * 2);
        doors[0].rotation.y = open + wu * 0.55;
        doors[1].rotation.y = -(open + wu * 0.55);
      } else if (st === 'hurt') {
        var h = ht * ht;
        bobY = -h * 0.1;
        hunch = -h * 0.3 + 0.08;
        twist = h * 0.22;
        sway = h * 0.16;
        headP = -h * 0.4;
        armSw = -h * 0.5;
        mCore.emissiveIntensity += h * 2.5;
      } else if (st === 'die') {
        var s1 = subT(dq, 0.0, 0.3);
        var s2 = subT(dq, 0.28, 0.66);
        var s3 = subT(dq, 0.6, 1.0);
        hunch = -smooth(s1) * 0.55 + smooth(s2) * 1.35 + s3 * 0.35;
        twist = smooth(s1) * 0.3 + smooth(s2) * 0.35;
        sway = Math.sin(dq * 9) * 0.22 * (1 - s3);
        bobY = smooth(s1) * 0.18 - easeIn3(s2) * 0.55 - s3 * 1.9;
        armRaise = smooth(s1) * 2.4 * (1 - s2) - s2 * 0.8;
        headP = -smooth(s1) * 0.7 + smooth(s2) * 1.1;
        doors[0].rotation.y = open + smooth(s1) * 1.15;
        doors[1].rotation.y = -(open + smooth(s1) * 1.15);
        mCore.emissiveIntensity = (0.9 + s1 * 5.5) * (1 - smooth(s2)) + 0.05;
        mEye.emissiveIntensity *= (1 - smooth(s2));
        mWound.emissiveIntensity *= (1 - s3);
        body.scale.set(1 + s3 * 0.15, Math.max(0.18, 1 - s3 * 0.72), 1 + s3 * 0.15);
      }

      if (!spawning) {
        /* rolling about the origin sinks one side of the mound - lift by that much */
        body.position.y = bobY + Math.abs(Math.sin(sway)) * moundR * 0.92;
        body.rotation.z = sway;
      }
      torso.rotation.x = hunch;
      torso.rotation.y = twist;
      torso.rotation.z = sway * 0.4;
      chest.rotation.x = hunch * 0.35 + br * 0.03;
      var puff = 1 + br * 0.035 + beat * 0.05;
      trunk.scale.set(puff, 1 + br * 0.02, 0.82 * puff);
      yoke.scale.set(1.15 * puff, 0.62, 0.78 * puff);
      neck.rotation.x = headP * 0.4;
      head.rotation.x = headP * 0.7 + 0.1;
      head.rotation.y = Math.sin(t * 0.6) * 0.18 * (st === 'attack' ? 0.2 : 1);
      jaw.rotation.x = (0.08 + dmg * 0.3) + (st === 'attack' ? strike(at) * 0.5 : 0) + beat * 0.08;
      halo.rotation.z = t * (0.3 + dmg * 1.1);

      for (i = 0; i < 2; i++) {
        var A = arms[i];
        var side = A.sd;
        var ph = i === 0 ? 0 : PI;
        A.sh.rotation.x = 0.22 + armSw * Math.cos(ph) - armRaise - bladeStrike * 1.5;
        A.sh.rotation.z = side * (-0.26 - dmg * 0.12) + Math.sin(t * 0.7 + ph) * 0.04;
        A.sh.rotation.y = side * bladeStrike * -0.35;
        A.elbow.rotation.x = -1.3 + armRaise * 0.45 + bladeStrike * 0.95 - armSw * 0.25 * Math.cos(ph);
        A.wrist.rotation.x = 0.72 - bladeStrike * 1.1 + Math.sin(t * 1.3 + ph) * 0.06;
        A.wrist.rotation.z = side * dmg * 0.2;
      }
    }

    return {
      group: group,
      headAnchor: headAnchor,
      materials: kit.mats,
      hitPoints: [coreRig, head, arms[0].wrist, arms[1].wrist, mound],
      update: update,
      dispose: disposerFor(kit),
      _meshCount: kit.meshCount
    };
  }

  window.CaveTyper.monsters['patient_zero'] = {
    id: 'patient_zero',
    name: 'PATIENT ZERO',
    tier: 'boss',
    size: { height: 6.0, radius: 2.6 },
    build: buildPatientZero
  };

  /* ================================================================== #2
   * HIVE REACTOR
   * ================================================================= */
  function buildHiveReactor(opts) {
    var kit = new Kit(opts), P = kit.pal;
    var group = new THREE.Group();
    var body = new THREE.Group();
    group.add(body);

    var SEG = kit.pick(8, 10, 12);
    var SEG2 = kit.pick(5, 6, 7);

    var mChitin = kit.organic(P.flesh2, { rough: 0.7 });
    var mChitin2 = kit.organic(P.flesh, { rough: 0.75 });
    var mHull = kit.metal(P.metal);
    var mHull2 = kit.metal(P.metal, { rough: 0.55, metal: 0.65 });
    var mGlass = kit.glow(P.glow2, P.glow2, 0.35, { flat: false, rough: 0.12, metal: 0.1, transparent: true, opacity: 0.32 });
    var mCore = kit.glow(P.glow, P.glow, 2.0, { rough: 0.3 });
    var mCoolant = kit.glow(P.goo, P.goo, 1.1, { flat: false, rough: 0.3 });
    var mCrack = kit.glow(P.accent, P.glow, 0.25);
    var mIchor = kit.glow(P.glow2, P.glow2, 0.8);
    var mPipe = kit.metal(P.metal, { rough: 0.5, metal: 0.6 });

    /* ---- chitinous base mound + floor anchors ---- */
    var baseR = kit.jit(1.6, 0.08);
    var baseH = kit.jit(0.52, 0.1);
    var baseG = kit.geo(new THREE.IcosahedronGeometry(1, 1));
    var baseM = kit.mesh(baseG, mChitin, body);
    baseM.scale.set(baseR, baseH, baseR);
    baseM.position.y = baseH;
    baseM.rotation.y = kit.rr(0, TAU);

    var nAnchor = 4;
    for (var an = 0; an < nAnchor; an++) {
      var aa = (an / nAnchor) * TAU + kit.rr(-0.25, 0.25);
      var ar = kit.rr(2.0, 2.45);
      strut(kit, body, Math.cos(aa) * 0.5, baseH * 1.5, Math.sin(aa) * 0.5,
        Math.cos(aa) * ar, 0.24, Math.sin(aa) * ar, 0.14, mChitin2, 5);
    }

    /* ---- central cracked reactor column ---- */
    var colTop = 5.55;
    var colBase = 0.45;
    var nSeg = 5;
    var segH = (colTop - colBase) / nSeg;
    var colSegs = [];
    var colR = kit.jit(0.6, 0.08);
    for (var cs = 0; cs < nSeg; cs++) {
      var pivot = new THREE.Object3D();
      pivot.position.y = colBase + cs * segH;
      body.add(pivot);
      var isGlass = (cs === 2);
      var r0 = colR * (1 - cs * 0.055);
      var r1 = colR * (1 - (cs + 1) * 0.055);
      var g = kit.geo(new THREE.CylinderGeometry(r1, r0, segH * 0.97, SEG, 1));
      var m = kit.mesh(g, isGlass ? mGlass : mHull, pivot);
      m.position.y = segH * 0.5;
      /* collar flange between segments */
      var fg = kit.geo(new THREE.CylinderGeometry(r0 * 1.16, r0 * 1.16, 0.09, SEG, 1));
      var fm = kit.mesh(fg, mHull2, pivot);
      fm.position.y = 0.02;
      colSegs.push({ pivot: pivot, mesh: m, base: pivot.position.y, i: cs });
    }

    /* glowing fracture lines up the column */
    var cracks = [];
    var crackG = kit.geo(new THREE.BoxGeometry(0.055, 0.85, 0.055));
    for (var ck = 0; ck < 4; ck++) {
      var cka = kit.rr(0, TAU);
      var cm = kit.mesh(crackG, mCrack, body);
      cm.position.set(Math.cos(cka) * colR * 0.92, kit.rr(1.0, 4.6), Math.sin(cka) * colR * 0.92);
      cm.rotation.set(kit.rr(-0.25, 0.25), -cka, kit.rr(-0.2, 0.2));
      cracks.push(cm);
    }

    /* ---- the core (single PointLight lives here) ---- */
    var coreRig = new THREE.Object3D();
    coreRig.position.y = 2.95;
    body.add(coreRig);
    var coreG = kit.geo(new THREE.IcosahedronGeometry(0.4, 1));
    var core = kit.mesh(coreG, mCore, coreRig);
    var haloG = kit.geo(new THREE.TorusGeometry(0.56, 0.05, 4, 10));
    var coreHalo = kit.mesh(haloG, mIchor, coreRig);
    coreHalo.rotation.x = PI * 0.5;
    var coreLight = new THREE.PointLight(P.glow, 1.4, 7.0, 2);
    coreRig.add(coreLight);

    /* ---- chitinous growth wrapped through the column ---- */
    var wrapG = kit.geo(new THREE.DodecahedronGeometry(1, 0));
    var wraps = [];
    var nWrap = kit.pick(4, 5, 6);
    for (var wr = 0; wr < nWrap; wr++) {
      var wa = kit.rr(0, TAU);
      var wy = kit.rr(0.9, 5.0);
      var wm = kit.mesh(wrapG, wr % 2 ? mChitin : mChitin2, body);
      var ws = kit.rr(0.34, 0.6);
      wm.scale.set(ws * 1.4, ws, ws * 1.4);
      wm.position.set(Math.cos(wa) * colR * 0.85, wy, Math.sin(wa) * colR * 0.85);
      wm.rotation.set(kit.rr(0, TAU), kit.rr(0, TAU), kit.rr(0, TAU));
      wraps.push({ m: wm, ph: kit.rr(0, TAU), s: ws });
    }

    /* ---- counter-rotating rings ---- */
    var rings = [];
    var ringYs = [1.55, 2.95, 4.35];
    for (var rg2 = 0; rg2 < 3; rg2++) {
      var ring = new THREE.Object3D();
      ring.position.y = ringYs[rg2];
      body.add(ring);
      var rr0 = kit.jit(0.95 - rg2 * 0.07, 0.07);
      var tg = kit.geo(new THREE.TorusGeometry(rr0, 0.075, 4, kit.pick(10, 14, 18)));
      var tm = kit.mesh(tg, rg2 === 1 ? mHull2 : mHull, ring);
      tm.rotation.x = PI * 0.5;
      var nubG = kit.geo(new THREE.BoxGeometry(0.14, 0.2, 0.3));
      for (var nb = 0; nb < 2; nb++) {
        var na = kit.rr(0, TAU) + nb * PI;
        var nm = kit.mesh(nubG, mPipe, ring);
        nm.position.set(Math.cos(na) * rr0, 0, Math.sin(na) * rr0);
        nm.rotation.y = -na;
      }
      rings.push({ o: ring, dir: (rg2 % 2 === 0) ? 1 : -1, sp: kit.rr(0.22, 0.42) });
    }

    /* ---- armour plates that crack open as it takes damage ---- */
    var plateMat = mHull2;
    var plates = plateRing(kit, body, {
      count: kit.pick(4, 5, 5), y: 1.05, radius: colR * 0.95,
      w: 0.5, h: 0.8, d: 0.11, mat: plateMat, offset: kit.rr(0, 1)
    }).concat(plateRing(kit, body, {
      count: kit.pick(4, 5, 5), y: 3.75, radius: colR * 0.88,
      w: 0.44, h: 0.72, d: 0.1, mat: plateMat, offset: kit.rr(0, 1)
    }));

    /* ---- coolant / ichor tubes running up the column ---- */
    var beads = [], tubes = [];
    var nTube = kit.pick(3, 4, 4);
    var tubeY0 = 0.75, tubeY1 = 5.0;
    var beadG = kit.geo(new THREE.SphereGeometry(0.1, 6, 5));
    for (var tb = 0; tb < nTube; tb++) {
      var ta = (tb / nTube) * TAU + kit.rr(-0.2, 0.2);
      var tr = colR * 1.22;
      var tx = Math.cos(ta) * tr, tz = Math.sin(ta) * tr;
      var tm2 = strut(kit, body, tx, tubeY0, tz, tx * 0.82, tubeY1, tz * 0.82, 0.062, mCoolant, 5);
      tubes.push(tm2);
      var bd = kit.mesh(beadG, mIchor, body);
      var bph = kit.rr(0, 1);
      bd.position.set(lerp(tx, tx * 0.82, bph), lerp(tubeY0, tubeY1, bph), lerp(tz, tz * 0.82, bph));
      beads.push({ m: bd, x: tx, z: tz, ph: bph });
    }

    /* ---- radiating arms: segmented insect limb + pipework ---- */
    var nArms = kit.ql === 0 ? kit.ri(6, 7) : (kit.ql === 2 ? kit.ri(7, 9) : kit.ri(6, 8));
    var armSegs = kit.pick(3, 3, 4);
    var arms = [];
    var hubs = [];
    for (var hb = 0; hb < 2; hb++) {
      var hub = new THREE.Object3D();
      hub.position.y = hb === 0 ? 2.3 : 3.95;
      body.add(hub);
      hubs.push({ o: hub, dir: hb === 0 ? 1 : -1, sp: kit.rr(0.08, 0.16) });
    }
    var clawG = kit.geo(new THREE.ConeGeometry(0.1, 0.44, 4, 1));
    for (var am = 0; am < nArms; am++) {
      var hub2 = hubs[am % 2];
      var yaw = new THREE.Object3D();
      yaw.rotation.y = (am / nArms) * TAU + kit.rr(-0.18, 0.18);
      hub2.o.add(yaw);
      var lift = new THREE.Object3D();
      lift.rotation.x = PI * 0.5;
      yaw.add(lift);
      var ch = segmentChain(kit, lift, {
        count: armSegs, len: kit.jit(0.78, 0.14), r: kit.jit(0.13, 0.15), taper: 0.82,
        radial: SEG2, baseY: colR * 0.85,
        mats: [mChitin, mPipe, mChitin2, mPipe]
      });
      var claw = kit.mesh(clawG, mChitin, ch.tip);
      claw.rotation.x = kit.rr(-0.3, 0.3);
      var up0 = kit.rr(0.5, 0.95);
      ch.joints[0].rotation.x = -up0;
      ch.joints[1].rotation.x = 1.1 + kit.rr(-0.2, 0.35);
      if (armSegs > 2) ch.joints[2].rotation.x = 0.7 + kit.rr(-0.2, 0.3);
      if (armSegs > 3) ch.joints[3].rotation.x = 0.4 + kit.rr(-0.2, 0.2);
      arms.push({ ch: ch, yaw: yaw, up0: up0, ph: kit.rr(0, TAU), splay: kit.rr(0.8, 1.2) });
    }

    /* ---- venting crown ---- */
    var crownG = kit.geo(new THREE.ConeGeometry(colR * 1.25, 0.72, SEG, 1));
    var crown = kit.mesh(crownG, mHull, body);
    crown.position.y = colTop + 0.36;
    var spoutG = kit.geo(new THREE.CylinderGeometry(0.09, 0.13, 0.78, 6, 1));
    var spouts = [];
    for (var sp2 = 0; sp2 < 3; sp2++) {
      var sa = (sp2 / 3) * TAU + kit.rr(-0.2, 0.2);
      var sm = kit.mesh(spoutG, mPipe, body);
      sm.position.set(Math.cos(sa) * 0.42, colTop + 0.95, Math.sin(sa) * 0.42);
      sm.rotation.z = -Math.cos(sa) * 0.32;
      sm.rotation.x = Math.sin(sa) * 0.32;
      spouts.push(sm);
    }

    var headAnchor = new THREE.Object3D();
    headAnchor.position.y = 7.35;
    group.add(headAnchor);

    /* ------------------------------------------------------- animation */
    var walkPhase = kit.rr(0, TAU);
    var spin = 0, flick = 0;
    var TOTAL_H = 7.0;

    function update(dt, ctx) {
      ctx = ctx || {};
      var t = ctx.time || 0;
      var st = ctx.state || 'idle';
      var hp = clamp(ctx.hpFrac == null ? 1 : ctx.hpFrac, 0, 1);
      var dmg = 1 - hp;
      var sp = clamp(ctx.spawnT == null ? 1 : ctx.spawnT, 0, 1);
      var at = clamp(ctx.attackT || 0, 0, 1);
      var ht = clamp(ctx.hurtT || 0, 0, 1);
      var dq = clamp(ctx.dieT || 0, 0, 1);
      var ms = ctx.moveSpeed || 0;
      var i;
      walkPhase += dt * (0.5 + ms * 1.25);
      spin += dt * (1 + dmg * 2.6);
      flick += dt * (6 + dmg * 20);

      var pulse = Math.sin(t * (1.6 + dmg * 2.4)) * 0.5 + 0.5;
      var beat = thump(t * (0.8 + dmg * 1.6));
      var br = Math.sin(t * 0.95 * (1 + dmg * 0.8));

      /* --- core + light: primary damage readout --- */
      var coreS = 1 + pulse * (0.1 + dmg * 0.2) + dmg * 0.22;
      core.scale.setScalar(coreS);
      core.rotation.y = spin * 0.6;
      core.rotation.x = spin * 0.31;
      coreHalo.rotation.z = spin * 1.2;
      coreHalo.scale.setScalar(1 + dmg * 0.35 + pulse * 0.06);
      mCore.emissiveIntensity = 1.4 + pulse * 0.9 + dmg * 3.4;
      mIchor.emissiveIntensity = 0.6 + pulse * 0.4 + dmg * 1.6;
      mCoolant.emissiveIntensity = 0.8 + dmg * 1.5 + Math.sin(flick * 0.5) * 0.15;
      mCrack.emissiveIntensity = 0.15 + dmg * 3.0 + (Math.sin(flick) * 0.5 + 0.5) * dmg * 1.2;
      mGlass.emissiveIntensity = 0.25 + dmg * 1.4 + pulse * 0.2;
      mGlass.opacity = clamp(0.32 + dmg * 0.22, 0.2, 0.7);
      coreLight.intensity = (1.1 + pulse * 0.5 + dmg * 2.6);
      coreLight.distance = 7.0;

      for (i = 0; i < cracks.length; i++) {
        cracks[i].scale.set(1 + dmg * 1.6, 1 + dmg * 0.3, 1 + dmg * 1.6);
      }

      /* --- plates crack outward with damage --- */
      var crack = 0.04 + dmg * 1.18;
      for (i = 0; i < plates.length; i++) {
        plates[i].rotation.x = -(crack + Math.sin(t * 1.3 + i) * 0.03 * (0.3 + dmg));
        plates[i].position.z = plates[i].userData.baseZ + dmg * 0.1;
      }

      /* --- counter-rotating rings --- */
      for (i = 0; i < rings.length; i++) {
        var RG = rings[i];
        RG.o.rotation.y = spin * RG.sp * RG.dir * (1 + dmg * 1.2);
        RG.o.position.y = ringYs[i] + Math.sin(t * 0.7 + i) * 0.03 * (1 + dmg);
        RG.o.rotation.z = Math.sin(t * 0.5 + i * 2) * 0.02 * (1 + dmg * 3);
      }
      for (i = 0; i < hubs.length; i++) {
        hubs[i].o.rotation.y = spin * hubs[i].sp * hubs[i].dir;
      }

      /* --- column segments shear apart as it fails --- */
      for (i = 0; i < colSegs.length; i++) {
        var CS = colSegs[i];
        CS.pivot.position.y = CS.base + dmg * 0.05 * i;
        CS.pivot.rotation.z = Math.sin(t * 0.6 + i * 1.7) * 0.012 * (1 + dmg * 6);
        CS.pivot.rotation.x = Math.cos(t * 0.53 + i * 2.1) * 0.012 * (1 + dmg * 6);
      }

      /* --- chitin breathing --- */
      for (i = 0; i < wraps.length; i++) {
        var W = wraps[i];
        var k = 1 + Math.sin(t * 1.2 + W.ph) * (0.05 + dmg * 0.09);
        W.m.scale.set(W.s * 1.4 * k, W.s * k, W.s * 1.4 * k);
      }

      /* --- coolant beads climbing the tubes --- */
      for (i = 0; i < beads.length; i++) {
        var B = beads[i];
        var f = ((t * (0.28 + dmg * 0.5) + B.ph) % 1);
        var yy = lerp(tubeY0, tubeY1, f);
        B.m.position.set(lerp(B.x, B.x * 0.82, f), yy, lerp(B.z, B.z * 0.82, f));
        B.m.scale.setScalar(0.7 + Math.sin(f * PI) * 0.5);
      }

      /* --- pose --- */
      var bobY = 0, tiltX = 0, tiltZ = 0, splay = 0, armPunch = 0, twitch = 1;
      var spawning = (st === 'spawn');

      if (spawning) {
        var e = ease3(sp);
        body.position.y = -TOTAL_H * (1 - e);
        body.scale.set(lerp(0.5, 1, smooth(sp)), lerp(0.35, 1, ease3(sp)), lerp(0.5, 1, smooth(sp)));
        body.rotation.y = (1 - e) * -2.4;
        var power = smooth(subT(sp, 0.4, 1.0));
        mCore.emissiveIntensity *= power;
        mCoolant.emissiveIntensity *= power;
        mIchor.emissiveIntensity *= power;
        coreLight.intensity *= power;
        splay = (1 - smooth(subT(sp, 0.3, 0.95))) * -0.95;
        for (i = 0; i < plates.length; i++) plates[i].rotation.x = -crack * power;
      } else {
        body.scale.set(1, 1, 1);
        body.rotation.y = 0;
      }

      if (st === 'idle') {
        bobY = (Math.sin(t * 0.9) * 0.5 + 0.5) * 0.06;
        tiltZ = Math.sin(t * 0.37) * 0.025;
        tiltX = Math.cos(t * 0.29) * 0.02;
        splay = br * 0.06 + dmg * 0.18;
      } else if (st === 'walk') {
        var wp = walkPhase;
        bobY = (Math.sin(wp * 2) * 0.5 + 0.5) * 0.13;
        tiltZ = Math.sin(wp) * 0.075;
        tiltX = Math.sin(wp * 2 + 0.7) * 0.05;
        splay = Math.sin(wp) * 0.16 + dmg * 0.2;
        twitch = 1.8;
      } else if (st === 'attack') {
        var wu = windUp(at), sk = strike(at);
        bobY = wu * 0.26 - sk * 0.2;
        splay = -wu * 0.95 + sk * 1.5;
        armPunch = sk;
        tiltX = -wu * 0.1 + sk * 0.16;
        mCore.emissiveIntensity += wu * 2.2 + bump(subT(at, 0.4, 0.75)) * 4.5;
        coreLight.intensity += wu * 1.4 + bump(subT(at, 0.4, 0.75)) * 3.2;
        core.scale.setScalar(coreS * (1 + wu * 0.3 - sk * 0.25));
        twitch = 2.4;
      } else if (st === 'hurt') {
        var h = ht * ht;
        bobY = -h * 0.08;
        tiltZ = h * 0.09 * (1 - 2 * ((flick | 0) % 2));
        tiltX = -h * 0.07;
        splay = h * 0.3;
        mCore.emissiveIntensity += h * 3.0;
        coreLight.intensity += h * 2.0;
      } else if (st === 'die') {
        var s1 = subT(dq, 0.0, 0.32);
        var s2 = subT(dq, 0.3, 0.68);
        var s3 = subT(dq, 0.62, 1.0);
        /* stage 1: overload flare. 2: rings fly apart, column buckles. 3: sink. */
        mCore.emissiveIntensity = (1.5 + s1 * 9) * (1 - smooth(s2)) + 0.05;
        coreLight.intensity = (1.5 + s1 * 6) * (1 - smooth(s2));
        coreLight.distance = 7.0;
        mCrack.emissiveIntensity *= (1 - s3);
        mCoolant.emissiveIntensity *= (1 - smooth(s2));
        splay = smooth(s1) * -0.6 + smooth(s2) * 1.7;
        bobY = smooth(s1) * 0.2 - easeIn3(s2) * 0.7 - s3 * 2.3;
        tiltZ = smooth(s2) * 0.34 + Math.sin(dq * 22) * 0.05 * (1 - s3);
        tiltX = smooth(s2) * 0.18;
        for (i = 0; i < rings.length; i++) {
          rings[i].o.position.y = ringYs[i] - smooth(s2) * (0.35 + i * 0.25) - s3 * 0.5;
          rings[i].o.rotation.z = smooth(s2) * (i % 2 ? 0.7 : -0.7);
        }
        for (i = 0; i < colSegs.length; i++) {
          colSegs[i].pivot.position.y = colSegs[i].base - smooth(s2) * 0.16 * i - s3 * 0.3 * i;
          colSegs[i].pivot.rotation.z = smooth(s2) * ((i % 2) ? 0.16 : -0.16);
        }
        for (i = 0; i < plates.length; i++) plates[i].rotation.x = -(crack + smooth(s1) * 0.7);
        body.scale.set(1 + s3 * 0.1, Math.max(0.2, 1 - s3 * 0.7), 1 + s3 * 0.1);
      }

      if (!spawning) {
        body.position.y = bobY
          + (Math.abs(Math.sin(tiltZ)) + Math.abs(Math.sin(tiltX))) * baseR * 1.45;
      }
      body.rotation.z = tiltZ;
      body.rotation.x = tiltX;

      /* --- arms --- */
      for (i = 0; i < arms.length; i++) {
        var A = arms[i];
        var w = Math.sin(t * (1.1 * twitch) + A.ph);
        var w2 = Math.sin(t * (1.7 * twitch) + A.ph * 1.7);
        A.ch.joints[0].rotation.x = -A.up0 + splay * A.splay + w * 0.07 * twitch;
        A.ch.joints[0].rotation.z = w2 * 0.09;
        A.ch.joints[1].rotation.x = 1.1 + w2 * (0.12 + dmg * 0.2) - armPunch * 0.9;
        if (A.ch.joints[2]) A.ch.joints[2].rotation.x = 0.7 + w * (0.14 + dmg * 0.22) - armPunch * 0.5;
        if (A.ch.joints[3]) A.ch.joints[3].rotation.x = 0.4 + w2 * 0.12;
        A.yaw.rotation.z = w * 0.05;
      }
      crown.rotation.y = spin * 0.12;
      for (i = 0; i < spouts.length; i++) {
        spouts[i].scale.y = 1 + Math.sin(t * 2.2 + i) * 0.08 * (1 + dmg * 2);
      }
    }

    return {
      group: group,
      headAnchor: headAnchor,
      materials: kit.mats,
      hitPoints: [coreRig, rings[0].o, rings[2].o, baseM],
      update: update,
      dispose: function () {
        if (coreLight.parent) coreLight.parent.remove(coreLight);
        disposerFor(kit)();
      },
      _meshCount: kit.meshCount
    };
  }

  window.CaveTyper.monsters['hive_reactor'] = {
    id: 'hive_reactor',
    name: 'HIVE REACTOR',
    tier: 'boss',
    size: { height: 7.0, radius: 2.6 },
    build: buildHiveReactor
  };

  /* ================================================================== #3
   * THE CULTIVAR
   * ================================================================= */
  function buildCultivar(opts) {
    var kit = new Kit(opts), P = kit.pal;
    var group = new THREE.Group();
    var body = new THREE.Group();
    group.add(body);

    var SEG = kit.pick(6, 8, 9);
    var SEG2 = kit.pick(5, 6, 7);

    var mBark = kit.organic(P.flesh2, { rough: 0.95 });
    var mBark2 = kit.organic(P.flesh, { rough: 0.92 });
    var mFungus = kit.organic(P.accent, { rough: 0.85 });
    var mPod = kit.organic(P.flesh, { rough: 0.7 });
    var mPodGlow = kit.glow(P.goo, P.glow, 0.9);
    var mGill = kit.glow(P.glow, P.glow, 1.6, { rough: 0.4 });
    var mSeam = kit.glow(P.accent, P.glow, 0.2);
    var mEye = kit.glow(P.glow2, P.glow2, 1.4, { rough: 0.3 });
    var mMaw = kit.glow(P.flesh2, P.accent, 0.3);
    var mTray = kit.metal(P.metal);
    var mRoot = kit.organic(P.flesh2, { rough: 0.9 });

    /* ---- the specimen tray it burst out of ---- */
    var trayW = kit.jit(3.1, 0.08), trayD = kit.jit(2.3, 0.08);
    var trayG = kit.geo(new THREE.BoxGeometry(trayW, 0.16, trayD));
    var tray = kit.mesh(trayG, mTray, body);
    tray.position.y = 0.08;
    tray.rotation.y = kit.rr(-0.25, 0.25);
    var lipG = kit.geo(new THREE.BoxGeometry(trayW * 0.9, 0.42, 0.11));
    var lipA = kit.mesh(lipG, mTray, tray);
    lipA.position.set(0, 0.16, -trayD * 0.46); lipA.rotation.x = -0.45;
    var lipB = kit.mesh(lipG, mTray, tray);
    lipB.position.set(0, 0.14, trayD * 0.46); lipB.rotation.x = 0.7;

    /* ---- gnarled trunk ---- */
    var trunkRoot = new THREE.Object3D();
    trunkRoot.position.y = 0.1;
    body.add(trunkRoot);
    var trunkLen = kit.jit(1.0, 0.08);
    var trunk = segmentChain(kit, trunkRoot, {
      count: 5, len: trunkLen, r: kit.jit(0.88, 0.08), taper: 0.92,
      radial: SEG, mats: [mBark, mBark2, mBark, mBark2, mBark]
    });
    var trunkTotal = 0;
    for (var tl = 0; tl < trunk.lens.length; tl++) trunkTotal += trunk.lens[tl];
    var trunkRest = [];
    for (var tj = 0; tj < trunk.joints.length; tj++) {
      var rx = kit.rr(-0.04, 0.04), rz = kit.rr(-0.045, 0.045);
      trunk.joints[tj].rotation.x = rx;
      trunk.joints[tj].rotation.z = rz;
      trunkRest.push({ x: rx, z: rz });
    }

    /* gnarls + glowing bark seams */
    var knotG = kit.geo(new THREE.DodecahedronGeometry(1, 0));
    var knots = [];
    for (var kn = 0; kn < 4; kn++) {
      var host = trunk.joints[1 + (kn % 3)];
      var ka = kit.rr(0, TAU);
      var km = kit.mesh(knotG, kn % 2 ? mFungus : mBark2, host);
      var ks = kit.rr(0.22, 0.4);
      km.scale.set(ks, ks * kit.rr(0.7, 1.3), ks);
      km.position.set(Math.cos(ka) * 0.62, kit.rr(0.15, 0.85), Math.sin(ka) * 0.62);
      km.rotation.set(kit.rr(0, TAU), kit.rr(0, TAU), kit.rr(0, TAU));
      knots.push(km);
    }
    var seams = [];
    var seamG = kit.geo(new THREE.BoxGeometry(0.07, 0.8, 0.07));
    for (var se = 0; se < 3; se++) {
      var sa = kit.rr(0, TAU);
      var host2 = trunk.joints[1 + (se % 3)];
      var sm = kit.mesh(seamG, mSeam, host2);
      sm.position.set(Math.cos(sa) * 0.72, kit.rr(0.2, 0.75), Math.sin(sa) * 0.72);
      sm.rotation.set(kit.rr(-0.3, 0.3), -sa, kit.rr(-0.25, 0.25));
      seams.push(sm);
    }

    /* buttress roots anchoring into the tray */
    for (var bu = 0; bu < 4; bu++) {
      var ba = (bu / 4) * TAU + kit.rr(-0.3, 0.3);
      strut(kit, body, Math.cos(ba) * 0.55, kit.rr(0.85, 1.25), Math.sin(ba) * 0.55,
        Math.cos(ba) * kit.rr(1.25, 1.7), 0.26, Math.sin(ba) * kit.rr(1.25, 1.7), 0.16, mRoot, 5);
    }

    /* ---- human-ish faces half swallowed by the bark ---- */
    var faces = [];
    var nFace = 3;
    for (var fi = 0; fi < nFace; fi++) {
      var fj = trunk.joints[1 + (fi % 3)];
      var fa = kit.rr(-0.9, 0.9);
      var f = facePlate(kit, fj, { r: kit.rr(0.24, 0.34), skin: mBark2, eye: mEye, mouth: mMaw });
      f.group.position.set(Math.sin(fa) * 0.72, kit.rr(0.2, 0.8), Math.cos(fa) * 0.72);
      f.group.rotation.y = fa;
      f.group.rotation.z = kit.rr(-0.4, 0.4);
      faces.push({ f: f, ph: kit.rr(0, TAU) });
    }

    /* ---- canopy ---- */
    var canopy = new THREE.Object3D();
    canopy.position.y = trunk.lens[trunk.lens.length - 1];
    trunk.joints[trunk.joints.length - 1].add(canopy);

    var capR = kit.jit(2.0, 0.08);
    var capG = kit.geo(new THREE.IcosahedronGeometry(1, 1));
    var cap = kit.mesh(capG, mFungus, canopy);
    cap.scale.set(capR, kit.jit(0.82, 0.12), capR * 0.94);
    cap.position.y = 0.52;
    cap.rotation.y = kit.rr(0, TAU);
    var capBaseY = cap.scale.y;
    var cap2 = kit.mesh(capG, mBark2, canopy);
    cap2.scale.set(capR * 0.55, 0.46, capR * 0.52);
    cap2.position.y = 0.95;

    /* ring of glowing gills under the canopy */
    var nGill = kit.pick(8, 10, 12);
    var gillG = kit.geo(new THREE.BoxGeometry(0.1, 0.34, 0.95));
    var gills = [];
    for (var gi = 0; gi < nGill; gi++) {
      var ga = (gi / nGill) * TAU;
      var gm = kit.mesh(gillG, mGill, canopy);
      gm.position.set(Math.cos(ga) * capR * 0.6, 0.18, Math.sin(ga) * capR * 0.58);
      gm.rotation.y = -ga;
      gills.push(gm);
    }
    var gringG = kit.geo(new THREE.TorusGeometry(capR * 0.85, 0.07, 4, kit.pick(10, 14, 18)));
    var gring = kit.mesh(gringG, mGill, canopy);
    gring.position.y = 0.12;
    gring.rotation.x = PI * 0.5;

    /* ---- spore pods on drooping stalks ---- */
    var nPod = kit.ql === 0 ? kit.ri(4, 5) : (kit.ql === 2 ? kit.ri(5, 7) : kit.ri(4, 6));
    var pods = [];
    var podG = kit.geo(new THREE.IcosahedronGeometry(1, 1));
    var nubG = kit.geo(new THREE.IcosahedronGeometry(1, 0));
    for (var pi = 0; pi < nPod; pi++) {
      var pa = (pi / nPod) * TAU + kit.rr(-0.22, 0.22);
      var yaw = new THREE.Object3D();
      yaw.rotation.y = pa;
      yaw.position.y = 0.62;
      canopy.add(yaw);
      var lift = new THREE.Object3D();
      lift.rotation.x = PI * 0.5;
      yaw.add(lift);
      var stalk = segmentChain(kit, lift, {
        count: 2, len: kit.jit(0.84, 0.14), r: kit.jit(0.14, 0.18), taper: 0.85,
        radial: SEG2, baseY: capR * 0.42, mat: mBark2
      });
      var up0 = kit.rr(0.35, 0.75);
      stalk.joints[0].rotation.x = -up0;
      stalk.joints[1].rotation.x = 0.85 + kit.rr(-0.2, 0.3);
      var pr = kit.rr(0.36, 0.52);
      var pod = kit.mesh(podG, mPod, stalk.tip);
      pod.scale.setScalar(pr);
      pod.position.y = pr * 0.7;
      pod.rotation.set(kit.rr(0, TAU), kit.rr(0, TAU), kit.rr(0, TAU));
      var nub = kit.mesh(nubG, mPodGlow, stalk.tip);
      nub.scale.setScalar(pr * 0.42);
      nub.position.y = pr * 0.7;
      pods.push({
        stalk: stalk, pod: pod, nub: nub, r: pr, up0: up0,
        ph: kit.rr(0, TAU), rate: kit.rr(0.7, 1.25),
        burstAt: 0.82 - pi * (0.72 / Math.max(1, nPod))
      });
    }

    /* crown stalk + apex pod (tallest point) */
    var crownStalk = segmentChain(kit, canopy, {
      count: 2, len: kit.jit(0.66, 0.1), r: 0.16, taper: 0.85,
      radial: SEG2, baseY: 0.85, mat: mBark
    });
    crownStalk.joints[0].rotation.x = kit.rr(-0.12, 0.12);
    crownStalk.joints[1].rotation.x = kit.rr(-0.18, 0.18);
    var crownPod = kit.mesh(podG, mPod, crownStalk.tip);
    var crownR = kit.jit(0.52, 0.12);
    crownPod.scale.setScalar(crownR);
    crownPod.position.y = crownR * 0.75;
    var crownNub = kit.mesh(nubG, mPodGlow, crownStalk.tip);
    crownNub.scale.setScalar(crownR * 0.45);
    crownNub.position.y = crownR * 0.75;

    /* ---- curtains of hanging root tendrils ---- */
    var nTendril = kit.pick(6, 8, 9);
    var tendSegs = kit.pick(2, 2, 3);
    var tendrils = [];
    for (var ti = 0; ti < nTendril; ti++) {
      var ta = (ti / nTendril) * TAU + kit.rr(-0.2, 0.2);
      var thold = new THREE.Object3D();
      thold.position.set(Math.cos(ta) * capR * 0.82, 0.05, Math.sin(ta) * capR * 0.8);
      thold.rotation.y = -ta;
      canopy.add(thold);
      var drop = new THREE.Object3D();
      drop.rotation.x = PI;
      thold.add(drop);
      var tc = segmentChain(kit, drop, {
        count: tendSegs, len: kit.rr(0.85, 1.4), r: kit.rr(0.07, 0.12), taper: 0.78,
        radial: 5, mat: ti % 2 ? mRoot : mBark2
      });
      for (var tq = 0; tq < tc.joints.length; tq++) tc.joints[tq].rotation.x = kit.rr(-0.14, 0.14);
      tendrils.push({ ch: tc, ph: kit.rr(0, TAU), amp: kit.rr(0.06, 0.16) });
    }

    var headAnchor = new THREE.Object3D();
    headAnchor.position.y = 7.9;
    group.add(headAnchor);

    /* ------------------------------------------------------- animation */
    var walkPhase = kit.rr(0, TAU);
    var flick = 0;
    var TOTAL_H = 7.5;

    function update(dt, ctx) {
      ctx = ctx || {};
      var t = ctx.time || 0;
      var st = ctx.state || 'idle';
      var hp = clamp(ctx.hpFrac == null ? 1 : ctx.hpFrac, 0, 1);
      var dmg = 1 - hp;
      var sp = clamp(ctx.spawnT == null ? 1 : ctx.spawnT, 0, 1);
      var at = clamp(ctx.attackT || 0, 0, 1);
      var ht = clamp(ctx.hurtT || 0, 0, 1);
      var dq = clamp(ctx.dieT || 0, 0, 1);
      var ms = ctx.moveSpeed || 0;
      var i;
      walkPhase += dt * (0.45 + ms * 1.15);
      flick += dt * (5 + dmg * 18);

      var rage = 1 + dmg * 0.9;
      var br = Math.sin(t * 0.85 * rage);
      var pulse = Math.sin(t * (1.3 + dmg * 1.5)) * 0.5 + 0.5;

      mGill.emissiveIntensity = 1.1 + pulse * 0.5 + dmg * 2.8 + (Math.sin(flick) * 0.5 + 0.5) * dmg * 1.2;
      mSeam.emissiveIntensity = 0.12 + dmg * 2.6;
      mPodGlow.emissiveIntensity = 0.6 + pulse * 0.4 + dmg * 2.2;
      mEye.emissiveIntensity = 0.9 + dmg * 1.8 + Math.sin(flick * 1.3) * 0.15 * (1 + dmg * 3);
      mMaw.emissiveIntensity = 0.2 + dmg * 1.5;
      for (i = 0; i < seams.length; i++) {
        seams[i].scale.set(1 + dmg * 2.2, 1, 1 + dmg * 2.2);
      }

      /* --- pose drivers --- */
      var bobY = 0, leanX = 0, leanZ = 0, canopyPitch = 0, canopyRise = 0;
      var stalkFling = 0, tendFling = 0, sagExtra = 0;
      var spawning = (st === 'spawn');

      if (spawning) {
        var e = ease3(sp);
        var uncurl = smooth(subT(sp, 0.25, 1.0));
        body.position.y = -TOTAL_H * (1 - e) * 0.95;
        body.scale.set(lerp(0.35, 1, smooth(sp)), lerp(0.28, 1, ease3(sp)), lerp(0.35, 1, smooth(sp)));
        body.rotation.y = (1 - e) * 2.1;
        canopyPitch = (1 - uncurl) * 1.15;
        canopyRise = (1 - uncurl);
        stalkFling = -(1 - uncurl) * 1.25;
        tendFling = (1 - uncurl) * 0.9;
        mGill.emissiveIntensity *= smooth(subT(sp, 0.45, 1.0));
        mPodGlow.emissiveIntensity *= smooth(subT(sp, 0.5, 1.0));
      } else {
        body.scale.set(1, 1, 1);
        body.rotation.y = 0;
      }

      if (st === 'idle') {
        bobY = (Math.sin(t * 0.8 * rage) * 0.5 + 0.5) * 0.08;
        leanZ = Math.sin(t * 0.33) * 0.05;
        leanX = Math.cos(t * 0.27) * 0.04;
        canopyPitch = Math.sin(t * 0.55) * 0.07 + dmg * 0.22;
      } else if (st === 'walk') {
        var wp = walkPhase;
        bobY = (Math.sin(wp * 2) * 0.5 + 0.5) * 0.2;
        leanZ = Math.sin(wp) * (0.16 + dmg * 0.05);
        leanX = Math.sin(wp * 2 + 0.6) * 0.08 + 0.05;
        canopyPitch = Math.sin(wp + 0.9) * 0.16 + dmg * 0.24;
        stalkFling = Math.sin(wp + 0.5) * 0.22;
        tendFling = Math.sin(wp + 1.1) * 0.3;
      } else if (st === 'attack') {
        var wu = windUp(at), sk = strike(at);
        /* rear the whole canopy back, then slam it forward */
        canopyPitch = -wu * 0.85 + sk * 1.45;
        canopyRise = wu * 0.5 - sk * 0.35;
        leanX = -wu * 0.24 + sk * 0.4;
        bobY = wu * 0.3 - sk * 0.25;
        stalkFling = -wu * 1.0 + sk * 1.7;
        tendFling = -wu * 0.55 + sk * 1.2;
        mGill.emissiveIntensity += wu * 1.6 + bump(subT(at, 0.4, 0.78)) * 3.2;
        mPodGlow.emissiveIntensity += wu * 1.2;
      } else if (st === 'hurt') {
        var h = ht * ht;
        bobY = -h * 0.12;
        leanX = -h * 0.2;
        leanZ = h * 0.13;
        canopyPitch = -h * 0.35;
        stalkFling = -h * 0.8;
        tendFling = h * 0.6;
        mGill.emissiveIntensity += h * 2.0;
      } else if (st === 'die') {
        var s1 = subT(dq, 0.0, 0.3);
        var s2 = subT(dq, 0.28, 0.66);
        var s3 = subT(dq, 0.6, 1.0);
        canopyPitch = -smooth(s1) * 0.5 + smooth(s2) * 1.5 + s3 * 0.4;
        leanX = smooth(s2) * 0.75 + s3 * 0.25;
        leanZ = Math.sin(dq * 8) * 0.18 * (1 - s3);
        bobY = smooth(s1) * 0.22 - easeIn3(s2) * 0.8 - s3 * 2.6;
        stalkFling = smooth(s1) * -1.2 + smooth(s2) * 2.0;
        tendFling = smooth(s2) * 1.1;
        sagExtra = smooth(s2) * 0.5;
        mGill.emissiveIntensity = (1.4 + s1 * 5) * (1 - smooth(s2)) + 0.04;
        mPodGlow.emissiveIntensity = (1.0 + s1 * 4) * (1 - smooth(s2)) + 0.04;
        mEye.emissiveIntensity *= (1 - smooth(s2));
        mSeam.emissiveIntensity *= (1 - s3);
        body.scale.set(1 + s3 * 0.2, Math.max(0.15, 1 - s3 * 0.78), 1 + s3 * 0.2);
      }

      if (!spawning) {
        body.position.y = bobY
          + Math.abs(Math.sin(leanZ)) * trayW * 0.5
          + Math.abs(Math.sin(leanX)) * trayD * 0.5;
      }
      body.rotation.z = leanZ;
      body.rotation.x = leanX;

      /* trunk sway spread over the joints */
      for (i = 0; i < trunk.joints.length; i++) {
        var f2 = (i + 1) / trunk.joints.length;
        trunk.joints[i].rotation.x = trunkRest[i].x + (canopyPitch * 0.34 + Math.sin(t * 0.6 + i) * 0.02) * f2 + sagExtra * f2 * 0.4;
        trunk.joints[i].rotation.z = trunkRest[i].z + Math.sin(t * 0.43 + i * 1.3) * 0.022 * (1 + dmg);
        var swell = 1 + Math.sin(t * 0.9 * rage - i * 0.5) * (0.018 + dmg * 0.03);
        trunk.meshes[i].scale.set(swell, 1, swell);
      }
      canopy.rotation.x = canopyPitch * 0.55;
      canopy.position.y = trunk.lens[trunk.lens.length - 1] + canopyRise * 0.3;
      cap.scale.y = capBaseY * (1 + br * 0.02);
      gring.rotation.z = t * 0.12 * (1 + dmg);
      for (i = 0; i < gills.length; i++) {
        gills[i].scale.y = 1 + Math.sin(t * 1.6 + i * 0.7) * 0.1 * (1 + dmg * 1.5);
      }

      /* --- spore pods: swell, pulse, and burst as health falls --- */
      for (i = 0; i < pods.length; i++) {
        var Pd = pods[i];
        var burst = clamp((Pd.burstAt - hp) * 6, 0, 1);
        var swell2 = 1 + Math.sin(t * (1.1 * Pd.rate) + Pd.ph) * (0.09 + dmg * 0.12);
        var sX = Pd.r * swell2 * (1 + burst * 0.75);
        var sY = Pd.r * swell2 * (1 - burst * 0.82);
        Pd.pod.scale.set(sX, sY, sX);
        Pd.pod.position.y = Pd.r * 0.7 * (1 - burst * 0.55);
        Pd.nub.scale.setScalar(Pd.r * (0.34 + burst * 0.5 + pulse * 0.05));
        Pd.nub.position.y = Pd.r * 0.7 * (1 - burst * 0.4);
        var sway2 = Math.sin(t * (0.72 * Pd.rate) + Pd.ph);
        var sway3 = Math.cos(t * (0.95 * Pd.rate) + Pd.ph * 1.4);
        Pd.stalk.joints[0].rotation.x = -Pd.up0 + stalkFling * 0.55 + sway2 * 0.09 + burst * 0.55;
        Pd.stalk.joints[0].rotation.z = sway3 * 0.11;
        Pd.stalk.joints[1].rotation.x = 0.85 + sway3 * 0.13 + stalkFling * 0.45 + burst * 0.7 + dmg * 0.2;
        Pd.stalk.joints[1].rotation.z = sway2 * 0.08;
      }
      crownStalk.joints[0].rotation.x = Math.sin(t * 0.7) * 0.07 + canopyPitch * 0.2;
      crownStalk.joints[1].rotation.x = Math.sin(t * 0.9 + 1) * 0.09 + canopyPitch * 0.25;
      var cBurst = clamp((0.25 - hp) * 6, 0, 1);
      var cs2 = 1 + Math.sin(t * 1.2) * (0.07 + dmg * 0.1);
      crownPod.scale.set(crownR * cs2 * (1 + cBurst * 0.7), crownR * cs2 * (1 - cBurst * 0.8), crownR * cs2 * (1 + cBurst * 0.7));
      crownNub.scale.setScalar(crownR * (0.4 + cBurst * 0.5));

      /* --- hanging tendrils --- */
      for (i = 0; i < tendrils.length; i++) {
        var T = tendrils[i];
        for (var j = 0; j < T.ch.joints.length; j++) {
          T.ch.joints[j].rotation.x = Math.sin(t * (0.8 + j * 0.25) + T.ph + j) * T.amp * (1 + dmg * 0.8) + tendFling * (0.4 + j * 0.2);
          T.ch.joints[j].rotation.z = Math.cos(t * (0.65 + j * 0.2) + T.ph * 1.5) * T.amp * 0.8;
        }
      }

      /* --- swallowed faces --- */
      for (i = 0; i < faces.length; i++) {
        var F = faces[i];
        F.f.jaw.rotation.x = (0.08 + dmg * 0.55) * (Math.sin(t * 1.4 * rage + F.ph) * 0.5 + 0.5);
        F.f.group.rotation.x = Math.sin(t * 0.7 + F.ph) * 0.1;
      }
    }

    return {
      group: group,
      headAnchor: headAnchor,
      materials: kit.mats,
      hitPoints: [canopy, trunk.joints[2], pods.length ? pods[0].stalk.tip : canopy, trunkRoot],
      update: update,
      dispose: disposerFor(kit),
      _meshCount: kit.meshCount
    };
  }

  window.CaveTyper.monsters['the_cultivar'] = {
    id: 'the_cultivar',
    name: 'THE CULTIVAR',
    tier: 'boss',
    size: { height: 7.5, radius: 3.8 },
    build: buildCultivar
  };

  /* ================================================================== #4
   * WARDEN PRIME
   * ================================================================= */
  function buildWardenPrime(opts) {
    var kit = new Kit(opts), P = kit.pal;
    var group = new THREE.Group();
    var body = new THREE.Group();
    group.add(body);

    var SEG2 = kit.pick(5, 6, 7);

    var mSteel = kit.metal(P.metal);
    var mSteel2 = kit.metal(P.metal, { rough: 0.55, metal: 0.6 });
    var mPiston = kit.metal(0xc8ccd2, { rough: 0.18, metal: 0.95 });
    var mHazard = kit.metal(0xd6bb35, { rough: 0.6, metal: 0.35 });
    var mHazard2 = kit.metal(0x25282c, { rough: 0.7, metal: 0.3 });
    var mFlesh = kit.organic(P.flesh);
    var mFlesh2 = kit.organic(P.accent, { rough: 0.78 });
    var mVein = kit.glow(P.goo, P.glow, 0.7);
    var mLens = kit.glow(P.glow2, P.glow2, 2.2, { flat: false, rough: 0.2 });
    var mGlass = kit.glow(P.glow2, P.glow2, 0.2, { flat: false, rough: 0.1, transparent: true, opacity: 0.3 });
    var mSpark = kit.glow(P.accent, P.glow, 0.15);

    /* ---- quadruped piston chassis ---- */
    var thighLen = kit.jit(1.0, 0.08);
    var shinLen = kit.jit(1.06, 0.08);
    var legR = kit.jit(0.25, 0.08);
    var footH = legR * 0.55;
    var hipY = thighLen + shinLen + footH;
    var hullHW = kit.jit(0.86, 0.07);
    var hullHD = kit.jit(1.22, 0.07);

    var legs = [];
    var legDefs = [
      { x: -hullHW, z: hullHD * 0.78, ph: 0.0 },
      { x: hullHW, z: hullHD * 0.78, ph: 0.5 },
      { x: -hullHW, z: -hullHD * 0.78, ph: 0.5 },
      { x: hullHW, z: -hullHD * 0.78, ph: 0.0 }
    ];
    for (var lg = 0; lg < 4; lg++) {
      var L = pistonLeg(kit, body, {
        x: legDefs[lg].x, y: hipY, z: legDefs[lg].z, r: legR,
        thigh: thighLen, shin: shinLen,
        mat: mSteel, pistonMat: mSteel2, rodMat: mPiston, footMat: mSteel2
      });
      L.ph = legDefs[lg].ph;
      L.sx = legDefs[lg].x < 0 ? -1 : 1;
      legs.push(L);
    }

    /* ---- armoured hull ---- */
    var hull = new THREE.Object3D();
    hull.position.y = hipY + 0.3;
    body.add(hull);
    var hullG = kit.geo(new THREE.BoxGeometry(hullHW * 2.05, 0.8, hullHD * 2.0));
    kit.mesh(hullG, mSteel, hull);
    var deckG = kit.geo(new THREE.BoxGeometry(hullHW * 1.7, 0.26, hullHD * 1.7));
    var deck = kit.mesh(deckG, mSteel2, hull);
    deck.position.y = 0.5;
    var ridgeG = kit.geo(new THREE.BoxGeometry(0.28, 0.3, hullHD * 1.5));
    var ridge = kit.mesh(ridgeG, mSteel, hull);
    ridge.position.y = 0.72;
    var skirtG = kit.geo(new THREE.BoxGeometry(hullHW * 2.1, 0.3, 0.22));
    var skirt = kit.mesh(skirtG, mSteel2, hull);
    skirt.position.set(0, -0.42, -hullHD * 0.98);

    /* hazard stripes across the front lip */
    var stripeG = kit.geo(new THREE.BoxGeometry(hullHW * 0.36, 0.3, 0.08));
    for (var hz = 0; hz < 5; hz++) {
      var smh = kit.mesh(stripeG, hz % 2 ? mHazard2 : mHazard, hull);
      smh.position.set((hz - 2) * hullHW * 0.38, 0.12, hullHD * 1.01);
      smh.rotation.z = 0.35;
    }
    var ventG = kit.geo(new THREE.BoxGeometry(0.42, 0.12, 0.5));
    for (var vt = 0; vt < 2; vt++) {
      var vm = kit.mesh(ventG, mHazard2, hull);
      vm.position.set((vt ? 1 : -1) * hullHW * 1.02, 0.1, -hullHD * 0.4);
      vm.rotation.z = (vt ? -1 : 1) * 0.35;
    }

    /* blow-off armour panels (open as damage rises) */
    var panels = [];
    var panelG = kit.geo(new THREE.BoxGeometry(hullHW * 0.9, 0.06, hullHD * 0.75));
    var panelPos = [
      { x: -hullHW * 0.55, z: hullHD * 0.25, s: -1 },
      { x: hullHW * 0.55, z: -hullHD * 0.3, s: 1 },
      { x: 0, z: -hullHD * 0.75, s: 1 }
    ];
    for (var pn = 0; pn < panelPos.length; pn++) {
      var hinge = new THREE.Object3D();
      hinge.position.set(panelPos[pn].x, 0.64, panelPos[pn].z);
      hull.add(hinge);
      var pm = kit.mesh(panelG, mSteel2, hinge);
      pm.position.z = hullHD * 0.36;
      panels.push({ o: hinge, s: panelPos[pn].s, ph: kit.rr(0, TAU) });
    }

    /* ---- segmented neck + sensor head ---- */
    var neckBase = new THREE.Object3D();
    neckBase.position.set(0, 0.55, hullHD * 0.55);
    hull.add(neckBase);
    var neck = segmentChain(kit, neckBase, {
      count: 3, len: kit.jit(0.5, 0.1), r: 0.19, taper: 0.9,
      radial: 8, shape: 'cyl', mats: [mSteel, mPiston, mSteel]
    });
    for (var nj = 0; nj < neck.joints.length; nj++) neck.joints[nj].rotation.x = -0.12;
    var collarG = kit.geo(new THREE.TorusGeometry(0.24, 0.06, 5, 10));
    var collar = kit.mesh(collarG, mSteel2, neck.joints[0]);
    collar.position.y = 0.08; collar.rotation.x = PI * 0.5;

    var headYaw = new THREE.Object3D();
    neck.tip.add(headYaw);
    var headPitch = new THREE.Object3D();
    headYaw.add(headPitch);
    var headG = kit.geo(new THREE.BoxGeometry(0.72, 0.4, 0.58));
    var headM = kit.mesh(headG, mSteel, headPitch);
    headM.position.y = 0.2;
    var visorG = kit.geo(new THREE.BoxGeometry(0.62, 0.18, 0.1));
    var visor = kit.mesh(visorG, mHazard2, headPitch);
    visor.position.set(0, 0.22, 0.31);
    var lensG = kit.geo(new THREE.SphereGeometry(0.13, 8, 6));
    var lens = kit.mesh(lensG, mLens, headPitch);
    lens.position.set(0, 0.22, 0.33);
    var ringG = kit.geo(new THREE.TorusGeometry(0.17, 0.035, 5, 10));
    var lensRing = kit.mesh(ringG, mPiston, headPitch);
    lensRing.position.set(0, 0.22, 0.33);
    var antG = kit.geo(new THREE.CylinderGeometry(0.02, 0.035, 0.52, 5, 1));
    var antennae = [];
    for (var aq = 0; aq < 2; aq++) {
      var am2 = kit.mesh(antG, mPiston, headPitch);
      am2.position.set((aq ? 1 : -1) * 0.28, 0.5, -0.1);
      am2.rotation.z = (aq ? -1 : 1) * 0.3;
      antennae.push(am2);
    }

    /* ---- failed containment cradle on the front ---- */
    var cradle = new THREE.Object3D();
    cradle.position.set(0, -0.12, hullHD * 0.86);
    hull.add(cradle);
    var barG = kit.geo(new THREE.BoxGeometry(0.1, 0.1, 0.62));
    var frameW = hullHW * 0.78;
    for (var fr = 0; fr < 4; fr++) {
      var fx = (fr % 2 ? 1 : -1) * frameW;
      var fy = (fr < 2 ? 1 : -1) * 0.42;
      var fm2 = kit.mesh(barG, mSteel2, cradle);
      fm2.position.set(fx, fy, 0.26);
    }
    var shardG = kit.geo(new THREE.BoxGeometry(0.5, 0.5, 0.04));
    var shards = [];
    for (var sh2 = 0; sh2 < 3; sh2++) {
      var sm2 = kit.mesh(shardG, mGlass, cradle);
      sm2.position.set(kit.rr(-frameW, frameW), kit.rr(-0.35, 0.35), 0.46);
      sm2.rotation.set(kit.rr(-0.5, 0.5), kit.rr(-0.7, 0.7), kit.rr(0, TAU));
      sm2.scale.setScalar(kit.rr(0.6, 1.1));
      shards.push(sm2);
    }

    /* ---- the thing that burst out of it ---- */
    var meat = new THREE.Object3D();
    meat.position.set(0, 0, 0.22);
    cradle.add(meat);
    var blobG = kit.geo(new THREE.IcosahedronGeometry(1, 1));
    var blobs = [];
    for (var bl = 0; bl < 3; bl++) {
      var bm = kit.mesh(blobG, bl % 2 ? mFlesh : mFlesh2, meat);
      var bs = kit.rr(0.34, 0.52);
      bm.scale.setScalar(bs);
      bm.position.set(kit.rr(-0.4, 0.4), kit.rr(-0.3, 0.3), kit.rr(0.05, 0.34));
      bm.rotation.set(kit.rr(0, TAU), kit.rr(0, TAU), kit.rr(0, TAU));
      blobs.push({ m: bm, s: bs, ph: kit.rr(0, TAU) });
    }
    var nodeG = kit.geo(new THREE.IcosahedronGeometry(1, 0));
    var nodes = [];
    for (var nd = 0; nd < 3; nd++) {
      var nm2 = kit.mesh(nodeG, mVein, meat);
      var ns = kit.rr(0.1, 0.17);
      nm2.scale.setScalar(ns);
      nm2.position.set(kit.rr(-0.45, 0.45), kit.rr(-0.35, 0.35), kit.rr(0.25, 0.5));
      nodes.push({ m: nm2, s: ns, ph: kit.rr(0, TAU) });
    }

    /* tendrils threading back into the machine's joints */
    var tendrils = [];
    var nTend = kit.pick(4, 5, 6);
    for (var td = 0; td < nTend; td++) {
      var root2 = new THREE.Object3D();
      root2.position.set(kit.rr(-0.5, 0.5), kit.rr(-0.3, 0.3), kit.rr(0.0, 0.3));
      root2.rotation.y = kit.rr(-0.9, 0.9);
      root2.rotation.x = kit.rr(1.8, 2.7);
      meat.add(root2);
      var tc = segmentChain(kit, root2, {
        count: 3, len: kit.rr(0.45, 0.72), r: kit.rr(0.055, 0.1), taper: 0.8,
        radial: 5, mats: [mFlesh2, mFlesh, mFlesh2]
      });
      for (var tq2 = 0; tq2 < 3; tq2++) tc.joints[tq2].rotation.x = kit.rr(-0.35, 0.35);
      tendrils.push({ ch: tc, ph: kit.rr(0, TAU), amp: kit.rr(0.1, 0.22) });
    }

    /* sparking damage seams on the hull */
    var sparks = [];
    var sparkG = kit.geo(new THREE.BoxGeometry(0.06, 0.06, 0.4));
    for (var sk2 = 0; sk2 < 3; sk2++) {
      var skm = kit.mesh(sparkG, mSpark, hull);
      skm.position.set(kit.rr(-hullHW, hullHW), kit.rr(-0.25, 0.35), kit.rr(-hullHD * 0.8, hullHD * 0.6));
      skm.rotation.set(0, kit.rr(0, TAU), kit.rr(-0.4, 0.4));
      sparks.push(skm);
    }

    var headAnchor = new THREE.Object3D();
    headAnchor.position.y = 5.85;
    group.add(headAnchor);

    /* ------------------------------------------------------- animation */
    var walkPhase = kit.rr(0, TAU);
    var flick = 0;
    var TOTAL_H = 5.5;

    function groundLegs() {
      var lowest = 1e9;
      for (var i = 0; i < 4; i++) {
        var L2 = legs[i];
        var a = L2.hip.rotation.x, b = L2.knee.rotation.x;
        var y = L2.hipY - L2.thigh * Math.cos(a) - L2.shin * Math.cos(a + b) - L2.footH;
        if (y < lowest) lowest = y;
      }
      return -lowest;
    }

    function update(dt, ctx) {
      ctx = ctx || {};
      var t = ctx.time || 0;
      var st = ctx.state || 'idle';
      var hp = clamp(ctx.hpFrac == null ? 1 : ctx.hpFrac, 0, 1);
      var dmg = 1 - hp;
      var sp = clamp(ctx.spawnT == null ? 1 : ctx.spawnT, 0, 1);
      var at = clamp(ctx.attackT || 0, 0, 1);
      var ht = clamp(ctx.hurtT || 0, 0, 1);
      var dq = clamp(ctx.dieT || 0, 0, 1);
      var ms = ctx.moveSpeed || 0;
      var i, j;
      walkPhase += dt * (0.42 + ms * 0.95);
      flick += dt * (8 + dmg * 26);

      /* organic parts run on their own slower rhythm */
      var organic = Math.sin(t * 0.62) * 0.5 + 0.5;
      var organic2 = Math.sin(t * 0.41 + 1.7) * 0.5 + 0.5;
      var pulse = Math.sin(t * (1.1 + dmg * 1.1)) * 0.5 + 0.5;

      mLens.emissiveIntensity = 1.6 + dmg * 2.4 + (st === 'attack' ? windUp(at) * 3 : 0)
        + (Math.sin(flick * 0.8) * 0.5 + 0.5) * dmg * 1.4;
      mVein.emissiveIntensity = 0.45 + organic * 0.5 + dmg * 2.3;
      mSpark.emissiveIntensity = Math.max(0, dmg - 0.15) * 3.4 * (0.4 + (Math.sin(flick * 2.1) * 0.5 + 0.5) * 0.6);
      mGlass.emissiveIntensity = 0.15 + dmg * 0.9;

      for (i = 0; i < sparks.length; i++) {
        sparks[i].scale.set(1 + dmg * 1.4, 1 + dmg * 1.4, 1 + dmg * 0.6);
      }

      /* --- flesh overgrowth swells as the machine fails --- */
      for (i = 0; i < blobs.length; i++) {
        var B = blobs[i];
        var k = 1 + Math.sin(t * 0.55 + B.ph) * 0.07 + dmg * 0.42;
        B.m.scale.setScalar(B.s * k);
      }
      for (i = 0; i < nodes.length; i++) {
        var N = nodes[i];
        N.m.scale.setScalar(N.s * (1 + organic2 * 0.18 + dmg * 0.7 + pulse * 0.08));
      }
      meat.scale.setScalar(1 + dmg * 0.22);

      /* --- armour panels blow open --- */
      for (i = 0; i < panels.length; i++) {
        var PN = panels[i];
        var openP = Math.max(0, dmg - 0.2 - i * 0.16) * 2.0;
        PN.o.rotation.x = -openP * 1.1 + Math.sin(t * 3 + PN.ph) * 0.02 * openP;
        PN.o.rotation.z = PN.s * openP * 0.25;
      }

      /* --- pose drivers --- */
      var bobY = 0, pitch = 0, roll = 0, crouch = 0, rearUp = 0;
      var headSweep = 0, headTilt = 0, lockOn = 0, tendFling = 0;
      var spawning = (st === 'spawn');
      var wp = walkPhase;
      var gaitAmp = 0, gaitRate = 0;

      if (spawning) {
        var e = ease3(sp);
        body.position.y = -TOTAL_H * (1 - e) * 0.9;
        body.scale.set(1, 1, 1);
        body.rotation.y = (1 - e) * 1.1;
        crouch = (1 - smooth(subT(sp, 0.2, 0.85))) * 0.62;
        var boot = smooth(subT(sp, 0.45, 1.0));
        mLens.emissiveIntensity *= boot;
        mVein.emissiveIntensity *= smooth(subT(sp, 0.55, 1.0));
        headSweep = (1 - boot) * 1.3;
        headTilt = (1 - boot) * 0.7;
        tendFling = (1 - boot) * 0.8;
      } else {
        body.rotation.y = 0;
        body.scale.set(1, 1, 1);
      }

      if (st === 'idle') {
        crouch += 0.1 + Math.sin(t * 0.7) * 0.02;
        headSweep = Math.sin(t * 0.42) * 0.75;
        headTilt = Math.sin(t * 0.31) * 0.14;
        pitch = Math.sin(t * 0.5) * 0.012;
        roll = Math.sin(t * 0.37) * 0.012;
      } else if (st === 'walk') {
        crouch += 0.1;
        gaitAmp = 0.42;
        gaitRate = 1;
        pitch = Math.sin(wp * 2) * 0.035;
        roll = Math.sin(wp) * 0.05;
        headSweep = Math.sin(t * 0.55) * 0.45;
        headTilt = Math.sin(wp * 2) * 0.06;
      } else if (st === 'attack') {
        var wu = windUp(at), sk = strike(at);
        crouch += 0.1 + wu * 0.42 - sk * 0.34;
        rearUp = sk * 0.55;
        pitch = wu * 0.13 - sk * 0.42;
        lockOn = clamp(wu * 1.6, 0, 1);
        headTilt = -wu * 0.3 + sk * 0.45;
        tendFling = -wu * 0.7 + sk * 1.5;
        bobY = wu * 0.06 - sk * 0.05;
      } else if (st === 'hurt') {
        var h = ht * ht;
        crouch += 0.1 + h * 0.2;
        pitch = -h * 0.1;
        roll = h * 0.1 * (((flick | 0) % 2) ? 1 : -1);
        headTilt = -h * 0.35;
        headSweep = h * 0.5;
        tendFling = h * 0.9;
      } else if (st === 'die') {
        var s1 = subT(dq, 0.0, 0.28);
        var s2 = subT(dq, 0.26, 0.64);
        var s3 = subT(dq, 0.58, 1.0);
        /* 1: seize up + rear. 2: legs buckle. 3: hull hits the deck and the flesh sags out. */
        crouch += 0.1 - smooth(s1) * 0.35 + smooth(s2) * 1.15 + s3 * 0.35;
        pitch = smooth(s1) * -0.18 + smooth(s2) * 0.34 + s3 * 0.12;
        roll = smooth(s2) * 0.22 + Math.sin(dq * 20) * 0.04 * (1 - s3);
        headTilt = smooth(s1) * -0.5 + smooth(s2) * 1.2;
        headSweep = Math.sin(dq * 16) * 0.8 * (1 - s2);
        tendFling = smooth(s1) * -0.6 + smooth(s2) * 1.3;
        mLens.emissiveIntensity = (1.8 + s1 * 4) * (1 - smooth(s2)) + 0.03;
        mSpark.emissiveIntensity = (1.5 + s1 * 4) * (1 - s3);
        mVein.emissiveIntensity = (1.2 + s1 * 2.5) * (1 - s3 * 0.7);
        bobY = -s3 * 0.25;
      }

      /* --- crisp four-beat machine gait --- */
      var limp = Math.max(0, dmg - 0.45) * 1.6;
      for (i = 0; i < 4; i++) {
        var LG = legs[i];
        var ph = wp + LG.ph * TAU;
        var s = Math.sin(ph);
        var lift = s > 0 ? Math.pow(s, 2.2) : 0;
        var amp = gaitAmp * (i === 3 ? (1 - limp * 0.55) : 1);
        var swing = -Math.cos(ph) * amp * 0.55;
        LG.hip.rotation.x = swing - crouch * 0.55 + rearUp * (LG.root.position.z > 0 ? -0.9 : 0.25);
        LG.hip.rotation.z = LG.sx * (0.08 + crouch * 0.12);
        LG.knee.rotation.x = crouch * 1.05 + lift * amp * 1.35 + (i === 3 ? limp * 0.25 : 0);
        LG.ankle.rotation.x = -(LG.hip.rotation.x + LG.knee.rotation.x) * 0.85;
        /* telescoping piston follows the knee */
        LG.rod.position.y = -LG.thigh * 0.42 - LG.knee.rotation.x * LG.thigh * 0.34;
      }

      var lift2 = groundLegs();
      if (spawning) {
        body.position.y = -TOTAL_H * (1 - ease3(sp)) * 0.9 + lift2;
      } else {
        body.position.y = lift2 + bobY
          + Math.abs(Math.sin(roll)) * hullHW * 1.2
          + Math.abs(Math.sin(pitch)) * hullHD * 1.2;
      }
      body.rotation.x = pitch;
      body.rotation.z = roll;

      /* --- neck + sensor head --- */
      for (i = 0; i < neck.joints.length; i++) {
        var nf = (i + 1) / neck.joints.length;
        neck.joints[i].rotation.x = -0.12 + headTilt * 0.3 * nf - pitch * 0.5;
        neck.joints[i].rotation.y = headSweep * 0.22 * nf * (1 - lockOn);
        neck.joints[i].rotation.z = Math.sin(t * 0.8 + i) * 0.012;
      }
      headYaw.rotation.y = headSweep * (1 - lockOn) * 0.55;
      headPitch.rotation.x = headTilt + 0.05;
      lens.scale.setScalar(1 + (st === 'attack' ? windUp(at) * 0.35 : 0) + pulse * 0.05 * dmg);
      lensRing.rotation.z = t * (0.6 + dmg * 2.2);
      for (i = 0; i < antennae.length; i++) {
        antennae[i].rotation.x = Math.sin(t * 1.4 + i) * 0.06 * (1 + dmg * 2);
      }
      for (i = 0; i < shards.length; i++) {
        shards[i].rotation.z += dt * 0.0;
        shards[i].position.z = 0.46 + dmg * 0.12;
      }

      /* --- organic tendrils undulate on a slower rhythm than the chassis --- */
      for (i = 0; i < tendrils.length; i++) {
        var T = tendrils[i];
        for (j = 0; j < T.ch.joints.length; j++) {
          T.ch.joints[j].rotation.x = Math.sin(t * (0.45 + j * 0.13) + T.ph + j * 0.8) * T.amp * (1 + dmg * 1.1)
            + tendFling * (0.3 + j * 0.25);
          T.ch.joints[j].rotation.z = Math.cos(t * (0.33 + j * 0.11) + T.ph * 1.3) * T.amp * 0.9;
        }
      }
    }

    return {
      group: group,
      headAnchor: headAnchor,
      materials: kit.mats,
      hitPoints: [hull, headPitch, meat, legs[0].knee, legs[1].knee],
      update: update,
      dispose: disposerFor(kit),
      _meshCount: kit.meshCount
    };
  }

  window.CaveTyper.monsters['warden_prime'] = {
    id: 'warden_prime',
    name: 'WARDEN PRIME',
    tier: 'boss',
    size: { height: 5.5, radius: 3.0 },
    build: buildWardenPrime
  };

}());
