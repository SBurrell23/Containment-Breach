/* Cave Typer — monster registry, fallback models, and the live monster entity.
 *
 * Model definitions are registered by the files in js/monsters/. This file owns
 * everything about a monster that is *gameplay* rather than geometry: the word
 * queue, the advance/attack state machine, hit flashes and death. */
(function (global) {
  'use strict';
  var CT = (global.CaveTyper = global.CaveTyper || {});
  var S = function () { return CT.Settings; };

  CT.monsters = CT.monsters || {};

  /* ---- fallback models ---------------------------------------------------
   * If a model file fails to load, or a tier has no entries, the game still has
   * to run. These are deliberately crude but they honour the full contract. */

  function buildFallback(tier, opts) {
    var rng = opts.rng, pal = opts.palette;
    var geos = [], mats = [];
    var group = new THREE.Group();
    var body = new THREE.Group();
    group.add(body);

    var h = tier === 'boss' ? 5.2 : (tier === 'mid' ? 2.4 : 1.3);
    var r = h * 0.28;

    function mat(color, emissive, ei) {
      var m = new THREE.MeshStandardMaterial({
        color: color, roughness: 0.85, flatShading: true,
        emissive: emissive === undefined ? 0x000000 : emissive,
        emissiveIntensity: ei === undefined ? 0 : ei
      });
      mats.push(m);
      return m;
    }
    function mesh(geo, m, parent) {
      geos.push(geo);
      var msh = new THREE.Mesh(geo, m);
      (parent || body).add(msh);
      return msh;
    }

    var fleshCol = new THREE.Color(pal.flesh).offsetHSL((rng() - 0.5) * 0.08, 0, (rng() - 0.5) * 0.12);
    var fleshMat = mat(fleshCol.getHex());
    var boneMat = mat(pal.bone);
    var glowMat = mat(0x0a0a0a, pal.glow, 1.6);

    var torso = mesh(new THREE.IcosahedronGeometry(r, 1), fleshMat);
    torso.position.y = h * 0.55;
    torso.scale.set(1, 1.35, 0.85);

    var head = mesh(new THREE.IcosahedronGeometry(r * 0.55, 1), fleshMat);
    head.position.y = h * 0.86;
    head.position.z = r * 0.25;

    var eyes = [];
    var eyeCount = 1 + Math.floor(rng() * 3);
    for (var e = 0; e < eyeCount; e++) {
      var eye = mesh(new THREE.SphereGeometry(r * 0.12, 6, 5), glowMat);
      eye.position.set((e - (eyeCount - 1) / 2) * r * 0.28, h * 0.88 + (rng() - 0.5) * r * 0.2, r * 0.6);
      eyes.push(eye);
    }

    var legs = [];
    var legCount = tier === 'boss' ? 4 : 2;
    for (var l = 0; l < legCount; l++) {
      var leg = new THREE.Group();
      var seg = mesh(new THREE.CylinderGeometry(r * 0.16, r * 0.11, h * 0.5, 6), boneMat, leg);
      seg.position.y = -h * 0.25;
      leg.position.set((l % 2 ? 1 : -1) * r * 0.5, h * 0.5, (l < 2 ? 0 : -r * 0.5));
      body.add(leg);
      legs.push(leg);
    }

    var arms = [];
    for (var a = 0; a < 2; a++) {
      var arm = new THREE.Group();
      var as = mesh(new THREE.CylinderGeometry(r * 0.14, r * 0.09, h * 0.42, 6), fleshMat, arm);
      as.position.y = -h * 0.21;
      var claw = mesh(new THREE.ConeGeometry(r * 0.12, r * 0.4, 5), boneMat, arm);
      claw.position.y = -h * 0.46;
      claw.rotation.x = Math.PI;
      arm.position.set((a ? 1 : -1) * r * 0.95, h * 0.72, 0);
      body.add(arm);
      arms.push(arm);
    }

    var headAnchor = new THREE.Object3D();
    headAnchor.position.set(0, h * 1.05, 0);
    group.add(headAnchor);

    return {
      group: group,
      headAnchor: headAnchor,
      materials: mats,
      hitPoints: [torso, head],
      update: function (dt, c) {
        var t = c.time;
        var sp = c.spawnT === undefined ? 1 : c.spawnT;
        body.scale.setScalar(0.2 + 0.8 * sp);
        body.position.y = (sp - 1) * h * 0.6;

        var breathe = Math.sin(t * 2.2) * 0.03;
        torso.scale.set(1 + breathe, 1.35 - breathe, 0.85 + breathe);

        if (c.state === 'walk') {
          var ph = t * (2.5 + c.moveSpeed * 1.6);
          for (var i = 0; i < legs.length; i++) legs[i].rotation.x = Math.sin(ph + i * Math.PI) * 0.6;
          for (var j = 0; j < arms.length; j++) arms[j].rotation.x = Math.sin(ph + j * Math.PI + 1) * 0.4;
          body.position.y += Math.abs(Math.sin(ph)) * h * 0.03;
          body.rotation.z = Math.sin(ph) * 0.05;
        } else if (c.state === 'attack') {
          var k = c.attackT < 0.4 ? -c.attackT / 0.4 : (1 - (c.attackT - 0.4) / 0.6) * 1.4 - 0.4;
          for (var k2 = 0; k2 < arms.length; k2++) arms[k2].rotation.x = k * 1.5;
          body.position.z = -k * 0.25;
        } else {
          for (var q = 0; q < arms.length; q++) arms[q].rotation.x *= 0.9;
          for (var q2 = 0; q2 < legs.length; q2++) legs[q2].rotation.x *= 0.9;
          body.rotation.z = Math.sin(t * 1.4) * 0.02;
        }

        if (c.hurtT > 0) {
          body.position.z = c.hurtT * 0.3;
          body.rotation.x = -c.hurtT * 0.2;
        } else if (c.state !== 'attack') {
          body.rotation.x *= 0.85;
        }

        if (c.dieT > 0) {
          body.rotation.x = c.dieT * 1.4;
          body.position.y = -c.dieT * h * 0.5;
          body.scale.setScalar(Math.max(0.05, 1 - c.dieT * 0.45));
        }

        for (var ei = 0; ei < eyes.length; ei++) {
          eyes[ei].scale.setScalar(0.85 + Math.sin(t * 5 + ei) * 0.15);
        }
        glowMat.emissiveIntensity = 1.2 + (1 - c.hpFrac) * 1.8 + Math.sin(t * 3) * 0.2;
      },
      dispose: function () {
        for (var i = 0; i < geos.length; i++) geos[i].dispose();
        for (var j = 0; j < mats.length; j++) mats[j].dispose();
      }
    };
  }

  function registerFallbacks() {
    ['grunt', 'mid', 'boss'].forEach(function (tier) {
      var id = 'fallback_' + tier;
      if (CT.monsters[id]) return;
      CT.monsters[id] = {
        id: id,
        name: tier === 'boss' ? 'ANOMALY' : (tier === 'mid' ? 'ABERRATION' : 'SPECIMEN'),
        tier: tier,
        fallback: true,
        size: { height: tier === 'boss' ? 5.2 : (tier === 'mid' ? 2.4 : 1.3),
                radius: tier === 'boss' ? 2.4 : (tier === 'mid' ? 1.0 : 0.6) },
        build: function (opts) { return buildFallback(tier, opts); }
      };
    });
  }

  /* ---- registry ---------------------------------------------------------- */

  var Registry = {
    /* Validates what the model files registered and drops anything malformed,
     * so one bad file cannot take the whole game down. */
    validate: function () {
      var dropped = [];
      for (var id in CT.monsters) {
        var m = CT.monsters[id];
        var ok = m && typeof m.build === 'function' && m.size &&
                 typeof m.size.height === 'number' && m.size.height > 0 &&
                 (m.tier === 'grunt' || m.tier === 'mid' || m.tier === 'boss');
        if (!ok) { dropped.push(id); delete CT.monsters[id]; }
      }
      registerFallbacks();
      return dropped;
    },
    all: function () {
      var out = [];
      for (var id in CT.monsters) out.push(CT.monsters[id]);
      return out;
    },
    byTier: function (tier) {
      var out = [];
      for (var id in CT.monsters) {
        var m = CT.monsters[id];
        // Only fall back to the placeholder when a tier is genuinely empty.
        if (m.tier === tier && !m.fallback) out.push(m);
      }
      if (!out.length && CT.monsters['fallback_' + tier]) out.push(CT.monsters['fallback_' + tier]);
      return out;
    },
    get: function (id) { return CT.monsters[id] || null; },
    summary: function () {
      var c = { grunt: 0, mid: 0, boss: 0 };
      for (var id in CT.monsters) if (!CT.monsters[id].fallback) c[CT.monsters[id].tier]++;
      return c;
    }
  };

  /* ---- palette handed to model builders ---------------------------------- */

  function monsterPalette(rng) {
    var base = rng.range(0.9, 1.02);
    var glowPick = rng.next();
    var glow = glowPick < 0.4 ? 0x7dff4a : (glowPick < 0.72 ? 0x36e0ff : 0xff3ea5);
    return {
      flesh: new THREE.Color().setHSL(rng.range(0.92, 1.03) % 1, rng.range(0.14, 0.3), rng.range(0.34, 0.48)).getHex(),
      flesh2: new THREE.Color().setHSL(rng.range(0.88, 0.99) % 1, rng.range(0.2, 0.38), rng.range(0.16, 0.26)).getHex(),
      accent: new THREE.Color().setHSL(rng.range(0.98, 1.04) % 1, rng.range(0.4, 0.62), rng.range(0.3, 0.42)).getHex(),
      glow: glow,
      glow2: glowPick < 0.4 ? 0x36e0ff : 0x7dff4a,
      bone: new THREE.Color().setHSL(rng.range(0.1, 0.14), rng.range(0.1, 0.22), rng.range(0.68, 0.82)).getHex(),
      metal: 0x6b7076,
      goo: glow,
      base: base
    };
  }

  /* ---- live monster ------------------------------------------------------ */

  var HURT_TIME = 0.26;
  var _v = new THREE.Vector3();
  var _aim = new THREE.Vector3();
  var _frame = { x: 0, z: 0, h: 0, rx: 1, rz: 0 };

  function Monster(spec, world) {
    this.spec = spec;
    this.uid = spec.uid;
    this.world = world;
    this.boss = !!spec.boss;
    this.tier = spec.tier;

    var def = Registry.get(spec.typeId) || Registry.byTier(spec.tier)[0];
    this.def = def;
    this.name = def.name || 'SPECIMEN';

    var rng = new CT.Rng((world.encounterSeed ^ Math.imul(spec.uid + 7, 0x27d4eb2d)) >>> 0);
    this.rng = rng;

    var built = null;
    try {
      built = def.build({
        rng: rng.fn(),
        palette: monsterPalette(rng.fork('pal')),
        quality: S().get('quality'),
        scale: spec.scale || 1
      });
    } catch (err) {
      if (global.console) console.error('[CaveTyper] model "' + def.id + '" failed to build:', err);
      built = buildFallback(spec.tier, {
        rng: rng.fn(), palette: monsterPalette(rng.fork('pal2')),
        quality: 'low', scale: 1
      });
      this.name = def.name || 'SPECIMEN';
    }
    /* Surface detail, applied centrally rather than inside fourteen model
     * files. CT.detailMat leaves alone anything glowing or transparent — the
     * eyes, the goo, the exposed cores are meant to read as light sources —
     * so what this touches is exactly the flesh, chitin and plate that was
     * otherwise a smooth gradient. Tiling is per-specimen, scaled against its
     * height, so a six-metre boss is not wearing a rat's pores. */
    var detailRep = CT.clamp(Math.round(5 / ((def.size.height || 1.5) * (spec.scale || 1))), 1, 6);
    var dmats = built.materials || [];
    for (var di = 0; di < dmats.length; di++) {
      CT.detailMat(dmats[di], 'hide', detailRep, 0.014);
    }

    this.model = built;
    this.group = built.group;
    this.group.scale.setScalar(spec.scale || 1);

    this.height = (def.size.height || 1.5) * (spec.scale || 1);
    this.radius = (def.size.radius || 0.6) * (spec.scale || 1);

    // word queue
    this.words = spec.words.slice();
    this.totalWords = this.words.length;
    this.wordIndex = 0;

    // position: dist is measured back down the tunnel from the player station
    this.dist = spec.startDist;
    this.laneX = spec.x;
    this.meleeDist = spec.meleeDist;
    this.speed = spec.speed;

    this.state = 'spawn';
    this.time = 0;
    this.spawnT = 0;
    this.spawnDuration = this.boss ? 2.0 : 0.65;
    this.hurtT = 0;
    this.dieT = 0;
    this.attackT = 0;
    this.attackCooldown = spec.attackInterval * (0.4 + rng.next() * 0.5);
    this.alive = true;
    this.dying = false;
    this.removed = false;
    this.delay = spec.spawnDelay;
    this.active = false;
    // Per-slot typing progress. Both players are allowed to work the same word
    // at the same time — whoever finishes first fires and the other's progress
    // is reset — so a single "owner" slot cannot describe the state.
    this.claim = [null, null];
    this.lastGrowl = -99;

    // Hit-flash bookkeeping: remember each material's original emissive.
    this.flashMats = [];
    var mats = built.materials || [];
    for (var i = 0; i < mats.length; i++) {
      var m = mats[i];
      if (m && m.emissive) {
        this.flashMats.push({
          mat: m,
          r: m.emissive.r, g: m.emissive.g, b: m.emissive.b,
          ei: m.emissiveIntensity === undefined ? 1 : m.emissiveIntensity
        });
      }
      if (m) { m.transparent = m.transparent || false; }
    }

    this.gooColor = 0x9bff2e;
    try {
      var pmats = built.materials || [];
      for (var p = 0; p < pmats.length; p++) {
        if (pmats[p].emissive && pmats[p].emissiveIntensity > 0.5) {
          this.gooColor = pmats[p].emissive.getHex();
          break;
        }
      }
    } catch (e2) { /* keep default */ }

    this.group.visible = false;
    world.root.add(this.group);
    this.syncTransform();
  }

  Monster.prototype.currentWord = function () {
    return this.wordIndex < this.words.length ? this.words[this.wordIndex] : null;
  };

  /* ---- claims ------------------------------------------------------------
   * A claim is "slot N has typed this much of my current word". It is purely
   * cosmetic bookkeeping for the other player's benefit — nothing about who may
   * shoot what depends on it, because both players may shoot the same
   * specimen. Targeting merely *prefers* an unclaimed one, so a co-op pair
   * naturally splits the room instead of doubling up by accident. */

  Monster.prototype.setClaim = function (slot, typed) {
    if (slot === 0 || slot === 1) this.claim[slot] = typed || '';
  };

  Monster.prototype.clearClaim = function (slot) {
    if (slot === 0 || slot === 1) this.claim[slot] = null;
  };

  /* Is anyone other than `slot` part-way through this specimen's word? */
  Monster.prototype.claimedByOther = function (slot) {
    for (var i = 0; i < this.claim.length; i++) {
      if (i !== slot && this.claim[i] !== null) return true;
    }
    return false;
  };

  Monster.prototype.otherClaim = function (slot) {
    for (var i = 0; i < this.claim.length; i++) {
      if (i !== slot && this.claim[i] !== null) return { slot: i, typed: this.claim[i] };
    }
    return null;
  };

  Monster.prototype.hpFrac = function () {
    return this.totalWords ? 1 - this.wordIndex / this.totalWords : 0;
  };

  /* Arc length along the route. Monsters stand ahead of the rail stop and walk
   * back down the route toward it, so the cave can bend between them and the
   * player without any of them drifting through a wall. */
  Monster.prototype.worldArc = function () { return this.world.stationS + this.dist; };

  Monster.prototype.syncTransform = function () {
    var cave = this.world.cave;
    if (!cave) return;
    var frame = cave.frameAt(this.worldArc(), _frame);
    // Lanes funnel inward as a monster closes. A creature that walked its full
    // spawn offset all the way to melee range would end up 60 degrees off-axis
    // and half off the screen exactly when it starts hurting you.
    var spread = 0.3 + 0.7 * CT.clamp((this.dist - this.meleeDist) / 15, 0, 1);
    var lat = this.laneX * spread;
    this.group.position.set(frame.x + frame.rx * lat, 0, frame.z + frame.rz * lat);
    // Always face the player.
    this.group.rotation.y = Math.atan2(
      this.world.stationX - this.group.position.x,
      this.world.stationZ - this.group.position.z
    );
  };

  Monster.prototype.headWorld = function (out) {
    out = out || _v;
    if (this.model.headAnchor) {
      this.model.headAnchor.getWorldPosition(out);
    } else {
      out.copy(this.group.position);
      out.y += this.height;
    }
    return out;
  };

  /* Cache how far this specimen sits from the crosshair, in units of half the
   * screen height. Targeting uses it to pick whichever candidate is nearest to
   * where the player is already looking, so firing back and forth between two
   * specimens does not send the aim skidding across the chamber.
   *
   * ndc.x is scaled by the aspect ratio because normalised device coordinates
   * run -1..1 on both axes regardless of window shape: without it, horizontal
   * separation — which is how specimens are actually spread out — would count
   * for far less than it looks like on screen. */
  Monster.prototype.updateAim = function () {
    var cam = this.world.stage && this.world.stage.camera;
    if (!cam) { this.aimDist = 9; return; }
    this.headWorld(_aim);
    _aim.project(cam);
    if (_aim.z > 1) { this.aimDist = 9; return; }      // behind the camera
    var x = _aim.x * (cam.aspect || 1);
    this.aimDist = Math.sqrt(x * x + _aim.y * _aim.y);
  };

  Monster.prototype.hitWorld = function (out) {
    out = out || new THREE.Vector3();
    var hp = this.model.hitPoints;
    if (hp && hp.length) {
      hp[Math.floor(Math.random() * hp.length)].getWorldPosition(out);
    } else {
      this.headWorld(out);
      out.y -= this.height * 0.25;
    }
    return out;
  };

  /* A word was completed against this monster. Returns true if it just died. */
  Monster.prototype.takeWordHit = function () {
    if (!this.alive) return false;
    this.wordIndex++;
    this.hurtT = 1;
    if (this.wordIndex >= this.totalWords) {
      this.alive = false;
      this.dying = true;
      this.dieT = 0;
      this.state = 'die';
      this.claim[0] = this.claim[1] = null;
      return true;
    }
    this.state = 'hurt';
    this._hurtHold = HURT_TIME;
    return false;
  };

  Monster.prototype.update = function (dt, onAttack) {
    if (this.removed) return;
    this.time += dt;

    if (!this.active) {
      this.delay -= dt;
      if (this.delay > 0) return;
      this.active = true;
      this.group.visible = true;
      // Catalogued on arrival rather than at encounter planning: a specimen
      // queued for a wave the player never lived to see is not "encountered".
      if (CT.Records) CT.Records.noteSeen(this.def.id, (this.world.encounterIndex || 0) + 1);
    }

    if (this.dying) {
      this.dieT += dt / (this.boss ? 2.4 : 0.9);
      if (this.dieT >= 1) { this.dieT = 1; this.removed = true; }
      // fade out over the back half of the death animation
      var fade = CT.clamp(1 - (this.dieT - 0.45) / 0.55, 0, 1);
      for (var i = 0; i < this.flashMats.length; i++) {
        var fm = this.flashMats[i];
        fm.mat.transparent = true;
        fm.mat.opacity = fade;
        fm.mat.depthWrite = fade > 0.7;
      }
    } else {
      if (this.spawnT < 1) {
        this.spawnT = Math.min(1, this.spawnT + dt / this.spawnDuration);
        this.state = 'spawn';
      } else if (this.dist > this.meleeDist + 0.05) {
        this.dist = Math.max(this.meleeDist, this.dist - this.speed * dt);
        this.state = 'walk';
      } else {
        // In contact: swing on a timer.
        this.attackCooldown -= dt;
        if (this.attackCooldown <= 0) {
          this.attackCooldown = this.spec.attackInterval;
          this.state = 'attack';
          this.attackT = 0;
          this._attackFired = false;
        }
        if (this.state === 'attack') {
          this.attackT += dt / (this.spec.attackInterval * 0.75);
          if (!this._attackFired && this.attackT >= 0.55) {
            this._attackFired = true;
            if (onAttack) onAttack(this);
          }
          if (this.attackT >= 1) { this.attackT = 0; this.state = 'idle'; }
        } else {
          this.state = 'idle';
        }
      }

      if (this._hurtHold > 0) {
        this._hurtHold -= dt;
        if (this.state !== 'attack') this.state = 'hurt';
      }
    }

    this.hurtT = Math.max(0, this.hurtT - dt / HURT_TIME);
    this.syncTransform();
    this.updateAim();

    // white-hot flash on hit
    var f = this.hurtT * this.hurtT;
    for (var j = 0; j < this.flashMats.length; j++) {
      var m = this.flashMats[j];
      if (f > 0.001) {
        m.mat.emissive.setRGB(
          m.r + (1 - m.r) * f,
          m.g + (1 - m.g) * f,
          m.b + (1 - m.b) * f
        );
        m.mat.emissiveIntensity = m.ei + f * 2.4;
      } else if (m._wasFlashing) {
        m.mat.emissive.setRGB(m.r, m.g, m.b);
        m.mat.emissiveIntensity = m.ei;
      }
      m._wasFlashing = f > 0.001;
    }

    try {
      this.model.update(Math.min(dt, 0.05), {
        time: this.time,
        state: this.state,
        moveSpeed: this.state === 'walk' ? this.speed : 0,
        attackT: this.attackT,
        hurtT: this.hurtT,
        dieT: this.dieT,
        spawnT: this.spawnT,
        hpFrac: this.hpFrac()
      });
    } catch (err) {
      if (!this._animErrored) {
        this._animErrored = true;
        if (global.console) console.error('[CaveTyper] "' + this.def.id + '" update() threw:', err);
      }
    }
  };

  Monster.prototype.dispose = function () {
    if (this.group.parent) this.group.parent.remove(this.group);
    try { this.model.dispose(); } catch (e) { /* best effort */ }
  };

  CT.MonsterRegistry = Registry;
  CT.Monster = Monster;
  CT.monsterPalette = monsterPalette;
})(window);
