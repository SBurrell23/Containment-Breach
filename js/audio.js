/* Cave Typer — 100% synthesised audio. No samples, no files.
 *
 * Bus layout:   [voice] -> sfx|ambience|music gain -> master gain -> compressor -> out
 * Everything is built from oscillators plus one shared white-noise buffer. */
(function (global) {
  'use strict';
  var CT = (global.CaveTyper = global.CaveTyper || {});

  var ctx = null;
  var master, comp, busSfx, busAmb, busMusic;
  var noiseBuf = null;
  var started = false;
  var ambienceNodes = null;
  var musicState = null;      // synthesised drone (fallback / no-file mode)
  var trackState = null;      // the scored loop
  var enabled = true;

  var TRACK_URL = 'audio/deep-cave-echoes.mp3';
  // The track is a bed, not a feature. This sits under the player's own music
  // slider so even at 100% it stays behind the rifle and the specimens.
  var TRACK_GAIN = 0.34;

  function S() { return CT.Settings; }

  function ensure() {
    if (ctx) return ctx;
    var AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) { enabled = false; return null; }
    ctx = new AC();

    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 24;
    comp.ratio.value = 8;
    comp.attack.value = 0.003;
    comp.release.value = 0.22;
    comp.connect(ctx.destination);

    master = ctx.createGain();
    master.gain.value = 0.8;
    master.connect(comp);

    busSfx = ctx.createGain(); busSfx.gain.value = 0.9; busSfx.connect(master);
    busAmb = ctx.createGain(); busAmb.gain.value = 0.55; busAmb.connect(master);
    busMusic = ctx.createGain(); busMusic.gain.value = 0.45; busMusic.connect(master);

    // 2 s of white noise, reused by every noise-based voice.
    var len = Math.floor(ctx.sampleRate * 2);
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = noiseBuf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    applyVolumes();
    return ctx;
  }

  function applyVolumes() {
    var s = S();
    var mv = s ? s.getNum('musicVolume') : 0.4;
    var mas = s ? s.getNum('masterVolume') : 0.8;

    // An element that could not be routed into the graph never passes through
    // the master gain, so fold master in by hand.
    if (trackState && !trackState.routed) {
      try { trackState.el.volume = Math.max(0, Math.min(1, mas * mv * TRACK_GAIN)); } catch (e) {}
    }
    if (!ctx) return;
    master.gain.setTargetAtTime(mas, ctx.currentTime, 0.02);
    busSfx.gain.setTargetAtTime(s ? s.getNum('sfxVolume') : 0.9, ctx.currentTime, 0.02);
    busAmb.gain.setTargetAtTime(s ? s.getNum('ambienceVolume') : 0.55, ctx.currentTime, 0.05);
    busMusic.gain.setTargetAtTime(mv, ctx.currentTime, 0.05);
  }

  /* ---- primitive voices -------------------------------------------------- */

  function noise(dest, dur, gain, filterType, f0, f1, q) {
    var src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;

    var flt = ctx.createBiquadFilter();
    flt.type = filterType || 'bandpass';
    flt.frequency.setValueAtTime(f0, ctx.currentTime);
    if (f1 !== undefined && f1 !== null) flt.frequency.exponentialRampToValueAtTime(Math.max(20, f1), ctx.currentTime + dur);
    flt.Q.value = q === undefined ? 1 : q;

    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), ctx.currentTime + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);

    src.connect(flt); flt.connect(g); g.connect(dest);
    src.start();
    src.stop(ctx.currentTime + dur + 0.02);
    return { src: src, gain: g, filter: flt };
  }

  function tone(dest, type, f0, f1, dur, gain, delay) {
    var t = ctx.currentTime + (delay || 0);
    var o = ctx.createOscillator();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== undefined && f1 !== null && f1 !== f0) {
      o.frequency.exponentialRampToValueAtTime(Math.max(0.0001, f1), t + dur);
    }
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(dest);
    o.start(t); o.stop(t + dur + 0.02);
    return { osc: o, gain: g };
  }

  /* A cheap stereo placement so encounters feel wide. pan is -1..1 */
  function panned(dest, pan) {
    if (!ctx.createStereoPanner) return dest;
    var p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan || 0));
    p.connect(dest);
    return p;
  }

  /* ---- game sounds ------------------------------------------------------- */

  var Audio = {
    init: function () {
      ensure();
      if (ctx && ctx.state === 'suspended') ctx.resume();
      started = true;
      applyVolumes();
      Audio._nudgeTrack();
    },

    get ready() { return !!ctx && started; },

    resume: function () {
      if (ctx && ctx.state === 'suspended') ctx.resume();
      Audio._nudgeTrack();
    },

    refreshVolumes: applyVolumes,

    /* soft tick per accepted keystroke */
    key: function () {
      if (!ctx || !enabled) return;
      var s = S();
      if (s && !s.get('keyClicks')) return;
      noise(busSfx, 0.022, 0.09, 'bandpass', 2400 + Math.random() * 1200, 900, 3);
    },

    /* rejected keystroke */
    keyBad: function () {
      if (!ctx || !enabled) return;
      tone(busSfx, 'square', 150, 90, 0.09, 0.09);
      noise(busSfx, 0.07, 0.06, 'highpass', 1200, 400, 1);
    },

    /* Completing a word = firing. Layered: click, body, noise crack, tail. */
    shot: function (pan, power) {
      if (!ctx || !enabled) return;
      power = power === undefined ? 1 : power;
      var d = panned(busSfx, pan);
      // transient
      noise(d, 0.035, 0.5 * power, 'highpass', 5000, 2200, 0.7);
      // body crack
      noise(d, 0.16, 0.42 * power, 'bandpass', 1600, 260, 0.9);
      // low thump
      tone(d, 'sine', 180, 46, 0.19, 0.55 * power);
      tone(d, 'triangle', 320, 80, 0.10, 0.22 * power);
      // cave tail
      noise(d, 0.55, 0.10 * power, 'lowpass', 900, 220, 0.6);
    },

    /* charged shot for finishing a monster's last word */
    shotHeavy: function (pan) {
      if (!ctx || !enabled) return;
      var d = panned(busSfx, pan);
      noise(d, 0.05, 0.6, 'highpass', 4200, 1800, 0.7);
      noise(d, 0.28, 0.5, 'bandpass', 1100, 180, 0.8);
      tone(d, 'sine', 140, 32, 0.34, 0.7);
      tone(d, 'sawtooth', 220, 55, 0.16, 0.2);
      noise(d, 0.9, 0.14, 'lowpass', 700, 160, 0.5);
    },

    /* wet impact on flesh */
    hit: function (pan) {
      if (!ctx || !enabled) return;
      var d = panned(busSfx, pan);
      noise(d, 0.11, 0.3, 'bandpass', 700 + Math.random() * 400, 180, 1.4);
      tone(d, 'triangle', 260 + Math.random() * 90, 90, 0.09, 0.16);
    },

    /* specimen expires */
    death: function (pan, big) {
      if (!ctx || !enabled) return;
      var d = panned(busSfx, pan);
      var dur = big ? 1.4 : 0.55;
      noise(d, dur, big ? 0.42 : 0.26, 'lowpass', big ? 1400 : 900, 120, 0.8);
      tone(d, 'sawtooth', big ? 180 : 320, big ? 34 : 70, dur * 0.8, big ? 0.34 : 0.16);
      tone(d, 'sine', big ? 90 : 160, big ? 26 : 50, dur, big ? 0.4 : 0.14);
      // gristle
      for (var i = 0; i < (big ? 6 : 3); i++) {
        setTimeout(function () {
          if (ctx) noise(d, 0.09, 0.14, 'bandpass', 500 + Math.random() * 900, 200, 2);
        }, 40 + i * (big ? 120 : 70));
      }
    },

    /* monster swipes at a player */
    monsterAttack: function (pan) {
      if (!ctx || !enabled) return;
      var d = panned(busSfx, pan);
      noise(d, 0.22, 0.3, 'bandpass', 2600, 300, 0.8);
      tone(d, 'sawtooth', 110, 60, 0.26, 0.18);
    },

    /* a monster is within reach and growling */
    growl: function (pan, deep) {
      if (!ctx || !enabled) return;
      var d = panned(busSfx, pan);
      var base = deep ? 48 : 92;
      var o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(base, ctx.currentTime);
      var lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 6 + Math.random() * 7;
      var lg = ctx.createGain(); lg.gain.value = base * 0.35;
      lfo.connect(lg); lg.connect(o.frequency);
      var flt = ctx.createBiquadFilter();
      flt.type = 'lowpass'; flt.frequency.value = deep ? 420 : 780; flt.Q.value = 3;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(deep ? 0.3 : 0.18, ctx.currentTime + 0.12);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + (deep ? 1.1 : 0.6));
      o.connect(flt); flt.connect(g); g.connect(d);
      o.start(); lfo.start();
      o.stop(ctx.currentTime + 1.3); lfo.stop(ctx.currentTime + 1.3);
    },

    /* the player takes damage */
    playerHurt: function () {
      if (!ctx || !enabled) return;
      tone(busSfx, 'sine', 90, 38, 0.3, 0.5);
      noise(busSfx, 0.22, 0.24, 'lowpass', 600, 140, 0.7);
      tone(busSfx, 'square', 220, 140, 0.07, 0.1);
    },

    playerDown: function () {
      if (!ctx || !enabled) return;
      tone(busSfx, 'sine', 160, 28, 1.6, 0.5);
      tone(busSfx, 'sawtooth', 120, 22, 1.4, 0.2);
      noise(busSfx, 1.5, 0.2, 'lowpass', 500, 90, 0.6);
    },

    revive: function () {
      if (!ctx || !enabled) return;
      tone(busSfx, 'triangle', 300, 900, 0.3, 0.3);
      tone(busSfx, 'sine', 600, 1400, 0.25, 0.2, 0.05);
    },

    /* boss arrival */
    bossRoar: function () {
      if (!ctx || !enabled) return;
      var o = ctx.createOscillator(); o.type = 'sawtooth';
      o.frequency.setValueAtTime(70, ctx.currentTime);
      o.frequency.exponentialRampToValueAtTime(38, ctx.currentTime + 2.2);
      var o2 = ctx.createOscillator(); o2.type = 'square';
      o2.frequency.setValueAtTime(104, ctx.currentTime);
      o2.frequency.exponentialRampToValueAtTime(52, ctx.currentTime + 2.2);
      var lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 11;
      var lg = ctx.createGain(); lg.gain.value = 22;
      lfo.connect(lg); lg.connect(o.frequency); lg.connect(o2.frequency);
      var flt = ctx.createBiquadFilter(); flt.type = 'lowpass';
      flt.frequency.setValueAtTime(1600, ctx.currentTime);
      flt.frequency.exponentialRampToValueAtTime(260, ctx.currentTime + 2.2);
      flt.Q.value = 4;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.7, ctx.currentTime + 0.25);
      g.gain.setValueAtTime(0.7, ctx.currentTime + 1.4);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 2.4);
      o.connect(flt); o2.connect(flt); flt.connect(g); g.connect(busSfx);
      o.start(); o2.start(); lfo.start();
      o.stop(ctx.currentTime + 2.5); o2.stop(ctx.currentTime + 2.5); lfo.stop(ctx.currentTime + 2.5);
      noise(busSfx, 2.4, 0.2, 'lowpass', 400, 110, 0.6);
    },

    /* moving to the next chamber */
    advance: function () {
      if (!ctx || !enabled) return;
      noise(busSfx, 1.1, 0.16, 'lowpass', 300, 900, 0.5);
      tone(busSfx, 'sine', 55, 90, 1.0, 0.24);
    },

    alarm: function () {
      if (!ctx || !enabled) return;
      for (var i = 0; i < 3; i++) {
        tone(busSfx, 'square', 720, 500, 0.16, 0.13, i * 0.26);
        tone(busSfx, 'square', 540, 380, 0.16, 0.10, i * 0.26 + 0.01);
      }
    },

    /* Your partner landed the word you were half-way through. Deliberately not
     * the error buzz — you did nothing wrong — just a soft descending blip so
     * the letters vanishing off your word has an audible cause. */
    wordTaken: function () {
      if (!ctx || !enabled) return;
      tone(busSfx, 'sine', 760, 430, 0.09, 0.07);
      tone(busSfx, 'sine', 520, 300, 0.11, 0.05, 0.04);
    },

    uiClick: function () {
      if (!ctx || !enabled) return;
      tone(busSfx, 'square', 880, 1180, 0.05, 0.10);
    },

    uiBack: function () {
      if (!ctx || !enabled) return;
      tone(busSfx, 'square', 520, 300, 0.07, 0.10);
    },

    encounterClear: function () {
      if (!ctx || !enabled) return;
      tone(busSfx, 'triangle', 420, 640, 0.10, 0.18);
      tone(busSfx, 'triangle', 640, 860, 0.12, 0.16, 0.09);
      tone(busSfx, 'sine', 860, 1290, 0.20, 0.14, 0.19);
    },

    gameOver: function () {
      if (!ctx || !enabled) return;
      tone(busSfx, 'sawtooth', 220, 55, 2.4, 0.3);
      tone(busSfx, 'sine', 110, 28, 3.0, 0.35);
      noise(busSfx, 3.0, 0.15, 'lowpass', 700, 80, 0.6);
    },

    /* ---- ambience -------------------------------------------------------- */

    startAmbience: function () {
      if (!ctx || ambienceNodes) return;
      // Deep cave rumble: filtered noise with a slow wandering cutoff.
      var src = ctx.createBufferSource();
      src.buffer = noiseBuf; src.loop = true; src.playbackRate.value = 0.35;
      var lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 180; lp.Q.value = 0.8;
      var g = ctx.createGain(); g.gain.value = 0.55;
      src.connect(lp); lp.connect(g); g.connect(busAmb);
      src.start();

      // Air / ventilation hiss.
      var src2 = ctx.createBufferSource();
      src2.buffer = noiseBuf; src2.loop = true; src2.playbackRate.value = 1.0;
      var bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.6;
      var g2 = ctx.createGain(); g2.gain.value = 0.045;
      src2.connect(bp); bp.connect(g2); g2.connect(busAmb);
      src2.start();

      // Wandering cutoff LFO on the rumble.
      var lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 0.06;
      var lfg = ctx.createGain(); lfg.gain.value = 70;
      lfo.connect(lfg); lfg.connect(lp.frequency);
      lfo.start();

      // Irregular water drips.
      var dripTimer = setInterval(function () {
        if (!ctx || Math.random() > 0.55) return;
        var d = panned(busAmb, Math.random() * 2 - 1);
        var f = 900 + Math.random() * 1600;
        tone(d, 'sine', f, f * 0.35, 0.16, 0.22);
        noise(d, 0.05, 0.05, 'bandpass', f * 1.4, f * 0.6, 6);
      }, 1700);

      // Distant structural groans / far-off screams.
      var groanTimer = setInterval(function () {
        if (!ctx || Math.random() > 0.4) return;
        var d = panned(busAmb, Math.random() * 2 - 1);
        var f = 60 + Math.random() * 90;
        tone(d, 'sawtooth', f, f * 0.6, 2.2 + Math.random() * 2, 0.06);
        if (Math.random() < 0.3) tone(d, 'sine', 300 + Math.random() * 400, 180, 1.4, 0.03);
      }, 6500);

      ambienceNodes = { src: src, src2: src2, lfo: lfo, dripTimer: dripTimer, groanTimer: groanTimer };
    },

    stopAmbience: function () {
      if (!ambienceNodes) return;
      try { ambienceNodes.src.stop(); } catch (e) {}
      try { ambienceNodes.src2.stop(); } catch (e) {}
      try { ambienceNodes.lfo.stop(); } catch (e) {}
      clearInterval(ambienceNodes.dripTimer);
      clearInterval(ambienceNodes.groanTimer);
      ambienceNodes = null;
    },

    /* ---- music ------------------------------------------------------------
     * There are two music sources. The scored track is the bed; the synthesised
     * drone below is the fallback for when the file cannot be played, and is
     * skipped entirely once the track is running so the two do not fight.
     *
     * Routing the <audio> element through WebAudio buys the intensity filter,
     * but createMediaElementSource on a file:// page yields silence in Chrome
     * (the element's origin is opaque), so on that protocol the element is left
     * unrouted and driven by its own .volume instead. */

    startTrack: function () {
      if (!TRACK_URL || trackState) return false;
      var el = new global.Audio();
      el.src = TRACK_URL;
      el.loop = true;
      el.preload = 'auto';
      el.crossOrigin = 'anonymous';

      trackState = { el: el, routed: false, gain: null, filter: null, failed: false, intensity: 0 };

      el.addEventListener('error', function () {
        trackState.failed = true;
        // Nothing scored is playing, so bring the synthesised drone up instead.
        if (!musicState) Audio.startDrone();
      });

      if (ctx && global.location.protocol !== 'file:') {
        try {
          var src = ctx.createMediaElementSource(el);
          var flt = ctx.createBiquadFilter();
          flt.type = 'lowpass';
          flt.frequency.value = 2400;
          flt.Q.value = 0.7;
          var g = ctx.createGain();
          g.gain.value = TRACK_GAIN;
          src.connect(flt); flt.connect(g); g.connect(busMusic);
          trackState.routed = true;
          trackState.gain = g;
          trackState.filter = flt;
        } catch (e) {
          trackState.routed = false;
        }
      }

      if (!trackState.routed) applyVolumes();   // drive el.volume directly
      var p = el.play();
      if (p && p.catch) {
        p.catch(function () {
          // Autoplay blocked — retry on the next user gesture via resume().
        });
      }
      return true;
    },

    stopTrack: function () {
      if (!trackState) return;
      try { trackState.el.pause(); } catch (e) {}
      try { trackState.el.src = ''; } catch (e) {}
      trackState = null;
    },

    /* Called by init/resume: browsers refuse play() until a user gesture. */
    _nudgeTrack: function () {
      if (!trackState || trackState.failed) return;
      if (trackState.el.paused) {
        var p = trackState.el.play();
        if (p && p.catch) p.catch(function () {});
      }
    },

    startMusic: function () {
      // Idempotent. The track deliberately keeps playing under the game-over
      // screen, so a second run starts with one already live — without this
      // guard startTrack() would decline and the synthesised drone would come
      // up *on top of* the track that never stopped.
      if (trackState && !trackState.failed) { Audio._nudgeTrack(); return; }
      if (Audio.startTrack()) return;      // scored track is the bed
      Audio.startDrone();
    },

    startDrone: function () {
      if (!ctx || musicState) return;
      var out = ctx.createGain(); out.gain.value = 0.0001; out.connect(busMusic);
      out.gain.exponentialRampToValueAtTime(0.35, ctx.currentTime + 4);

      var flt = ctx.createBiquadFilter(); flt.type = 'lowpass';
      flt.frequency.value = 420; flt.Q.value = 2.0;
      flt.connect(out);

      var oscs = [];
      var roots = [55, 55.4, 82.5, 110.3];
      for (var i = 0; i < roots.length; i++) {
        var o = ctx.createOscillator();
        o.type = i % 2 ? 'sawtooth' : 'triangle';
        o.frequency.value = roots[i];
        var g = ctx.createGain(); g.gain.value = 0.16 / roots.length * 2;
        o.connect(g); g.connect(flt);
        o.start();
        oscs.push({ o: o, g: g, base: roots[i] });
      }

      // Slow pulse — the facility's failing power plant.
      var pulse = ctx.createOscillator(); pulse.type = 'sine'; pulse.frequency.value = 0.18;
      var pulseGain = ctx.createGain(); pulseGain.gain.value = 160;
      pulse.connect(pulseGain); pulseGain.connect(flt.frequency);
      pulse.start();

      musicState = { out: out, flt: flt, oscs: oscs, pulse: pulse, pulseGain: pulseGain, intensity: 0 };
    },

    /* 0..1+ — raise as the run gets deeper. */
    setMusicIntensity: function (v) {
      v = Math.max(0, Math.min(1.4, v));

      // The scored track cannot change key, but it can open up: muffled and
      // distant in the shallows, full-band by the time things are hopeless.
      if (trackState && trackState.routed && ctx) {
        trackState.intensity = v;
        trackState.filter.frequency.setTargetAtTime(1500 + v * 12000, ctx.currentTime, 2.0);
        trackState.gain.gain.setTargetAtTime(TRACK_GAIN * (0.82 + v * 0.18), ctx.currentTime, 2.0);
      }

      if (!musicState || !ctx) return;
      musicState.intensity = v;
      var t = ctx.currentTime;
      musicState.flt.frequency.setTargetAtTime(380 + v * 1500, t, 1.5);
      musicState.pulse.frequency.setTargetAtTime(0.16 + v * 1.1, t, 2.0);
      musicState.out.gain.setTargetAtTime(0.30 + v * 0.22, t, 2.0);
      for (var i = 0; i < musicState.oscs.length; i++) {
        var e = musicState.oscs[i];
        // detune the stack apart as things fall apart
        e.o.frequency.setTargetAtTime(e.base * (1 + (i % 2 ? 1 : -1) * v * 0.022), t, 2.0);
      }
    },

    setMusicCombat: function (on) {
      if (!musicState || !ctx) return;
      musicState.flt.Q.setTargetAtTime(on ? 6 : 2, ctx.currentTime, 0.6);
    },

    stopMusic: function () {
      Audio.stopTrack();
      if (!musicState) return;
      try {
        musicState.out.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 1.2);
        var ms = musicState;
        setTimeout(function () {
          for (var i = 0; i < ms.oscs.length; i++) { try { ms.oscs[i].o.stop(); } catch (e) {} }
          try { ms.pulse.stop(); } catch (e) {}
        }, 1400);
      } catch (e) {}
      musicState = null;
    },

    stopAll: function () {
      Audio.stopAmbience();
      Audio.stopMusic();
    },

    /* Diagnostics for the music track. The element is deliberately detached
     * from the DOM, so there is no other way to see its state. */
    trackInfo: function () {
      if (!trackState) return { present: false, drone: !!musicState };
      var el = trackState.el;
      return {
        present: true,
        routed: trackState.routed,
        failed: trackState.failed,
        paused: el.paused,
        loop: el.loop,
        currentTime: +el.currentTime.toFixed(2),
        duration: isNaN(el.duration) ? null : +el.duration.toFixed(1),
        readyState: el.readyState,
        elementVolume: +el.volume.toFixed(3),
        graphGain: trackState.gain ? +trackState.gain.gain.value.toFixed(3) : null,
        filterHz: trackState.filter ? Math.round(trackState.filter.frequency.value) : null,
        error: el.error ? el.error.code : null,
        drone: !!musicState
      };
    }
  };

  CT.Audio = Audio;
})(window);
