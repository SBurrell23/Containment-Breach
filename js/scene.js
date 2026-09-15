/* Cave Typer — renderer, camera rig, lighting, quality plumbing.
 *
 * The world runs down the -Z axis: the player station sits at some z, looks
 * toward -Z, and monsters walk toward +Z to reach them. */
(function (global) {
  'use strict';
  var CT = (global.CaveTyper = global.CaveTyper || {});
  var S = function () { return CT.Settings; };

  var FOG_COLOR = 0x05070a;

  function Stage(canvasHost) {
    this.host = canvasHost;
    this.renderer = null;
    this.canvas = null;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(FOG_COLOR);
    this.scene.fog = new THREE.FogExp2(FOG_COLOR, 0.023);

    this.camera = new THREE.PerspectiveCamera(68, 1, 0.1, 400);

    /* Rig: rigRoot holds the station position, shakeNode holds transient
     * recoil/shake, camera hangs off that. Keeps shake from fighting movement. */
    this.rigRoot = new THREE.Group();
    this.shakeNode = new THREE.Group();
    this.rigRoot.add(this.shakeNode);
    this.shakeNode.add(this.camera);
    this.scene.add(this.rigRoot);
    this.camera.position.set(0, 1.62, 0);

    this._shake = 0;
    this._shakeDecay = 3.2;
    this._recoil = 0;
    this._lookTarget = new THREE.Vector2(0, 0);
    this._look = new THREE.Vector2(0, 0);

    this.buildLights();
    this.buildRenderer();

    var self = this;
    this._onResize = function () { self.resize(); };
    global.addEventListener('resize', this._onResize);

    S().onChange(function (k, v) {
      if (k === 'antialias') self.buildRenderer();
      else if (k === 'resolutionScale') self.resize();
      else if (k === 'fov') { self.camera.fov = v; self.camera.updateProjectionMatrix(); }
      else if (k === 'shadows') self.applyShadowSetting();
      else if (k === 'fogDensity') self.applyFog();
    });
  }

  Stage.prototype.buildLights = function () {
    // Barely-there fill so silhouettes never go fully black.
    this.ambient = new THREE.AmbientLight(0x1b2430, 0.62);
    this.scene.add(this.ambient);

    this.hemi = new THREE.HemisphereLight(0x2b3a4a, 0x0a0d10, 0.34);
    this.scene.add(this.hemi);

    // The player's lamp. Attached to the camera so it always points where you look.
    // It sits AHEAD of the viewmodel: at the camera origin it is close enough to
    // the weapon to blow it out to solid white.
    this.lamp = new THREE.SpotLight(0xd7e9ff, 1.25, 78, Math.PI * 0.30, 0.75, 0.9);
    this.lamp.position.set(0, 0.1, -2.1);
    this.lamp.target.position.set(0, -0.15, -14);
    this.camera.add(this.lamp);
    this.camera.add(this.lamp.target);

    // A warm bounce right at the station so the player's own space reads.
    this.stationLight = new THREE.PointLight(0xff9a5c, 0.6, 16, 1.6);
    this.stationLight.position.set(0, 2.4, 1.2);
    this.rigRoot.add(this.stationLight);

    // Muzzle flash light, pulsed on each shot.
    this.muzzle = new THREE.PointLight(0xffd9a0, 0, 26, 2.0);
    this.muzzle.position.set(0, 1.35, -1.0);
    this.rigRoot.add(this.muzzle);

    // Red alert light that swells when a player is hurt.
    this.alertLight = new THREE.PointLight(0xff2a2a, 0, 20, 2.0);
    this.alertLight.position.set(0, 1.8, 0.5);
    this.rigRoot.add(this.alertLight);
  };

  Stage.prototype.buildRenderer = function () {
    var oldCanvas = this.canvas;
    if (this.renderer) { this.renderer.dispose(); }

    this.renderer = new THREE.WebGLRenderer({
      antialias: !!S().get('antialias'),
      powerPreference: 'high-performance',
      stencil: false,
      alpha: false
    });
    this.renderer.setClearColor(FOG_COLOR, 1);
    this.renderer.outputEncoding = THREE.sRGBEncoding;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.82;
    this.canvas = this.renderer.domElement;
    this.canvas.id = 'gl';

    if (oldCanvas && oldCanvas.parentNode) oldCanvas.parentNode.removeChild(oldCanvas);
    this.host.appendChild(this.canvas);

    this.applyShadowSetting();
    this.applyFog();
    this.camera.fov = S().getNum('fov');
    this.camera.updateProjectionMatrix();
    this.resize();
  };

  Stage.prototype.applyShadowSetting = function () {
    if (!this.renderer) return;
    var on = !!S().get('shadows');
    this.renderer.shadowMap.enabled = on;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.lamp.castShadow = on;
    if (on) {
      this.lamp.shadow.mapSize.width = 1024;
      this.lamp.shadow.mapSize.height = 1024;
      this.lamp.shadow.camera.near = 0.5;
      this.lamp.shadow.camera.far = 60;
      this.lamp.shadow.bias = -0.0012;
    }
    this.scene.traverse(function (o) {
      if (o.isMesh) { o.castShadow = on && !o.userData.noShadow; o.receiveShadow = on; }
    });
  };

  Stage.prototype.applyFog = function () {
    var d = S().getNum('fogDensity');
    this.scene.fog.density = 0.023 * d;
  };

  Stage.prototype.resize = function () {
    if (!this.renderer) return;
    var w = this.host.clientWidth || global.innerWidth;
    var h = this.host.clientHeight || global.innerHeight;
    var scale = S().getNum('resolutionScale') || 1;
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(dpr * scale);
    this.renderer.setSize(w, h, true);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  };

  /* ---- feel ------------------------------------------------------------- */

  Stage.prototype.addShake = function (amount) {
    var mul = S().getNum('screenShake');
    this._shake = Math.min(1.6, this._shake + amount * mul);
  };

  Stage.prototype.fireFeedback = function (power) {
    this._recoil = Math.min(1.0, this._recoil + 0.5 * (power || 1));
    this.addShake(0.16 * (power || 1));
    this.muzzle.intensity = 6.5 * (power || 1);
  };

  Stage.prototype.hurtFeedback = function () {
    this.addShake(0.55);
    // Kept deliberately modest: this light reaches everything within 20 units,
    // and a hard red wash over the whole chamber hides the words at exactly the
    // moment the player most needs to read them.
    this.alertLight.intensity = 2.6;
  };

  /* Nudges the camera toward whichever monster is being targeted, so the player
   * feels like they are aiming. `dir` is a world-space direction. */
  Stage.prototype.lookToward = function (worldPos) {
    if (!worldPos) { this._lookTarget.set(0, 0); return; }
    var local = this.rigRoot.worldToLocal(worldPos.clone());
    var dist = Math.max(3, Math.abs(local.z));
    this._lookTarget.set(
      CT.clamp(local.x / dist, -0.55, 0.55),
      CT.clamp((local.y - 1.6) / dist, -0.35, 0.35)
    );
  };

  Stage.prototype.update = function (dt, time) {
    // shake
    this._shake = Math.max(0, this._shake - this._shakeDecay * dt * (0.4 + this._shake));
    var s = this._shake * this._shake;
    var n = time * 47;
    this.shakeNode.position.set(
      Math.sin(n * 1.7) * 0.10 * s,
      Math.sin(n * 2.3 + 1.1) * 0.09 * s,
      Math.sin(n * 1.1 + 2.2) * 0.05 * s
    );
    this.shakeNode.rotation.z = Math.sin(n * 1.9 + 0.5) * 0.035 * s;

    // recoil kicks the camera up and back, then settles
    this._recoil = Math.max(0, this._recoil - dt * 4.5);
    var r = this._recoil * this._recoil;

    // aim drift toward target
    this._look.x = CT.damp(this._look.x, this._lookTarget.x, 7, dt);
    this._look.y = CT.damp(this._look.y, this._lookTarget.y, 7, dt);

    this.camera.rotation.set(this._look.y + r * 0.10, -this._look.x * 0.9, 0, 'YXZ');
    this.camera.position.z = r * 0.22;

    // light falloffs
    this.muzzle.intensity = Math.max(0, this.muzzle.intensity - dt * 42);
    this.alertLight.intensity = Math.max(0, this.alertLight.intensity - dt * 7);

    if (S().get('lightFlicker')) {
      this.stationLight.intensity = 0.6 + Math.sin(time * 13.7) * 0.05 + Math.sin(time * 41.3) * 0.025;
      this.lamp.intensity = 1.25 + Math.sin(time * 9.1) * 0.05;
    } else {
      this.stationLight.intensity = 0.6;
      this.lamp.intensity = 1.25;
    }
  };

  Stage.prototype.render = function () {
    this.renderer.render(this.scene, this.camera);
  };

  /* Where the rig is standing right now, in world space. */
  Stage.prototype.stationPos = function () { return this.rigRoot.position; };

  Stage.prototype.dispose = function () {
    global.removeEventListener('resize', this._onResize);
    if (this.renderer) this.renderer.dispose();
  };

  CT.Stage = Stage;
  CT.FOG_COLOR = FOG_COLOR;
})(window);
