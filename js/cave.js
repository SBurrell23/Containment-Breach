/* Cave Typer — procedural cave route and ruined-lab set dressing.
 *
 * The cave is a ROUTE, not an axis: a centre line that turns corners, addressed
 * by arc length `s`. Wall rings, props, monsters and the camera rig are all
 * placed through that route's local frame, which is what makes it a cave system
 * rather than one long mineshaft.
 *
 * It is generated in chunks and recycled behind the player, so a run can go on
 * forever without the scene growing without bound. Every chunk and every turn is
 * derived from the run seed, so the same seed gives the same cave — which is
 * what keeps two networked players walking the same corridors. */
(function (global) {
  'use strict';
  var CT = (global.CaveTyper = global.CaveTyper || {});
  var S = function () { return CT.Settings; };

  var _tmpV = new THREE.Vector3();

  var CHUNK_LEN = 48;       // world units per chunk
  var KEEP_AHEAD = 4;       // chunks generated in front of the player
  var KEEP_BEHIND = 1;      // chunks retained behind before recycling

  /* ---- shared procedural textures --------------------------------------- */

  var _tex = {};

  function hazardTexture() {
    if (_tex.hazard) return _tex.hazard;
    var c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    var g = c.getContext('2d');
    g.fillStyle = '#c9a227'; g.fillRect(0, 0, 64, 64);
    g.fillStyle = '#16140c';
    for (var i = -64; i < 128; i += 22) {
      g.beginPath();
      g.moveTo(i, 0); g.lineTo(i + 11, 0); g.lineTo(i + 11 + 64, 64); g.lineTo(i + 64, 64);
      g.closePath(); g.fill();
    }
    var t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    _tex.hazard = t;
    return t;
  }

  /* Grime for the rock, as a tiling texture rather than as vertex colour.
   *
   * The wall mesh has a vertex roughly every two and a half units, so anything
   * finer than about a five-unit wavelength cannot be expressed in vertex
   * colour at all — it just aliases into blotches. That is most of what makes
   * untextured low-poly rock look moulded: the large shapes are stone, and
   * every surface between them is a perfectly smooth gradient. So the broad
   * marks stay in the vertex colours, where they belong, and the close-range
   * dirt lives here, where mesh density is irrelevant.
   *
   * Used as both map and bumpMap: the same field that darkens the rock also
   * pushes it around, which is what stops it reading as a decal printed on
   * plastic. Generated once and shared by every wall chunk.
   */
  function grimeTexture() {
    if (_tex.grime) return _tex.grime;
    var N = 256;
    var c = document.createElement('canvas');
    c.width = c.height = N;
    var g = c.getContext('2d');
    var img = g.createImageData(N, N);
    var rng = new CT.Rng(0x9e3779b9);

    /* Value noise on a wrapping lattice, so the tile has no seam. */
    function lattice(size) {
      var a = new Float32Array(size * size);
      for (var i = 0; i < a.length; i++) a[i] = rng.next();
      return a;
    }
    function sample(a, size, u, v) {
      var x = u * size, y = v * size;
      var x0 = Math.floor(x), y0 = Math.floor(y);
      var fx = x - x0, fy = y - y0;
      fx = fx * fx * (3 - 2 * fx);
      fy = fy * fy * (3 - 2 * fy);
      var x1 = (x0 + 1) % size, y1 = (y0 + 1) % size;
      x0 = ((x0 % size) + size) % size; y0 = ((y0 % size) + size) % size;
      var s00 = a[y0 * size + x0], s10 = a[y0 * size + x1];
      var s01 = a[y1 * size + x0], s11 = a[y1 * size + x1];
      return (s00 * (1 - fx) + s10 * fx) * (1 - fy) + (s01 * (1 - fx) + s11 * fx) * fy;
    }

    var oct = [4, 8, 16, 32, 64].map(lattice);
    var sizes = [4, 8, 16, 32, 64];
    var amps = [0.34, 0.26, 0.20, 0.13, 0.07];
    // Stretched vertically so the dirt reads as having run downhill.
    var drip = lattice(48);

    for (var y = 0; y < N; y++) {
      for (var x = 0; x < N; x++) {
        var u = x / N, v = y / N;
        var n = 0;
        for (var o = 0; o < oct.length; o++) n += amps[o] * sample(oct[o], sizes[o], u, v);
        // Vertical streaking: same field, squashed along v.
        var st = sample(drip, 48, u, v * 0.22);
        n = n * 0.78 + st * 0.22;
        // Centred high so the map modulates the rock rather than halving its
        // albedo: the cave is meant to be dark because the lamp is weak, not
        // because every surface has been painted grey. The contrast stretch is
        // what makes the dark end read as dirt rather than as shading.
        var val = 0.70 + (n - 0.5) * 1.25;
        if (val < 0.08) val = 0.08; else if (val > 1) val = 1;
        // A scatter of dark pits and pale mineral flecks.
        var r = rng.next();
        if (r < 0.014) val *= 0.45;
        else if (r > 0.992) val = Math.min(1, val * 1.9);
        var b = Math.round(val * 255);
        var k = (y * N + x) * 4;
        img.data[k] = b; img.data[k + 1] = b; img.data[k + 2] = b; img.data[k + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    var t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
    _tex.grime = t;
    return t;
  }

  var SIGN_TEXTS = [
    ['BIOHAZARD', 'LEVEL 4'], ['NO ENTRY', 'SECTOR 7'], ['DECON', 'REQUIRED'],
    ['SPECIMEN', 'TRANSIT'], ['QUARANTINE', 'IN EFFECT'], ['CRYO', 'STORAGE'],
    ['VIVARIUM', 'SUB-LEVEL'], ['CAUTION', 'LIVE SAMPLES'], ['CONTAINMENT', 'BREACH'],
    ['EMERGENCY', 'PURGE VALVE'], ['SUBJECT', 'INTAKE'], ['DO NOT', 'FEED']
  ];

  function signTexture(idx) {
    var key = 'sign' + idx;
    if (_tex[key]) return _tex[key];
    var words = SIGN_TEXTS[idx % SIGN_TEXTS.length];
    var c = document.createElement('canvas');
    c.width = 256; c.height = 128;
    var g = c.getContext('2d');
    g.fillStyle = '#d8c528'; g.fillRect(0, 0, 256, 128);
    g.strokeStyle = '#14120a'; g.lineWidth = 10; g.strokeRect(5, 5, 246, 118);
    g.fillStyle = '#14120a';
    g.font = 'bold 34px monospace';
    g.textAlign = 'center';
    g.fillText(words[0], 128, 58);
    g.font = 'bold 24px monospace';
    g.fillText(words[1], 128, 94);
    // grime
    g.globalAlpha = 0.25; g.fillStyle = '#2a2410';
    for (var i = 0; i < 40; i++) {
      g.fillRect((i * 97) % 256, (i * 53) % 128, 3 + (i % 9), 2 + (i % 5));
    }
    var t = new THREE.CanvasTexture(c);
    _tex[key] = t;
    return t;
  }

  function disposeTextures() {
    for (var k in _tex) { if (_tex[k]) _tex[k].dispose(); }
    _tex = {};
  }

  /* ---- palette ----------------------------------------------------------- */

  function makePalette(rng) {
    var rockH = rng.range(0.55, 0.72);            // blue-grey through to slate
    var glowChoice = rng.next();
    var glow = glowChoice < 0.45 ? 0x7dff4a : (glowChoice < 0.75 ? 0x36e0ff : 0xd44bff);
    // Rock on its own reads as moulded plastic: one hue, one value, and every
    // facet the same. What sells stone is that several different things have
    // happened to it. These are those things, each laid down by its own noise
    // field at its own scale in _buildWalls.
    var spill = new THREE.Color(glow);
    spill.offsetHSL(0, -0.42, -0.30);
    return {
      rock: new THREE.Color().setHSL(rockH, rng.range(0.06, 0.16), rng.range(0.12, 0.2)),
      rockDark: new THREE.Color().setHSL(rockH, rng.range(0.08, 0.2), rng.range(0.05, 0.09)),
      moss: new THREE.Color().setHSL(rng.range(0.22, 0.32), 0.45, 0.16),
      // Iron bleeding out of the rock: warm, and the strongest colour break.
      rust: new THREE.Color().setHSL(rng.range(0.035, 0.075), rng.range(0.34, 0.52), rng.range(0.11, 0.17)),
      // Dried mineral crust where water ran and stopped running.
      crust: new THREE.Color().setHSL(rng.range(0.08, 0.13), rng.range(0.07, 0.15), rng.range(0.27, 0.36)),
      // Wet seepage: nearly black, slightly colder than the rock around it.
      seep: new THREE.Color().setHSL((rockH + 0.04) % 1, rng.range(0.16, 0.3), rng.range(0.028, 0.05)),
      // Floor silt — trodden dirt, warmer and duller than the walls.
      silt: new THREE.Color().setHSL(rng.range(0.06, 0.11), rng.range(0.10, 0.20), rng.range(0.075, 0.115)),
      // Whatever leaked out of the vats, pooled at the bottom of the tunnel.
      spill: spill,
      glow: glow,
      glow2: glowChoice < 0.45 ? 0x36e0ff : 0x7dff4a,
      metal: 0x60666d,
      metalDark: 0x30353a,
      goo: glow,
      warn: 0xd8c528
    };
  }

  /* ---- the cave ---------------------------------------------------------- */

  function Cave(stage, seed) {
    this.stage = stage;
    this.seed = seed >>> 0;
    this.rng = new CT.Rng(seed ^ 0x5eed);
    this.noise = new CT.Noise(seed ^ 0xca7e);
    this.palette = makePalette(this.rng.fork('palette'));
    this.chunks = {};      // index -> {group, lights:[], disposables:[]}
    this.root = new THREE.Group();
    stage.scene.add(this.root);

    this.stage.scene.fog.color.setHex(CT.FOG_COLOR);
    this.stage.scene.background = new THREE.Color(CT.FOG_COLOR).lerp(this.palette.rockDark, 0.5);
    this.stage.scene.fog.color.copy(this.stage.scene.background);

    this._initPath();

    // Deferred prop-construction jobs, drained a few per frame by pump().
    this._queue = [];

    this.dust = null;
    this._buildDust();
  }

  /* ---- the path ----------------------------------------------------------
   * The tunnel is not an axis, it is a route. Everything downstream — wall
   * rings, props, monsters, the camera rig — is placed by arc length `s` along
   * that route rather than by z, which is what lets the cave actually turn
   * corners instead of being one long mineshaft.
   *
   * Turns are deliberately quantised to the rail's stops. Every station gets a
   * guaranteed straight run of CLEAR units ahead of it, because that is where
   * its specimens spawn and walk in from — a corner inside that window would
   * hide the things the player has to shoot. All the turning therefore happens
   * in the short window between the end of one chamber's sightline and arrival
   * at the next, so the player rides around the bend and stops facing down a
   * fresh corridor. */

  var SAMPLE = 0.5;        // arc length between cached path samples

  Cave.prototype._initPath = function () {
    var spacing = (CT.Difficulty && CT.Difficulty.TUNING.stationSpacing) || 44;
    this.spacing = spacing;
    // Straight run guaranteed ahead of each station. Must comfortably exceed the
    // furthest monster spawn distance, or specimens spawn around a corner.
    var maxSpawn = (CT.Difficulty && CT.Difficulty.TUNING.spawnDistMax) || 27;
    this.clear = Math.min(spacing - 8, maxSpawn + 5);
    this.turnArc = spacing - this.clear;     // window the heading swings through

    this._turnRng = this.rng.fork('turns');
    this._turns = [];        // yaw delta applied while travelling k -> k+1
    this._headSum = [0];     // cumulative heading at the start of station k
    this._nextTurnAt = this._turnRng.int(1, 2);
    this._lastDir = this._turnRng.bool() ? 1 : -1;

    // Integrated centre-line, extended lazily.
    this._px = [0];
    this._pz = [0];
    this._sMax = 0;
  };

  /* Yaw deltas are generated in order and cached, so the route is identical for
   * both players in co-op given the same run seed. */
  Cave.prototype._ensureTurns = function (k) {
    while (this._turns.length <= k) {
      var i = this._turns.length;
      var delta = 0;
      if (i === this._nextTurnAt) {
        var rng = this._turnRng;
        // Mostly alternate, so the cave switchbacks rather than spiralling away.
        var dir = rng.bool(0.78) ? -this._lastDir : this._lastDir;
        delta = dir * rng.range(0.45, 1.05);     // ~26 to ~60 degrees
        this._lastDir = dir;
        this._nextTurnAt = i + rng.int(1, 3);    // next turn in 1-3 chambers
      }
      this._turns.push(delta);
      this._headSum.push(this._headSum[i] + delta);
    }
  };

  /* Heading (yaw, radians) of the route at arc length s. Forward is
   * (-sin h, 0, -cos h), so h = 0 points down -Z as the rest of the game
   * assumes, and this value can be assigned straight to rigRoot.rotation.y. */
  Cave.prototype.headingAt = function (s) {
    if (s < 0) s = 0;
    var k = Math.floor(s / this.spacing);
    this._ensureTurns(k);
    var t = s - k * this.spacing;
    var turn = CT.clamp((t - this.clear) / this.turnArc, 0, 1);
    return this._headSum[k] + this._turns[k] * (turn * turn * (3 - 2 * turn));
  };

  Cave.prototype._extendPath = function (s) {
    while (this._sMax < s) {
      var i = this._px.length - 1;
      var h = this.headingAt(this._sMax + SAMPLE * 0.5);   // midpoint integration
      this._px.push(this._px[i] - Math.sin(h) * SAMPLE);
      this._pz.push(this._pz[i] - Math.cos(h) * SAMPLE);
      this._sMax += SAMPLE;
    }
  };

  /* World-space centre of the tunnel at arc length s. */
  Cave.prototype.pointAt = function (s, out) {
    out = out || new THREE.Vector3();
    if (s < 0) s = 0;
    this._extendPath(s + SAMPLE * 2);
    var f = s / SAMPLE;
    var i = Math.floor(f);
    var t = f - i;
    var j = Math.min(i + 1, this._px.length - 1);
    out.set(
      this._px[i] + (this._px[j] - this._px[i]) * t,
      0,
      this._pz[i] + (this._pz[j] - this._pz[i]) * t
    );
    return out;
  };

  /* Position plus the local right vector, which is what lateral offsets (lanes,
   * wall props, ring vertices) are measured along. */
  Cave.prototype.frameAt = function (s, out) {
    out = out || { x: 0, z: 0, h: 0, rx: 1, rz: 0 };
    var p = this.pointAt(s, _tmpV);
    var h = this.headingAt(s);
    out.x = p.x; out.z = p.z; out.h = h;
    out.rx = Math.cos(h);
    out.rz = -Math.sin(h);
    return out;
  };

  /* Arc length of the k-th rail stop. */
  Cave.prototype.stationArc = function (k) { return k * this.spacing; };

  /* True where the route is turning — used to keep props off the bend. */
  Cave.prototype.isTurning = function (s) {
    var k = Math.floor(s / this.spacing);
    this._ensureTurns(k);
    if (!this._turns[k]) return false;
    var t = s - k * this.spacing;
    return t > this.clear - 2;
  };

  /* How tightly the route is bending at s, 0..1.
   *
   * This exists because a sharp turn in a wide tube turns itself inside out: if
   * the bend radius is smaller than the tunnel radius, the inner wall folds
   * through the centre line and you get inverted geometry on every corner. The
   * turns here are deliberately sharp, so the tunnel narrows to meet them —
   * which also happens to be exactly right for a cave, where the wide chambers
   * are joined by passages you have to squeeze through and cannot see past. */
  Cave.prototype.bendAmount = function (s) {
    if (s < 0) s = 0;
    var k = Math.floor(s / this.spacing);
    this._ensureTurns(k);
    var t = s - k * this.spacing;
    var RAMP = 9;
    var sq = 0;

    var d0 = Math.abs(this._turns[k] || 0);
    if (d0) {
      sq = Math.max(sq, CT.clamp((t - (this.clear - RAMP)) / RAMP, 0, 1) * Math.min(1, d0 / 1.0));
    }
    // The previous leg's bend finishes exactly at this station, so its squeeze
    // spills over into the first few units of this leg.
    var dPrev = k > 0 ? Math.abs(this._turns[k - 1] || 0) : 0;
    if (dPrev) {
      sq = Math.max(sq, CT.clamp((RAMP - t) / RAMP, 0, 1) * Math.min(1, dPrev / 1.0));
    }
    return sq;
  };

  /* Ceiling height at arc s — chambers open up, corridors squeeze. */
  Cave.prototype.ceilingAt = function (s) {
    var n = this.noise;
    var h = 6.0 + n.fbm3(s * 0.013, 7.7, 0.0, 3) * 5.5;
    return h * CT.lerp(1, 0.62, this.bendAmount(s));
  };

  Cave.prototype.radiusAt = function (s, angle) {
    var n = this.noise;
    var base = 7.2 + n.fbm3(s * 0.011, 2.2, 0.0, 3) * 5.0;
    var wob = n.fbm3(Math.cos(angle) * 1.6, Math.sin(angle) * 1.6, s * 0.055, 4) - 0.5;
    var r = base * (1 + wob * 0.42);
    return r * CT.lerp(1, 0.46, this.bendAmount(s));
  };

  Cave.prototype.quality = function () {
    var q = S().get('quality');
    if (q === 'low') return { rings: 10, radial: 12, props: 0.55 };
    if (q === 'medium') return { rings: 16, radial: 18, props: 0.8 };
    return { rings: 22, radial: 26, props: 1.0 };
  };

  /* ---- wall mesh --------------------------------------------------------- */

  Cave.prototype._buildWalls = function (ci, disposables) {
    var q = this.quality();
    var s0 = ci * CHUNK_LEN;
    var radial = q.radial;
    var verts = [], colors = [], uvs = [], indices = [];
    // One grime tile every ~5 units in both directions. v is driven by absolute
    // arc length, so the pattern runs continuously through a chunk seam.
    var UV_TILE = 5.0;
    var pal = this.palette;
    var cRock = pal.rock, cDark = pal.rockDark, cMoss = pal.moss;
    var cRust = pal.rust, cCrust = pal.crust, cSeep = pal.seep;
    var cSilt = pal.silt, cSpill = pal.spill;
    var tmp = new THREE.Color();
    var N = this.noise;
    var frame = { x: 0, z: 0, h: 0, rx: 1, rz: 0 };

    // Rings are swept along the route and oriented to its local frame, so the
    // tube bends with the path. Corners need more rings than a straight run or
    // the bend facets visibly, so ring spacing tightens where the route turns.
    var arcs = [];
    var sEnd = s0 + CHUNK_LEN;
    var baseStep = CHUNK_LEN / q.rings;
    for (var s = s0; s < sEnd; ) {
      arcs.push(s);
      s += this.isTurning(s) ? baseStep * 0.4 : baseStep;
    }
    arcs.push(sEnd);        // one ring of overlap, so chunks seam without a crack
    var rings = arcs.length - 1;

    for (var i = 0; i <= rings; i++) {
      var sa = arcs[i];
      this.frameAt(sa, frame);
      var ceil = this.ceilingAt(sa);

      for (var j = 0; j <= radial; j++) {
        var a = (j / radial) * Math.PI * 2;
        var r = this.radiusAt(sa, a);
        var lat = Math.cos(a) * r;          // offset along the route's right axis
        var y = Math.sin(a) * r;

        // Squash the lower half into a floor: anything below 0 gets pulled up to
        // a lumpy near-flat surface so monsters have somewhere to stand.
        var x = frame.x + frame.rx * lat;
        var z = frame.z + frame.rz * lat;
        if (y < 0) {
          var bump = (this.noise.fbm3(x * 0.16, 9.1, z * 0.16, 3) - 0.5) * 0.7;
          var flatness = CT.clamp(-y / 3.0, 0, 1);
          y = CT.lerp(y, bump - 0.05, flatness);
        } else {
          // clamp the ceiling so the tunnel does not balloon vertically
          y = Math.min(y, ceil);
        }

        verts.push(x, y, z);
        uvs.push((a / (Math.PI * 2)) * (2 * Math.PI * r) / UV_TILE, sa / UV_TILE);

        /* Vertex colour. Five noise fields at deliberately different scales,
         * because grime at one frequency just looks like a texture: broad
         * strata that read from across the chamber, mid-scale staining that
         * reads at conversation distance, and a fine grain that only does
         * anything up close, where it is the thing that stops a flat-shaded
         * facet looking moulded. Each layer is masked so it lands where that
         * kind of mark would actually be — rust high and dry, seepage in the
         * runs, crust and silt at the bottom. */
        var up = CT.clamp(y / 9, 0, 1);
        var low = CT.clamp((1.1 - y) / 2.2, 0, 1);          // 1 at the floor line

        var strata = N.fbm3(x * 0.032, y * 0.115, z * 0.032, 3);
        var streak = N.fbm3(x * 0.09, y * 0.09, z * 0.09, 3);
        var stain  = N.fbm3(x * 0.16 + 41.3, y * 0.06, z * 0.16, 3);
        var damp   = N.fbm3(x * 0.055 + 17.7, y * 0.24, z * 0.055, 3);
        // Coarse mottling only — anything finer than the vertex spacing is the
        // grime texture's job now.
        var grain  = N.fbm3(x * 0.19, y * 0.19, z * 0.19, 2);

        tmp.copy(cRock).lerp(cDark, up * 0.58 + strata * 0.30);

        // Iron staining: warm, blotchy, and thinner where water still runs.
        tmp.lerp(cRust, CT.clamp((stain - 0.58) * 2.1, 0, 0.33) * (0.45 + 0.55 * (1 - low)));
        // Wet runs, darkest where the damp field bottoms out.
        tmp.lerp(cSeep, CT.clamp((0.40 - damp) * 2.5, 0, 0.58));
        // Pale crust left behind where the damp field peaks.
        tmp.lerp(cCrust, CT.clamp((damp - 0.62) * 2.6, 0, 0.5));
        // Moss along the floor line, in the streaks.
        tmp.lerp(cMoss, CT.clamp((0.6 - Math.abs(y - 0.4) * 0.3) * (streak - 0.42) * 2.4, 0, 0.55));

        if (y < 0.9) {
          // The floor is trodden dirt rather than bare rock, with the spill
          // pooled in whatever is lowest.
          var floorAmt = CT.clamp((0.9 - y) / 1.5, 0, 1);
          tmp.lerp(cSilt, floorAmt * (0.18 + stain * 0.26));
          tmp.lerp(cSpill, CT.clamp((0.36 - damp) * 2.2, 0, 1) * floorAmt * 0.28);
        }

        // Fine per-vertex grain. Small, but it is the difference between stone
        // and injection moulding.
        var g = 1 + (grain - 0.5) * 0.42;
        tmp.setRGB(CT.clamp(tmp.r * g, 0, 1), CT.clamp(tmp.g * g, 0, 1), CT.clamp(tmp.b * g, 0, 1));
        colors.push(tmp.r, tmp.g, tmp.b);
      }
    }

    var stride = radial + 1;
    for (var ri = 0; ri < rings; ri++) {
      for (var rj = 0; rj < radial; rj++) {
        var a0 = ri * stride + rj;
        var b0 = a0 + 1;
        var c0 = a0 + stride;
        var d0 = c0 + 1;
        // Wound so the normals point INWARD — the camera lives inside this tube,
        // so the opposite winding culls the whole cave away.
        indices.push(a0, b0, c0);
        indices.push(b0, d0, c0);
      }
    }

    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    var mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      map: grimeTexture(),
      bumpMap: grimeTexture(),
      bumpScale: 0.055,
      roughness: 0.97,
      metalness: 0.03,
      flatShading: true,
      side: THREE.FrontSide
    });

    var mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = !!S().get('shadows');
    // Not the texture: it is shared by every chunk and freed by disposeTextures.
    disposables.push(geo, mat);
    return mesh;
  };

  /* ---- props ------------------------------------------------------------- */

  function trackMat(list, m) { list.push(m); return m; }
  function trackGeo(list, g) { list.push(g); return g; }

  Cave.prototype._propContainmentPod = function (rng, dis) {
    var pal = this.palette;
    var g = new THREE.Group();
    var h = rng.range(2.2, 3.4);
    var r = rng.range(0.55, 0.85);

    var baseGeo = trackGeo(dis, new THREE.CylinderGeometry(r * 1.25, r * 1.4, 0.35, 12));
    var baseMat = trackMat(dis, new THREE.MeshStandardMaterial({ color: pal.metalDark, roughness: 0.7, metalness: 0.7 }));
    var base = new THREE.Mesh(baseGeo, baseMat);
    base.position.y = 0.175;
    g.add(base);

    var capGeo = trackGeo(dis, new THREE.CylinderGeometry(r * 1.2, r * 1.3, 0.3, 12));
    var cap = new THREE.Mesh(capGeo, baseMat);
    cap.position.y = h + 0.15;
    g.add(cap);

    var broken = rng.bool(0.55);
    var glassGeo = trackGeo(dis, new THREE.CylinderGeometry(r, r, h, 14, 1, true,
      broken ? rng.range(0, 6) : 0, broken ? rng.range(3.4, 5.4) : Math.PI * 2));
    var glassMat = trackMat(dis, new THREE.MeshStandardMaterial({
      color: 0x8fd6e0, transparent: true, opacity: 0.22, roughness: 0.15,
      metalness: 0.0, side: THREE.DoubleSide
    }));
    var glass = new THREE.Mesh(glassGeo, glassMat);
    glass.position.y = h / 2 + 0.3;
    g.add(glass);

    // occupant / residue
    if (rng.bool(0.75)) {
      var occGeo = trackGeo(dis, new THREE.IcosahedronGeometry(r * rng.range(0.45, 0.75), 1));
      var occMat = trackMat(dis, new THREE.MeshStandardMaterial({
        color: pal.goo, emissive: pal.goo, emissiveIntensity: rng.range(0.4, 1.1),
        roughness: 0.6, flatShading: true, transparent: true, opacity: 0.85
      }));
      var occ = new THREE.Mesh(occGeo, occMat);
      occ.position.y = rng.range(0.6, h * 0.7);
      occ.scale.y = rng.range(0.7, 1.6);
      g.add(occ);
      g.userData.pulse = occMat;
    }

    // vertical strip light
    var stripGeo = trackGeo(dis, new THREE.BoxGeometry(0.06, h * 0.8, 0.06));
    var stripMat = trackMat(dis, new THREE.MeshStandardMaterial({
      color: 0x111111, emissive: pal.glow2, emissiveIntensity: rng.range(0.6, 1.6)
    }));
    var strip = new THREE.Mesh(stripGeo, stripMat);
    strip.position.set(r * 1.05, h / 2 + 0.3, 0);
    g.add(strip);

    return g;
  };

  Cave.prototype._propGurney = function (rng, dis) {
    var pal = this.palette;
    var g = new THREE.Group();
    var mat = trackMat(dis, new THREE.MeshStandardMaterial({ color: pal.metal, roughness: 0.55, metalness: 0.75 }));
    var topGeo = trackGeo(dis, new THREE.BoxGeometry(0.85, 0.08, 2.0));
    var top = new THREE.Mesh(topGeo, mat);
    top.position.y = 0.85;
    g.add(top);
    var legGeo = trackGeo(dis, new THREE.CylinderGeometry(0.04, 0.04, 0.85, 6));
    for (var i = 0; i < 4; i++) {
      var leg = new THREE.Mesh(legGeo, mat);
      leg.position.set((i < 2 ? -0.35 : 0.35), 0.42, (i % 2 ? -0.85 : 0.85));
      g.add(leg);
    }
    // restraint straps
    var strapMat = trackMat(dis, new THREE.MeshStandardMaterial({ color: 0x3a2b24, roughness: 0.9 }));
    var strapGeo = trackGeo(dis, new THREE.BoxGeometry(0.95, 0.03, 0.12));
    for (var s = 0; s < 2; s++) {
      var st = new THREE.Mesh(strapGeo, strapMat);
      st.position.set(0, 0.9, -0.5 + s * 1.0);
      g.add(st);
    }
    if (rng.bool(0.5)) g.rotation.z = rng.range(-0.5, 0.5); // tipped over
    return g;
  };

  Cave.prototype._propBarrel = function (rng, dis) {
    var g = new THREE.Group();
    var h = rng.range(0.9, 1.25), r = rng.range(0.34, 0.46);
    var geo = trackGeo(dis, new THREE.CylinderGeometry(r, r, h, 12));
    var mat = trackMat(dis, new THREE.MeshStandardMaterial({
      map: hazardTexture(), roughness: 0.8, metalness: 0.3
    }));
    mat.map.repeat.set(3, 1);
    var m = new THREE.Mesh(geo, mat);
    m.position.y = h / 2;
    g.add(m);
    var rimGeo = trackGeo(dis, new THREE.TorusGeometry(r * 1.02, 0.035, 5, 12));
    var rimMat = trackMat(dis, new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.7, metalness: 0.6 }));
    for (var i = 0; i < 2; i++) {
      var rim = new THREE.Mesh(rimGeo, rimMat);
      rim.rotation.x = Math.PI / 2;
      rim.position.y = h * (0.28 + i * 0.44);
      g.add(rim);
    }
    if (rng.bool(0.3)) { g.rotation.z = Math.PI / 2 * rng.sign(); g.position.y = r; }
    return g;
  };

  Cave.prototype._propPipes = function (rng, dis, len) {
    var pal = this.palette;
    var g = new THREE.Group();
    var n = rng.int(2, 4);
    var mat = trackMat(dis, new THREE.MeshStandardMaterial({ color: pal.metal, roughness: 0.5, metalness: 0.85 }));
    var hotMat = trackMat(dis, new THREE.MeshStandardMaterial({
      color: 0x231a16, emissive: pal.glow, emissiveIntensity: 0.55, roughness: 0.6
    }));
    for (var i = 0; i < n; i++) {
      var r = rng.range(0.09, 0.2);
      var geo = trackGeo(dis, new THREE.CylinderGeometry(r, r, len, 8));
      var m = new THREE.Mesh(geo, rng.bool(0.25) ? hotMat : mat);
      m.rotation.x = Math.PI / 2;
      m.position.set(rng.range(-0.5, 0.5), i * rng.range(0.3, 0.5), -len / 2);
      g.add(m);
      // flanges
      var fg = trackGeo(dis, new THREE.CylinderGeometry(r * 1.5, r * 1.5, 0.12, 8));
      for (var f = 0; f < 3; f++) {
        var fm = new THREE.Mesh(fg, mat);
        fm.rotation.x = Math.PI / 2;
        fm.position.set(m.position.x, m.position.y, -len * (0.15 + f * 0.35));
        g.add(fm);
      }
    }
    return g;
  };

  Cave.prototype._propSign = function (rng, dis) {
    var g = new THREE.Group();
    var geo = trackGeo(dis, new THREE.PlaneGeometry(1.3, 0.65));
    var mat = trackMat(dis, new THREE.MeshStandardMaterial({
      map: signTexture(rng.int(0, SIGN_TEXTS.length - 1)),
      roughness: 0.85, metalness: 0.1, side: THREE.DoubleSide,
      emissive: 0x2a2408, emissiveIntensity: 0.35
    }));
    var m = new THREE.Mesh(geo, mat);
    g.add(m);
    g.rotation.z = rng.range(-0.25, 0.25);
    return g;
  };

  Cave.prototype._propGooPool = function (rng, dis) {
    var pal = this.palette;
    var r = rng.range(0.8, 1.8);
    var geo = trackGeo(dis, new THREE.CircleGeometry(r, 12));
    var mat = trackMat(dis, new THREE.MeshStandardMaterial({
      color: 0x0d1a08, emissive: pal.goo, emissiveIntensity: rng.range(0.14, 0.34),
      roughness: 0.25, metalness: 0.1, transparent: true, opacity: 0.75,
      // The pool is a flat disc lying on a lumpy floor mesh; without a depth
      // bias the two z-fight into a shimmering mess.
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
    }));
    var m = new THREE.Mesh(geo, mat);
    m.rotation.x = -Math.PI / 2;
    m.position.y = 0.06;
    m.userData.pulse = mat;
    m.userData.pulseBase = mat.emissiveIntensity;
    return m;
  };

  Cave.prototype._propStalagmite = function (rng, dis, up) {
    var pal = this.palette;
    var h = rng.range(0.8, 3.2);
    var r = rng.range(0.22, 0.75);
    var geo = trackGeo(dis, new THREE.ConeGeometry(r, h, rng.int(5, 8), 2));
    var mat = trackMat(dis, new THREE.MeshStandardMaterial({
      color: pal.rockDark, roughness: 0.98, flatShading: true
    }));
    var m = new THREE.Mesh(geo, mat);
    m.position.y = up ? h / 2 : -h / 2;
    if (!up) m.rotation.z = Math.PI;
    var wrap = new THREE.Group();
    wrap.add(m);
    wrap.rotation.y = rng.range(0, 6.3);
    wrap.scale.set(rng.range(0.8, 1.2), 1, rng.range(0.8, 1.2));
    return wrap;
  };

  Cave.prototype._propLight = function (rng, dis, wantLight) {
    var pal = this.palette;
    var g = new THREE.Group();
    var housingGeo = trackGeo(dis, new THREE.BoxGeometry(0.5, 0.22, 0.22));
    var housingMat = trackMat(dis, new THREE.MeshStandardMaterial({ color: 0x1b1e21, roughness: 0.7, metalness: 0.6 }));
    g.add(new THREE.Mesh(housingGeo, housingMat));

    var broken = rng.bool(0.3);
    var col = broken ? 0xff3b2e : 0xffd9a0;
    var lensGeo = trackGeo(dis, new THREE.BoxGeometry(0.42, 0.14, 0.06));
    var lensMat = trackMat(dis, new THREE.MeshStandardMaterial({
      color: 0x0a0a0a, emissive: col, emissiveIntensity: broken ? 2.2 : 1.6
    }));
    var lens = new THREE.Mesh(lensGeo, lensMat);
    lens.position.z = 0.13;
    g.add(lens);

    g.userData.flicker = { mat: lensMat, base: broken ? 2.2 : 1.6, rate: rng.range(6, 24), broken: broken };

    if (wantLight) {
      var pl = new THREE.PointLight(col, broken ? 1.5 : 1.1, broken ? 13 : 16, 1.8);
      pl.position.z = 0.4;
      g.add(pl);
      g.userData.pointLight = pl;
      g.userData.flicker.light = pl;
      g.userData.flicker.lightBase = broken ? 1.5 : 1.1;
    }
    return g;
  };

  Cave.prototype._propCables = function (rng, dis) {
    var g = new THREE.Group();
    var mat = trackMat(dis, new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.95 }));
    var n = rng.int(2, 5);
    for (var i = 0; i < n; i++) {
      var span = rng.range(3, 7);
      var sag = rng.range(0.4, 1.6);
      var pts = [];
      for (var t = 0; t <= 8; t++) {
        var u = t / 8;
        pts.push(new THREE.Vector3(
          (u - 0.5) * span,
          -Math.sin(u * Math.PI) * sag,
          rng.range(-0.05, 0.05)
        ));
      }
      var curve = new THREE.CatmullRomCurve3(pts);
      var geo = trackGeo(dis, new THREE.TubeGeometry(curve, 10, rng.range(0.025, 0.06), 5, false));
      var m = new THREE.Mesh(geo, mat);
      m.position.y = -i * 0.12;
      g.add(m);
    }
    return g;
  };

  Cave.prototype._propRubble = function (rng, dis) {
    var pal = this.palette;
    var g = new THREE.Group();
    var mat = trackMat(dis, new THREE.MeshStandardMaterial({
      color: pal.rockDark, roughness: 0.98, flatShading: true
    }));
    var n = rng.int(3, 8);
    for (var i = 0; i < n; i++) {
      var s = rng.range(0.2, 0.9);
      var geo = trackGeo(dis, new THREE.DodecahedronGeometry(s, 0));
      var m = new THREE.Mesh(geo, mat);
      m.position.set(rng.range(-2, 2), s * rng.range(0.3, 0.6), rng.range(-2, 2));
      m.rotation.set(rng.range(0, 6.3), rng.range(0, 6.3), rng.range(0, 6.3));
      m.scale.set(1, rng.range(0.5, 0.9), 1);
      g.add(m);
    }
    return g;
  };

  Cave.prototype._propCatwalk = function (rng, dis) {
    var pal = this.palette;
    var g = new THREE.Group();
    var mat = trackMat(dis, new THREE.MeshStandardMaterial({ color: pal.metalDark, roughness: 0.65, metalness: 0.8 }));
    var len = rng.range(8, 16);
    var deckGeo = trackGeo(dis, new THREE.BoxGeometry(1.8, 0.12, len));
    var deck = new THREE.Mesh(deckGeo, mat);
    g.add(deck);
    var railGeo = trackGeo(dis, new THREE.CylinderGeometry(0.04, 0.04, len, 5));
    for (var i = 0; i < 2; i++) {
      var rail = new THREE.Mesh(railGeo, mat);
      rail.rotation.x = Math.PI / 2;
      rail.position.set(i ? 0.85 : -0.85, 0.55, 0);
      g.add(rail);
    }
    var postGeo = trackGeo(dis, new THREE.CylinderGeometry(0.035, 0.035, 0.6, 5));
    for (var p = 0; p < 6; p++) {
      for (var sdx = 0; sdx < 2; sdx++) {
        var post = new THREE.Mesh(postGeo, mat);
        post.position.set(sdx ? 0.85 : -0.85, 0.3, -len / 2 + (p + 0.5) * (len / 6));
        g.add(post);
      }
    }
    return g;
  };

  /* ---- chunk assembly ---------------------------------------------------- */

  /* Building a chunk is cheap in JavaScript — a couple of milliseconds — but the
   * NEXT render is not: fifty fresh BufferGeometries all get uploaded to the GPU
   * in one frame, and that measured at 60-105 ms, which is exactly the hitch
   * players were seeing while the rail moved between chambers.
   *
   * So a chunk is created in slices. The wall mesh goes up immediately (it is
   * one object and the chunk must not be an empty hole), and every prop is
   * pushed onto a work queue that `pump()` drains a couple of items per frame.
   * Spread that thinly, the uploads disappear into the frame budget. */
  Cave.prototype._buildChunk = function (ci) {
    if (this.chunks[ci]) return;
    var rng = new CT.Rng((this.seed ^ Math.imul(ci + 1, 0x9e3779b1)) >>> 0);
    var q = this.quality();
    var dis = [];
    var group = new THREE.Group();
    var lights = [];
    var animated = [];

    group.add(this._buildWalls(ci, dis));

    var s0 = ci * CHUNK_LEN;
    var propCount = Math.round(rng.int(9, 16) * q.props);
    var lightBudget = 2;
    var frame = { x: 0, z: 0, h: 0, rx: 1, rz: 0 };

    // Everything below is deferred onto the queue.
    var chunk = { group: group, disposables: dis, lights: lights, animated: animated,
                  pending: propCount, ci: ci };
    this.root.add(group);
    this.chunks[ci] = chunk;

    var lightBudgetRef = { n: lightBudget };
    for (var qi = 0; qi < propCount; qi++) {
      this._queue.push({ ci: ci, chunk: chunk, rng: rng, q: q, s0: s0,
                         lb: lightBudgetRef, frame: frame });
    }
    return;
  };

  /* Creates one prop for a queued chunk. Split out of _buildChunk so the work
   * can be dripped in over many frames instead of landing in one. */
  Cave.prototype._buildOneProp = function (job) {
    var chunk = job.chunk;
    // The chunk was recycled out from under this job while it sat in the queue.
    if (this.chunks[job.ci] !== chunk) return;

    var rng = job.rng, q = job.q, s0 = job.s0, frame = job.frame;
    var dis = chunk.disposables, group = chunk.group;
    var lights = chunk.lights, animated = chunk.animated;

    // Monsters walk up the middle of the tunnel, so anything tall enough to hide
    // one has to stay out of the central corridor. Flat floor decals and
    // ceiling-mounted clutter are exempt — they never block a silhouette.
    var CORRIDOR = 5.0;
    // The rail stops the players every `spacing` units. Nothing may be dressed
    // into those spots — a two-metre pool of luminous specimen fluid rendered
    // from inside is a magenta wall across half the screen.
    var SPACING = this.spacing;
    function nearAStation(sa) {
      var d = Math.abs(sa) % SPACING;
      return Math.min(d, SPACING - d) < 5.5;
    }
    function clearOfCorridor(lat, side) {
      if (Math.abs(lat) >= CORRIDOR) return lat;
      return side * CORRIDOR + lat * 0.15;
    }

    {
      var sa = s0 + rng.range(1, CHUNK_LEN - 1);
      // Corners carry no dressing: the geometry is densest there and a prop
      // pinned to a swinging wall reads as floating.
      if (nearAStation(sa) || this.isTurning(sa)) { chunk.pending--; return; }
      var side = rng.sign();
      var wallR = this.radiusAt(sa, side > 0 ? 0 : Math.PI);
      var kind = rng.next();
      var p = null, yPos = 0, xPos, baseRot = 0;

      if (kind < 0.13) {
        p = this._propContainmentPod(rng, dis);
        xPos = clearOfCorridor(side * rng.range(wallR * 0.45, wallR * 0.8), side);
      } else if (kind < 0.20) {
        p = this._propGurney(rng, dis);
        xPos = clearOfCorridor(side * rng.range(1.5, wallR * 0.7), side);
      } else if (kind < 0.30) {
        p = this._propBarrel(rng, dis);
        xPos = clearOfCorridor(side * rng.range(1.2, wallR * 0.85), side);
      } else if (kind < 0.38) {
        p = this._propPipes(rng, dis, rng.range(8, 20));
        xPos = side * rng.range(wallR * 0.7, wallR * 0.95);
        yPos = rng.range(1.2, 3.5);
      } else if (kind < 0.44) {
        p = this._propSign(rng, dis);
        xPos = side * rng.range(wallR * 0.72, wallR * 0.92);
        yPos = rng.range(1.6, 3.0);
        baseRot = side > 0 ? -Math.PI / 2 : Math.PI / 2;
      } else if (kind < 0.53) {
        p = this._propGooPool(rng, dis);
        xPos = rng.range(-wallR * 0.7, wallR * 0.7);
        animated.push(p);
      } else if (kind < 0.68) {
        p = this._propStalagmite(rng, dis, true);
        xPos = clearOfCorridor(side * rng.range(2.0, wallR * 0.9), side);
      } else if (kind < 0.76) {
        p = this._propStalagmite(rng, dis, false);
        xPos = rng.range(-wallR * 0.8, wallR * 0.8);
        yPos = this.ceilingAt(sa) * rng.range(0.75, 0.95);
      } else if (kind < 0.85) {
        var wantLight = job.lb.n > 0 && rng.bool(0.7);
        if (wantLight) job.lb.n--;
        p = this._propLight(rng, dis, wantLight);
        xPos = side * rng.range(wallR * 0.65, wallR * 0.88);
        yPos = rng.range(2.2, 4.2);
        baseRot = side > 0 ? -Math.PI / 2 : Math.PI / 2;
        if (p.userData.pointLight) lights.push(p.userData.pointLight);
        animated.push(p);
      } else if (kind < 0.92) {
        p = this._propCables(rng, dis);
        xPos = rng.range(-2, 2);
        yPos = this.ceilingAt(sa) * rng.range(0.6, 0.85);
      } else if (kind < 0.97) {
        p = this._propRubble(rng, dis);
        xPos = clearOfCorridor(side * rng.range(2, wallR * 0.7), side);
      } else {
        p = this._propCatwalk(rng, dis);
        xPos = side * rng.range(1.5, 4);   // overhead, never in the way
        yPos = this.ceilingAt(sa) * rng.range(0.55, 0.75);
        baseRot = rng.range(-0.2, 0.2);
      }

      if (p) {
        // Place through the route's local frame so props sit against the walls
        // and turn with the corridor instead of staying axis-aligned.
        this.frameAt(sa, frame);
        p.position.set(frame.x + frame.rx * xPos, yPos, frame.z + frame.rz * xPos);
        if (!baseRot && kind > 0.44 && kind < 0.85) baseRot = rng.range(0, 6.28);
        p.rotation.y = baseRot + frame.h;
        if (S().get('shadows')) {
          p.traverse(function (o) { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
        }
        group.add(p);
      }
    }
    chunk.pending--;
  };

  /* Drains queued prop work. Called every frame, in every game state — the
   * point is that chunks well ahead of the player finish assembling while they
   * are standing still fighting, long before the rail reaches them. */
  Cave.prototype.pump = function (maxProps) {
    var n = maxProps === undefined ? 2 : maxProps;
    while (n-- > 0 && this._queue.length) {
      this._buildOneProp(this._queue.shift());
    }
  };

  /* Finish everything now. Used behind the loading screen at the start of a run,
   * where a stall costs nothing. */
  Cave.prototype.drain = function () {
    while (this._queue.length) this._buildOneProp(this._queue.shift());
  };

  Cave.prototype._disposeChunk = function (ci) {
    var c = this.chunks[ci];
    if (!c) return;
    // Drop any queued work for this chunk before its geometries go away.
    if (c.pending > 0) {
      this._queue = this._queue.filter(function (j) { return j.ci !== ci; });
    }
    this.root.remove(c.group);
    for (var i = 0; i < c.disposables.length; i++) {
      var d = c.disposables[i];
      if (d && d.dispose) d.dispose();
    }
    delete this.chunks[ci];
  };

  /* Ensure the cave exists around the player's arc position, recycling behind. */
  Cave.prototype.streamTo = function (sArc) {
    var ci = Math.max(0, Math.floor(sArc / CHUNK_LEN));
    for (var i = Math.max(0, ci - KEEP_BEHIND); i <= ci + KEEP_AHEAD; i++) this._buildChunk(i);
    for (var key in this.chunks) {
      var k = parseInt(key, 10);
      if (k < ci - KEEP_BEHIND || k > ci + KEEP_AHEAD + 1) this._disposeChunk(k);
    }
  };

  Cave.prototype.rebuild = function () {
    for (var key in this.chunks) this._disposeChunk(parseInt(key, 10));
    this.chunks = {};
    this._queue.length = 0;
  };

  /* Floating motes so the air reads as thick and contaminated. */
  Cave.prototype._buildDust = function () {
    var density = S().getNum('particles');
    var count = Math.round(700 * density);
    if (this.dust) {
      this.stage.scene.remove(this.dust);
      this.dust.geometry.dispose();
      this.dust.material.dispose();
      this.dust = null;
    }
    if (count <= 0) return;
    var pos = new Float32Array(count * 3);
    var rng = this.rng.fork('dust');
    for (var i = 0; i < count; i++) {
      pos[i * 3] = rng.range(-16, 16);
      pos[i * 3 + 1] = rng.range(-1, 9);
      pos[i * 3 + 2] = rng.range(-46, 6);
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    var mat = new THREE.PointsMaterial({
      color: 0x8fa8b8, size: 0.035, transparent: true, opacity: 0.16,
      depthWrite: false, sizeAttenuation: true, fog: true
    });
    this.dust = new THREE.Points(geo, mat);
    this.dust.frustumCulled = false;
    this.dust.userData.noShadow = true;
    this.stage.scene.add(this.dust);
  };

  Cave.prototype.update = function (dt, time, playerS) {
    this.pump();

    // dust follows the player so the field never runs out
    if (this.dust) {
      this.pointAt(playerS, this.dust.position);
      this.dust.rotation.y = this.headingAt(playerS);
      var a = this.dust.geometry.attributes.position;
      // gentle upward drift, wrapped
      for (var i = 1; i < a.array.length; i += 3) {
        a.array[i] += dt * 0.12;
        if (a.array[i] > 9) a.array[i] = -1;
      }
      a.needsUpdate = true;
    }

    var flick = S().get('lightFlicker');
    for (var key in this.chunks) {
      var anim = this.chunks[key].animated;
      for (var j = 0; j < anim.length; j++) {
        var o = anim[j];
        if (o.userData.flicker && flick) {
          var f = o.userData.flicker;
          var n = Math.sin(time * f.rate) * 0.5 + Math.sin(time * f.rate * 2.7 + 1.3) * 0.3;
          var v = f.broken
            ? (n > 0.1 ? 1 : 0.06) * f.base
            : f.base * (0.85 + n * 0.2);
          f.mat.emissiveIntensity = v;
          if (f.light) f.light.intensity = f.lightBase * (f.broken ? (n > 0.1 ? 1 : 0.05) : (0.85 + n * 0.2));
        } else if (o.userData.flicker) {
          o.userData.flicker.mat.emissiveIntensity = o.userData.flicker.base;
          if (o.userData.flicker.light) o.userData.flicker.light.intensity = o.userData.flicker.lightBase;
        }
        if (o.userData.pulse) {
          var base = o.userData.pulseBase === undefined ? 0.45 : o.userData.pulseBase;
          o.userData.pulse.emissiveIntensity = base * (1 + Math.sin(time * 1.7 + o.position.z) * 0.4);
        }
      }
    }
  };

  Cave.prototype.dispose = function () {
    for (var key in this.chunks) this._disposeChunk(parseInt(key, 10));
    if (this.dust) {
      this.stage.scene.remove(this.dust);
      this.dust.geometry.dispose();
      this.dust.material.dispose();
      this.dust = null;
    }
    this.stage.scene.remove(this.root);
  };

  CT.Cave = Cave;
  CT.CHUNK_LEN = CHUNK_LEN;
  CT.caveDisposeTextures = disposeTextures;
})(window);
