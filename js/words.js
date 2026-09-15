/* Containment Breach — difficulty-scaled word selection.
 *
 * The words themselves live in js/wordbank.js, which is GENERATED and
 * dictionary-verified (see tools/build-wordbank.js). This file only decides
 * which of them a given chamber gets.
 *
 * Selection is by length band, because length is what actually costs a typist
 * time. On top of that, modifiers unlock progressively so late-game words
 * punish the things that slow a fast typist down specifically: shift keys,
 * hyphens, underscores and digits.
 */
(function (global) {
  'use strict';
  var CT = (global.ContainmentBreach = global.ContainmentBreach || {});

  function bank() { return CT.WordBank; }

  /* Facility asset tags — the late-game symbol/digit punishers. These are not
   * claimed to be dictionary words; they are equipment labels, and they read as
   * such. Their component words are real and validated. */
  var TAG_PREFIX = ('SPEC VAT LAB SEC BIO GEN TOX RAD VIV NEC HEM CRY INC SUB').split(' ');
  var TAG_WORDS = ('breach purge reflux lockdown override failsafe sterilize venting ' +
    'collapse cascade rupture meltdown scrubber shutdown quarantine containment ' +
    'evacuation incineration decontamination').split(' ');

  /* Difficulty is a 0..1-ish scalar derived from encounter index (can exceed 1). */
  function lengthBand(difficulty) {
    // 3-5 chars at the start, creeping to 13-18 by the time it is brutal.
    var lo = 3 + difficulty * 7.0;
    var hi = 5 + difficulty * 9.5;
    return [Math.max(3, Math.round(lo)), Math.max(4, Math.round(hi))];
  }

  /* The bank indexed by first letter and then by length, built once on demand.
   *
   * The planner hands every specimen its own exclusive set of initials (see
   * dealLetters in js/difficulty.js), so picking has to be able to ask for "a
   * nine-letter word starting with k" without scanning four thousand entries
   * to find one. */
  var _byLetter = null;
  function letterIndex() {
    if (_byLetter) return _byLetter;
    _byLetter = {};
    var B = bank();
    for (var L in B.byLength) {
      var list = B.byLength[L];
      for (var i = 0; i < list.length; i++) {
        var w = list[i], c = w.charAt(0);
        if (!_byLetter[c]) _byLetter[c] = {};
        if (!_byLetter[c][L]) _byLetter[c][L] = [];
        _byLetter[c][L].push(w);
      }
    }
    return _byLetter;
  }

  /* Letters ordered by how much of the bank actually starts with each, so the
   * planner can hand out a well-stocked initial first and only reach the thin
   * end of the alphabet once every specimen already has one. */
  var _ranking = null;
  function letterRanking() {
    if (_ranking) return _ranking;
    var idx = letterIndex();
    var counts = [];
    for (var c in idx) {
      var n = 0;
      for (var L in idx[c]) n += idx[c][L].length;
      counts.push([c, n]);
    }
    counts.sort(function (a, b) { return b[1] - a[1]; });
    _ranking = counts.map(function (p) { return p[0]; });
    return _ranking;
  }

  /* One word whose length falls in [lo, hi], and — when `letters` is given —
   * starting with one of them. The band widens rather than failing: the bank
   * tops out at 16 characters, so a late-game band asking for 13-18 simply gets
   * the longest words on file. The LETTERS are held onto much harder than the
   * length is, because a specimen keeping its own initial is what makes
   * targeting unambiguous, whereas a word two characters off the ideal length
   * is something no player will notice. */
  function pickByLength(rng, lo, hi, letters) {
    var B = bank();
    var pool = [], L, i, widen;

    if (letters && letters.length) {
      var idx = letterIndex();
      for (i = 0; i < letters.length; i++) {
        var byL = idx[letters[i]];
        if (!byL) continue;
        for (L = lo; L <= hi; L++) if (byL[L]) pool = pool.concat(byL[L]);
      }
      for (widen = 1; !pool.length && widen < 16; widen++) {
        for (i = 0; i < letters.length; i++) {
          var b2 = idx[letters[i]];
          if (!b2) continue;
          if (b2[lo - widen]) pool = pool.concat(b2[lo - widen]);
          if (b2[hi + widen]) pool = pool.concat(b2[hi + widen]);
        }
      }
      if (pool.length) return rng.pick(pool);
      // Only if this letter set has nothing at all anywhere in the bank.
    }

    for (L = lo; L <= hi; L++) {
      if (B.byLength[L]) pool = pool.concat(B.byLength[L]);
    }
    for (widen = 1; !pool.length && widen < 14; widen++) {
      var a = lo - widen, b = hi + widen;
      if (B.byLength[a]) pool = pool.concat(B.byLength[a]);
      if (B.byLength[b]) pool = pool.concat(B.byLength[b]);
    }
    if (!pool.length) pool = B.all;
    return rng.pick(pool);
  }

  /* The subset of a tag pool that keeps the specimen's initials. */
  function tagsFor(pool, letters) {
    if (!letters || !letters.length) return pool;
    var out = [];
    for (var i = 0; i < pool.length; i++) {
      if (letters.indexOf(pool[i].charAt(0).toLowerCase()) !== -1) out.push(pool[i]);
    }
    return out;
  }

  /* Modifiers, unlocked progressively. Each returns a transformed word.
   *
   * Two of them replace the word outright rather than decorating it, so when
   * the caller owns a set of initials those two have to draw from the part of
   * their pool that keeps one — otherwise a specimen dealt "k" suddenly shows
   * SPEC-42 and collides with whatever else starts with S. */
  function applyModifiers(word, rng, difficulty, letters) {
    var out = word;

    // >0.30 : occasional hyphenated compound
    if (difficulty > 0.30 && rng.bool(Math.min(0.28, (difficulty - 0.30) * 0.6))) {
      out = out + '-' + pickByLength(rng, 3, 6);
    }
    // >0.45 : capitalisation (forces a shift key)
    if (difficulty > 0.45 && rng.bool(Math.min(0.35, (difficulty - 0.45) * 0.8))) {
      if (rng.bool(0.4)) out = out.toUpperCase();
      else out = out.charAt(0).toUpperCase() + out.slice(1);
    }
    // >0.60 : facility tag with digits
    if (difficulty > 0.60 && rng.bool(Math.min(0.30, (difficulty - 0.60) * 0.7))) {
      var prefixes = tagsFor(TAG_PREFIX, letters);
      if (prefixes.length) {
        out = rng.pick(prefixes) + '-' + rng.int(10, 99) + rng.pick(['', '', 'A', 'B', 'X']);
      }
    }
    // >0.80 : underscore-joined protocol strings
    if (difficulty > 0.80 && rng.bool(Math.min(0.25, (difficulty - 0.80) * 0.6))) {
      var heads = tagsFor(TAG_WORDS, letters);
      if (heads.length) out = rng.pick(heads) + '_' + rng.pick(TAG_WORDS);
    }
    return out;
  }

  var Words = {
    /* difficulty: 0 (encounter 1) .. ~1.3 (deep run). */
    make: function (rng, difficulty, letters) {
      var band = lengthBand(difficulty);
      var w = pickByLength(rng, band[0], band[1], letters);
      return applyModifiers(w, rng, difficulty, letters);
    },

    /* Boss words are the longest real words on file — a sustained, punishing
     * read. These used to be invented Greek/Latin compounds ("cryptothreshold"),
     * which looked the part but were not words, and were miserable to type from
     * sight because no spelling instinct helped. */
    makeBoss: function (rng, difficulty, letters) {
      var lo = Math.round(11 + difficulty * 2);
      var w = pickByLength(rng, lo, 16, letters);
      if (difficulty > 0.5 && rng.bool(0.35)) w = w.charAt(0).toUpperCase() + w.slice(1);
      if (difficulty > 0.9 && rng.bool(0.3)) w = w + '-' + rng.int(100, 999);
      return w;
    },

    /* One specimen's whole queue of words.
     *
     * Every word in it starts with one of `letters`, which the planner has
     * reserved for this specimen alone. That is the opposite of what this used
     * to do — it used to spread first letters out WITHIN a specimen's list,
     * which achieved nothing, because a player only ever sees one word per
     * specimen at a time. What matters is that no two specimens standing in the
     * room together offer the same initial, and since their queues advance
     * independently as they take hits, the only way to guarantee that is to
     * make the initial a property of the specimen rather than of the word.
     *
     * Duplicate words within the queue are still avoided where possible. */
    makeSet: function (rng, n, difficulty, boss, letters) {
      var out = [], seen = {};
      var attempts = 0;
      while (out.length < n && attempts < n * 30) {
        attempts++;
        var w = boss ? Words.makeBoss(rng, difficulty, letters)
                     : Words.make(rng, difficulty, letters);
        var key = w.toLowerCase();
        if (seen[key]) continue;
        seen[key] = 1;
        out.push(w);
      }
      // A thin letter set can run out of distinct words; repeating one is far
      // better than handing the specimen somebody else's initial.
      while (out.length < n) {
        out.push(boss ? Words.makeBoss(rng, difficulty, letters)
                      : Words.make(rng, difficulty, letters));
      }
      return out;
    },

    /* Letters ordered by how much of the bank starts with each. */
    letterRanking: letterRanking,

    /* Short, always-easy words — used for the downed-teammate revive prompt. */
    makeRevive: function (rng) {
      return rng.pick(['revive', 'stabilize', 'adrenaline', 'medkit', 'suture', 'restart', 'defib']);
    }
  };

  /* Every word the bank can emit, for tools/check-dictionary.js. TAG_PREFIX is
   * excluded deliberately: those are equipment label prefixes, not words. */
  Words.everyWord = function () {
    return bank().all.concat(TAG_WORDS);
  };

  CT.Words = Words;
})(window);
