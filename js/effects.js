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

  function Effects(stage) {
    this.stage = stage;
    this.root = new THREE.Group();
    this.root.frustumCulled = false;
    stage.scene.add(this.root);

    this._buildParticles();
    this._buildTracers();
    this._buildFlash();
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

  /* ---- muzzle flash ------------------------------------------------------ */

  Effects.prototype._buildFlash = function () {
    var geo = new THREE.PlaneGeometry(1.5, 1.5);
    this.flashGeo = geo;
    var mat = new THREE.MeshBasicMaterial({
      color: 0xffd48a, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false
    });
    this.flashMat = mat;
    this.flash = new THREE.Mesh(geo, mat);
    this.flash.renderOrder = 10;
    this.flash.userData.noShadow = true;
    this.flashLife = 0;

    // The dictation rifle. A viewmodel sits centimetres from the near plane, so
    // everything here is deliberately small and pushed well forward — anything
    // chunky at this range swallows the bottom third of the screen.
    this.weapon = new THREE.Group();
    var dis = [];
    var steel = new THREE.MeshStandardMaterial({ color: 0x23282d, roughness: 0.42, metalness: 0.85 });
    var polymer = new THREE.MeshStandardMaterial({ color: 0x14171a, roughness: 0.82, metalness: 0.1 });
    var cellMat = new THREE.MeshStandardMaterial({ color: 0x0a0d0a, emissive: 0x7dff4a, emissiveIntensity: 0.9 });
    dis.push(steel, polymer, cellMat);

    function part(geo, mat, x, y, z, rx, ry, rz) {
      dis.push(geo);
      var m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      if (rx || ry || rz) m.rotation.set(rx || 0, ry || 0, rz || 0);
      m.userData.noShadow = true;
      return m;
    }

    var W = this.weapon;
    W.add(part(new THREE.BoxGeometry(0.115, 0.13, 0.5), polymer, 0, 0, 0));                        // receiver
    W.add(part(new THREE.BoxGeometry(0.075, 0.035, 0.46), steel, 0, 0.082, -0.02));                // top rail
    W.add(part(new THREE.CylinderGeometry(0.031, 0.036, 0.52, 8), steel, 0, -0.008, -0.5, Math.PI / 2)); // barrel
    W.add(part(new THREE.CylinderGeometry(0.05, 0.047, 0.085, 8), steel, 0, -0.008, -0.78, Math.PI / 2)); // brake
    W.add(part(new THREE.BoxGeometry(0.065, 0.17, 0.075), polymer, 0, -0.135, 0.17, 0.26));        // grip
    W.add(part(new THREE.CylinderGeometry(0.042, 0.042, 0.22, 8), steel, 0, -0.12, -0.02, 0.2));   // reagent canister
    // The charge cell is the only lit element; it stays a thin sliver on the
    // flank rather than a glowing slab across the top.
    var cell = part(new THREE.BoxGeometry(0.018, 0.045, 0.21), cellMat, -0.062, 0.012, -0.05);
    W.add(cell);
    W.add(part(new THREE.BoxGeometry(0.018, 0.045, 0.21), cellMat, 0.062, 0.012, -0.05));

    // Muzzle anchor rides on the weapon, so tracers and the flash stay attached
    // to the brake however the viewmodel is repositioned for the window shape.
    this.muzzleAnchor = new THREE.Object3D();
    this.muzzleAnchor.position.set(0, -0.008, -0.86);
    W.add(this.muzzleAnchor);
    this.flash.position.copy(this.muzzleAnchor.position);
    this.flash.scale.setScalar(0.55);
    W.add(this.flash);

    this.weaponVent = cellMat;
    this.weapon.position.set(0.30, -0.30, -1.15);
    this.weapon.rotation.set(0.03, -0.055, 0.02);
    this.stage.camera.add(this.weapon);
    this._weaponKick = 0;
    this._weaponHome = this.weapon.position.clone();
    this._weaponDis = dis;
    this._lastAspect = -1;
    this._lastFov = -1;
    this._layoutWeapon();
  };

  /* Keep the viewmodel pinned to the lower-right corner at any window shape.
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

    var home = this._weaponHome;
    // Half the visible width at the weapon's depth, in world units.
    var halfW = Math.tan(cam.fov * Math.PI / 360) * aspect * Math.abs(home.z);

    // 0 at a normal widescreen window, 1 at an extremely tall/narrow one. As the
    // window narrows the rifle has to travel further out toward the corner and
    // shrink, or its (aspect-independent) world size swallows the middle of the
    // screen and hides the specimens behind it.
    var t = CT.clamp((1.78 - aspect) / 1.18, 0, 1);
    var frac = CT.lerp(0.217, 0.85, t);        // 0.217 reproduces the 16:9 pose
    this._aspectX = frac * halfW;
    this._aspectY = home.y - t * 0.09;
    this.weapon.scale.setScalar(CT.lerp(1, 0.6, t));
  };

  Effects.prototype.muzzleWorld = function (out) {
    out = out || new THREE.Vector3();
    return this.muzzleAnchor.getWorldPosition(out);
  };

  Effects.prototype.muzzleFlash = function (power) {
    this.flashLife = 0.07;
    this.flashMat.opacity = S().get('glow') ? 1.0 : 0.55;
    this.flash.scale.setScalar(0.42 + (power || 1) * 0.3);
    this.flash.rotation.z = Math.random() * Math.PI * 2;
    this._weaponKick = Math.min(1.2, this._weaponKick + 0.7 * (power || 1));
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

    // flash + weapon
    if (this.flashLife > 0) {
      this.flashLife -= dt;
      this.flashMat.opacity = Math.max(0, this.flashLife / 0.07);
      if (this.flashLife <= 0) this.flashMat.opacity = 0;
    }
    this._layoutWeapon();
    this._weaponKick = Math.max(0, this._weaponKick - dt * 6.5);
    var k2 = this._weaponKick * this._weaponKick;
    var home = this._weaponHome;
    this.weapon.position.set(
      this._aspectX,
      this._aspectY - k2 * 0.014 + Math.sin(time * 1.7) * 0.005,
      home.z + k2 * 0.10
    );
    this.weapon.rotation.x = 0.03 + k2 * 0.26;
    this.weapon.rotation.z = 0.02 + Math.sin(time * 1.3) * 0.01;
    this.weaponVent.emissiveIntensity = 0.7 + Math.sin(time * 6) * 0.22 + k2 * 2.2;
  };

  Effects.prototype.setWeaponVisible = function (v) {
    this.weapon.visible = v;
    if (!v) { this.flashMat.opacity = 0; this.flashLife = 0; }
  };

  Effects.prototype.dispose = function () {
    this.pGeo.dispose(); this.pMat.dispose();
    this.tracerGeo.dispose();
    for (var i = 0; i < this.tracers.length; i++) this.tracers[i].mat.dispose();
    this.ringGeo.dispose();
    for (var r = 0; r < this.rings.length; r++) this.rings[r].mat.dispose();
    this.flashGeo.dispose(); this.flashMat.dispose();
    this.weapon.remove(this.flash);
    for (var d = 0; d < this._weaponDis.length; d++) this._weaponDis[d].dispose();
    this.stage.camera.remove(this.weapon);
    this.stage.scene.remove(this.root);
  };

  CT.Effects = Effects;
})(window);
