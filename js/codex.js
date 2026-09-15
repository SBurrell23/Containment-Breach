/* Cave Typer — the specimen compendium.
 *
 * A grid of every specimen type, locked until you have met it, with a live 3D
 * preview of the selected one. The preview is a real build from the same model
 * code the game uses, driven through the same animation states — a compendium
 * of procedurally generated creatures that showed static art would be lying
 * about what the player actually fought.
 *
 * It owns its own small WebGLRenderer, created when the screen opens and
 * disposed when it closes, so it never contends with the game's renderer or
 * leaves a second GL context alive during play. */
(function (global) {
  'use strict';
  var CT = (global.CaveTyper = global.CaveTyper || {});
  var S = function () { return CT.Settings; };

  var TIER_LABEL = { grunt: 'MINOR', mid: 'MAJOR', boss: 'APEX' };
  var TIER_ORDER = { grunt: 0, mid: 1, boss: 2 };

  function Codex() {
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.instance = null;      // built model currently on show
    this.def = null;
    this.raf = null;
    this.t = 0;
    this.stateCycle = 0;
    this.open = false;
  }

  Codex.prototype._ensureRenderer = function (host) {
    if (this.renderer) return;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setClearColor(0x05070a, 0);
    this.renderer.outputEncoding = THREE.sRGBEncoding;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.domElement.className = 'codex-canvas';
    host.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);

    // Deliberately brighter and more even than the cave: this is a specimen
    // under examination lights, not something lunging at you out of fog.
    this.scene.add(new THREE.AmbientLight(0x2c3a48, 0.9));
    var key = new THREE.DirectionalLight(0xdbe9ff, 1.5);
    key.position.set(2.5, 4, 3.5);
    this.scene.add(key);
    var rim = new THREE.DirectionalLight(0x7dff4a, 0.7);
    rim.position.set(-3, 1.5, -2.5);
    this.scene.add(rim);
    var fill = new THREE.DirectionalLight(0x36e0ff, 0.35);
    fill.position.set(-1.5, 0.5, 3);
    this.scene.add(fill);

    this.pivot = new THREE.Group();
    this.scene.add(this.pivot);

    // A dim disc so the specimen is standing on something.
    var padGeo = new THREE.CircleGeometry(1, 32);
    var padMat = new THREE.MeshBasicMaterial({
      color: 0x0e1a14, transparent: true, opacity: 0.55, side: THREE.DoubleSide
    });
    this.pad = new THREE.Mesh(padGeo, padMat);
    this.pad.rotation.x = -Math.PI / 2;
    this.scene.add(this.pad);
    this._padDis = [padGeo, padMat];
  };

  Codex.prototype._resize = function () {
    if (!this.renderer) return;
    var host = this.renderer.domElement.parentNode;
    if (!host) return;
    var w = host.clientWidth || 400;
    var h = host.clientHeight || 220;
    this.renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  };

  Codex.prototype._clearModel = function () {
    if (!this.instance) return;
    this.pivot.remove(this.instance.group);
    try { this.instance.dispose(); } catch (e) { /* best effort */ }
    this.instance = null;
  };

  /* Build a specimen for display. Seeded off the id so a given specimen always
   * looks the same in the compendium even though it is randomised in play. */
  Codex.prototype.show = function (def) {
    if (!def || !this.renderer) return;
    this._clearModel();
    this.def = def;

    var rng = new CT.Rng(CT.hashString('codex:' + def.id));
    try {
      this.instance = def.build({
        rng: rng.fn(),
        palette: CT.monsterPalette(rng.fork('pal')),
        quality: 'high',
        scale: 1
      });
    } catch (e) {
      if (global.console) console.error('[codex] could not build ' + def.id, e);
      this.instance = null;
      return;
    }

    this.pivot.add(this.instance.group);
    this.t = 0;
    this.stateCycle = 0;

    // Frame the specimen: back the camera off by its actual measured size, not
    // its declared one, so a boss and a lab rat both fill the viewport.
    var box = new THREE.Box3().setFromObject(this.instance.group);
    var size = box.getSize(new THREE.Vector3());
    var height = Math.max(0.4, size.y);
    var width = Math.max(size.x, size.z);
    var fitH = height / (2 * Math.tan(this.camera.fov * Math.PI / 360));
    var fitW = width / (2 * Math.tan(this.camera.fov * Math.PI / 360) * this.camera.aspect);
    var dist = Math.max(fitH, fitW) * 1.5 + 1.0;

    this.camera.position.set(0, height * 0.58, dist);
    this.camera.lookAt(0, height * 0.45, 0);
    this.pad.scale.setScalar(Math.max(0.8, width * 0.75));
  };

  /* The preview walks the specimen through its own animation states so the
   * player can see what it does, not just what it looks like standing still. */
  Codex.prototype._ctx = function (dt) {
    this.t += dt;
    var cycle = this.t % 9;
    var state = 'idle', attackT = 0, moveSpeed = 0, hurtT = 0;
    if (cycle < 3.2) {
      state = 'walk'; moveSpeed = 1.6;
    } else if (cycle < 4.6) {
      state = 'idle';
    } else if (cycle < 7.0) {
      state = 'attack';
      attackT = ((cycle - 4.6) % 1.2) / 1.2;
    } else {
      state = 'idle';
    }
    return {
      time: this.t, state: state, moveSpeed: moveSpeed,
      attackT: attackT, hurtT: hurtT, dieT: 0,
      spawnT: Math.min(1, this.t / 0.6),
      hpFrac: 0.5 + Math.cos(this.t * 0.35) * 0.5
    };
  };

  Codex.prototype._frame = function () {
    var self = this;
    this.raf = requestAnimationFrame(function () { self._frame(); });
    if (!this.open || !this.renderer) return;

    var now = performance.now();
    var dt = Math.min(0.05, (now - (this._last || now)) / 1000);
    this._last = now;

    if (this.instance) {
      try { this.instance.update(dt, this._ctx(dt)); }
      catch (e) { /* a model that throws here must not kill the screen */ }
      this.pivot.rotation.y += dt * 0.42;
    }
    this.renderer.render(this.scene, this.camera);
  };

  Codex.prototype.start = function (host) {
    this._ensureRenderer(host);
    this._resize();
    this.open = true;
    this._last = performance.now();
    if (!this.raf) this._frame();
  };

  Codex.prototype.stop = function () {
    this.open = false;
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = null; }
    this._clearModel();
    if (this.renderer) {
      var el = this.renderer.domElement;
      if (el.parentNode) el.parentNode.removeChild(el);
      this.renderer.dispose();
      this.renderer = null;
    }
    for (var i = 0; this._padDis && i < this._padDis.length; i++) this._padDis[i].dispose();
    this._padDis = null;
    this.scene = null;
    this.def = null;
  };

  /* ---- the screen -------------------------------------------------------- */

  Codex.prototype.render = function (viewport, grid, info) {
    var self = this;
    var all = CT.MonsterRegistry.all().filter(function (m) { return !m.fallback; });
    all.sort(function (a, b) {
      var d = (TIER_ORDER[a.tier] || 0) - (TIER_ORDER[b.tier] || 0);
      return d !== 0 ? d : (a.name < b.name ? -1 : 1);
    });

    this.start(viewport);

    grid.innerHTML = '';
    var firstFound = null;

    all.forEach(function (def) {
      var e = CT.Records.codexEntry(def.id);
      var card = document.createElement('button');
      card.type = 'button';
      card.className = 'cx-card ' + def.tier + (e ? '' : ' locked');
      card.innerHTML =
        '<span class="cx-tier">' + (TIER_LABEL[def.tier] || def.tier) + '</span>' +
        '<span class="cx-name">' + (e ? CT.UI.escapeHtml(def.name) : '––––––') + '</span>' +
        '<span class="cx-sub">' + (e ? e.killed + ' killed' : 'not encountered') + '</span>';
      if (e) {
        if (!firstFound) firstFound = { def: def, card: card };
        card.addEventListener('click', function () {
          CT.Audio.uiClick();
          self.select(def, card, grid, info);
        });
      } else {
        card.disabled = true;
      }
      grid.appendChild(card);
    });

    var prog = CT.Records.codexProgress();
    if (firstFound) {
      this.select(firstFound.def, firstFound.card, grid, info);
    } else {
      info.innerHTML = '<div class="cx-empty">No specimens on file. Descend, and whatever ' +
                       'comes at you gets catalogued.</div>';
    }
    return prog;
  };

  Codex.prototype.select = function (def, card, grid, info) {
    var cards = grid.querySelectorAll('.cx-card');
    for (var i = 0; i < cards.length; i++) cards[i].classList.remove('sel');
    if (card) card.classList.add('sel');

    this.show(def);

    var e = CT.Records.codexEntry(def.id) || { seen: 0, killed: 0, deepest: 0, first: Date.now() };
    var stats = [
      ['encountered', e.seen],
      ['killed', e.killed],
      ['deepest', 'chamber ' + (e.deepest || 1)],
      ['first met', CT.Records.fmtDate(e.first)]
    ];
    info.innerHTML =
      '<div class="cx-title"><b>' + CT.UI.escapeHtml(def.name) + '</b>' +
      '<span class="cx-badge ' + def.tier + '">' + (TIER_LABEL[def.tier] || def.tier) + '</span></div>' +
      '<div class="cx-meta">' + def.size.height.toFixed(1) + 'm tall</div>' +
      '<div class="cx-stats">' + stats.map(function (s) {
        return '<div><span class="k">' + s[0] + '</span><span class="v">' + s[1] + '</span></div>';
      }).join('') + '</div>';
  };

  CT.Codex = new Codex();
})(window);
