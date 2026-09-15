/* Containment Breach — shared surface detail.
 *
 * Everything in this game is built from flat-shaded primitives, and untextured
 * flat-shaded primitives read as injection-moulded plastic: the big shapes are
 * right, and every surface between them is a perfectly smooth gradient. Vertex
 * colour cannot rescue that, because the meshes are coarse — the cave wall has
 * a vertex roughly every two and a half units, so anything finer than about a
 * five-unit wavelength aliases into blotches rather than reading as grain.
 *
 * So the close-range dirt lives in a texture, where mesh density is irrelevant.
 * One generated tile per surface kind, shared by every material that asks for
 * it, used as both map and bump map — the same field that darkens a surface
 * also pushes it around, which is what stops it looking like a decal printed on
 * plastic.
 *
 * Each kind is centred bright on purpose. These are meant to modulate a
 * surface, not to repaint it grey: the cave is dark because the lamp is weak.
 */
(function (global) {
  'use strict';
  var CT = (global.ContainmentBreach = global.ContainmentBreach || {});

  var RES = 256;

  var KINDS = {
    /* Wet rock: heavy contrast, strong vertical running, pitted. */
    rock: {
      seed: 0x9e3779b9, centre: 0.70, contrast: 1.25,
      amps: [0.34, 0.26, 0.20, 0.13, 0.07],
      drip: 0.22, pit: 0.014, fleck: 0.008
    },
    /* Machined surfaces that have spent years in a damp cave. Tighter and much
     * subtler than rock — a steel gurney is scuffed and stained, not eroded. */
    metal: {
      seed: 0x1b873593, centre: 0.85, contrast: 0.72,
      amps: [0.16, 0.22, 0.26, 0.22, 0.14],
      drip: 0.30, pit: 0.010, fleck: 0.005
    },
    /* Living surfaces: blotchy and mottled, with no vertical run at all,
     * because nothing has been trickling down a specimen for a decade. */
    hide: {
      seed: 0xcc9e2d51, centre: 0.83, contrast: 0.74,
      amps: [0.30, 0.30, 0.22, 0.12, 0.06],
      drip: 0.0, pit: 0.006, fleck: 0.004
    }
  };

  var SIZES = [4, 8, 16, 32, 64];
  var _cache = {};

  function build(name) {
    var K = KINDS[name] || KINDS.rock;
    var c = document.createElement('canvas');
    c.width = c.height = RES;
    var g = c.getContext('2d');
    var img = g.createImageData(RES, RES);
    var rng = new CT.Rng(K.seed);

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
      x0 = ((x0 % size) + size) % size;
      y0 = ((y0 % size) + size) % size;
      var s00 = a[y0 * size + x0], s10 = a[y0 * size + x1];
      var s01 = a[y1 * size + x0], s11 = a[y1 * size + x1];
      return (s00 * (1 - fx) + s10 * fx) * (1 - fy) + (s01 * (1 - fx) + s11 * fx) * fy;
    }

    var oct = [];
    for (var o = 0; o < SIZES.length; o++) oct.push(lattice(SIZES[o]));
    var drip = K.drip > 0 ? lattice(48) : null;

    for (var y = 0; y < RES; y++) {
      for (var x = 0; x < RES; x++) {
        var u = x / RES, v = y / RES;
        var n = 0;
        for (var k = 0; k < oct.length; k++) n += K.amps[k] * sample(oct[k], SIZES[k], u, v);
        // Streaking: the same field squashed along v, so it runs downhill.
        if (drip) n = n * (1 - K.drip) + sample(drip, 48, u, v * 0.22) * K.drip;

        var val = K.centre + (n - 0.5) * K.contrast;
        if (val < 0.06) val = 0.06; else if (val > 1) val = 1;

        // A scatter of dark pits and pale mineral flecks, which is what keeps
        // the result from reading as smooth cloud.
        var r = rng.next();
        if (r < K.pit) val *= 0.45;
        else if (r > 1 - K.fleck) val = Math.min(1, val * 1.8);

        var b = Math.round(val * 255);
        var i2 = (y * RES + x) * 4;
        img.data[i2] = b; img.data[i2 + 1] = b; img.data[i2 + 2] = b; img.data[i2 + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    var t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
    return t;
  }

  /* `repeat` is baked into a cached variant rather than left to the caller.
   * The texture object is shared by every material that asks for this kind, and
   * `repeat` lives on the texture, not the material — so a caller setting it
   * would silently change the tiling of everything else in the scene. */
  CT.detail = function (kind, repeat) {
    repeat = repeat || 1;
    var key = kind + '@' + repeat;
    if (_cache[key]) return _cache[key];
    var base = _cache[kind + '@1'] || (_cache[kind + '@1'] = build(kind));
    if (repeat === 1) return base;
    var t = base.clone();
    t.repeat.set(repeat, repeat);
    t.needsUpdate = true;
    _cache[key] = t;
    return t;
  };

  /* Give a material surface detail, unless it already has a map or is one of
   * the things detail would ruin: anything glowing is meant to read as a light
   * source, and anything transparent is meant to read as glass or slime. */
  CT.detailMat = function (mat, kind, repeat, bump) {
    if (!mat || mat.map || mat.transparent) return mat;
    // Emissive intensity alone says nothing — it defaults to 1 on every
    // MeshStandardMaterial, including the ones whose emissive is pure black.
    // What matters is how much light the surface is actually claiming to give
    // off, which is the colour and the intensity together.
    var e = mat.emissive;
    if (e) {
      var i = mat.emissiveIntensity === undefined ? 1 : mat.emissiveIntensity;
      if ((e.r + e.g + e.b) * i > 0.35) return mat;
    }
    var t = CT.detail(kind, repeat);
    mat.map = t;
    if (bump !== 0) {
      mat.bumpMap = t;
      mat.bumpScale = bump || 0.02;
    }
    mat.needsUpdate = true;
    return mat;
  };

  CT.detailDispose = function () {
    for (var k in _cache) { if (_cache[k]) _cache[k].dispose(); }
    _cache = {};
  };
})(window);
