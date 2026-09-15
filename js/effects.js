/* Containment Breach — pooled hit effects: impact sparks, gore, muzzle flash, brass.
 *
 * Everything is pre-allocated. Nothing here creates geometry at runtime, so a
 * long run does not stutter on GC. */
(function (global) {
  'use strict';
  var CT = (global.ContainmentBreach = global.ContainmentBreach || {});
  var S = function () { return CT.Settings; };

  var MAX_PARTICLES = 1400;
  var _shellV = new THREE.Vector3();

  /* Muzzle flare texture, drawn once.
   *
   * The flash used to be an untextured quad, which under additive blending is a
   * flat lozenge with visible corners — it read as a grey card at the barrel
   * rather than as light. Additive blending ignores alpha and simply sums RGB,
   * so the falloff has to be in the COLOUR: white-hot core through amber to
   * true black at the rim, where it then contributes nothing and the edges of
   * the quad disappear. */
  var _flareTex = null;
  function flareTexture() {
    if (_flareTex) return _flareTex;
    var N = 64, c = document.createElement('canvas');
    c.width = c.height = N;
    var g = c.getContext('2d');
    var half = N / 2;

    var grd = g.createRadialGradient(half, half, 0, half, half, half);
    grd.addColorStop(0.00, 'rgb(255,255,255)');
    grd.addColorStop(0.30, 'rgb(255,248,226)');
    grd.addColorStop(0.55, 'rgb(255,190,96)');
    grd.addColorStop(0.80, 'rgb(96,44,10)');
    grd.addColorStop(1.00, 'rgb(0,0,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, N, N);

    // A few spokes so it flares rather than reading as a perfect dot.
    g.globalCompositeOperation = 'lighter';
    g.strokeStyle = 'rgb(150,100,40)';
    g.lineCap = 'round';
    for (var i = 0; i < 4; i++) {
      var a = (i / 4) * Math.PI * 2 + 0.4;
      g.lineWidth = i % 2 ? 2 : 3.5;
      g.beginPath();
      g.moveTo(half - Math.cos(a) * half * 0.9, half - Math.sin(a) * half * 0.9);
      g.lineTo(half + Math.cos(a) * half * 0.9, half + Math.sin(a) * half * 0.9);
      g.stroke();
    }

    _flareTex = new THREE.CanvasTexture(c);
    return _flareTex;
  }

  /* ---- gore ---------------------------------------------------------------
   *
   * The existing particle system is additively blended, which is right for
   * sparks and muzzle flash and exactly wrong for blood: additive can only ever
   * add light, so every "blood" particle came out as a bright glowing dot. Wet
   * red needs normal blending and a texture with real alpha in it, so the gore
   * gets its own system rather than another colour passed to burst().
   */

  var MAX_BLOOD = 900;
  var MAX_CHUNKS = 26;
  var MAX_SPLATS = 18;
  var _goreTex = {};

  /* One irregular droplet, soft at the edge and darkest off-centre, so a
   * cloud of them reads as wet rather than as a field of identical dots. */
  function bloodTexture() {
    if (_goreTex.drop) return _goreTex.drop;
    var N = 64, c = document.createElement('canvas');
    c.width = c.height = N;
    var g = c.getContext('2d');
    var rng = new CT.Rng(0xb100d);
    var half = N / 2;

    // The body of the drop: an off-round blob, not a circle.
    g.beginPath();
    for (var a = 0; a <= 32; a++) {
      var th = (a / 32) * Math.PI * 2;
      var rad = half * (0.66 + 0.26 * Math.sin(th * 3 + 1.1) * rng.range(0.4, 1));
      var x = half + Math.cos(th) * rad, y = half + Math.sin(th) * rad;
      if (a === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath();
    var grd = g.createRadialGradient(half * 0.82, half * 0.78, 1, half, half, half);
    grd.addColorStop(0.00, 'rgba(255,255,255,1)');
    grd.addColorStop(0.45, 'rgba(210,210,210,0.96)');
    grd.addColorStop(0.82, 'rgba(120,120,120,0.55)');
    grd.addColorStop(1.00, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fill();

    _goreTex.drop = new THREE.CanvasTexture(c);
    return _goreTex.drop;
  }

  /* A splat for the floor: a main pool with satellite droplets thrown off it. */
  function splatTexture() {
    if (_goreTex.splat) return _goreTex.splat;
    var N = 128, c = document.createElement('canvas');
    c.width = c.height = N;
    var g = c.getContext('2d');
    var rng = new CT.Rng(0x51a7bb);
    var half = N / 2;

    function blob(cx, cy, r, alpha) {
      g.beginPath();
      for (var a = 0; a <= 24; a++) {
        var th = (a / 24) * Math.PI * 2;
        var rad = r * rng.range(0.6, 1.25);
        var x = cx + Math.cos(th) * rad, y = cy + Math.sin(th) * rad;
        if (a === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.closePath();
      g.fillStyle = 'rgba(255,255,255,' + alpha + ')';
      g.fill();
    }

    blob(half, half, half * 0.42, 0.95);
    for (var i = 0; i < 16; i++) {
      var th2 = rng.range(0, 6.3);
      var d = rng.range(half * 0.35, half * 0.92);
      blob(half + Math.cos(th2) * d, half + Math.sin(th2) * d,
           half * rng.range(0.035, 0.13), rng.range(0.4, 0.9));
    }
    _goreTex.splat = new THREE.CanvasTexture(c);
    return _goreTex.splat;
  }

  function Effects(stage) {
    this.stage = stage;
    this.root = new THREE.Group();
    this.root.frustumCulled = false;
    stage.scene.add(this.root);

    this._buildParticles();
    this._buildBlood();
    this._buildChunks();
    this._buildSplats();
    this._buildFlash();
    this._buildShells();
    this._buildRings();

    // One pooled light for kills. A specimen coming apart should throw red
    // light onto the rock around it for a moment; without that the burst is
    // just a decal floating in an unlit chamber.
    this.killLight = new THREE.PointLight(0xff2a10, 0, 16, 2.0);
    this.killLight.userData.noShadow = true;
    this.root.add(this.killLight);
  }

  /* ---- blood ---------------------------------------------------------------
   *
   * Its own points system, with a shader rather than PointsMaterial, for two
   * reasons: PointsMaterial has one global opacity, so particles can only fade
   * by darkening toward black (fine against additive, wrong for blood), and one
   * global size, so every drop is the same drop. Per-particle alpha and size
   * are most of what separates spatter from confetti. */
  Effects.prototype._buildBlood = function () {
    var n = MAX_BLOOD;
    this.bPos = new Float32Array(n * 3);
    this.bCol = new Float32Array(n * 3);
    this.bVel = new Float32Array(n * 3);
    this.bAlpha = new Float32Array(n);
    this.bSize = new Float32Array(n);
    this.bLife = new Float32Array(n);
    this.bMax = new Float32Array(n);
    this.bGrav = new Float32Array(n);
    this.bCursor = 0;
    for (var i = 0; i < n; i++) this.bPos[i * 3 + 1] = -9999;

    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.bPos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.bCol, 3));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.bAlpha, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.bSize, 1));

    var mat = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: bloodTexture() },
        fogColor: { value: new THREE.Color(CT.FOG_COLOR) },
        fogDensity: { value: 0.0 }
      },
      vertexShader: [
        'attribute vec3 aColor;',
        'attribute float aAlpha;',
        'attribute float aSize;',
        'varying vec3 vColor;',
        'varying float vAlpha;',
        'varying float vDepth;',
        'void main() {',
        '  vColor = aColor;',
        '  vAlpha = aAlpha;',
        '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
        '  vDepth = -mv.z;',
        '  gl_PointSize = aSize * (320.0 / max(0.001, -mv.z));',
        '  gl_Position = projectionMatrix * mv;',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform sampler2D map;',
        'uniform vec3 fogColor;',
        'uniform float fogDensity;',
        'varying vec3 vColor;',
        'varying float vAlpha;',
        'varying float vDepth;',
        'void main() {',
        '  vec4 t = texture2D(map, gl_PointCoord);',
        '  float a = t.a * vAlpha;',
        '  if (a < 0.02) discard;',
        // Fog by hand: the cave is FogExp2, and blood that ignores it hangs in
        // the dark at the far end of the tunnel like a sticker.
        '  float f = 1.0 - exp(-fogDensity * fogDensity * vDepth * vDepth);',
        '  gl_FragColor = vec4(mix(vColor * t.rgb, fogColor, clamp(f, 0.0, 1.0)), a);',
        '}'
      ].join('\n'),
      transparent: true,
      depthWrite: false
    });

    this.blood = new THREE.Points(geo, mat);
    this.blood.frustumCulled = false;
    this.blood.userData.noShadow = true;
    this.root.add(this.blood);
    this.bGeo = geo; this.bMat = mat;
  };

  Effects.prototype.bloodBurst = function (pos, count, speed, life, size) {
    var density = S().getNum('particles');
    count = Math.max(1, Math.round(count * density));
    for (var i = 0; i < count; i++) {
      var idx = this.bCursor;
      this.bCursor = (this.bCursor + 1) % MAX_BLOOD;
      var o = idx * 3;
      this.bPos[o] = pos.x; this.bPos[o + 1] = pos.y; this.bPos[o + 2] = pos.z;
      var th = Math.random() * Math.PI * 2;
      var ph = Math.acos(2 * Math.random() - 1);
      var sp = speed * (0.25 + Math.random() * 1.1);
      this.bVel[o] = Math.sin(ph) * Math.cos(th) * sp;
      // Biased upward: arterial, not a leak.
      this.bVel[o + 1] = Math.cos(ph) * sp + speed * 0.35;
      this.bVel[o + 2] = Math.sin(ph) * Math.sin(th) * sp;
      // Arterial red through to nearly-black venous, so the cloud has depth.
      var dark = Math.random();
      this.bCol[o] = 0.30 + dark * 0.52;
      this.bCol[o + 1] = 0.012 + dark * 0.055;
      this.bCol[o + 2] = 0.016 + dark * 0.05;
      this.bSize[idx] = size * (0.5 + Math.random() * 1.1);
      this.bAlpha[idx] = 1;
      this.bMax[idx] = life * (0.55 + Math.random() * 0.9);
      this.bLife[idx] = this.bMax[idx];
      this.bGrav[idx] = 16;
    }
  };

  /* Steam, on the same droplet system.
   *
   * It belongs here rather than on the additive burst() for one reason: point
   * size. burst() has a single global size, and a vent puff comes out a hand's
   * width from the camera, where a fixed-size point is drawn sixty pixels
   * across and reads as a white card. The droplet system carries a size per
   * particle, so a close puff can be made of small wisps.
   *
   * Negative gravity, because steam goes up. */
  Effects.prototype.steam = function (pos, count, speed, life, size) {
    var density = S().getNum('particles');
    count = Math.max(1, Math.round(count * density));
    for (var i = 0; i < count; i++) {
      var idx = this.bCursor;
      this.bCursor = (this.bCursor + 1) % MAX_BLOOD;
      var o = idx * 3;
      this.bPos[o] = pos.x + (Math.random() - 0.5) * 0.06;
      this.bPos[o + 1] = pos.y + (Math.random() - 0.5) * 0.06;
      this.bPos[o + 2] = pos.z + (Math.random() - 0.5) * 0.06;
      var th = Math.random() * Math.PI * 2;
      var ph = Math.acos(2 * Math.random() - 1);
      var sp = speed * (0.3 + Math.random());
      this.bVel[o] = Math.sin(ph) * Math.cos(th) * sp;
      this.bVel[o + 1] = Math.abs(Math.cos(ph)) * sp * 0.6 + speed * 0.3;
      this.bVel[o + 2] = Math.sin(ph) * Math.sin(th) * sp;
      var g = 0.55 + Math.random() * 0.35;
      this.bCol[o] = g; this.bCol[o + 1] = g * 0.96; this.bCol[o + 2] = g * 0.9;
      this.bSize[idx] = size * (0.6 + Math.random() * 0.9);
      this.bAlpha[idx] = 1;
      this.bMax[idx] = life * (0.6 + Math.random() * 0.8);
      this.bLife[idx] = this.bMax[idx];
      this.bGrav[idx] = -2.4;
    }
  };

  /* ---- flying pieces -------------------------------------------------------
   * Points cannot tumble, and a specimen that bursts into nothing but spray
   * reads as a balloon popping. These are the bits of it. */
  Effects.prototype._buildChunks = function () {
    this.chunks = [];
    // Three irregular solids, shared: a chunk is on screen for under a second
    // and nobody counts the faces.
    this.chunkGeos = [];
    for (var v = 0; v < 3; v++) {
      var g = new THREE.IcosahedronGeometry(0.07 + v * 0.028, 0);
      var p = g.attributes.position;
      var rng = new CT.Rng(0xc0ffee + v);
      for (var k = 0; k < p.count; k++) {
        p.setXYZ(k, p.getX(k) * rng.range(0.55, 1.5),
                    p.getY(k) * rng.range(0.55, 1.5),
                    p.getZ(k) * rng.range(0.55, 1.5));
      }
      g.computeVertexNormals();
      this.chunkGeos.push(g);
    }
    this.chunkMat = new THREE.MeshStandardMaterial({
      color: 0x431016, roughness: 0.78, metalness: 0.0, flatShading: true
    });
    CT.detailMat(this.chunkMat, 'hide', 2, 0.02);

    for (var i = 0; i < MAX_CHUNKS; i++) {
      var m = new THREE.Mesh(this.chunkGeos[i % 3], this.chunkMat);
      m.visible = false;
      m.userData.noShadow = true;
      this.root.add(m);
      this.chunks.push({ mesh: m, life: 0, max: 1, vel: new THREE.Vector3(), spin: new THREE.Vector3() });
    }
    this.chunkCursor = 0;
  };

  Effects.prototype.chunkBurst = function (pos, count, speed, groundY) {
    for (var i = 0; i < count; i++) {
      var c = this.chunks[this.chunkCursor];
      this.chunkCursor = (this.chunkCursor + 1) % MAX_CHUNKS;
      c.mesh.position.copy(pos);
      c.mesh.visible = true;
      c.mesh.rotation.set(Math.random() * 6.3, Math.random() * 6.3, Math.random() * 6.3);
      var sc = 0.6 + Math.random() * 0.7;
      c.mesh.scale.setScalar(sc);
      var th = Math.random() * Math.PI * 2;
      var ph = Math.acos(2 * Math.random() - 1);
      var sp = speed * (0.4 + Math.random());
      c.vel.set(Math.sin(ph) * Math.cos(th) * sp, Math.cos(ph) * sp + speed * 0.5, Math.sin(ph) * Math.sin(th) * sp);
      c.spin.set((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14);
      c.max = 1.0 + Math.random() * 0.7;
      c.life = c.max;
      c.ground = groundY === undefined ? 0.05 : groundY + 0.05;
      c.scale0 = sc;
    }
  };

  /* ---- floor splats -------------------------------------------------------- */

  Effects.prototype._buildSplats = function () {
    this.splats = [];
    this.splatGeo = new THREE.PlaneGeometry(1, 1);
    this.splatMats = [];
    for (var i = 0; i < MAX_SPLATS; i++) {
      var mat = new THREE.MeshBasicMaterial({
        map: splatTexture(), color: 0x4a0a0c, transparent: true, opacity: 0,
        depthWrite: false, side: THREE.DoubleSide,
        // Lying flat on a displaced floor, so the same depth bias the old
        // specimen pools needed.
        polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3
      });
      var m = new THREE.Mesh(this.splatGeo, mat);
      m.rotation.x = -Math.PI / 2;
      m.visible = false;
      m.userData.noShadow = true;
      this.root.add(m);
      this.splatMats.push(mat);
      this.splats.push({ mesh: m, mat: mat, life: 0, max: 1 });
    }
    this.splatCursor = 0;
  };

  Effects.prototype.splat = function (pos, groundY, size) {
    var sp = this.splats[this.splatCursor];
    this.splatCursor = (this.splatCursor + 1) % MAX_SPLATS;
    sp.mesh.position.set(pos.x + (Math.random() - 0.5) * size,
                         (groundY === undefined ? 0 : groundY) + 0.035,
                         pos.z + (Math.random() - 0.5) * size);
    sp.mesh.rotation.z = Math.random() * 6.3;
    sp.mesh.scale.setScalar(size * (0.7 + Math.random() * 0.7));
    sp.mesh.visible = true;
    sp.mat.opacity = 0.85;
    sp.max = 7 + Math.random() * 5;
    sp.life = sp.max;
  };


  /* ---- particles --------------------------------------------------------- */

  Effects.prototype._buildParticles = function () {
    var n = MAX_PARTICLES;
    this.pPos = new Float32Array(n * 3);
    this.pCol = new Float32Array(n * 3);
    this.pVel = new Float32Array(n * 3);
    this.pLife = new Float32Array(n);
    this.pMaxLife = new Float32Array(n);
    this.pGrav = new Float32Array(n);
    this.pCursor = 0;

    // park everything far away until used
    for (var i = 0; i < n; i++) this.pPos[i * 3 + 1] = -9999;

    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3));
    var mat = new THREE.PointsMaterial({
      size: 0.16, vertexColors: true, transparent: true, opacity: 0.95,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true
    });
    this.particles = new THREE.Points(geo, mat);
    this.particles.frustumCulled = false;
    this.particles.userData.noShadow = true;
    this.root.add(this.particles);
    this.pGeo = geo; this.pMat = mat;
  };

  Effects.prototype.burst = function (pos, color, count, speed, spread, gravity, life) {
    var density = S().getNum('particles');
    count = Math.max(1, Math.round(count * density));
    var c = new THREE.Color(color);
    for (var i = 0; i < count; i++) {
      var idx = this.pCursor;
      this.pCursor = (this.pCursor + 1) % MAX_PARTICLES;
      var o = idx * 3;
      this.pPos[o] = pos.x; this.pPos[o + 1] = pos.y; this.pPos[o + 2] = pos.z;
      // random direction on a sphere, biased outward
      var th = Math.random() * Math.PI * 2;
      var ph = Math.acos(2 * Math.random() - 1);
      var sp = speed * (0.35 + Math.random() * 0.9);
      this.pVel[o] = Math.sin(ph) * Math.cos(th) * sp * spread;
      this.pVel[o + 1] = Math.cos(ph) * sp;
      this.pVel[o + 2] = Math.sin(ph) * Math.sin(th) * sp * spread;
      var j = 0.75 + Math.random() * 0.5;
      this.pCol[o] = c.r * j; this.pCol[o + 1] = c.g * j; this.pCol[o + 2] = c.b * j;
      this.pMaxLife[idx] = life * (0.6 + Math.random() * 0.8);
      this.pLife[idx] = this.pMaxLife[idx];
      this.pGrav[idx] = gravity;
    }
  };

  /* Splash where a shot lands. Blood and nothing else: these used to also
   * throw the specimen's own luminous fluid and a few pale sparks, so every
   * hit came off green, cyan or magenta depending on the creature, with yellow
   * on top of it. */
  Effects.prototype.impact = function (pos, groundY) {
    this.bloodBurst(pos, 20, 4.0, 0.8, 0.3);
    this.ring(pos, 0x9c1003, 0.7);
    if (Math.random() < 0.35) this.splat(pos, groundY, 0.7);
  };

  /* A specimen comes apart.
   *
   * Four things at once, because one of them alone always reads as a decal: a
   * red flash with light behind it so the rock around the kill lights up, a
   * dense cloud of textured blood, solid pieces that tumble and land, and the
   * mess they leave on the floor. */
  Effects.prototype.gib = function (pos, big, groundY) {
    this.bloodBurst(pos, big ? 260 : 95, big ? 8.5 : 5.5, big ? 1.7 : 1.2, big ? 0.62 : 0.42);

    /* Embers, which is what sells it as an explosion rather than a splash.
     * Kept almost pure red on purpose: these are additively blended, so where
     * a lot of them overlap their channels sum, and any green in the colour
     * turns the core of the burst orange and then yellow-white. With green and
     * blue near zero the densest part of the burst still reads as red. */
    this.burst(pos, 0xd80600, big ? 48 : 18, big ? 10 : 7, 1.0, 6, big ? 0.55 : 0.32);

    this.chunkBurst(pos, big ? 14 : 6, big ? 7 : 5, groundY);

    var splats = big ? 5 : 2;
    for (var i = 0; i < splats; i++) this.splat(pos, groundY, big ? 3.2 : 1.5);

    /* Deliberately well under full red. The rings are additive and the
     * renderer is ACES tone mapped, which rolls a high-luminance red off
     * toward orange and then toward yellow-white - so a ring authored at
     * 0xff2008 arrives on screen as a tan hoop. Dropped to here it stays
     * red through the tone curve. */
    this.ring(pos, 0xa81204, big ? 4.0 : 1.9);
    this.ring(pos, 0x700a02, big ? 2.4 : 1.1);

    this.killLight.position.copy(pos);
    this.killLight.intensity = big ? 14 : 6;
    this.killLight.distance = big ? 26 : 16;
  };

  /* ---- expanding shock rings -------------------------------------------- */

  Effects.prototype._buildRings = function () {
    this.rings = [];
    var geo = new THREE.RingGeometry(0.5, 0.62, 18);
    this.ringGeo = geo;
    for (var i = 0; i < 10; i++) {
      var mat = new THREE.MeshBasicMaterial({
        color: 0xa81204, transparent: true, opacity: 0, side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending, depthWrite: false
      });
      var m = new THREE.Mesh(geo, mat);
      m.visible = false;
      m.userData.noShadow = true;
      this.root.add(m);
      this.rings.push({ mesh: m, mat: mat, life: 0, max: 0.35, size: 1 });
    }
    this.ringCursor = 0;
  };

  Effects.prototype.ring = function (pos, color, size) {
    if (!S().get('glow')) return;
    var r = this.rings[this.ringCursor];
    this.ringCursor = (this.ringCursor + 1) % this.rings.length;
    r.mesh.position.copy(pos);
    r.mesh.quaternion.copy(this.stage.camera.getWorldQuaternion(new THREE.Quaternion()));
    r.mat.color.setHex(color);
    r.mat.opacity = 0.9;
    r.life = r.max;
    r.size = size;
    r.mesh.visible = true;
    r.mesh.scale.setScalar(0.1);
  };

  /* ---- weapons and muzzle flash ------------------------------------------
   * In co-op both rifles are on screen: yours on your side of the cabinet and
   * your partner's on theirs, player one left and player two right. Seeing the
   * other barrel buck and flash is the only direct feedback that someone else
   * is in the cave with you — everything else they do reads as damage numbers
   * on a specimen you were not looking at.
   *
   * Both are camera-attached viewmodels rather than world objects, because at
   * any believable world position a partner standing beside you is either
   * off-screen or in the way of the thing you are trying to read. */

  var WEAPON_HOME = { x: 0.30, y: -0.30, z: -1.15 };

  /* Set to false to take the hazmat arms back off.
   *
   * Everything they add is built in _buildArm() and parented to the rifle
   * group, and nothing else in the codebase refers to them — so flipping this
   * one flag is the entire revert, with no loose ends to chase. */
  var SHOW_ARMS = true;

  /* Which way the arm swings away from the grip. See buildArm. */
  var ARM_LEAN = -1;

  /* A limb between two points, as a tapered cylinder. Placing these by euler
   * angles is guesswork; giving the two joint positions and letting the
   * quaternion fall out of the direction is not. */
  var _limbA = new THREE.Vector3(), _limbB = new THREE.Vector3();
  var _limbDir = new THREE.Vector3(), _limbUp = new THREE.Vector3(0, 1, 0);

  function limb(dis, mat, a, b, rTop, rBottom) {
    _limbA.fromArray(a); _limbB.fromArray(b);
    _limbDir.subVectors(_limbB, _limbA);
    var len = _limbDir.length();
    var geo = new THREE.CylinderGeometry(rTop, rBottom, len, 9, 1);
    dis.push(geo);
    var m = new THREE.Mesh(geo, mat);
    m.position.copy(_limbA).addScaledVector(_limbDir, 0.5);
    m.quaternion.setFromUnitVectors(_limbUp, _limbDir.normalize());
    m.userData.noShadow = true;
    return m;
  }

  /* The arm holding it. Parented to the rifle group, so it inherits every bit
   * of sway, kick and repositioning the weapon already does and cannot drift
   * away from the grip.
   *
   * It runs from the grip down and outboard to a shoulder behind the camera,
   * which is what keeps it out of the middle of the screen: the weapon already
   * sits off-centre, and the arm only ever travels further that way. */
  function buildArm(dis, side) {
    var g = new THREE.Group();

    var suit = CT.detailMat(new THREE.MeshStandardMaterial({
      color: 0xb7972a, roughness: 0.78, metalness: 0.03
    }), 'metal', 5, 0.010);
    var glove = CT.detailMat(new THREE.MeshStandardMaterial({
      color: 0x8a7220, roughness: 0.86, metalness: 0.02
    }), 'hide', 6, 0.012);
    var seal = CT.detailMat(new THREE.MeshStandardMaterial({
      color: 0x22262a, roughness: 0.6, metalness: 0.35
    }), 'metal', 8, 0.008);
    dis.push(suit, glove, seal);

    /* Joints, in the rifle's local space. The grip is at (0, -0.135, 0.17).
     *
     * ARM_LEAN is which way the elbow and shoulder swing away from the grip:
     * -1 takes them across the body toward the middle of the screen, +1 takes
     * them out toward the shoulder on the weapon's own side. One character to
     * change your mind. */
    var lean = side * ARM_LEAN;
    var wrist = [0.012 * lean, -0.20, 0.27];
    var elbow = [0.17 * lean, -0.44, 0.60];
    var shoulder = [0.35 * lean, -0.66, 0.86];

    g.add(limb(dis, suit, elbow, wrist, 0.050, 0.064));       // forearm
    g.add(limb(dis, suit, shoulder, elbow, 0.066, 0.082));    // upper arm

    // Elbow, so the two tubes do not read as a hinge made of nothing.
    var elbowGeo = new THREE.SphereGeometry(0.066, 9, 7);
    dis.push(elbowGeo);
    var eb = new THREE.Mesh(elbowGeo, suit);
    eb.position.fromArray(elbow);
    eb.userData.noShadow = true;
    g.add(eb);

    // The cuff seal, which is the detail that says hazmat rather than sleeve.
    var cuffGeo = new THREE.CylinderGeometry(0.062, 0.058, 0.055, 10);
    dis.push(cuffGeo);
    var cuff = new THREE.Mesh(cuffGeo, seal);
    cuff.position.set(wrist[0], wrist[1], wrist[2]);
    cuff.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(elbow[0] - wrist[0], elbow[1] - wrist[1], elbow[2] - wrist[2]).normalize());
    cuff.userData.noShadow = true;
    g.add(cuff);

    // The hand, wrapped around the grip and canted with it.
    var handGeo = new THREE.BoxGeometry(0.086, 0.115, 0.10);
    dis.push(handGeo);
    var hand = new THREE.Mesh(handGeo, glove);
    hand.position.set(0.004 * lean, -0.148, 0.185);
    hand.rotation.set(0.26, 0, 0);
    hand.userData.noShadow = true;
    g.add(hand);

    // Thumb, laid along the top of the grip.
    var thumbGeo = new THREE.CylinderGeometry(0.019, 0.017, 0.085, 7);
    dis.push(thumbGeo);
    var thumb = new THREE.Mesh(thumbGeo, glove);
    thumb.position.set(-0.038 * lean, -0.108, 0.155);
    thumb.rotation.set(1.15, 0, 0.5 * lean);
    thumb.userData.noShadow = true;
    g.add(thumb);

    return g;
  }

  /* Builds one rifle. `side` is +1 for the right of the screen, -1 for the
   * left; the model is near-symmetric so mirroring the pose is enough, and it
   * avoids a negative scale (which would invert every normal). */
  Effects.prototype._buildRifle = function (side, cellColor) {
    var dis = [];
    var group = new THREE.Group();
    // The rifle is the one thing on screen at all times and a hand's width from
    // the camera, so it is where bare plastic shows most. Tighter tiling than
    // the props get: at this range a 2x tile would read as wallpaper.
    var steel = CT.detailMat(
      new THREE.MeshStandardMaterial({ color: 0x23282d, roughness: 0.42, metalness: 0.85 }),
      'metal', 4, 0.012);
    var polymer = CT.detailMat(
      new THREE.MeshStandardMaterial({ color: 0x14171a, roughness: 0.82, metalness: 0.1 }),
      'metal', 6, 0.010);
    var cellMat = new THREE.MeshStandardMaterial({
      color: 0x0a0d0a, emissive: cellColor, emissiveIntensity: 0.9
    });
    dis.push(steel, polymer, cellMat);

    function part(geo, mat, x, y, z, rx, ry, rz) {
      dis.push(geo);
      var m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      if (rx || ry || rz) m.rotation.set(rx || 0, ry || 0, rz || 0);
      m.userData.noShadow = true;
      return m;
    }

    group.add(part(new THREE.BoxGeometry(0.115, 0.13, 0.5), polymer, 0, 0, 0));                        // receiver
    group.add(part(new THREE.BoxGeometry(0.075, 0.035, 0.46), steel, 0, 0.082, -0.02));                // top rail
    group.add(part(new THREE.CylinderGeometry(0.031, 0.036, 0.52, 8), steel, 0, -0.008, -0.5, Math.PI / 2)); // barrel
    group.add(part(new THREE.CylinderGeometry(0.05, 0.047, 0.085, 8), steel, 0, -0.008, -0.78, Math.PI / 2)); // brake
    group.add(part(new THREE.BoxGeometry(0.065, 0.17, 0.075), polymer, 0, -0.135, 0.17, 0.26));        // grip
    group.add(part(new THREE.CylinderGeometry(0.042, 0.042, 0.22, 8), steel, 0, -0.12, -0.02, 0.2));   // reagent canister
    /* The heat gauge, one down each flank of the receiver.
     *
     * A dark channel with a lit bar inside it that grows from the back as the
     * weapon heats. The bar geometry is shifted so its origin is its rear face,
     * which is what lets a plain scale on z read as a bar filling rather than
     * as a block growing out of its own middle.
     *
     * It is also the player-colour tell in co-op, so it runs from the player's
     * own colour when cold through amber to red at the point of venting. */
    var GAUGE_LEN = 0.40;
    var channelMat = CT.detailMat(new THREE.MeshStandardMaterial({
      color: 0x0c0e10, roughness: 0.75, metalness: 0.3
    }), 'metal', 8, 0.006);
    dis.push(channelMat);
    var fills = [];
    for (var gi = 0; gi < 2; gi++) {
      var gx = gi ? 0.064 : -0.064;
      group.add(part(new THREE.BoxGeometry(0.024, 0.056, GAUGE_LEN), channelMat, gx, 0.012, -0.06));
      var fillGeo = new THREE.BoxGeometry(0.030, 0.040, GAUGE_LEN);
      fillGeo.translate(0, 0, GAUGE_LEN / 2);      // origin at the rear face
      dis.push(fillGeo);
      var fill = new THREE.Mesh(fillGeo, cellMat);
      fill.position.set(gx, 0.012, -0.06 - GAUGE_LEN / 2);
      fill.userData.noShadow = true;
      group.add(fill);
      fills.push(fill);
    }

    // Muzzle anchor rides on the weapon, so the flash stays attached to the
    // brake however the viewmodel is repositioned for the window shape.
    var anchor = new THREE.Object3D();
    anchor.position.set(0, -0.008, -0.86);
    group.add(anchor);

    // Ejection port, on the outboard flank of the receiver so spent brass is
    // thrown away from the centre of the screen rather than across it.
    var port = new THREE.Object3D();
    port.position.set(0.06 * side, 0.03, -0.02);
    group.add(port);

    var flashMat = new THREE.MeshBasicMaterial({
      map: flareTexture(), color: 0xffffff, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false
    });
    // The scene is tone-mapped with ACES at 0.82 exposure, which is what keeps
    // the cave from blowing out — but it also crushes an additive highlight
    // into a dull smudge. A muzzle flash is the one thing that should be
    // allowed to clip, so it opts out of tone mapping entirely.
    flashMat.toneMapped = false;
    var flash = new THREE.Mesh(this.flashGeo, flashMat);
    flash.position.copy(anchor.position);
    flash.position.z -= 0.03;            // clear of the brake, not over the barrel
    flash.scale.setScalar(0.55);
    flash.renderOrder = 10;
    flash.userData.noShadow = true;
    group.add(flash);
    dis.push(flashMat);

    if (SHOW_ARMS) group.add(buildArm(dis, side));

    group.position.set(WEAPON_HOME.x * side, WEAPON_HOME.y, WEAPON_HOME.z);
    group.rotation.set(0.03, -0.055 * side, 0.02 * side);
    this.stage.camera.add(group);

    return {
      side: side, group: group, anchor: anchor, port: port,
      flash: flash, flashMat: flashMat, flashLife: 0,
      cell: cellMat, kick: 0, dis: dis,
      fills: fills, gaugeLen: GAUGE_LEN, coldColor: new THREE.Color(cellColor),
      heat: 0, venting: 0,
      aspectX: WEAPON_HOME.x * side, aspectY: WEAPON_HOME.y
    };
  };

  /* ---- spent brass -------------------------------------------------------
   * A casing tumbles out of the ejection port on every shot. It is the cheapest
   * possible confirmation that the rifle did something mechanical, and in co-op
   * it is a second way to tell at a glance which side just fired.
   *
   * Shells live in CAMERA space alongside the viewmodel, not in the world: a
   * world-space casing would be left behind as the rail moves and would have to
   * be lit by the cave, for a two-centimetre object that exists for under a
   * second. Camera space also means they cannot fall into the play area and
   * clutter the words. */

  var MAX_SHELLS = 18;

  Effects.prototype._buildShells = function () {
    var geo = new THREE.CylinderGeometry(0.0085, 0.0095, 0.038, 6, 1, false);
    // Lay it on its side so it tumbles like a casing rather than a pillar.
    geo.rotateZ(Math.PI / 2);
    this.shellGeo = geo;
    this.shellMat = new THREE.MeshStandardMaterial({
      color: 0xc9a227, roughness: 0.34, metalness: 0.95, emissive: 0x2a1c05
    });

    this.shells = [];
    for (var i = 0; i < MAX_SHELLS; i++) {
      var m = new THREE.Mesh(geo, this.shellMat);
      m.visible = false;
      m.userData.noShadow = true;
      this.stage.camera.add(m);
      this.shells.push({
        mesh: m, life: 0, max: 1,
        vel: new THREE.Vector3(), spin: new THREE.Vector3()
      });
    }
    this.shellCursor = 0;
  };

  /* Throw one casing out of the given player's rifle. */
  Effects.prototype.ejectShell = function (slot) {
    var r = this.rifleFor(slot === undefined ? this.mySlot : slot);
    if (!r.group.visible) return;

    var sh = this.shells[this.shellCursor];
    this.shellCursor = (this.shellCursor + 1) % this.shells.length;

    // Port position expressed in camera space, which is where shells live.
    r.port.getWorldPosition(_shellV);
    this.stage.camera.worldToLocal(_shellV);
    sh.mesh.position.copy(_shellV);
    sh.mesh.rotation.set(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28);

    // Outward and up, drifting back past the player. `side` is what makes the
    // left-hand rifle throw left and the right-hand one throw right.
    var out = r.side;
    sh.vel.set(
      out * (0.55 + Math.random() * 0.35),
      0.75 + Math.random() * 0.35,
      0.45 + Math.random() * 0.3
    );
    sh.spin.set(
      (Math.random() - 0.5) * 26,
      (Math.random() - 0.5) * 26,
      (Math.random() - 0.5) * 26
    );
    sh.max = 0.85 + Math.random() * 0.25;
    sh.life = sh.max;
    sh.mesh.visible = true;
    sh.mesh.scale.setScalar(1);
  };

  Effects.prototype._updateShells = function (dt) {
    for (var i = 0; i < this.shells.length; i++) {
      var sh = this.shells[i];
      if (sh.life <= 0) continue;
      sh.life -= dt;
      if (sh.life <= 0) { sh.mesh.visible = false; continue; }

      sh.vel.y -= 2.6 * dt;                 // gravity, in viewmodel scale
      var drag = Math.exp(-1.1 * dt);
      sh.vel.multiplyScalar(drag);
      sh.mesh.position.addScaledVector(sh.vel, dt);
      sh.mesh.rotation.x += sh.spin.x * dt;
      sh.mesh.rotation.y += sh.spin.y * dt;
      sh.mesh.rotation.z += sh.spin.z * dt;

      // Shrink away over the last third rather than vanishing mid-air.
      var k = sh.life / sh.max;
      if (k < 0.34) sh.mesh.scale.setScalar(Math.max(0.01, k / 0.34));
    }
  };

  Effects.prototype._buildFlash = function () {
    // One plane geometry, shared by every muzzle flash.
    /* The flash quad sits about two units from the camera, where the whole
     * visible frame is only ~2.7 units tall. At its old 1.5 size it covered
     * roughly 40% of the screen height on every shot and painted over the
     * specimens and their words — it read as a flashbang rather than a muzzle.
     * Kept deliberately small now: a bright bloom at the brake, nothing more. */
    this.flashGeo = new THREE.PlaneGeometry(0.5, 0.5);

    // Slot 0 is player one (left of screen), slot 1 is player two (right).
    // Solo play uses slot 0's rifle but keeps it on the right, where a single
    // player expects it — setCoop() does that repositioning.
    this.rifles = [
      this._buildRifle(-1, 0x7dff4a),
      this._buildRifle(1, 0x36e0ff)
    ];
    this.mySlot = 0;
    this.coop = false;

    this._lastAspect = -1;
    this._lastFov = -1;
    this.setCoop(false, 0);
  };

  /* Solo: one rifle, bottom right. Co-op: both, P1 left and P2 right. */
  Effects.prototype.setCoop = function (coop, mySlot) {
    this.coop = !!coop;
    this.mySlot = mySlot || 0;
    for (var i = 0; i < this.rifles.length; i++) {
      var r = this.rifles[i];
      if (this.coop) {
        r.group.visible = true;
        r.side = i === 0 ? -1 : 1;
      } else {
        // Only the local player's rifle exists, and it sits on the right.
        r.group.visible = (i === this.mySlot);
        r.side = 1;
      }
      r.group.rotation.set(0.03, -0.055 * r.side, 0.02 * r.side);
    }
    this._lastAspect = -1;      // force a re-layout for the new sides
    this._layoutWeapon();
  };

  Effects.prototype.rifleFor = function (slot) {
    return this.rifles[slot === 1 ? 1 : 0];
  };

  /* Keep each viewmodel pinned to its corner at any window shape.
   * three.js FOV is vertical, so a tall or narrow window shrinks the horizontal
   * extent while leaving the weapon's world size alone — at portrait aspect a
   * fixed offset drags the rifle into the middle of the screen. */
  Effects.prototype._layoutWeapon = function () {
    var cam = this.stage.camera;
    var aspect = cam.aspect;
    if (!(aspect > 0)) return;
    if (Math.abs(aspect - this._lastAspect) < 0.005 && cam.fov === this._lastFov) return;
    this._lastAspect = aspect;
    this._lastFov = cam.fov;

    // Half the visible width at the weapon's depth, in world units.
    var halfW = Math.tan(cam.fov * Math.PI / 360) * aspect * Math.abs(WEAPON_HOME.z);

    // 0 at a normal widescreen window, 1 at an extremely tall/narrow one. As the
    // window narrows the rifle has to travel further out toward the corner and
    // shrink, or its (aspect-independent) world size swallows the middle of the
    // screen and hides the specimens behind it.
    var t = CT.clamp((1.78 - aspect) / 1.18, 0, 1);
    var frac = CT.lerp(0.217, 0.85, t);        // 0.217 reproduces the 16:9 pose
    var scale = CT.lerp(1, 0.6, t);
    // Two rifles on one screen need to sit further out and smaller than one.
    if (this.coop) { frac *= 1.18; scale *= 0.88; }

    for (var i = 0; i < this.rifles.length; i++) {
      var r = this.rifles[i];
      r.aspectX = frac * halfW * r.side;
      r.aspectY = WEAPON_HOME.y - t * 0.09;
      r.group.scale.setScalar(scale);
    }
  };

  /* Where a given player's shots visually originate. */
  Effects.prototype.muzzleWorld = function (out, slot) {
    out = out || new THREE.Vector3();
    return this.rifleFor(slot === undefined ? this.mySlot : slot).anchor.getWorldPosition(out);
  };

  Effects.prototype.muzzleFlash = function (power, slot) {
    var r = this.rifleFor(slot === undefined ? this.mySlot : slot);
    if (!r.group.visible) return;
    r.flashLife = 0.07;
    r.flashMat.opacity = S().get('glow') ? 1.0 : 0.55;
    r.flash.scale.setScalar(0.40 + (power || 1) * 0.24);
    r.flash.rotation.z = Math.random() * Math.PI * 2;
    r.kick = Math.min(1.2, r.kick + 0.7 * (power || 1));
  };

  /* ---- frame ------------------------------------------------------------- */

  Effects.prototype.update = function (dt, time) {
    // particles
    var pos = this.pPos, vel = this.pVel, life = this.pLife, maxl = this.pMaxLife, grav = this.pGrav;
    var any = false;
    for (var i = 0; i < MAX_PARTICLES; i++) {
      if (life[i] <= 0) continue;
      any = true;
      life[i] -= dt;
      var o = i * 3;
      if (life[i] <= 0) { pos[o + 1] = -9999; continue; }
      vel[o + 1] -= grav[i] * dt;
      // drag
      var drag = Math.exp(-2.2 * dt);
      vel[o] *= drag; vel[o + 1] *= drag; vel[o + 2] *= drag;
      pos[o] += vel[o] * dt;
      pos[o + 1] += vel[o + 1] * dt;
      pos[o + 2] += vel[o + 2] * dt;
      if (pos[o + 1] < 0.03) { pos[o + 1] = 0.03; vel[o + 1] *= -0.25; vel[o] *= 0.6; vel[o + 2] *= 0.6; }
      // fade via colour since PointsMaterial has one global opacity
      var f = life[i] / maxl[i];
      var c = this.pCol;
      c[o] *= (0.986 + f * 0.012); // keeps hot cores bright, dims tails
      c[o + 1] *= (0.984 + f * 0.012);
      c[o + 2] *= (0.982 + f * 0.012);
    }
    if (any) {
      this.pGeo.attributes.position.needsUpdate = true;
      this.pGeo.attributes.color.needsUpdate = true;
    }

    // blood
    var bp = this.bPos, bv = this.bVel, bl = this.bLife, bm = this.bMax, ba = this.bAlpha;
    var anyB = false;
    for (var b = 0; b < MAX_BLOOD; b++) {
      if (bl[b] <= 0) continue;
      anyB = true;
      bl[b] -= dt;
      var bo = b * 3;
      if (bl[b] <= 0) { bp[bo + 1] = -9999; ba[b] = 0; continue; }
      var grav = this.bGrav[b];
      bv[bo + 1] -= grav * dt;                     // blood is heavy, steam rises
      var bd = Math.exp((grav < 0 ? -2.6 : -1.1) * dt);
      bv[bo] *= bd; bv[bo + 2] *= bd;
      if (grav < 0) bv[bo + 1] *= bd;
      bp[bo] += bv[bo] * dt;
      bp[bo + 1] += bv[bo + 1] * dt;
      bp[bo + 2] += bv[bo + 2] * dt;
      if (grav > 0 && bp[bo + 1] < 0.02) {
        // Lands and stays landed rather than bouncing like a spark. Blood that
        // ricochets looks like gravel.
        bp[bo + 1] = 0.02;
        bv[bo] *= 0.2; bv[bo + 1] = 0; bv[bo + 2] *= 0.2;
      }
      var bf = bl[b] / bm[b];
      ba[b] = bf > 0.4 ? 1 : bf / 0.4;
    }
    if (anyB) {
      this.bGeo.attributes.position.needsUpdate = true;
      this.bGeo.attributes.aAlpha.needsUpdate = true;
      this.bGeo.attributes.aColor.needsUpdate = true;
      this.bGeo.attributes.aSize.needsUpdate = true;
    }
    if (this.stage.scene.fog) this.bMat.uniforms.fogDensity.value = this.stage.scene.fog.density;

    // flying pieces
    for (var ci = 0; ci < this.chunks.length; ci++) {
      var ch = this.chunks[ci];
      if (ch.life <= 0) continue;
      ch.life -= dt;
      if (ch.life <= 0) { ch.mesh.visible = false; continue; }
      ch.vel.y -= 26 * dt;
      ch.mesh.position.addScaledVector(ch.vel, dt);
      if (ch.mesh.position.y < ch.ground) {
        ch.mesh.position.y = ch.ground;
        ch.vel.set(ch.vel.x * 0.3, Math.abs(ch.vel.y) * 0.22, ch.vel.z * 0.3);
        ch.spin.multiplyScalar(0.35);
      }
      ch.mesh.rotation.x += ch.spin.x * dt;
      ch.mesh.rotation.y += ch.spin.y * dt;
      ch.mesh.rotation.z += ch.spin.z * dt;
      // Sinks away over the last third rather than vanishing mid-air.
      var cf = ch.life / ch.max;
      ch.mesh.scale.setScalar(ch.scale0 * (cf > 0.3 ? 1 : cf / 0.3));
    }

    // floor splats
    for (var si = 0; si < this.splats.length; si++) {
      var sl = this.splats[si];
      if (sl.life <= 0) continue;
      sl.life -= dt;
      if (sl.life <= 0) { sl.mesh.visible = false; sl.mat.opacity = 0; continue; }
      var sf = sl.life / sl.max;
      sl.mat.opacity = 0.85 * (sf > 0.55 ? 1 : sf / 0.55);
    }

    if (this.killLight.intensity > 0) {
      this.killLight.intensity = Math.max(0, this.killLight.intensity - dt * 34);
    }

    // rings
    for (var r = 0; r < this.rings.length; r++) {
      var rg = this.rings[r];
      if (rg.life <= 0) continue;
      rg.life -= dt;
      var k = 1 - rg.life / rg.max;
      rg.mesh.scale.setScalar(0.1 + k * rg.size * 2.2);
      rg.mat.opacity = Math.max(0, 0.9 * (1 - k));
      if (rg.life <= 0) rg.mesh.visible = false;
    }

    this._updateShells(dt);

    // flash + weapons
    this._layoutWeapon();
    for (var wi = 0; wi < this.rifles.length; wi++) {
      var r = this.rifles[wi];
      if (r.flashLife > 0) {
        r.flashLife -= dt;
        r.flashMat.opacity = Math.max(0, r.flashLife / 0.07);
        if (r.flashLife <= 0) r.flashMat.opacity = 0;
      }
      if (!r.group.visible) continue;
      r.kick = Math.max(0, r.kick - dt * 6.5);
      var k2 = r.kick * r.kick;
      r.group.position.set(
        r.aspectX,
        r.aspectY - k2 * 0.014 + Math.sin(time * 1.7 + wi) * 0.005,
        WEAPON_HOME.z + k2 * 0.10
      );
      r.group.rotation.x = 0.03 + k2 * 0.26 + r.venting * 0.20;
      r.group.rotation.z = (0.02 + Math.sin(time * 1.3 + wi) * 0.01) * r.side;
    }
    this._updateHeat(dt, time);
  };

  /* ---- overheat ----------------------------------------------------------
   *
   * The gauge and the venting animation. The heat VALUE lives on the player in
   * js/game.js, because it is a rule of the game rather than a property of the
   * model; this only draws it. */

  var HOT_MID = new THREE.Color(0xff8c06);
  // Full red, not a dark one: the gauge is small and a hand's width from the
  // camera, and the whole job of the top of the bar is to be unmissable.
  var HOT_MAX = new THREE.Color(0xff0a00);
  var _heatCol = new THREE.Color();

  Effects.prototype.setHeat = function (slot, heat, locked) {
    var r = this.rifles[slot];
    if (!r) return;
    r.heat = CT.clamp(heat, 0, 1);
    r.locked = !!locked;
  };

  /* Called once when a weapon actually blows, for the one-off part: the kick,
   * the vent puff and the noise. */
  Effects.prototype.vent = function (slot) {
    var r = this.rifles[slot];
    if (!r) return;
    r.venting = 1;
    r.kick = Math.max(r.kick, 1.6);
    // Small wisps, because the breach is right under the camera. The additive
    // burst() used for impacts is the wrong tool here: at this range its fixed
    // point size covers a quarter of the screen.
    var p = new THREE.Vector3();
    r.port.getWorldPosition(p);
    this.steam(p, 30, 1.1, 0.75, 0.055);
    r.anchor.getWorldPosition(p);
    this.steam(p, 14, 0.8, 0.6, 0.05);
  };

  Effects.prototype._updateHeat = function (dt, time) {
    for (var i = 0; i < this.rifles.length; i++) {
      var r = this.rifles[i];
      if (r.venting > 0) r.venting = Math.max(0, r.venting - dt * 1.6);
      if (!r.group.visible) continue;

      // The bar fills from the back. A floor of 4% keeps a sliver lit at zero
      // heat, so the gauge still reads as a gauge rather than as an empty slot.
      var shown = 0.04 + r.heat * 0.96;
      for (var f = 0; f < r.fills.length; f++) r.fills[f].scale.z = shown;

      // Player colour when cold, amber through the middle, red at the top.
      if (r.heat < 0.5) _heatCol.copy(r.coldColor).lerp(HOT_MID, r.heat / 0.5);
      else _heatCol.copy(HOT_MID).lerp(HOT_MAX, (r.heat - 0.5) / 0.5);

      var pulse = 0.7 + Math.sin(time * 6 + i) * 0.22 + r.kick * r.kick * 2.2;
      if (r.locked) {
        // Hard strobe while it is actually locked out, so the reason the rifle
        // is not firing is never a mystery.
        _heatCol.copy(HOT_MAX);
        pulse = 4.2 + Math.sin(time * 34) * 3.2;
      } else if (r.heat > 0.72) {
        // A warning flicker before it goes, proportional to how close it is.
        pulse += (r.heat - 0.72) / 0.28 * (1.6 + Math.sin(time * 19) * 1.4);
      }
      pulse += r.venting * 3.0;

      r.cell.color.copy(_heatCol).multiplyScalar(0.18);
      r.cell.emissive.copy(_heatCol);
      // Emissive alone is tone-mapped down with everything else; letting the
      // gauge opt out is what keeps a hot bar reading as hot rather than as a
      // slightly warmer grey.
      r.cell.toneMapped = r.heat < 0.55;
      r.cell.emissiveIntensity = pulse;
    }
  };

  Effects.prototype.setWeaponVisible = function (v) {
    if (!v) {
      for (var sI = 0; sI < this.shells.length; sI++) {
        this.shells[sI].life = 0;
        this.shells[sI].mesh.visible = false;
      }
    }
    for (var i = 0; i < this.rifles.length; i++) {
      var r = this.rifles[i];
      var shouldShow = v && (this.coop || i === this.mySlot);
      r.group.visible = !!shouldShow;
      if (!shouldShow) { r.flashMat.opacity = 0; r.flashLife = 0; r.kick = 0; }
    }
  };

  Effects.prototype.dispose = function () {
    this.pGeo.dispose(); this.pMat.dispose();
    this.bGeo.dispose(); this.bMat.dispose();
    for (var cg = 0; cg < this.chunkGeos.length; cg++) this.chunkGeos[cg].dispose();
    this.chunkMat.dispose();
    this.splatGeo.dispose();
    for (var sm = 0; sm < this.splatMats.length; sm++) this.splatMats[sm].dispose();
    for (var gk in _goreTex) { if (_goreTex[gk]) _goreTex[gk].dispose(); }
    _goreTex = {};
    this.ringGeo.dispose();
    for (var r = 0; r < this.rings.length; r++) this.rings[r].mat.dispose();
    this.flashGeo.dispose();
    if (_flareTex) { _flareTex.dispose(); _flareTex = null; }
    this.shellGeo.dispose();
    this.shellMat.dispose();
    for (var sd = 0; sd < this.shells.length; sd++) this.stage.camera.remove(this.shells[sd].mesh);
    for (var w = 0; w < this.rifles.length; w++) {
      var rf = this.rifles[w];
      for (var d = 0; d < rf.dis.length; d++) rf.dis[d].dispose();
      this.stage.camera.remove(rf.group);
    }
    this.stage.scene.remove(this.root);
  };

  CT.Effects = Effects;
})(window);
