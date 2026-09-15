/* ==========================================================================
 * Containment Breach — GRUNT tier specimens
 * Sub-level 3 containment overflow: the small things that got out first.
 *
 *   lab_rat       — LAB RAT
 *   roach_host    — ROACH HOST
 *   goo_crawler   — GOO CRAWLER
 *   spider_graft  — SPIDER GRAFT
 *   failed_clone  — FAILED CLONE
 *
 * Classic script. three.js r128 only. No addons, no unseeded randomness,
 * no external assets. Every build() makes fresh geometries and materials.
 * ========================================================================== */
(function () {
  'use strict';

  window.ContainmentBreach = window.ContainmentBreach || {};
  window.ContainmentBreach.monsters = window.ContainmentBreach.monsters || {};
  var MONSTERS = window.ContainmentBreach.monsters;

  var PI = Math.PI;
  var TAU = PI * 2;

  /* ---------------------------------------------------------------- math -- */

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
  function smooth(x) { x = clamp01(x); return x * x * (3 - 2 * x); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  /* jittered value: center +/- amount */
  function jit(rng, amount) { return (rng() - 0.5) * 2 * amount; }
  /* uniform in [a,b) */
  function rr(rng, a, b) { return a + rng() * (b - a); }
  /* integer in [a,b] inclusive */
  function ri(rng, a, b) { return a + Math.floor(rng() * (b - a + 1)); }
  /* +1 or -1 */
  function sgn(rng) { return rng() < 0.5 ? -1 : 1; }

  /* seeded colour jitter — the house style from the spec */
  function cj(hex, rng, h, l) {
    return new THREE.Color(hex).offsetHSL(
      (rng() - 0.5) * (h === undefined ? 0.06 : h),
      0,
      (rng() - 0.5) * (l === undefined ? 0.12 : l)
    );
  }

  /* quality -> segment count */
  function qs(quality, lo, hi) {
    if (quality === 'low') return lo;
    if (quality === 'high') return hi;
    return Math.max(lo, Math.round((lo + hi) * 0.5));
  }

  /* --------------------------------------------------------- resources --- */

  function newRes() { return { geos: [], mats: [], dead: false }; }

  function mkMat(R, color, o) {
    o = o || {};
    var m = new THREE.MeshStandardMaterial({
      color: color,
      roughness: o.rough === undefined ? 0.9 : o.rough,
      metalness: o.metal === undefined ? 0.05 : o.metal,
      flatShading: o.flat === false ? false : true,
      emissive: o.emissive === undefined ? 0x000000 : o.emissive,
      emissiveIntensity: o.emissiveIntensity === undefined ? 1 : o.emissiveIntensity,
      transparent: !!o.transparent,
      opacity: o.opacity === undefined ? 1 : o.opacity,
      side: o.side === undefined ? THREE.FrontSide : o.side
    });
    R.mats.push(m);
    return m;
  }

  /* bio-luminescent material. Standard (not Basic) so the engine can flash it. */
  function glowMat(R, color, intensity, o) {
    o = o || {};
    var m = new THREE.MeshStandardMaterial({
      color: o.base === undefined ? color : o.base,
      emissive: color,
      emissiveIntensity: intensity === undefined ? 1.2 : intensity,
      roughness: o.rough === undefined ? 0.45 : o.rough,
      metalness: 0,
      flatShading: !!o.flat,
      transparent: !!o.transparent,
      opacity: o.opacity === undefined ? 1 : o.opacity
    });
    R.mats.push(m);
    return m;
  }

  function pushGeo(R, geo) { R.geos.push(geo); return geo; }

  function mkMesh(R, geo, mat) {
    pushGeo(R, geo);
    return new THREE.Mesh(geo, mat);
  }

  function mSphere(R, mat, r, w, h) {
    return mkMesh(R, new THREE.SphereGeometry(r, w, h), mat);
  }
  function mIco(R, mat, r, d) {
    return mkMesh(R, new THREE.IcosahedronGeometry(r, d || 0), mat);
  }
  function mBox(R, mat, w, h, d) {
    return mkMesh(R, new THREE.BoxGeometry(w, h, d), mat);
  }
  function mCyl(R, mat, rt, rb, h, seg) {
    return mkMesh(R, new THREE.CylinderGeometry(rt, rb, h, seg || 6), mat);
  }
  function mCone(R, mat, r, h, seg) {
    return mkMesh(R, new THREE.ConeGeometry(r, h, seg || 6), mat);
  }
  function mTorus(R, mat, r, tube, rs, ts) {
    return mkMesh(R, new THREE.TorusGeometry(r, tube, rs || 4, ts || 10), mat);
  }

  /* A chain of tapered segments hanging along -Y from its root.
   * segs: [{ len, r0, r1 }]  (r0 = radius at the joint, r1 = radius at the far end)
   * Returns { root, joints[], tip } — rotate joints[i] to animate. */
  function limb(R, mat, segs, radial) {
    var root = new THREE.Object3D();
    var parent = root;
    var joints = [];
    for (var i = 0; i < segs.length; i++) {
      var sg = segs[i];
      var j = new THREE.Object3D();
      parent.add(j);
      joints.push(j);
      var m = mkMesh(R, new THREE.CylinderGeometry(sg.r0, sg.r1, sg.len, radial || 5, 1), mat);
      m.position.y = -sg.len * 0.5;
      j.add(m);
      var nxt = new THREE.Object3D();
      nxt.position.y = -sg.len;
      j.add(nxt);
      parent = nxt;
    }
    return { root: root, joints: joints, tip: parent };
  }

  /* Two-segment sprawling leg solver.
   * Given the joint height H above the floor, an upper-segment length and the two
   * cumulative segment angles (measured from straight-down, about Z), return the
   * lower-segment length that puts the foot exactly on the floor.
   *   joints[0].rotation.z = side * a0        (femur: up and out)
   *   joints[1].rotation.z = side * (a1 - a0) (tibia: back down to the floor)   */
  function solveLo(H, up, a0, a1) {
    return Math.max(0.02, (H - up * Math.cos(a0)) / Math.cos(a1));
  }

  /* Drop the whole rig so its lowest vertex sits exactly on y = 0.
   * Returns the resulting base Y of the body group (the animation baseline). */
  function groundTo(group, body) {
    var box = new THREE.Box3().setFromObject(group);
    if (isFinite(box.min.y)) body.position.y -= box.min.y;
    return body.position.y;
  }

  function disposeRes(R) {
    if (R.dead) return;
    R.dead = true;
    var i;
    for (i = 0; i < R.geos.length; i++) { if (R.geos[i]) R.geos[i].dispose(); }
    for (i = 0; i < R.mats.length; i++) { if (R.mats[i]) R.mats[i].dispose(); }
  }

  /* ------------------------------------------------------------- motion -- */

  /* Telegraphed attack curve: <0.4 wind up (pull back), ~0.55 strike, then recover.
   * Returns -0.6..1.0 : negative = coiled back, positive = extended forward. */
  function atkCurve(a) {
    a = clamp01(a);
    if (a < 0.4) return -0.6 * smooth(a / 0.4);
    if (a < 0.55) return -0.6 + 1.6 * smooth((a - 0.4) / 0.15);
    return 1.0 * (1 - smooth((a - 0.55) / 0.45));
  }

  /* Emergence from the floor. Applied to the inner body group so the engine
   * keeps full ownership of group.position / group.scale. */
  function applySpawn(body, spawnT, depth, baseY) {
    var e = smooth(clamp01(spawnT));
    body.scale.multiplyScalar(0.25 + 0.75 * e);
    body.position.y = baseY - depth * (1 - e);
    return e;
  }

  /* Locomotion phase bookkeeping shared by every grunt. */
  function stepPhase(S, dt, ctx, base, perSpeed) {
    var mult;
    switch (ctx.state) {
      case 'walk': mult = 1; break;
      case 'attack': mult = 0.55; break;
      case 'idle': mult = 0.18; break;
      case 'die': mult = 0.0; break;
      default: mult = 0.3;
    }
    S.ph += dt * (base + ctx.moveSpeed * perSpeed) * mult;
    if (S.ph > 1e6) S.ph -= 1e6;
    return ctx.state === 'walk' ? 1 : (ctx.state === 'idle' ? 0.12 : 0.3);
  }

  /* =======================================================================
   * 1. LAB RAT — subject batch R-, dog sized, far too many legs.
   * ===================================================================== */

  function buildLabRat(opts) {
    var rng = opts.rng, P = opts.palette, Q = opts.quality;
    var R = newRes();
    var SW = qs(Q, 7, 12), SH = qs(Q, 5, 9), LR = qs(Q, 4, 6);
    var s = 1 + jit(rng, 0.12);

    var mFlesh = mkMat(R, cj(P.flesh, rng), { rough: 0.94 });
    var mDark = mkMat(R, cj(P.flesh2, rng), { rough: 0.96 });
    var mTumor = mkMat(R, cj(P.accent, rng), { rough: 0.6, emissive: P.glow, emissiveIntensity: 0.18 });
    var mMetal = mkMat(R, cj(P.metal, rng, 0.02, 0.08), { rough: 0.3, metal: 0.9, flat: false });
    var mGlow = glowMat(R, P.glow, 2.1);
    var mGlow2 = glowMat(R, P.glow2, 1.5);
    var mTag = mkMat(R, cj(0xffb020, rng, 0.05, 0.1), { rough: 0.5, flat: false });
    var mBone = mkMat(R, cj(P.bone, rng), { rough: 0.72 });

    var group = new THREE.Group();
    var body = new THREE.Group();
    group.add(body);

    var torso = new THREE.Group();
    torso.position.y = 0.34 * s;
    body.add(torso);

    /* bloated barrel body ------------------------------------------------ */
    var bodyR = 0.23 * s;
    var trunk = mSphere(R, mFlesh, bodyR, SW, SH);
    trunk.scale.set(1.0, 0.86, 1.65 + jit(rng, 0.15));
    torso.add(trunk);

    /* tumours — asymmetric lumps pushed through the hide */
    var nTum = ri(rng, 2, 3);
    for (var ti = 0; ti < nTum; ti++) {
      var ta = rng() * TAU, tz = rr(rng, -0.3, 0.22) * s;
      var tr = rr(rng, 0.055, 0.115) * s;
      var tum = mIco(R, ti % 2 === 0 ? mTumor : mFlesh, tr, 0);
      tum.position.set(Math.cos(ta) * bodyR * 0.85, Math.abs(Math.sin(ta)) * bodyR * 0.62, tz);
      tum.scale.set(1, rr(rng, 0.7, 1.1), 1);
      torso.add(tum);
    }

    /* head --------------------------------------------------------------- */
    var headG = new THREE.Group();
    headG.position.set(0, 0.02 * s, (0.33 + jit(rng, 0.03)) * s);
    torso.add(headG);

    var skull = mSphere(R, mFlesh, 0.15 * s, SW, SH);
    skull.scale.set(0.92, 0.9, 1.15);
    headG.add(skull);

    var snout = mCone(R, mDark, 0.085 * s, 0.22 * s, LR + 1);
    snout.rotation.x = PI * 0.5;
    snout.position.set(0, -0.035 * s, 0.17 * s);
    headG.add(snout);

    var nose = mIco(R, mTumor, 0.026 * s, 0);
    nose.position.set(0, -0.035 * s, 0.275 * s);
    headG.add(nose);

    /* ears — ragged, one notched */
    for (var e = 0; e < 2; e++) {
      var side = e === 0 ? -1 : 1;
      var ear = mCyl(R, mDark, 0.075 * s, 0.045 * s, 0.02 * s, LR + 2);
      ear.position.set(side * 0.105 * s, 0.11 * s, -0.02 * s);
      ear.rotation.set(rr(rng, -0.25, 0.1), 0, side * rr(rng, 0.35, 0.7));
      headG.add(ear);
      if (e === 1) {
        /* plastic specimen ear tag + its printed number block */
        var tag = mBox(R, mTag, 0.075 * s, 0.055 * s, 0.012 * s);
        tag.position.set(side * 0.155 * s, 0.075 * s, 0.0);
        tag.rotation.z = side * 0.4;
        headG.add(tag);
        var num = mBox(R, mDark, 0.042 * s, 0.016 * s, 0.006 * s);
        num.position.set(side * 0.162 * s, 0.075 * s, 0.01 * s);
        num.rotation.z = side * 0.4;
        headG.add(num);
      }
    }

    /* glowing eyes */
    var eyes = [];
    for (var ey = 0; ey < 2; ey++) {
      var es = ey === 0 ? -1 : 1;
      var eye = mIco(R, rng() < 0.3 ? mGlow2 : mGlow, rr(rng, 0.024, 0.034) * s, 0);
      eye.position.set(es * 0.075 * s, 0.03 * s, 0.105 * s);
      headG.add(eye);
      eyes.push(eye);
    }

    /* shaved patch + electrode plug + stub antenna ----------------------- */
    var patch = mCyl(R, mDark, 0.085 * s, 0.085 * s, 0.012 * s, LR + 3);
    patch.position.set(0.02 * s, 0.125 * s, -0.01 * s);
    patch.rotation.x = -0.12;
    headG.add(patch);

    var plug = mCyl(R, mMetal, 0.042 * s, 0.05 * s, 0.07 * s, LR + 2);
    plug.position.set(0.02 * s, 0.165 * s, -0.01 * s);
    headG.add(plug);

    var antG = new THREE.Object3D();
    antG.position.set(0.02 * s, 0.2 * s, -0.01 * s);
    headG.add(antG);
    var antLen = rr(rng, 0.2, 0.32) * s;
    var ant = mCyl(R, mMetal, 0.008 * s, 0.014 * s, antLen, 4);
    ant.position.y = antLen * 0.5;
    antG.add(ant);
    var antTip = mIco(R, mGlow2, 0.028 * s, 0);
    antTip.position.y = antLen;
    antG.add(antTip);

    /* legs — 5 to 7, split asymmetrically left/right -------------------- */
    var nLeg = ri(rng, 5, 7);
    var nRight = clamp(ri(rng, 2, 4), 2, nLeg - 2);
    var nLeft = nLeg - nRight;
    var legs = [];

    function addLegs(count, side) {
      for (var i = 0; i < count; i++) {
        var f = count === 1 ? 0.5 : i / (count - 1);
        var zz = lerp(0.27, -0.3, f) * s + jit(rng, 0.03) * s;
        var upper = rr(rng, 0.13, 0.18) * s;
        var lower = rr(rng, 0.11, 0.16) * s;
        var L = limb(R, i % 2 === 0 ? mFlesh : mDark, [
          { len: upper, r0: 0.036 * s, r1: 0.028 * s },
          { len: lower, r0: 0.026 * s, r1: 0.016 * s }
        ], LR);
        L.root.position.set(side * 0.16 * s, -0.11 * s, zz);
        var splay = side * rr(rng, 0.3, 0.55);
        L.joints[0].rotation.z = splay;
        L.joints[1].rotation.z = -splay * 0.45;
        /* every other leg keeps a proper foot; the rest end in bare claws */
        if (i % 2 === 0) {
          var foot = mIco(R, mBone, 0.035 * s, 0);
          foot.scale.set(1, 0.55, 1.3);
          foot.position.set(0, 0.012 * s, 0.018 * s);
          L.tip.add(foot);
        }
        torso.add(L.root);
        legs.push({
          L: L,
          rest: rr(rng, -0.12, 0.12),
          splay: splay,
          off: rng() * TAU,
          side: side
        });
      }
    }
    addLegs(nLeft, -1);
    addLegs(nRight, 1);

    /* hairless whip tail ------------------------------------------------- */
    var tailSegs = [];
    var tSegN = qs(Q, 3, 4);
    var tLen = rr(rng, 0.1, 0.135) * s;
    for (var tt = 0; tt < tSegN; tt++) {
      tailSegs.push({
        len: tLen * (1 - tt * 0.12),
        r0: (0.038 - tt * 0.008) * s,
        r1: (0.03 - tt * 0.008) * s
      });
    }
    var tail = limb(R, mDark, tailSegs, 4);
    tail.root.position.set(0, 0.03 * s, -0.3 * s);
    tail.root.rotation.x = 1.42;
    torso.add(tail.root);

    var headAnchor = new THREE.Object3D();
    headAnchor.position.set(0, 0.62 * s, 0.1 * s);
    torso.add(headAnchor);

    var baseY = groundTo(group, body);
    var hits = [trunk, headG, tail.joints[1] || tail.joints[0]];

    var S = { ph: rng() * TAU, tw: rng() * TAU };

    return {
      group: group,
      headAnchor: headAnchor,
      materials: R.mats,
      hitPoints: hits,
      update: function (dt, ctx) {
        var t = ctx.time, st = ctx.state;
        var w = stepPhase(S, dt, ctx, 5.5, 3.4);
        S.tw += dt * (2.2 + (1 - ctx.hpFrac) * 3.0);

        /* reset animated channels */
        body.position.set(0, baseY, 0);
        body.rotation.set(0, 0, 0);
        body.scale.set(1, 1, 1);
        torso.rotation.set(0, 0, 0);
        headG.rotation.set(0, 0, 0);
        headG.position.z = (0.33) * s;

        /* breathing — the bloated flank works in and out */
        var br = Math.sin(t * 3.2) * 0.035 + Math.sin(t * 7.1) * 0.008;
        trunk.scale.y = 0.86 * (1 + br);
        trunk.scale.x = 1.0 * (1 - br * 0.6);

        /* scuttle: fast low leg cycle, body sway, shoulder roll */
        var i, lg, p, sw;
        for (i = 0; i < legs.length; i++) {
          lg = legs[i];
          p = S.ph + lg.off;
          sw = Math.sin(p);
          lg.L.joints[0].rotation.x = lg.rest + sw * 0.62 * w;
          lg.L.joints[1].rotation.x = 0.45 + Math.max(0, -Math.cos(p)) * 0.8 * w;
          lg.L.joints[0].rotation.z = lg.splay * (1 + Math.max(0, sw) * 0.25 * w);
        }
        body.position.y = baseY + Math.abs(Math.sin(S.ph * 2)) * 0.028 * s * w;
        body.rotation.z = Math.sin(S.ph) * 0.09 * w;
        torso.rotation.y = Math.sin(S.ph * 0.5) * 0.11 * w;
        torso.rotation.x = -0.05 * w + Math.sin(S.ph * 2) * 0.03 * w;

        /* tail lash — always alive, faster while moving */
        for (i = 0; i < tail.joints.length; i++) {
          var tp = S.tw * 1.6 - i * 0.8;
          tail.joints[i].rotation.z = Math.sin(tp) * (0.34 + 0.2 * w) * (1 + i * 0.25);
          tail.joints[i].rotation.x = (i === 0 ? -0.12 : 0.07) + Math.cos(tp * 0.7) * 0.1;
        }

        /* antenna + head twitch */
        antG.rotation.z = Math.sin(S.tw * 2.4) * 0.16;
        antG.rotation.x = Math.cos(S.tw * 1.7) * 0.12;
        headG.rotation.y = Math.sin(S.tw * 0.9) * 0.14;
        headG.rotation.x = Math.sin(t * 5.3) * 0.05;
        mGlow.emissiveIntensity = 2.1 + Math.sin(t * 6.0) * 0.35;

        if (st === 'attack') {
          var c = atkCurve(ctx.attackT);
          torso.rotation.x += c * 0.3;
          body.position.z = c * 0.34 * s;
          body.position.y += Math.max(0, c) * 0.07 * s;
          headG.rotation.x += -c * 0.45;
          headG.position.z = (0.33 + Math.max(0, c) * 0.1) * s;
          snout.rotation.x = PI * 0.5 + Math.max(0, c) * 0.25;
        } else {
          snout.rotation.x = PI * 0.5;
        }

        if (st === 'spawn') {
          applySpawn(body, ctx.spawnT, 0.7 * s, baseY);
          torso.rotation.x += (1 - smooth(ctx.spawnT)) * 0.5;
        }

        if (ctx.hurtT > 0 && st !== 'die') {
          var h = clamp01(ctx.hurtT);
          body.position.z -= h * 0.15 * s;
          body.position.x += Math.sin(t * 62) * h * 0.03 * s;
          torso.rotation.x -= h * 0.28;
        }

        if (st === 'die') {
          var d = smooth(ctx.dieT);
          body.rotation.z = d * 1.35;
          body.rotation.x = d * 0.3;
          body.position.y = baseY - d * 0.3 * s;
          body.scale.set(1 + d * 0.1, 1 - d * 0.35, 1);
          for (i = 0; i < legs.length; i++) {
            legs[i].L.joints[0].rotation.x = lerp(legs[i].L.joints[0].rotation.x, 1.5, d);
            legs[i].L.joints[1].rotation.x = lerp(legs[i].L.joints[1].rotation.x, 1.9, d);
          }
          for (i = 0; i < tail.joints.length; i++) {
            tail.joints[i].rotation.z *= (1 - d);
          }
          mGlow.emissiveIntensity = 2.1 * (1 - d);
          mGlow2.emissiveIntensity = 1.5 * (1 - d);
        } else {
          mGlow2.emissiveIntensity = 1.5 + Math.sin(t * 3.3) * 0.4;
        }
      },
      dispose: function () { disposeRes(R); }
    };
  }

  MONSTERS['lab_rat'] = {
    id: 'lab_rat',
    name: 'LAB RAT',
    tier: 'grunt',
    size: { height: 0.95, radius: 0.65 },
    build: buildLabRat
  };

  /* =======================================================================
   * 2. ROACH HOST — carapace forced open by the thing growing in it.
   * ===================================================================== */

  function buildRoachHost(opts) {
    var rng = opts.rng, P = opts.palette, Q = opts.quality;
    var R = newRes();
    var SW = qs(Q, 7, 12), SH = qs(Q, 5, 9), LR = qs(Q, 4, 6);
    var s = 1 + jit(rng, 0.12);

    var chitC = cj(P.flesh2, rng, 0.05, 0.14);
    var mChit = mkMat(R, chitC, { rough: 0.45, metal: 0.25 });
    var mChit2 = mkMat(R, cj(P.flesh, rng, 0.05, 0.16), { rough: 0.55, metal: 0.15 });
    var mSoft = mkMat(R, cj(P.accent, rng), { rough: 0.8 });
    var mSac = glowMat(R, P.glow, 1.6, { base: cj(P.goo, rng, 0.05, 0.1), transparent: true, opacity: 0.88, flat: true });
    var mEgg = glowMat(R, P.glow2, 1.9, { flat: true });
    var mEye = glowMat(R, P.glow2, 2.2);
    var mMetal = mkMat(R, cj(P.metal, rng, 0.02, 0.08), { rough: 0.35, metal: 0.85, flat: false });

    var group = new THREE.Group();
    var body = new THREE.Group();
    group.add(body);

    var torso = new THREE.Group();
    var torsoY = rr(rng, 0.40, 0.45) * s;
    torso.position.y = torsoY;
    body.add(torso);

    /* flat armoured abdomen ---------------------------------------------- */
    var abR = 0.24 * s;
    var abdomen = mSphere(R, mChit, abR, SW, SH);
    abdomen.scale.set(1.05, 0.52, 1.45);
    abdomen.position.z = -0.05 * s;
    torso.add(abdomen);

    var plate = mSphere(R, mChit2, abR * 0.82, SW, SH);
    plate.scale.set(1.0, 0.42, 0.85);
    plate.position.set(0, 0.035 * s, 0.14 * s);
    torso.add(plate);

    /* split carapace: two shell halves levered open by the sac ----------- */
    var openA = rr(rng, 0.5, 0.95);
    var shells = [];
    for (var sh = 0; sh < 2; sh++) {
      var sd = sh === 0 ? -1 : 1;
      var piv = new THREE.Object3D();
      piv.position.set(0, 0.07 * s, -0.06 * s);
      torso.add(piv);
      var shell = mSphere(R, mChit, abR * 0.98, SW, Math.max(4, SH - 1));
      shell.scale.set(0.55, 0.4, 1.35);
      shell.position.set(sd * 0.11 * s, 0, 0);
      piv.add(shell);
      piv.rotation.z = sd * openA;
      shells.push({ piv: piv, sd: sd, open: openA + jit(rng, 0.12) });
    }

    /* the egg sac bursting out of the seam ------------------------------- */
    var sacG = new THREE.Group();
    var sacY = 0.17 * s;
    sacG.position.set(jit(rng, 0.02) * s, sacY, -0.05 * s);
    torso.add(sacG);
    var sacR = rr(rng, 0.18, 0.21) * s;
    var sac = mIco(R, mSac, sacR, qs(Q, 0, 1));
    sac.scale.set(1.0, 0.95, 1.2);
    sacG.add(sac);

    var eggs = [];
    var nEgg = ri(rng, 2, 4);
    for (var eg = 0; eg < nEgg; eg++) {
      var ea = rng() * TAU;
      var eb = mIco(R, mEgg, rr(rng, 0.04, 0.07) * s, 0);
      eb.position.set(
        Math.cos(ea) * sacR * 0.8,
        rr(rng, 0.1, 0.85) * sacR,
        Math.sin(ea) * sacR * 0.85
      );
      sacG.add(eb);
      eggs.push({ m: eb, off: rng() * TAU, base: eb.scale.x });
    }

    /* a containment staple still clamped through the shell */
    var staple = mBox(R, mMetal, 0.13 * s, 0.018 * s, 0.03 * s);
    staple.position.set(jit(rng, 0.06) * s, 0.05 * s, 0.24 * s);
    staple.rotation.z = jit(rng, 0.3);
    torso.add(staple);

    /* head --------------------------------------------------------------- */
    var headG = new THREE.Group();
    headG.position.set(0, -0.01 * s, 0.31 * s);
    torso.add(headG);
    var head = mSphere(R, mChit2, 0.1 * s, SW, Math.max(4, SH - 1));
    head.scale.set(1.15, 0.7, 0.95);
    headG.add(head);

    var eyes = [];
    for (var ei = 0; ei < 2; ei++) {
      var es = ei === 0 ? -1 : 1;
      var eye = mIco(R, mEye, rr(rng, 0.02, 0.03) * s, 0);
      eye.position.set(es * 0.065 * s, 0.025 * s, 0.05 * s);
      headG.add(eye);
      eyes.push(eye);
    }

    /* mandibles */
    var mands = [];
    for (var mi = 0; mi < 2; mi++) {
      var ms = mi === 0 ? -1 : 1;
      var mand = mCone(R, mChit, 0.025 * s, 0.11 * s, 4);
      mand.position.set(ms * 0.045 * s, -0.045 * s, 0.09 * s);
      mand.rotation.set(PI * 0.52, 0, ms * 0.45);
      headG.add(mand);
      mands.push({ m: mand, s: ms });
    }

    /* antennae */
    var ants = [];
    for (var ai = 0; ai < 2; ai++) {
      var as = ai === 0 ? -1 : 1;
      var A = limb(R, mChit, [
        { len: rr(rng, 0.13, 0.19) * s, r0: 0.013 * s, r1: 0.009 * s },
        { len: rr(rng, 0.11, 0.17) * s, r0: 0.008 * s, r1: 0.004 * s }
      ], 4);
      A.root.position.set(as * 0.05 * s, 0.05 * s, 0.07 * s);
      A.joints[0].rotation.set(-2.25, 0, as * 0.5);
      A.joints[1].rotation.set(0.5, 0, as * 0.4);
      headG.add(A.root);
      ants.push({ A: A, s: as, off: rng() * TAU });
    }

    /* six scrabbling legs, alternating tripod --------------------------- */
    var legs = [];
    for (var li = 0; li < 6; li++) {
      var side = li < 3 ? -1 : 1;
      var idx = li % 3;
      var zz = [0.2, 0.0, -0.2][idx] * s + jit(rng, 0.02) * s;
      var rootY = -0.02 * s;
      var up = rr(rng, 0.13, 0.18) * s;
      var lift = rr(rng, 1.85, 2.1);                       /* femur: up and out */
      var a1 = rr(rng, 0.26, 0.48);                         /* tibia angle */
      var lo = solveLo(torsoY + rootY, up, lift, a1);       /* lands on the floor */
      var L = limb(R, mChit, [
        { len: up, r0: 0.024 * s, r1: 0.016 * s },
        { len: lo, r0: 0.014 * s, r1: 0.007 * s }
      ], 4);
      L.root.position.set(side * 0.17 * s, rootY, zz);
      var drop = a1 - lift;
      L.joints[0].rotation.z = side * lift;
      L.joints[1].rotation.z = side * drop;
      L.joints[0].rotation.x = [-0.35, 0, 0.35][idx];
      torso.add(L.root);
      legs.push({
        L: L, side: side, lift: lift, drop: drop,
        restX: [-0.35, 0, 0.35][idx],
        off: ((side < 0 ? idx : idx + 1) % 2) * PI + jit(rng, 0.18)
      });
    }

    var headAnchor = new THREE.Object3D();
    headAnchor.position.set(0, 0.62 * s, 0.05 * s);
    torso.add(headAnchor);

    var baseY = groundTo(group, body);
    var hits = [abdomen, sacG, headG];
    var S = { ph: rng() * TAU, pulse: rng() * TAU, tw: rng() * TAU };

    return {
      group: group,
      headAnchor: headAnchor,
      materials: R.mats,
      hitPoints: hits,
      update: function (dt, ctx) {
        var t = ctx.time, st = ctx.state, i;
        var w = stepPhase(S, dt, ctx, 8.0, 4.0);
        S.tw += dt * 3.0;

        /* the sac pulses harder and faster as the host is broken down */
        var rage = 1 - clamp01(ctx.hpFrac);
        S.pulse += dt * (3.0 + rage * 8.0);
        var pu = 0.5 + 0.5 * Math.sin(S.pulse);
        var pu2 = pu * pu;

        body.position.set(0, baseY, 0);
        body.rotation.set(0, 0, 0);
        body.scale.set(1, 1, 1);
        torso.rotation.set(0, 0, 0);
        headG.rotation.set(0, 0, 0);

        var br = Math.sin(t * 2.6) * 0.03;
        abdomen.scale.set(1.05 * (1 + br * 0.5), 0.52 * (1 + br), 1.45);

        sacG.scale.setScalar(1 + pu2 * (0.13 + rage * 0.1));
        sacG.position.y = sacY + pu * 0.015 * s;
        mSac.emissiveIntensity = 1.0 + pu2 * (1.4 + rage * 1.6);
        mEgg.emissiveIntensity = 1.2 + (1 - pu) * (1.1 + rage * 1.4);
        for (i = 0; i < eggs.length; i++) {
          var k = 1 + Math.sin(S.pulse * 1.3 + eggs[i].off) * 0.16;
          eggs[i].m.scale.setScalar(k);
        }

        /* the shells are levered wider as the sac swells */
        for (i = 0; i < shells.length; i++) {
          shells[i].piv.rotation.z = shells[i].sd * (shells[i].open + pu2 * 0.22 + rage * 0.25);
          shells[i].piv.rotation.x = Math.sin(S.ph * 0.5 + i) * 0.04 * w;
        }

        /* tripod scrabble */
        for (i = 0; i < legs.length; i++) {
          var lg = legs[i];
          var p = S.ph + lg.off;
          var sw = Math.sin(p);
          lg.L.joints[0].rotation.x = lg.restX + sw * 0.55 * w;
          lg.L.joints[0].rotation.z = lg.side * (lg.lift + Math.max(0, -Math.cos(p)) * 0.3 * w);
          lg.L.joints[1].rotation.z = lg.side * (lg.drop - Math.max(0, -Math.cos(p)) * 0.35 * w);
        }
        body.position.y = baseY + Math.abs(Math.sin(S.ph)) * 0.022 * s * w;
        torso.rotation.z = Math.sin(S.ph) * 0.07 * w;
        torso.rotation.y = Math.sin(S.ph * 0.5) * 0.06 * w;

        /* antennae twitch constantly */
        for (i = 0; i < ants.length; i++) {
          var an = ants[i];
          an.A.joints[0].rotation.x = -2.25 + Math.sin(S.tw * 2.1 + an.off) * 0.25;
          an.A.joints[0].rotation.z = an.s * (0.5 + Math.sin(S.tw * 1.4 + an.off) * 0.3);
          an.A.joints[1].rotation.x = 0.5 + Math.cos(S.tw * 2.6 + an.off) * 0.35;
        }
        headG.rotation.y = Math.sin(S.tw * 0.8) * 0.12;
        for (i = 0; i < mands.length; i++) {
          mands[i].m.rotation.z = mands[i].s * (0.45 + Math.abs(Math.sin(S.tw * 3.2)) * 0.3);
        }

        if (st === 'attack') {
          var c = atkCurve(ctx.attackT);
          body.position.z = c * 0.3 * s;
          torso.rotation.x = -c * 0.35;
          body.position.y += Math.max(0, c) * 0.09 * s;
          headG.rotation.x = -Math.max(0, c) * 0.4;
          for (i = 0; i < mands.length; i++) {
            mands[i].m.rotation.z = mands[i].s * (0.45 + Math.max(0, c) * 0.75);
          }
          for (i = 0; i < shells.length; i++) {
            shells[i].piv.rotation.z += shells[i].sd * Math.max(0, c) * 0.35;
          }
        }

        if (st === 'spawn') {
          applySpawn(body, ctx.spawnT, 0.55 * s, baseY);
          var se = 1 - smooth(ctx.spawnT);
          for (i = 0; i < shells.length; i++) {
            shells[i].piv.rotation.z *= (1 - se * 0.85);
          }
          sacG.scale.multiplyScalar(1 - se * 0.6);
        }

        if (ctx.hurtT > 0 && st !== 'die') {
          var h = clamp01(ctx.hurtT);
          body.position.z -= h * 0.14 * s;
          torso.rotation.x -= h * 0.25;
          body.position.x += Math.sin(t * 70) * h * 0.028 * s;
        }

        if (st === 'die') {
          var d = smooth(ctx.dieT);
          torso.rotation.x = d * 0.9;
          body.position.y = baseY - d * 0.22 * s;
          body.rotation.z = d * 0.5;
          body.scale.set(1 + d * 0.12, 1 - d * 0.4, 1);
          for (i = 0; i < legs.length; i++) {
            legs[i].L.joints[0].rotation.x = lerp(legs[i].L.joints[0].rotation.x, -1.3, d);
            legs[i].L.joints[1].rotation.z = lerp(legs[i].L.joints[1].rotation.z, legs[i].side * -2.6, d);
          }
          /* the sac ruptures and goes dark */
          sacG.scale.setScalar((1 + pu2 * 0.13) * (1 + d * 0.5));
          mSac.emissiveIntensity = (1.0 + pu2 * 2.4) * (1 - d);
          mEgg.emissiveIntensity = 2.0 * (1 - d);
          mEye.emissiveIntensity = 2.2 * (1 - d);
        } else {
          mEye.emissiveIntensity = 2.2 + Math.sin(t * 5.5) * 0.3;
        }
      },
      dispose: function () { disposeRes(R); }
    };
  }

  MONSTERS['roach_host'] = {
    id: 'roach_host',
    name: 'ROACH HOST',
    tier: 'grunt',
    size: { height: 0.8, radius: 0.55 },
    build: buildRoachHost
  };

  /* =======================================================================
   * 3. GOO CRAWLER — tank 4 specimen fluid. It learned to move.
   * ===================================================================== */

  function buildGooCrawler(opts) {
    var rng = opts.rng, P = opts.palette, Q = opts.quality;
    var R = newRes();
    var SW = qs(Q, 8, 13), SH = qs(Q, 6, 10), LR = qs(Q, 5, 7);
    var s = 1 + jit(rng, 0.12);

    var gooC = cj(P.goo, rng, 0.07, 0.14);
    var mGoo = glowMat(R, P.glow, 0.5, {
      base: gooC, transparent: true, opacity: rr(rng, 0.42, 0.58), rough: 0.18, flat: true
    });
    var mSkin = glowMat(R, P.glow, 0.32, {
      base: cj(P.goo, rng, 0.06, 0.2), transparent: true, opacity: 0.3, rough: 0.1, flat: true
    });
    var mCore = glowMat(R, P.glow2, 2.4, { flat: true });
    var mMetal = mkMat(R, cj(P.metal, rng, 0.02, 0.08), { rough: 0.32, metal: 0.9, flat: false });
    var mBone = mkMat(R, cj(P.bone, rng), { rough: 0.75 });
    var mGlass = glowMat(R, P.glow2, 0.45, {
      base: 0xcfe6ee, transparent: true, opacity: 0.6, rough: 0.15, flat: false
    });

    var group = new THREE.Group();
    var body = new THREE.Group();
    group.add(body);

    var blob = new THREE.Group();
    blob.position.y = 0.42 * s;
    body.add(blob);

    /* the dome ----------------------------------------------------------- */
    /* the height is fixed and the width jitters, so the declared size stays honest */
    var domeH = 0.44 * s;
    var domeR = rr(rng, 0.48, 0.56) * s;
    var squash = domeH / domeR;
    var dome = mSphere(R, mGoo, domeR, SW, SH);
    dome.scale.set(1.1, squash, 1.02);
    blob.add(dome);

    /* outer meniscus skin, a hair larger, catches the light */
    var skin = mSphere(R, mSkin, domeR * 1.035, Math.max(6, SW - 2), Math.max(4, SH - 2));
    skin.scale.set(1.1, squash * 0.99, 1.02);
    blob.add(skin);

    /* glowing core, hangs a little low and lags behind the hops */
    var coreG = new THREE.Object3D();
    coreG.position.y = -0.05 * s;
    blob.add(coreG);
    var core = mIco(R, mCore, rr(rng, 0.16, 0.22) * s, qs(Q, 0, 1));
    core.scale.set(1.1, 0.85, 1);
    coreG.add(core);

    /* half dissolved lab debris suspended in the fluid -------------------- */
    var junk = [];
    function suspend(obj3d) {
      var a = rng() * TAU, rad = rr(rng, 0.14, 0.3) * s;
      obj3d.position.set(Math.cos(a) * rad, rr(rng, -0.12, 0.2) * s, Math.sin(a) * rad);
      obj3d.rotation.set(rng() * TAU, rng() * TAU, rng() * TAU);
      blob.add(obj3d);
      junk.push({
        o: obj3d,
        base: obj3d.position.clone(),
        spin: new THREE.Vector3(jit(rng, 0.5), jit(rng, 0.6), jit(rng, 0.5)),
        off: rng() * TAU
      });
    }

    /* 1) lab clamp — two jaws on a post */
    var clampG = new THREE.Object3D();
    var post = mCyl(R, mMetal, 0.016 * s, 0.016 * s, 0.22 * s, 5);
    clampG.add(post);
    var jawA = mBox(R, mMetal, 0.13 * s, 0.022 * s, 0.03 * s);
    jawA.position.set(0.055 * s, 0.07 * s, 0);
    jawA.rotation.z = 0.35;
    clampG.add(jawA);
    var jawB = mBox(R, mMetal, 0.13 * s, 0.022 * s, 0.03 * s);
    jawB.position.set(0.055 * s, -0.02 * s, 0);
    jawB.rotation.z = -0.3;
    clampG.add(jawB);
    suspend(clampG);

    /* 2) bone — shaft with two knuckles, half eaten */
    var boneG = new THREE.Object3D();
    var shaft = mCyl(R, mBone, 0.026 * s, 0.02 * s, 0.26 * s, 5);
    boneG.add(shaft);
    var kn1 = mIco(R, mBone, 0.048 * s, 0);
    kn1.position.y = 0.13 * s;
    kn1.scale.set(1, 0.8, 1);
    boneG.add(kn1);
    var kn2 = mIco(R, mBone, 0.036 * s, 0);
    kn2.position.y = -0.13 * s;
    boneG.add(kn2);
    suspend(boneG);

    /* 3) syringe — optional third object */
    if (rng() < 0.75) {
      var syrG = new THREE.Object3D();
      var barrel = mCyl(R, mGlass, 0.032 * s, 0.032 * s, 0.17 * s, LR);
      syrG.add(barrel);
      var needle = mCyl(R, mMetal, 0.004 * s, 0.008 * s, 0.11 * s, 4);
      needle.position.y = 0.14 * s;
      syrG.add(needle);
      var plunger = mBox(R, mMetal, 0.055 * s, 0.014 * s, 0.055 * s);
      plunger.position.y = -0.1 * s;
      syrG.add(plunger);
      suspend(syrG);
    }

    /* surface blisters that read as the top of the silhouette */
    var blisters = [];
    var nBl = ri(rng, 2, 3);
    for (var bi = 0; bi < nBl; bi++) {
      var ba = rng() * TAU;
      var bl = mIco(R, mGoo, rr(rng, 0.085, 0.12) * s, 0);
      bl.position.set(
        Math.cos(ba) * domeR * 0.42,
        domeR * squash * rr(rng, 0.52, 0.7),
        Math.sin(ba) * domeR * 0.42
      );
      blob.add(bl);
      blisters.push({ m: bl, off: rng() * TAU, y: bl.position.y });
    }

    /* the trailing smear it drags behind itself */
    var smear = mSphere(R, mSkin, domeR * 0.55, Math.max(6, SW - 3), Math.max(4, SH - 3));
    smear.scale.set(1.05, 0.22, 1.25);
    smear.position.set(0, -domeR * squash * 0.86, -domeR * 0.55);
    blob.add(smear);

    var headAnchor = new THREE.Object3D();
    headAnchor.position.set(0, domeR * squash + 0.34 * s, 0);
    blob.add(headAnchor);

    var baseY = groundTo(group, body);
    var hits = [dome, core];
    var S = { hop: rng(), ph: rng() * TAU, wob: 0 };

    return {
      group: group,
      headAnchor: headAnchor,
      materials: R.mats,
      hitPoints: hits,
      update: function (dt, ctx) {
        var t = ctx.time, st = ctx.state, i;
        var moving = (st === 'walk');
        var rate = moving ? (0.85 + ctx.moveSpeed * 0.42) : (st === 'attack' ? 0.5 : 0.22);
        S.hop += dt * rate;
        if (S.hop > 1e6) S.hop -= 1e6;
        S.ph += dt;

        body.position.set(0, baseY, 0);
        body.rotation.set(0, 0, 0);
        body.scale.set(1, 1, 1);
        blob.rotation.set(0, 0, 0);

        /* squash -> launch -> arc -> land -> wobble */
        var u = S.hop - Math.floor(S.hop);
        var amp = moving ? 1 : 0.22;
        var hop = 0, sy = 1, sxz = 1;

        if (u < 0.25) {                       /* compress */
          var k = smooth(u / 0.25);
          sy = 1 - 0.3 * k * amp;
          sxz = 1 + 0.2 * k * amp;
        } else if (u < 0.86) {                /* airborne arc */
          var k2 = (u - 0.25) / 0.61;
          hop = Math.sin(PI * k2) * 0.42 * s * amp;
          var stretch = Math.sin(PI * k2 * 0.9);
          sy = 1 + 0.26 * stretch * amp;
          sxz = 1 - 0.16 * stretch * amp;
        } else {                              /* landing squash */
          var k3 = (u - 0.86) / 0.14;
          var imp = Math.sin(PI * k3);
          sy = 1 - 0.34 * imp * amp;
          sxz = 1 + 0.24 * imp * amp;
        }

        /* jelly wobble on top of everything */
        var jw = Math.sin(t * 13.0) * 0.035 + Math.sin(t * 7.3) * 0.02;
        var breathe = Math.sin(t * 2.4) * 0.03;
        sy += jw + breathe;
        sxz -= (jw + breathe) * 0.5;

        body.position.y = baseY + hop;
        dome.scale.set(1.1 * sxz, squash * sy, 1.02 * sxz);
        skin.scale.set(1.1 * sxz * 1.035, squash * sy * 1.03, 1.02 * sxz * 1.035);
        blob.rotation.z = Math.sin(t * 1.7) * 0.05;
        blob.rotation.x = -hop * 0.25;

        /* the core sloshes opposite to the motion */
        coreG.position.y = -0.05 * s - hop * 0.22 + Math.sin(t * 3.1) * 0.02 * s;
        coreG.position.z = -hop * 0.12 + Math.sin(t * 1.9) * 0.02 * s;
        coreG.position.x = Math.sin(t * 2.3) * 0.02 * s;
        core.scale.set(1.1 / (sy * 0.9), 0.85 * sy, 1 / (sxz * 0.95));
        mCore.emissiveIntensity = 2.0 + Math.sin(t * 4.2) * 0.5 + (1 - ctx.hpFrac) * 0.8;

        /* debris drifts and tumbles inside the fluid */
        for (i = 0; i < junk.length; i++) {
          var jk = junk[i];
          jk.o.rotation.x += jk.spin.x * dt;
          jk.o.rotation.y += jk.spin.y * dt;
          jk.o.rotation.z += jk.spin.z * dt;
          jk.o.position.set(
            jk.base.x + Math.sin(t * 1.3 + jk.off) * 0.035 * s,
            jk.base.y + Math.cos(t * 1.1 + jk.off) * 0.04 * s - hop * 0.14,
            jk.base.z + Math.sin(t * 0.9 + jk.off * 1.7) * 0.035 * s
          );
        }

        for (i = 0; i < blisters.length; i++) {
          var bs = blisters[i];
          bs.m.position.y = bs.y * sy + Math.sin(t * 5.0 + bs.off) * 0.012 * s;
          bs.m.scale.setScalar(1 + Math.sin(t * 4.0 + bs.off) * 0.14);
        }
        smear.scale.set(1.05 * sxz, 0.22 * (2 - sy), 1.25 * sxz);

        if (st === 'attack') {
          var c = atkCurve(ctx.attackT);
          body.position.z = c * 0.4 * s;
          body.position.y = baseY + Math.max(0, c) * 0.3 * s;
          /* coil down then throw itself forward */
          var cs = 1 + c * 0.35;
          dome.scale.set(1.1 / cs, squash * cs, 1.02 / cs);
          skin.scale.set(1.1 / cs * 1.035, squash * cs * 1.03, 1.02 / cs * 1.035);
          blob.rotation.x = -c * 0.35;
          mCore.emissiveIntensity += Math.max(0, c) * 1.8;
        }

        if (st === 'spawn') {
          /* seeps up through the floor as a puddle then bulges into a dome */
          var e = smooth(clamp01(ctx.spawnT));
          body.position.y = baseY - (1 - e) * 0.45 * s;
          blob.scale.set(1 + (1 - e) * 0.8, e * e, 1 + (1 - e) * 0.8);
        } else {
          blob.scale.set(1, 1, 1);
        }

        if (ctx.hurtT > 0 && st !== 'die') {
          var h = clamp01(ctx.hurtT);
          body.position.z -= h * 0.16 * s;
          var rip = 1 + Math.sin(t * 55) * h * 0.18;
          dome.scale.y *= rip;
          dome.scale.x /= rip;
          skin.scale.y *= rip;
          mCore.emissiveIntensity += h * 1.2;
        }

        if (st === 'die') {
          /* loses cohesion and spreads out into a puddle */
          var d = smooth(ctx.dieT);
          body.position.y = baseY - d * 0.18 * s;
          blob.scale.set(1 + d * 0.85, 1 - d * 0.88, 1 + d * 0.85);
          blob.rotation.x = 0;
          mCore.emissiveIntensity = 2.4 * (1 - d);
          mGoo.emissiveIntensity = 0.5 * (1 - d);
          mSkin.emissiveIntensity = 0.32 * (1 - d);
          for (i = 0; i < junk.length; i++) {
            junk[i].o.position.y = junk[i].base.y * (1 - d) - d * 0.22 * s;
          }
        }
      },
      dispose: function () { disposeRes(R); }
    };
  }

  MONSTERS['goo_crawler'] = {
    id: 'goo_crawler',
    name: 'GOO CRAWLER',
    tier: 'grunt',
    size: { height: 0.88, radius: 0.7 },
    build: buildGooCrawler
  };

  /* =======================================================================
   * 4. SPIDER GRAFT — arachnid / prosthetic hybrid, four legs replaced.
   * ===================================================================== */

  function buildSpiderGraft(opts) {
    var rng = opts.rng, P = opts.palette, Q = opts.quality;
    var R = newRes();
    var SW = qs(Q, 7, 12), SH = qs(Q, 5, 9), LR = qs(Q, 4, 6);
    var s = 1 + jit(rng, 0.12);

    var mFlesh = mkMat(R, cj(P.flesh2, rng, 0.05, 0.16), { rough: 0.8 });
    var mFlesh2 = mkMat(R, cj(P.flesh, rng, 0.05, 0.16), { rough: 0.85 });
    var mMetal = mkMat(R, cj(P.metal, rng, 0.02, 0.1), { rough: 0.28, metal: 0.92, flat: false });
    var mGlass = glowMat(R, P.glow2, 0.35, {
      base: 0xd4e8ef, transparent: true, opacity: 0.45, rough: 0.12, flat: false
    });
    var mViscera = glowMat(R, P.glow, 2.0, { base: cj(P.accent, rng), flat: true });
    var mEye = glowMat(R, rng() < 0.4 ? P.glow2 : P.glow, 2.4);
    var mBone = mkMat(R, cj(P.bone, rng), { rough: 0.7 });

    var group = new THREE.Group();
    var body = new THREE.Group();
    group.add(body);

    var torso = new THREE.Group();
    var torsoY = rr(rng, 0.38, 0.44) * s;
    torso.position.y = torsoY;
    body.add(torso);

    /* cephalothorax + bulbous abdomen ------------------------------------ */
    var ceph = mSphere(R, mFlesh, 0.15 * s, SW, SH);
    ceph.scale.set(1.15, 0.72, 1.2);
    ceph.position.z = 0.14 * s;
    torso.add(ceph);

    var abG = new THREE.Group();
    abG.position.set(0, 0.02 * s, -0.22 * s);
    torso.add(abG);
    var abR = rr(rng, 0.2, 0.26) * s;
    var abdomen = mSphere(R, mFlesh2, abR, SW, SH);
    abdomen.scale.set(1.0, 0.94, 1.15);
    abG.add(abdomen);

    /* observation window: cracked glass over glowing viscera */
    var viscera = mIco(R, mViscera, abR * 0.62, qs(Q, 0, 1));
    viscera.position.set(0, 0.02 * s, abR * 0.35);
    viscera.scale.set(1, 0.85, 0.7);
    abG.add(viscera);

    var winFrame = mCyl(R, mMetal, abR * 0.68, abR * 0.68, 0.025 * s, qs(Q, 6, 10));
    winFrame.rotation.x = PI * 0.5;
    winFrame.position.set(0, 0.02 * s, abR * 0.82);
    abG.add(winFrame);

    var glass = mSphere(R, mGlass, abR * 0.66, Math.max(6, SW - 2), Math.max(4, SH - 3));
    glass.scale.set(1, 0.9, 0.42);
    glass.position.set(0, 0.02 * s, abR * 0.86);
    abG.add(glass);

    /* the crack — a couple of thin dark slivers across the pane */
    var nCrack = ri(rng, 1, 2);
    for (var ck = 0; ck < nCrack; ck++) {
      var crk = mBox(R, mMetal, abR * rr(rng, 0.7, 1.15), 0.012 * s, 0.01 * s);
      crk.position.set(jit(rng, 0.05) * s, 0.02 * s + jit(rng, 0.06) * s, abR * 0.94);
      crk.rotation.z = jit(rng, 1.2);
      abG.add(crk);
    }

    /* spinneret / drip nub */
    var spin = mCone(R, mFlesh, 0.05 * s, 0.1 * s, 5);
    spin.rotation.x = -PI * 0.5;
    spin.position.set(0, -0.04 * s, -abR * 0.95);
    abG.add(spin);

    /* eye cluster -------------------------------------------------------- */
    var headG = new THREE.Group();
    headG.position.set(0, 0.02 * s, 0.26 * s);
    torso.add(headG);
    var face = mSphere(R, mFlesh, 0.095 * s, Math.max(6, SW - 2), Math.max(4, SH - 2));
    face.scale.set(1.15, 0.85, 0.85);
    headG.add(face);

    var eyes = [];
    var nEye = ri(rng, 6, 8);
    for (var ei = 0; ei < nEye; ei++) {
      var row = ei < Math.ceil(nEye / 2) ? 0 : 1;
      var inRow = row === 0 ? Math.ceil(nEye / 2) : nEye - Math.ceil(nEye / 2);
      var idx = row === 0 ? ei : ei - Math.ceil(nEye / 2);
      var fx = inRow === 1 ? 0.5 : idx / (inRow - 1);
      var ey = mIco(R, mEye, rr(rng, 0.014, 0.026) * s, 0);
      ey.position.set(
        lerp(-0.075, 0.075, fx) * s + jit(rng, 0.008) * s,
        (row === 0 ? 0.045 : 0.005) * s,
        (row === 0 ? 0.065 : 0.075) * s
      );
      headG.add(ey);
      eyes.push({ m: ey, off: rng() * TAU });
    }

    /* fangs */
    for (var fg = 0; fg < 2; fg++) {
      var fs = fg === 0 ? -1 : 1;
      var fang = mCone(R, mBone, 0.02 * s, 0.09 * s, 4);
      fang.position.set(fs * 0.04 * s, -0.06 * s, 0.06 * s);
      fang.rotation.set(PI * 0.82, 0, fs * 0.25);
      headG.add(fang);
    }

    /* eight legs: four organic, four bolted-on struts -------------------- */
    var legs = [];
    var organicSide = rng() < 0.5 ? -1 : 1; /* which flank kept its own legs */
    for (var li = 0; li < 8; li++) {
      var side = li < 4 ? -1 : 1;
      var idx2 = li % 4;
      var mech = (side === organicSide) ? (idx2 % 2 === 1) : (idx2 % 2 === 0);
      /* guarantee exactly four of each: alternate, flipped per flank */
      var zz = lerp(0.24, -0.26, idx2 / 3) * s + jit(rng, 0.02) * s;
      var rootY = 0.02 * s;
      /* femur rakes steeply up and out — the knee arch is the silhouette */
      var up = rr(rng, 0.44, 0.54) * s * (mech ? 1.05 : 1);
      var lift = rr(rng, 2.48, 2.66);
      var a1 = rr(rng, 0.22, 0.42);
      var lo = solveLo(torsoY + rootY, up, lift, a1);
      var drop = a1 - lift;
      var mat = mech ? mMetal : (idx2 % 2 === 0 ? mFlesh : mFlesh2);
      var L = limb(R, mat, [
        { len: up, r0: (mech ? 0.017 : 0.032) * s, r1: (mech ? 0.013 : 0.022) * s },
        { len: lo, r0: (mech ? 0.012 : 0.02) * s, r1: (mech ? 0.006 : 0.009) * s }
      ], mech ? 4 : LR);
      L.root.position.set(side * 0.11 * s, rootY, zz);
      L.joints[0].rotation.z = side * lift;
      L.joints[1].rotation.z = side * drop;
      L.joints[0].rotation.x = lerp(-0.5, 0.5, idx2 / 3);
      torso.add(L.root);
      legs.push({
        L: L, side: side, lift: lift, drop: drop, mech: mech,
        restX: lerp(-0.5, 0.5, idx2 / 3),
        /* alternating tripod: opposite flanks out of phase */
        off: ((idx2 + (side < 0 ? 0 : 1)) % 2) * PI + jit(rng, 0.15)
      });
    }

    var headAnchor = new THREE.Object3D();
    headAnchor.position.set(0, 0.68 * s, 0.1 * s);
    torso.add(headAnchor);

    var baseY = groundTo(group, body);
    var hits = [abG, headG, ceph];
    var S = { ph: rng() * TAU, tw: rng() * TAU };

    return {
      group: group,
      headAnchor: headAnchor,
      materials: R.mats,
      hitPoints: hits,
      update: function (dt, ctx) {
        var t = ctx.time, st = ctx.state, i;
        var w = stepPhase(S, dt, ctx, 6.2, 3.6);
        S.tw += dt * 2.4;

        body.position.set(0, baseY, 0);
        body.rotation.set(0, 0, 0);
        body.scale.set(1, 1, 1);
        torso.rotation.set(0, 0, 0);
        headG.rotation.set(0, 0, 0);
        abG.rotation.set(0, 0, 0);
        abG.position.set(0, 0.02 * s, -0.22 * s);

        /* abdomen breathes, viscera throbs behind the cracked pane */
        var br = Math.sin(t * 2.3) * 0.04;
        abdomen.scale.set(1 + br * 0.7, 0.94 * (1 + br), 1.15 * (1 - br * 0.4));
        var thr = 0.5 + 0.5 * Math.sin(t * 3.4 + Math.sin(t * 1.7));
        viscera.scale.set(1 + thr * 0.1, 0.85 * (1 + thr * 0.12), 0.7);
        mViscera.emissiveIntensity = 1.4 + thr * 1.3 + (1 - ctx.hpFrac) * 0.8;

        /* alternating tripod gait */
        for (i = 0; i < legs.length; i++) {
          var lg = legs[i];
          var p = S.ph + lg.off;
          var sw = Math.sin(p);
          var lift = Math.max(0, -Math.cos(p));
          lg.L.joints[0].rotation.x = lg.restX + sw * 0.4 * w;
          lg.L.joints[0].rotation.z = lg.side * (lg.lift + lift * 0.26 * w);
          lg.L.joints[1].rotation.z = lg.side * (lg.drop - lift * 0.4 * w);
        }
        body.position.y = baseY + Math.sin(S.ph * 2) * 0.026 * s * w;
        torso.rotation.z = Math.sin(S.ph) * 0.06 * w;
        torso.rotation.x = Math.sin(S.ph * 2 + 0.6) * 0.045 * w;
        torso.rotation.y = Math.sin(S.ph * 0.5) * 0.05 * w;

        /* eyes flicker slightly out of sync */
        mEye.emissiveIntensity = 2.2 + Math.sin(t * 7.0) * 0.4;
        for (i = 0; i < eyes.length; i++) {
          eyes[i].m.scale.setScalar(1 + Math.sin(t * 4.5 + eyes[i].off) * 0.1);
        }
        headG.rotation.y = Math.sin(S.tw * 0.9) * 0.1;
        headG.rotation.x = Math.sin(S.tw * 1.6) * 0.06;

        if (st === 'attack') {
          var c = atkCurve(ctx.attackT);
          /* rear up on the back legs, then stab forward */
          torso.rotation.x = -c * 0.55;
          body.position.z = c * 0.34 * s;
          body.position.y += Math.max(0, -c) * 0.1 * s + Math.max(0, c) * 0.14 * s;
          headG.rotation.x += c * 0.3;
          abG.position.y = 0.02 * s + c * 0.05 * s;
          for (i = 0; i < legs.length; i++) {
            if (legs[i].restX > 0) continue; /* front legs only */
            legs[i].L.joints[0].rotation.x -= c * 0.7;
            legs[i].L.joints[1].rotation.z += legs[i].side * c * 0.5;
          }
          mViscera.emissiveIntensity += Math.max(0, c) * 1.4;
        }

        if (st === 'spawn') {
          /* legs unfold from a tucked ball */
          var e = smooth(clamp01(ctx.spawnT));
          applySpawn(body, ctx.spawnT, 0.5 * s, baseY);
          for (i = 0; i < legs.length; i++) {
            legs[i].L.joints[0].rotation.z = legs[i].side * lerp(2.9, legs[i].lift, e);
            legs[i].L.joints[1].rotation.z = legs[i].side * lerp(-0.4, legs[i].drop, e);
          }
        }

        if (ctx.hurtT > 0 && st !== 'die') {
          var h = clamp01(ctx.hurtT);
          body.position.z -= h * 0.15 * s;
          body.position.y += h * 0.04 * s;
          torso.rotation.x += h * 0.3;
          body.position.x += Math.sin(t * 66) * h * 0.03 * s;
          for (i = 0; i < legs.length; i++) {
            legs[i].L.joints[0].rotation.z += legs[i].side * h * 0.25;
          }
        }

        if (st === 'die') {
          /* legs curl inward over the body, it drops flat */
          var d = smooth(ctx.dieT);
          for (i = 0; i < legs.length; i++) {
            legs[i].L.joints[0].rotation.z = lerp(legs[i].L.joints[0].rotation.z, legs[i].side * 0.55, d);
            legs[i].L.joints[1].rotation.z = lerp(legs[i].L.joints[1].rotation.z, legs[i].side * -1.1, d);
            legs[i].L.joints[0].rotation.x = lerp(legs[i].L.joints[0].rotation.x, 0, d);
          }
          body.position.y = baseY - d * 0.34 * s;
          body.rotation.z = d * 0.55;
          torso.rotation.x = d * 0.3;
          mViscera.emissiveIntensity = 2.0 * (1 - d);
          mEye.emissiveIntensity = 2.4 * (1 - d);
          mGlass.emissiveIntensity = 0.35 * (1 - d);
        }
      },
      dispose: function () { disposeRes(R); }
    };
  }

  MONSTERS['spider_graft'] = {
    id: 'spider_graft',
    name: 'SPIDER GRAFT',
    tier: 'grunt',
    size: { height: 0.9, radius: 0.8 },
    build: buildSpiderGraft
  };

  /* =======================================================================
   * 5. FAILED CLONE — iteration 9 of something that used to be staff.
   * ===================================================================== */

  function buildFailedClone(opts) {
    var rng = opts.rng, P = opts.palette, Q = opts.quality;
    var R = newRes();
    var SW = qs(Q, 7, 12), SH = qs(Q, 5, 9), LR = qs(Q, 4, 6);
    var s = 1 + jit(rng, 0.12);

    var mFlesh = mkMat(R, cj(P.flesh, rng), { rough: 0.92 });
    var mFlesh2 = mkMat(R, cj(P.flesh2, rng), { rough: 0.95 });
    var mMetal = mkMat(R, cj(P.metal, rng, 0.02, 0.1), { rough: 0.3, metal: 0.9, flat: false });
    var mGown = mkMat(R, cj(0xb9c6c4, rng, 0.05, 0.16), { rough: 0.95, side: THREE.DoubleSide });
    var mEye = glowMat(R, P.glow, 2.6);
    var mTube = glowMat(R, P.glow2, 0.5, {
      base: cj(P.goo, rng, 0.06, 0.16), transparent: true, opacity: 0.75, rough: 0.3, flat: false
    });
    var mBone = mkMat(R, cj(P.bone, rng), { rough: 0.7 });
    var mNode = glowMat(R, P.glow2, 1.7);

    var group = new THREE.Group();
    var body = new THREE.Group();
    group.add(body);

    var hipY = rr(rng, 0.74, 0.8) * s;
    var hips = new THREE.Group();
    hips.position.y = hipY;
    body.add(hips);

    var spine = new THREE.Group();           /* hunched upper body */
    spine.rotation.x = rr(rng, 0.3, 0.46);
    hips.add(spine);

    /* pelvis + torso ----------------------------------------------------- */
    var pelvis = mSphere(R, mFlesh2, 0.15 * s, SW, Math.max(4, SH - 2));
    pelvis.scale.set(1.12, 0.78, 0.86);
    hips.add(pelvis);

    var chest = mSphere(R, mFlesh, 0.2 * s, SW, SH);
    chest.scale.set(1.05, 1.15, 0.78);
    chest.position.y = 0.26 * s;
    spine.add(chest);

    /* ribcage stapled shut ----------------------------------------------- */
    var nStaple = ri(rng, 3, 4);
    for (var sp = 0; sp < nStaple; sp++) {
      var f = nStaple === 1 ? 0.5 : sp / (nStaple - 1);
      var st2 = mBox(R, mMetal, 0.075 * s, 0.016 * s, 0.026 * s);
      st2.position.set(jit(rng, 0.025) * s, lerp(0.09, 0.4, f) * s, 0.15 * s);
      st2.rotation.z = jit(rng, 0.35);
      spine.add(st2);
    }
    /* the seam the staples are holding */
    var seam = mBox(R, mFlesh2, 0.022 * s, 0.36 * s, 0.03 * s);
    seam.position.set(0, 0.25 * s, 0.155 * s);
    spine.add(seam);

    /* head --------------------------------------------------------------- */
    var neck = new THREE.Group();
    neck.position.y = 0.44 * s;
    spine.add(neck);

    var headG = new THREE.Group();
    headG.position.y = 0.11 * s;
    headG.rotation.x = -rr(rng, 0.15, 0.35);  /* head hangs, counter to the hunch */
    neck.add(headG);

    var skull = mSphere(R, mFlesh, 0.125 * s, SW, SH);
    skull.scale.set(0.95, 1.08, 1.0);
    headG.add(skull);

    /* the face is a blank sagging mass */
    var sag = mSphere(R, mFlesh2, 0.1 * s, Math.max(6, SW - 2), Math.max(4, SH - 2));
    sag.scale.set(0.9, 1.15, 0.6);
    sag.position.set(jit(rng, 0.015) * s, -0.045 * s, 0.075 * s);
    headG.add(sag);

    var eyeSide = sgn(rng);
    var eye = mIco(R, mEye, rr(rng, 0.028, 0.04) * s, 0);
    eye.position.set(eyeSide * 0.045 * s, rr(rng, -0.01, 0.035) * s, 0.115 * s);
    headG.add(eye);

    /* cranial electrode halo --------------------------------------------- */
    var haloG = new THREE.Object3D();
    haloG.position.y = 0.11 * s;
    haloG.rotation.x = rr(rng, -0.15, 0.15);
    headG.add(haloG);
    var halo = mTorus(R, mMetal, 0.15 * s, 0.012 * s, 4, qs(Q, 8, 14));
    halo.rotation.x = PI * 0.5;
    haloG.add(halo);

    var nodes = [];
    var nNode = ri(rng, 3, 4);
    for (var nd = 0; nd < nNode; nd++) {
      var na = (nd / nNode) * TAU + jit(rng, 0.3);
      var node = mCyl(R, nd % 2 === 0 ? mNode : mMetal, 0.018 * s, 0.024 * s, 0.05 * s, 4);
      node.position.set(Math.cos(na) * 0.15 * s, -0.015 * s, Math.sin(na) * 0.15 * s);
      node.rotation.z = Math.cos(na) * 0.5;
      node.rotation.x = -Math.sin(na) * 0.5;
      haloG.add(node);
      nodes.push({ m: node, off: rng() * TAU });
    }

    /* cracked containment collar + IV lines ------------------------------ */
    /* the arc leaves the gap where the collar split open */
    var collarGeo = new THREE.TorusGeometry(
      0.115 * s, 0.028 * s, 4, qs(Q, 7, 12), TAU * rr(rng, 0.76, 0.88)
    );
    var collar = mkMesh(R, collarGeo, mMetal);
    collar.rotation.x = PI * 0.5;
    collar.rotation.z = rng() * TAU;
    collar.position.y = 0.02 * s;
    neck.add(collar);

    var tubes = [];
    var nTube = 2;
    for (var tb = 0; tb < nTube; tb++) {
      var ta = rng() * TAU;
      var T = limb(R, mTube, [
        { len: rr(rng, 0.18, 0.26) * s, r0: 0.018 * s, r1: 0.016 * s },
        { len: rr(rng, 0.16, 0.24) * s, r0: 0.016 * s, r1: 0.012 * s },
        { len: rr(rng, 0.12, 0.2) * s, r0: 0.012 * s, r1: 0.008 * s }
      ], 4);
      T.root.position.set(Math.cos(ta) * 0.1 * s, 0.0, Math.sin(ta) * 0.09 * s);
      T.joints[0].rotation.set(jit(rng, 0.3), 0, jit(rng, 0.4));
      neck.add(T.root);
      tubes.push({ T: T, off: rng() * TAU, spd: rr(rng, 0.8, 1.5) });
    }

    /* arms — one grotesquely long, it drags ------------------------------ */
    var longSide = sgn(rng);
    var arms = [];
    for (var ar = 0; ar < 2; ar++) {
      var side = ar === 0 ? -1 : 1;
      var isLong = (side === longSide);
      var upLen = (isLong ? rr(rng, 0.38, 0.46) : rr(rng, 0.2, 0.25)) * s;
      var loLen = (isLong ? rr(rng, 0.36, 0.44) : rr(rng, 0.17, 0.22)) * s;
      var thick = isLong ? 1.0 : 0.82;
      var A = limb(R, side === longSide ? mFlesh : mFlesh2, [
        { len: upLen, r0: 0.055 * s * thick, r1: 0.042 * s * thick },
        { len: loLen, r0: 0.04 * s * thick, r1: 0.028 * s * thick }
      ], LR);
      A.root.position.set(side * 0.19 * s, 0.38 * s, 0);
      var rest0 = isLong ? rr(rng, 0.12, 0.3) : rr(rng, -0.15, 0.1);
      A.joints[0].rotation.set(rest0, 0, side * (isLong ? 0.12 : 0.3));
      A.joints[1].rotation.x = isLong ? rr(rng, 0.15, 0.4) : rr(rng, 0.6, 0.95);
      spine.add(A.root);

      var hand = mIco(R, mBone, (isLong ? 0.065 : 0.05) * s, 0);
      hand.scale.set(1, 1.35, 0.7);
      hand.position.y = -0.03 * s;
      A.tip.add(hand);
      /* a couple of long fingers on the dragging hand */
      if (isLong) {
        for (var fi = 0; fi < 2; fi++) {
          var fing = mCyl(R, mBone, 0.012 * s, 0.006 * s, rr(rng, 0.1, 0.16) * s, 4);
          fing.position.set((fi === 0 ? -0.025 : 0.025) * s, -0.11 * s, 0.01 * s);
          fing.rotation.z = (fi === 0 ? -0.2 : 0.2);
          A.tip.add(fing);
        }
      }
      arms.push({ A: A, side: side, isLong: isLong, rest0: rest0, elbow: A.joints[1].rotation.x });
    }

    /* legs — uneven, one stiff ------------------------------------------- */
    var shortLeg = sgn(rng);
    var legs = [];
    for (var lg2 = 0; lg2 < 2; lg2++) {
      var lside = lg2 === 0 ? -1 : 1;
      var shorter = (lside === shortLeg);
      var thigh = (shorter ? rr(rng, 0.3, 0.34) : rr(rng, 0.34, 0.38)) * s;
      var shin = (shorter ? rr(rng, 0.26, 0.3) : rr(rng, 0.3, 0.34)) * s;
      var L = limb(R, mFlesh2, [
        { len: thigh, r0: 0.075 * s, r1: 0.055 * s },
        { len: shin, r0: 0.05 * s, r1: 0.036 * s }
      ], LR);
      L.root.position.set(lside * 0.1 * s, -0.07 * s, 0);
      L.joints[0].rotation.z = lside * 0.06;
      hips.add(L.root);
      var foot = mBox(R, mBone, 0.1 * s, 0.045 * s, 0.2 * s);
      foot.position.set(0, -0.02 * s, 0.045 * s);
      L.tip.add(foot);
      legs.push({ L: L, side: lside, shorter: shorter, amp: shorter ? 0.3 : 0.52 });
    }

    /* hospital gown tatters ---------------------------------------------- */
    var tatters = [];
    var nTat = ri(rng, 3, 4);
    for (var tt2 = 0; tt2 < nTat; tt2++) {
      var tang = (tt2 / nTat) * TAU + jit(rng, 0.4);
      var tw = rr(rng, 0.1, 0.19) * s;
      var th = rr(rng, 0.2, 0.42) * s;
      var piv = new THREE.Object3D();
      piv.position.set(Math.cos(tang) * 0.15 * s, 0.1 * s, Math.sin(tang) * 0.12 * s);
      piv.rotation.y = -tang;
      spine.add(piv);
      var tat = mBox(R, mGown, tw, th, 0.008 * s);
      tat.position.y = -th * 0.5;
      piv.add(tat);
      tatters.push({ p: piv, off: rng() * TAU, base: piv.rotation.x });
    }

    var headAnchor = new THREE.Object3D();
    headAnchor.position.y = 0.42 * s;
    headG.add(headAnchor);

    var baseY = groundTo(group, body);
    var hits = [chest, headG, pelvis];
    var S = { ph: rng() * TAU, tw: rng() * TAU };
    var spineRest = spine.rotation.x;
    var headRest = headG.rotation.x;

    return {
      group: group,
      headAnchor: headAnchor,
      materials: R.mats,
      hitPoints: hits,
      update: function (dt, ctx) {
        var t = ctx.time, st = ctx.state, i;
        var w = stepPhase(S, dt, ctx, 3.0, 2.2);
        S.tw += dt * 1.6;

        body.position.set(0, baseY, 0);
        body.rotation.set(0, 0, 0);
        body.scale.set(1, 1, 1);
        hips.rotation.set(0, 0, 0);
        spine.rotation.set(spineRest, 0, 0);
        headG.rotation.set(headRest, 0, 0);
        neck.rotation.set(0, 0, 0);

        /* shallow wet breathing */
        var br = Math.sin(t * 2.1) * 0.045 + Math.max(0, Math.sin(t * 2.1 + 1.2)) * 0.02;
        chest.scale.set(1.05 * (1 + br * 0.5), 1.15 * (1 + br * 0.35), 0.78 * (1 + br));

        /* uneven limp: long stride on one side, a hitch on the other */
        var p = S.ph;
        var hitch = Math.max(0, Math.sin(p));
        for (i = 0; i < legs.length; i++) {
          var lg = legs[i];
          var lp = p + (lg.shorter ? PI : 0);
          var sw = Math.sin(lp);
          lg.L.joints[0].rotation.x = sw * lg.amp * w;
          lg.L.joints[1].rotation.x = 0.12 + Math.max(0, -Math.cos(lp)) * (lg.shorter ? 0.5 : 0.95) * w;
        }
        body.position.y = baseY - hitch * 0.075 * s * w + Math.abs(Math.sin(p * 2)) * 0.018 * s * w;
        body.rotation.z = (Math.sin(p) * 0.09 + 0.05) * w * shortLeg;
        hips.rotation.y = Math.sin(p) * 0.16 * w;
        spine.rotation.y = -Math.sin(p) * 0.13 * w;
        spine.rotation.x = spineRest + Math.sin(p * 2) * 0.05 * w + 0.1 * w;
        spine.rotation.z = -Math.sin(p) * 0.07 * w;

        /* arms: the long one drags and swings late */
        for (i = 0; i < arms.length; i++) {
          var am = arms[i];
          var ap = p + (am.side === shortLeg ? 0 : PI);
          var lagAmp = am.isLong ? 0.3 : 0.45;
          am.A.joints[0].rotation.x = am.rest0 + Math.sin(ap - 0.6) * lagAmp * w;
          am.A.joints[0].rotation.z = am.side * ((am.isLong ? 0.12 : 0.3) + Math.sin(p * 0.5 + i) * 0.06 * w);
          am.A.joints[1].rotation.x = am.elbow + Math.max(0, Math.sin(ap)) * (am.isLong ? 0.2 : 0.35) * w;
        }

        /* IV tubes sway with the body */
        for (i = 0; i < tubes.length; i++) {
          var tb2 = tubes[i];
          for (var j = 0; j < tb2.T.joints.length; j++) {
            var tp = t * tb2.spd * 1.6 + tb2.off - j * 0.7;
            tb2.T.joints[j].rotation.z = Math.sin(tp) * (0.12 + 0.16 * w) * (1 + j * 0.5);
            tb2.T.joints[j].rotation.x = (j === 0 ? 0.1 : 0.05) + Math.cos(tp * 0.8) * (0.08 + 0.12 * w);
          }
        }

        /* gown tatters trail */
        for (i = 0; i < tatters.length; i++) {
          var ta2 = tatters[i];
          ta2.p.rotation.x = Math.sin(t * 2.4 + ta2.off) * 0.1 + 0.28 * w;
          ta2.p.rotation.z = Math.sin(t * 1.9 + ta2.off * 1.3) * 0.12;
        }

        /* head lolls, electrodes fire */
        headG.rotation.x = headRest + Math.sin(S.tw * 0.9) * 0.1 + 0.12 * w;
        headG.rotation.z = Math.sin(S.tw * 0.6) * 0.14;
        headG.rotation.y = Math.sin(S.tw * 0.45) * 0.18;
        mEye.emissiveIntensity = 2.2 + Math.sin(t * 5.0) * 0.5 + (1 - ctx.hpFrac) * 0.9;
        for (i = 0; i < nodes.length; i++) {
          nodes[i].m.scale.setScalar(1 + Math.max(0, Math.sin(t * 6.0 + nodes[i].off)) * 0.22);
        }
        mNode.emissiveIntensity = 1.2 + Math.abs(Math.sin(t * 3.7)) * 1.1;

        if (st === 'attack') {
          var c = atkCurve(ctx.attackT);
          /* hauls the long arm up and back, then slams it down forward */
          spine.rotation.x = spineRest - c * 0.45;
          body.position.z = Math.max(0, c) * 0.3 * s;
          headG.rotation.x = headRest - c * 0.3;
          for (i = 0; i < arms.length; i++) {
            var am2 = arms[i];
            if (am2.isLong) {
              am2.A.joints[0].rotation.x = am2.rest0 - c * 2.1;
              am2.A.joints[1].rotation.x = am2.elbow + Math.max(0, -c) * 1.0;
              am2.A.joints[0].rotation.z = am2.side * (0.12 + Math.max(0, -c) * 0.4);
            } else {
              am2.A.joints[0].rotation.x = am2.rest0 - c * 0.5;
            }
          }
        }

        if (st === 'spawn') {
          /* unfolds upward out of the floor, still folded over itself */
          var e = smooth(clamp01(ctx.spawnT));
          applySpawn(body, ctx.spawnT, 1.15 * s, baseY);
          spine.rotation.x = lerp(1.35, spine.rotation.x, e);
          headG.rotation.x = lerp(0.8, headG.rotation.x, e);
          for (i = 0; i < arms.length; i++) {
            arms[i].A.joints[0].rotation.x = lerp(-0.4, arms[i].A.joints[0].rotation.x, e);
            arms[i].A.joints[1].rotation.x = lerp(1.9, arms[i].A.joints[1].rotation.x, e);
          }
        }

        if (ctx.hurtT > 0 && st !== 'die') {
          var h = clamp01(ctx.hurtT);
          body.position.z -= h * 0.14 * s;
          spine.rotation.x += h * 0.3;
          headG.rotation.x += h * 0.35;
          body.rotation.z += Math.sin(t * 58) * h * 0.08;
          body.position.x += Math.sin(t * 58) * h * 0.03 * s;
        }

        if (st === 'die') {
          /* knees buckle, it folds forward and sinks */
          var d = smooth(ctx.dieT);
          var d2 = smooth(clamp01((ctx.dieT - 0.25) / 0.75));
          body.position.y = baseY - d * (hipY * 0.72);
          body.rotation.x = d2 * 0.9;
          body.rotation.z = d * 0.35 * shortLeg;
          spine.rotation.x = spineRest + d * 0.7;
          headG.rotation.x = headRest + d * 0.6;
          for (i = 0; i < legs.length; i++) {
            legs[i].L.joints[0].rotation.x = lerp(legs[i].L.joints[0].rotation.x, -0.9, d);
            legs[i].L.joints[1].rotation.x = lerp(legs[i].L.joints[1].rotation.x, 1.9, d);
          }
          for (i = 0; i < arms.length; i++) {
            arms[i].A.joints[0].rotation.x = lerp(arms[i].A.joints[0].rotation.x, 0.5, d);
            arms[i].A.joints[1].rotation.x = lerp(arms[i].A.joints[1].rotation.x, 0.3, d);
          }
          mEye.emissiveIntensity = 2.6 * (1 - d);
          mNode.emissiveIntensity = 1.7 * (1 - d);
          mTube.emissiveIntensity = 0.5 * (1 - d);
        }
      },
      dispose: function () { disposeRes(R); }
    };
  }

  MONSTERS['failed_clone'] = {
    id: 'failed_clone',
    name: 'FAILED CLONE',
    tier: 'grunt',
    size: { height: 1.5, radius: 0.5 },
    build: buildFailedClone
  };

})();
