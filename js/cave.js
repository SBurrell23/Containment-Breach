/* Cave Typer — procedural cave tunnel and ruined-lab set dressing.
 *
 * The tunnel is generated in chunks along -Z and recycled behind the player, so
 * a run can go on forever without the scene growing without bound. Every chunk
 * is derived from (runSeed, chunkIndex), so the same seed gives the same cave —
 * which is what keeps two networked players in the same-looking cave. */
(function (global) {
  'use strict';
  var CT = (global.CaveTyper = global.CaveTyper || {});
  var S = function () { return CT.Settings; };

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
    return {
      rock: new THREE.Color().setHSL(rockH, rng.range(0.06, 0.16), rng.range(0.12, 0.2)),
      rockDark: new THREE.Color().setHSL(rockH, rng.range(0.08, 0.2), rng.range(0.05, 0.09)),
      moss: new THREE.Color().setHSL(rng.range(0.22, 0.32), 0.45, 0.16),
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

    this.dust = null;
    this._buildDust();
  }

  /* Tunnel centre-line X offset at a given z. Gentle, long-wavelength drift. */
  Cave.prototype.centerX = function (z) {
    var n = this.noise;
    return (n.n3(z * 0.008, 0.5, 11.3) - 0.5) * 9.0 + (n.n3(z * 0.031, 3.7, 2.1) - 0.5) * 2.4;
  };

  /* Ceiling height at a given z — used so chambers open up and corridors squeeze. */
  Cave.prototype.ceilingAt = function (z) {
    var n = this.noise;
    return 6.0 + n.fbm3(z * 0.013, 7.7, 0.0, 3) * 5.5;
  };

  Cave.prototype.radiusAt = function (z, angle) {
    var n = this.noise;
    var base = 7.2 + n.fbm3(z * 0.011, 2.2, 0.0, 3) * 5.0;
    var wob = n.fbm3(Math.cos(angle) * 1.6, Math.sin(angle) * 1.6, z * 0.055, 4) - 0.5;
    return base * (1 + wob * 0.42);
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
    var z0 = -ci * CHUNK_LEN;
    var rings = q.rings, radial = q.radial;
    var verts = [], colors = [], indices = [];
    var pal = this.palette;
    var cRock = pal.rock, cDark = pal.rockDark, cMoss = pal.moss;
    var tmp = new THREE.Color();

    // One extra ring of overlap so chunks seam without a visible crack.
    for (var i = 0; i <= rings; i++) {
      var t = i / rings;
      var z = z0 - t * CHUNK_LEN;
      var cx = this.centerX(z);
      var ceil = this.ceilingAt(z);

      for (var j = 0; j <= radial; j++) {
        var a = (j / radial) * Math.PI * 2;
        var r = this.radiusAt(z, a);
        var x = cx + Math.cos(a) * r;
        var y = Math.sin(a) * r;

        // Squash the lower half into a floor: anything below 0 gets pulled up to
        // a lumpy near-flat surface so monsters have somewhere to stand.
        if (y < 0) {
          var bump = (this.noise.fbm3(x * 0.16, 9.1, z * 0.16, 3) - 0.5) * 0.7;
          var flatness = CT.clamp(-y / 3.0, 0, 1);
          y = CT.lerp(y, bump - 0.05, flatness);
        } else {
          // clamp the ceiling so the tunnel does not balloon vertically
          y = Math.min(y, ceil);
        }

        verts.push(x, y, z);

        // vertex colour: darker high up, mossy near the floor line, streaks
        var up = CT.clamp(y / 9, 0, 1);
        var streak = this.noise.fbm3(x * 0.09, y * 0.09, z * 0.09, 3);
        tmp.copy(cRock).lerp(cDark, up * 0.75 + streak * 0.25);
        var mossAmt = CT.clamp((0.6 - Math.abs(y - 0.4) * 0.3) * (streak - 0.42) * 2.4, 0, 0.55);
        tmp.lerp(cMoss, mossAmt);
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
    geo.setIndex(indices);
    geo.computeVertexNormals();

    var mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.96,
      metalness: 0.04,
      flatShading: true,
      side: THREE.FrontSide
    });

    var mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = !!S().get('shadows');
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

  Cave.prototype._buildChunk = function (ci) {
    if (this.chunks[ci]) return;
    var rng = new CT.Rng((this.seed ^ Math.imul(ci + 1, 0x9e3779b1)) >>> 0);
    var q = this.quality();
    var dis = [];
    var group = new THREE.Group();
    var lights = [];
    var animated = [];

    group.add(this._buildWalls(ci, dis));

    var z0 = -ci * CHUNK_LEN;
    var propCount = Math.round(rng.int(9, 16) * q.props);
    var lightBudget = 2;

    // Monsters walk up the middle of the tunnel, so anything tall enough to hide
    // one has to stay out of the central corridor. Flat floor decals and
    // ceiling-mounted clutter are exempt — they never block a silhouette.
    var CORRIDOR = 5.0;

    // The rail stops the players every `stationSpacing` units. Nothing may be
    // dressed into those spots — a two-metre pool of luminous specimen fluid
    // rendered from inside is a magenta wall across half the screen.
    var SPACING = (CT.Difficulty && CT.Difficulty.TUNING.stationSpacing) || 26;
    function nearAStation(z) {
      var d = Math.abs(z) % SPACING;
      return Math.min(d, SPACING - d) < 5.5;
    }

    function clearOfCorridor(x, cx, side) {
      var off = x - cx;
      if (Math.abs(off) >= CORRIDOR) return x;
      return cx + side * CORRIDOR + (x - cx) * 0.15;
    }

    for (var i = 0; i < propCount; i++) {
      var z = z0 - rng.range(1, CHUNK_LEN - 1);
      if (nearAStation(z)) continue;
      var cx = this.centerX(z);
      var side = rng.sign();
      var wallR = this.radiusAt(z, side > 0 ? 0 : Math.PI);
      var kind = rng.next();
      var p = null, yPos = 0, xPos;

      if (kind < 0.13) {
        p = this._propContainmentPod(rng, dis);
        xPos = clearOfCorridor(cx + side * rng.range(wallR * 0.45, wallR * 0.8), cx, side);
      } else if (kind < 0.20) {
        p = this._propGurney(rng, dis);
        xPos = clearOfCorridor(cx + side * rng.range(1.5, wallR * 0.7), cx, side);
      } else if (kind < 0.30) {
        p = this._propBarrel(rng, dis);
        xPos = clearOfCorridor(cx + side * rng.range(1.2, wallR * 0.85), cx, side);
      } else if (kind < 0.38) {
        p = this._propPipes(rng, dis, rng.range(8, 20));
        xPos = cx + side * rng.range(wallR * 0.7, wallR * 0.95);
        yPos = rng.range(1.2, 3.5);
      } else if (kind < 0.44) {
        p = this._propSign(rng, dis);
        xPos = cx + side * rng.range(wallR * 0.72, wallR * 0.92);
        yPos = rng.range(1.6, 3.0);
        p.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
      } else if (kind < 0.53) {
        p = this._propGooPool(rng, dis);
        xPos = cx + rng.range(-wallR * 0.7, wallR * 0.7);
        animated.push(p);
      } else if (kind < 0.68) {
        p = this._propStalagmite(rng, dis, true);
        xPos = clearOfCorridor(cx + side * rng.range(2.0, wallR * 0.9), cx, side);
      } else if (kind < 0.76) {
        p = this._propStalagmite(rng, dis, false);
        xPos = cx + rng.range(-wallR * 0.8, wallR * 0.8);
        yPos = this.ceilingAt(z) * rng.range(0.75, 0.95);
      } else if (kind < 0.85) {
        var wantLight = lightBudget > 0 && rng.bool(0.7);
        if (wantLight) lightBudget--;
        p = this._propLight(rng, dis, wantLight);
        xPos = cx + side * rng.range(wallR * 0.65, wallR * 0.88);
        yPos = rng.range(2.2, 4.2);
        p.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
        if (p.userData.pointLight) lights.push(p.userData.pointLight);
        animated.push(p);
      } else if (kind < 0.92) {
        p = this._propCables(rng, dis);
        xPos = cx + rng.range(-2, 2);
        yPos = this.ceilingAt(z) * rng.range(0.6, 0.85);
      } else if (kind < 0.97) {
        p = this._propRubble(rng, dis);
        xPos = clearOfCorridor(cx + side * rng.range(2, wallR * 0.7), cx, side);
      } else {
        p = this._propCatwalk(rng, dis);
        xPos = cx + side * rng.range(1.5, 4);   // overhead, never in the way
        yPos = this.ceilingAt(z) * rng.range(0.55, 0.75);
        p.rotation.y = rng.range(-0.2, 0.2);
      }

      if (p) {
        p.position.set(xPos, yPos, z);
        if (!p.rotation.y && kind > 0.44 && kind < 0.85) p.rotation.y = rng.range(0, 6.28);
        group.add(p);
      }
    }

    if (S().get('shadows')) {
      group.traverse(function (o) { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    }

    this.root.add(group);
    this.chunks[ci] = { group: group, disposables: dis, lights: lights, animated: animated };
  };

  Cave.prototype._disposeChunk = function (ci) {
    var c = this.chunks[ci];
    if (!c) return;
    this.root.remove(c.group);
    for (var i = 0; i < c.disposables.length; i++) {
      var d = c.disposables[i];
      if (d && d.dispose) d.dispose();
    }
    delete this.chunks[ci];
  };

  /* Ensure the cave exists around the player's z, recycling what is behind. */
  Cave.prototype.streamTo = function (z) {
    var ci = Math.max(0, Math.floor(-z / CHUNK_LEN));
    for (var i = Math.max(0, ci - KEEP_BEHIND); i <= ci + KEEP_AHEAD; i++) this._buildChunk(i);
    for (var key in this.chunks) {
      var k = parseInt(key, 10);
      if (k < ci - KEEP_BEHIND || k > ci + KEEP_AHEAD + 1) this._disposeChunk(k);
    }
  };

  Cave.prototype.rebuild = function () {
    for (var key in this.chunks) this._disposeChunk(parseInt(key, 10));
    this.chunks = {};
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

  Cave.prototype.update = function (dt, time, playerZ) {
    // dust follows the player so the field never runs out
    if (this.dust) {
      this.dust.position.z = playerZ;
      this.dust.position.x = this.centerX(playerZ);
      this.dust.rotation.y = time * 0.01;
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
