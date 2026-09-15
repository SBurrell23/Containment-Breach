/* Containment Breach — the typing engine.
 *
 * One completed word is one gunshot. Targeting is implicit: the first character
 * you type picks the monster, and you stay locked onto it until the word is
 * finished, you backspace out of it, or it dies. */
(function (global) {
  'use strict';
  var CT = (global.ContainmentBreach = global.ContainmentBreach || {});
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
    this.targetWordIndex = -1;
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
      this.target.clearClaim(this.slot);
      if (this.hooks.onRelease) this.hooks.onRelease(this.target);
    }
    this.target = null;
    this.typed = '';
    this.error = false;
    this.targetWordIndex = -1;
  };

  /* Called by the game every frame.
   *
   * As well as dropping a dead target, this is where a word being finished out
   * from under you is caught. In co-op both players can be typing the same
   * specimen's word; when one of them lands it the specimen advances to its
   * next word, and the other player's half-typed prefix now belongs to a word
   * that no longer exists. Leaving it in place is what produced the bug where
   * the fresh word appeared with letters already highlighted — and worse, the
   * player's next keystroke was matched against the wrong position.
   *
   * Detecting it here rather than at each shot site means it holds for every
   * path that can move a word index: a local shot, a remote shot relayed by the
   * host, and the host's absolute reconciliation. */
  Typing.prototype.validate = function () {
    var t = this.target;
    if (!t) return;

    if (!t.alive || t.removed || !t.active) {
      t.clearClaim(this.slot);
      this.target = null;
      this.typed = '';
      this.error = false;
      this.targetWordIndex = -1;
      return;
    }

    if (t.wordIndex !== this.targetWordIndex) {
      // Somebody else finished this word. Start the new one clean — each player
      // has to type a word in its entirety, so no credit carries over.
      this.targetWordIndex = t.wordIndex;
      if (this.typed.length) {
        this.typed = '';
        this.error = false;
        t.setClaim(this.slot, '');
        if (this.hooks.onWordTaken) this.hooks.onWordTaken(t);
      }
    }
  };

  /* Pick the best monster whose current word starts with `ch`.
   *
   * The deciding factor is how close the candidate is to the crosshair, not how
   * close it is to the player. Words are only ever committed to one at a time,
   * so between words the player is free to swing to anything — and when two
   * specimens both offer a word starting with the letter just pressed, the one
   * already near where they are looking is the one they meant. That is what
   * makes firing back and forth between two specimens feel like aiming rather
   * than like a lottery.
   *
   * A teammate's in-progress word is avoided unless nothing else matches. */
  Typing.prototype._acquire = function (ch, monsters, slot) {
    var best = null, bestScore = Infinity;
    for (var i = 0; i < monsters.length; i++) {
      var m = monsters[i];
      if (!m.alive || !m.active || m.removed) continue;
      if (m.spawnT < 0.35) continue;                      // still emerging
      var w = m.currentWord();
      if (!w) continue;
      if (w.charAt(0).toLowerCase() !== ch.toLowerCase()) continue;
      // A soft preference, not a lock: if this is the only specimen offering
      // that letter the player still gets it, and both may shoot it at once.
      var claimedPenalty = m.claimedByOther(slot) ? 1000 : 0;
      var aim = m.aimDist === undefined ? 9 : m.aimDist;
      // Distance is a whisper of a tiebreak between two equally-aimed-at
      // specimens, so the closer threat wins that coin flip.
      var score = claimedPenalty + aim + m.dist * 0.004;
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
      this.targetWordIndex = m.wordIndex;
      m.setClaim(slot, ch);
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
      this.target.setClaim(slot, this.typed);
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

      // Always let go. A finished word is a fired round, not a commitment to
      // keep emptying the magazine into the same specimen — the next keystroke
      // re-targets from scratch, so the player can alternate between two
      // specimens word by word. Only an *unfinished* word holds you.
      m.clearClaim(this.slot);
      this.target = null;
      this.targetWordIndex = -1;
      if (this.hooks.onRelease) this.hooks.onRelease(m);
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
      this.target.setClaim(this.slot, this.typed);
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
