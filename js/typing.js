/* Cave Typer — the typing engine.
 *
 * One completed word is one gunshot. Targeting is implicit: the first character
 * you type picks the monster, and you stay locked onto it until the word is
 * finished, you backspace out of it, or it dies. */
(function (global) {
  'use strict';
  var CT = (global.CaveTyper = global.CaveTyper || {});
  var S = function () { return CT.Settings; };

  function Typing(hooks) {
    this.hooks = hooks || {};
    this.target = null;       // Monster being typed at
    this.typed = '';          // characters matched so far
    this.error = false;       // strict mode: waiting for a backspace
    this.reset();
  }

  Typing.prototype.reset = function () {
    this.target = null;
    this.typed = '';
    this.error = false;
    // Seeded so release() can clear a claim even if it runs before any keypress.
    this.slot = 0;
    this.stats = {
      keystrokes: 0,
      correct: 0,
      errors: 0,
      words: 0,
      chars: 0,        // characters in completed words
      combatMs: 0,     // time spent in encounters, for WPM
      bestStreak: 0,
      streak: 0
    };
  };

  Typing.prototype.wpm = function () {
    var mins = this.stats.combatMs / 60000;
    if (mins < 0.02) return 0;
    return (this.stats.chars / 5) / mins;
  };

  Typing.prototype.accuracy = function () {
    if (!this.stats.keystrokes) return 1;
    return this.stats.correct / this.stats.keystrokes;
  };

  Typing.prototype.addCombatTime = function (ms) { this.stats.combatMs += ms; };

  /* Drop the lock (monster died, encounter ended, player pressed Escape). */
  Typing.prototype.release = function () {
    if (this.target) {
      if (this.target.claimedBy === this.slot) this.target.claimedBy = -1;
      if (this.hooks.onRelease) this.hooks.onRelease(this.target);
    }
    this.target = null;
    this.typed = '';
    this.error = false;
  };

  /* Called by the game when the current target is no longer valid. */
  Typing.prototype.validate = function () {
    if (this.target && (!this.target.alive || this.target.removed || !this.target.active)) {
      this.target = null;
      this.typed = '';
      this.error = false;
    }
  };

  /* Pick the best monster whose current word starts with `ch`.
   * Preference: unclaimed over claimed, then whatever is closest to the player
   * (the most urgent threat), then whatever has the shortest word left. */
  Typing.prototype._acquire = function (ch, monsters, slot) {
    var best = null, bestScore = Infinity;
    for (var i = 0; i < monsters.length; i++) {
      var m = monsters[i];
      if (!m.alive || !m.active || m.removed) continue;
      if (m.spawnT < 0.35) continue;                      // still emerging
      var w = m.currentWord();
      if (!w) continue;
      if (w.charAt(0).toLowerCase() !== ch.toLowerCase()) continue;
      // Respect a teammate's lock unless nothing else is available.
      var claimedPenalty = (m.claimedBy >= 0 && m.claimedBy !== slot) ? 1000 : 0;
      var score = claimedPenalty + m.dist + w.length * 0.15;
      if (score < bestScore) { bestScore = score; best = m; }
    }
    return best;
  };

  /* Feed one printable character. Returns one of:
   *   'miss'     nothing matched that key
   *   'acquire'  locked a new target and consumed the key
   *   'hit'      matched the next character
   *   'word'     completed the word (a shot was fired)
   *   'bad'      wrong key against the current target
   *   'locked'   strict mode, waiting for backspace
   */
  Typing.prototype.key = function (ch, monsters, slot) {
    this.slot = slot;
    this.stats.keystrokes++;

    if (this.error) {
      this.stats.errors++;
      this.stats.streak = 0;
      if (this.hooks.onBadKey) this.hooks.onBadKey();
      return 'locked';
    }

    if (!this.target) {
      var m = this._acquire(ch, monsters, slot);
      if (!m) {
        this.stats.errors++;
        this.stats.streak = 0;
        if (this.hooks.onMiss) this.hooks.onMiss(ch);
        return 'miss';
      }
      this.target = m;
      m.claimedBy = slot;
      this.typed = ch;
      this.stats.correct++;
      this.stats.streak++;
      if (this.hooks.onAcquire) this.hooks.onAcquire(m);
      if (this.hooks.onGoodKey) this.hooks.onGoodKey();
      return this._maybeComplete();
    }

    var word = this.target.currentWord();
    if (!word) { this.release(); return 'miss'; }

    var expected = word.charAt(this.typed.length);
    if (ch === expected) {
      this.typed += ch;
      this.stats.correct++;
      this.stats.streak++;
      if (this.stats.streak > this.stats.bestStreak) this.stats.bestStreak = this.stats.streak;
      if (this.hooks.onGoodKey) this.hooks.onGoodKey();
      return this._maybeComplete();
    }

    // Wrong key.
    this.stats.errors++;
    this.stats.streak = 0;
    if (S().get('strictBackspace')) this.error = true;
    if (this.hooks.onBadKey) this.hooks.onBadKey();
    return S().get('strictBackspace') ? 'locked' : 'bad';
  };

  Typing.prototype._maybeComplete = function () {
    var word = this.target.currentWord();
    if (this.typed.length >= word.length) {
      this.stats.words++;
      this.stats.chars += word.length + 1;   // + the implied commit keystroke
      if (this.stats.streak > this.stats.bestStreak) this.stats.bestStreak = this.stats.streak;
      var m = this.target;
      this.typed = '';
      if (this.hooks.onWord) this.hooks.onWord(m, word);
      // The game decides whether the monster survived; re-validate either way.
      if (!m.alive || m.removed) {
        if (m.claimedBy === this.slot) m.claimedBy = -1;
        this.target = null;
      }
      return 'word';
    }
    return 'hit';
  };

  Typing.prototype.backspace = function () {
    if (this.error) { this.error = false; return 'unlocked'; }
    if (!this.target) return 'none';
    if (this.typed.length > 0) {
      this.typed = this.typed.slice(0, -1);
      if (this.typed.length === 0) { this.release(); return 'released'; }
      return 'back';
    }
    this.release();
    return 'released';
  };

  /* Progress against the current word, for the HUD. */
  Typing.prototype.progress = function () {
    if (!this.target) return null;
    var w = this.target.currentWord();
    if (!w) return null;
    return { word: w, typed: this.typed, error: this.error };
  };

  /* A character is "typeable" if it is something we want to consume. */
  Typing.isTypeable = function (ch) {
    return ch && ch.length === 1 && ch >= ' ' && ch <= '~';
  };

  CT.Typing = Typing;
})(window);
