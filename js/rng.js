/* Cave Typer — seeded randomness + value noise.
 * Everything procedural in the game funnels through here so that a run can be
 * reproduced exactly from a single integer seed (which is also what gets sent
 * over the wire in multiplayer). */
(function (global) {
  'use strict';

  var CT = (global.CaveTyper = global.CaveTyper || {});

  /* mulberry32 — small, fast, good enough distribution for visuals + gameplay. */
  function mulberry32(a) {
    a = a >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), 1 | t);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashString(str) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  /* A seeded stream with the sugar the rest of the codebase actually wants. */
  function Rng(seed) {
    if (typeof seed === 'string') seed = hashString(seed);
    this.seed = seed >>> 0;
    this._next = mulberry32(this.seed);
  }
  Rng.prototype.next = function () { return this._next(); };
  Rng.prototype.range = function (a, b) { return a + this._next() * (b - a); };
  Rng.prototype.int = function (a, b) { return Math.floor(a + this._next() * (b - a + 1)); };
  Rng.prototype.pick = function (arr) { return arr[Math.floor(this._next() * arr.length) % arr.length]; };
  Rng.prototype.bool = function (p) { return this._next() < (p === undefined ? 0.5 : p); };
  Rng.prototype.sign = function () { return this._next() < 0.5 ? -1 : 1; };
  /* A bound plain function, for handing to code that just wants `rng()`. */
  Rng.prototype.fn = function () { var s = this; return function () { return s._next(); }; };
  /* Deterministic child stream — lets subsystems draw without disturbing each other. */
  Rng.prototype.fork = function (tag) {
    return new Rng((this.seed ^ hashString(String(tag)) ^ Math.floor(this._next() * 0xffffffff)) >>> 0);
  };
  Rng.prototype.shuffle = function (arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(this._next() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  };

  /* ---- value noise -------------------------------------------------------
   * Used for cave wall displacement and ambient wobble. Hash-based so it needs
   * no permutation table and is stable across machines. */
  function hash3(x, y, z, seed) {
    var h = seed >>> 0;
    h = Math.imul(h ^ (x | 0), 0x27d4eb2d) >>> 0;
    h = Math.imul(h ^ (y | 0), 0x165667b1) >>> 0;
    h = Math.imul(h ^ (z | 0), 0x9e3779b1) >>> 0;
    h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
  }

  function smooth(t) { return t * t * (3 - 2 * t); }

  function Noise(seed) { this.seed = (typeof seed === 'string' ? hashString(seed) : seed) >>> 0; }

  Noise.prototype.n3 = function (x, y, z) {
    var xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    var xf = smooth(x - xi), yf = smooth(y - yi), zf = smooth(z - zi);
    var s = this.seed;
    function lerp(a, b, t) { return a + (b - a) * t; }
    var c000 = hash3(xi, yi, zi, s), c100 = hash3(xi + 1, yi, zi, s);
    var c010 = hash3(xi, yi + 1, zi, s), c110 = hash3(xi + 1, yi + 1, zi, s);
    var c001 = hash3(xi, yi, zi + 1, s), c101 = hash3(xi + 1, yi, zi + 1, s);
    var c011 = hash3(xi, yi + 1, zi + 1, s), c111 = hash3(xi + 1, yi + 1, zi + 1, s);
    return lerp(
      lerp(lerp(c000, c100, xf), lerp(c010, c110, xf), yf),
      lerp(lerp(c001, c101, xf), lerp(c011, c111, xf), yf),
      zf
    );
  };

  /* fractal brownian motion, returns roughly [0,1] */
  Noise.prototype.fbm3 = function (x, y, z, octaves, lacunarity, gain) {
    octaves = octaves || 4; lacunarity = lacunarity || 2.0; gain = gain || 0.5;
    var amp = 0.5, freq = 1.0, sum = 0, norm = 0;
    for (var i = 0; i < octaves; i++) {
      sum += amp * this.n3(x * freq, y * freq, z * freq);
      norm += amp;
      amp *= gain; freq *= lacunarity;
    }
    return sum / norm;
  };

  CT.Rng = Rng;
  CT.Noise = Noise;
  CT.hashString = hashString;
  CT.mulberry32 = mulberry32;

  /* small shared math helpers */
  CT.clamp = function (v, a, b) { return v < a ? a : (v > b ? b : v); };
  CT.lerp = function (a, b, t) { return a + (b - a) * t; };
  CT.smoothstep = function (a, b, x) {
    var t = CT.clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  /* frame-rate independent exponential approach */
  CT.damp = function (a, b, lambda, dt) { return CT.lerp(a, b, 1 - Math.exp(-lambda * dt)); };
})(window);
