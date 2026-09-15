/* Cave Typer — difficulty-scaled word selection.
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
  var CT = (global.CaveTyper = global.CaveTyper || {});

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

  /* One word whose length falls in [lo, hi]. The band widens rather than
   * failing: the bank tops out at 16 characters, so a late-game band asking for
   * 13-18 simply gets the longest words on file. */
  function pickByLength(rng, lo, hi) {
    var B = bank();
    var pool = [];
    for (var L = lo; L <= hi; L++) {
      if (B.byLength[L]) pool = pool.concat(B.byLength[L]);
    }
    for (var widen = 1; !pool.length && widen < 14; widen++) {
      var a = lo - widen, b = hi + widen;
      if (B.byLength[a]) pool = pool.concat(B.byLength[a]);
      if (B.byLength[b]) pool = pool.concat(B.byLength[b]);
    }
    if (!pool.length) pool = B.all;
    return rng.pick(pool);
  }

  /* Modifiers, unlocked progressively. Each returns a transformed word. */
  function applyModifiers(word, rng, difficulty) {
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
      out = rng.pick(TAG_PREFIX) + '-' + rng.int(10, 99) + rng.pick(['', '', 'A', 'B', 'X']);
    }
    // >0.80 : underscore-joined protocol strings
    if (difficulty > 0.80 && rng.bool(Math.min(0.25, (difficulty - 0.80) * 0.6))) {
      out = rng.pick(TAG_WORDS) + '_' + rng.pick(TAG_WORDS);
    }
    return out;
  }

  var Words = {
    /* difficulty: 0 (encounter 1) .. ~1.3 (deep run). */
    make: function (rng, difficulty) {
      var band = lengthBand(difficulty);
      var w = pickByLength(rng, band[0], band[1]);
      return applyModifiers(w, rng, difficulty);
    },

    /* Boss words are the longest real words on file — a sustained, punishing
     * read. These used to be invented Greek/Latin compounds ("cryptothreshold"),
     * which looked the part but were not words, and were miserable to type from
     * sight because no spelling instinct helped. */
    makeBoss: function (rng, difficulty) {
      var lo = Math.round(11 + difficulty * 2);
      var w = pickByLength(rng, lo, 16);
      if (difficulty > 0.5 && rng.bool(0.35)) w = w.charAt(0).toUpperCase() + w.slice(1);
      if (difficulty > 0.9 && rng.bool(0.3)) w = w + '-' + rng.int(100, 999);
      return w;
    },

    /* A list of `n` distinct-ish words. Avoids two words in the same encounter
     * starting with the same letter where it can, so auto-targeting is decisive. */
    makeSet: function (rng, n, difficulty, boss) {
      var out = [], seen = {}, firstLetters = {};
      var attempts = 0;
      while (out.length < n && attempts < n * 30) {
        attempts++;
        var w = boss ? Words.makeBoss(rng, difficulty) : Words.make(rng, difficulty);
        var key = w.toLowerCase();
        if (seen[key]) continue;
        var fl = key.charAt(0);
        // soft constraint: allow a repeat first letter only once we have tried a bit
        if (firstLetters[fl] && attempts < n * 12) continue;
        seen[key] = 1; firstLetters[fl] = (firstLetters[fl] || 0) + 1;
        out.push(w);
      }
      while (out.length < n) out.push(boss ? Words.makeBoss(rng, difficulty) : Words.make(rng, difficulty));
      return out;
    },

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
