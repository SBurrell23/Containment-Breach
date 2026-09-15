/* Cave Typer — pooled hit effects: tracers, impact sparks, gore, muzzle flash.
 *
 * Everything is pre-allocated. Nothing here creates geometry at runtime, so a
 * long run does not stutter on GC. */
(function (global) {
  'use strict';
  var CT = (global.CaveTyper = global.CaveTyper || {});
  var S = function () { return CT.Settings; };

  var MAX_PARTICLES = 1400;
  var MAX_TRACERS = 16;
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

  function Effects(stage) {
    this.stage = stage;
    this.root = new THREE.Group();
    this.root.frustumCulled = false;
    stage.scene.add(this.root);

    this._buildParticles();
    this._buildTracers();
    this._buildFlash();
    this._buildShells();
    this._buildRings();
  }

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

  /* Splash of specimen fluid where a shot lands. */
  Effects.prototype.impact = function (pos, color) {
    this.burst(pos, color || 0x9bff2e, 14, 4.5, 1.0, 9, 0.55);
    this.burst(pos, 0xfff0c0, 6, 7.0, 1.0, 2, 0.16);
    this.ring(pos, color || 0x9bff2e, 0.9);
  };

  /* A monster comes apart. */
  Effects.prototype.gib = function (pos, color, big) {
    this.burst(pos, color || 0x9bff2e, big ? 110 : 34, big ? 7 : 4.5, 1.0, 11, big ? 1.4 : 0.9);
    this.burst(pos, 0xffd9a0, big ? 30 : 10, big ? 9 : 6, 1.0, 5, 0.4);
    this.ring(pos, color || 0x9bff2e, big ? 3.5 : 1.6);
  };

  /* ---- tracers ----------------------------------------------------------- */

  Effects.prototype._buildTracers = function () {
    this.tracers = [];
    var geo = new THREE.CylinderGeometry(0.035, 0.008, 1, 5, 1, true);
    geo.translate(0, -0.5, 0);           // origin at the muzzle end
    geo.rotateX(Math.PI / 2);            // now points down -Z
    this.tracerGeo = geo;
    for (var i = 0; i < MAX_TRACERS; i++) {
      var mat = new THREE.MeshBasicMaterial({
        color: 0xffe9b0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.DoubleSide
      });
      var m = new THREE.Mesh(geo, mat);
      m.visible = false;
      m.frustumCulled = false;
      m.userData.noShadow = true;
      this.root.add(m);
      this.tracers.push({ mesh: m, mat: mat, life: 0 });
    }
    this.tracerCursor = 0;
  };

  Effects.prototype.tracer = function (from, to, color) {
    var t = this.tracers[this.tracerCursor];
    this.tracerCursor = (this.tracerCursor + 1) % this.tracers.length;
    t.mesh.position.copy(from);
    t.mesh.lookAt(to);
    var d = from.distanceTo(to);
    t.mesh.scale.set(1, 1, d);
    t.mesh.visible = true;
    t.mat.color.setHex(color || 0xffe9b0);
    t.mat.opacity = 1;
    t.life = 0.085;
  };

  /* ---- expanding shock rings -------------------------------------------- */

  Effects.prototype._buildRings = function () {
    this.rings = [];
    var geo = new THREE.RingGeometry(0.5, 0.62, 18);
    this.ringGeo = geo;
    for (var i = 0; i < 10; i++) {
      var mat = new THREE.MeshBasicMaterial({
        color: 0x9bff2e, transparent: true, opacity: 0, side: THREE.DoubleSide,
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

  /* Builds one rifle. `side` is +1 for the right of the screen, -1 for the
   * left; the model is near-symmetric so mirroring the pose is enough, and it
   * avoids a negative scale (which would invert every normal). */
  Effects.prototype._buildRifle = function (side, cellColor) {
    var dis = [];
    var group = new THREE.Group();
    var steel = new THREE.MeshStandardMaterial({ color: 0x23282d, roughness: 0.42, metalness: 0.85 });
    var polymer = new THREE.MeshStandardMaterial({ color: 0x14171a, roughness: 0.82, metalness: 0.1 });
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
    // The charge cell is the only lit element, and it carries the player colour
    // so the two rifles are told apart at a glance.
    group.add(part(new THREE.BoxGeometry(0.018, 0.045, 0.21), cellMat, -0.062, 0.012, -0.05));
    group.add(part(new THREE.BoxGeometry(0.018, 0.045, 0.21), cellMat, 0.062, 0.012, -0.05));

    // Muzzle anchor rides on the weapon, so tracers and the flash stay attached
    // to the brake however the viewmodel is repositioned for the window shape.
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

    group.position.set(WEAPON_HOME.x * side, WEAPON_HOME.y, WEAPON_HOME.z);
    group.rotation.set(0.03, -0.055 * side, 0.02 * side);
    this.stage.camera.add(group);

    return {
      side: side, group: group, anchor: anchor, port: port,
      flash: flash, flashMat: flashMat, flashLife: 0,
      cell: cellMat, kick: 0, dis: dis,
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

    // tracers
    for (var t = 0; t < this.tracers.length; t++) {
      var tr = this.tracers[t];
      if (tr.life <= 0) continue;
      tr.life -= dt;
      tr.mat.opacity = Math.max(0, tr.life / 0.085);
      if (tr.life <= 0) { tr.mesh.visible = false; tr.mat.opacity = 0; }
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
      r.group.rotation.x = 0.03 + k2 * 0.26;
      r.group.rotation.z = (0.02 + Math.sin(time * 1.3 + wi) * 0.01) * r.side;
      r.cell.emissiveIntensity = 0.7 + Math.sin(time * 6 + wi) * 0.22 + k2 * 2.2;
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
    this.tracerGeo.dispose();
    for (var i = 0; i < this.tracers.length; i++) this.tracers[i].mat.dispose();
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
