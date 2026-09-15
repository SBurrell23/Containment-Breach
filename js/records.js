/* Containment Breach — persistent records: the specimen codex and the run archive.
 *
 * Two stores, both in localStorage, both defensive about it being unavailable
 * (private windows, file:// on some browsers) — every read falls back to empty
 * and every write is allowed to fail silently. Nothing here is load-bearing for
 * actually playing.
 *
 * The codex accrues *during* a run, so an abandoned descent still contributes
 * discoveries. The archive only takes completed runs, because "how far did that
 * one get" is meaningless for a run you walked away from. */
(function (global) {
  'use strict';
  var CT = (global.ContainmentBreach = global.ContainmentBreach || {});

  /* These keys keep the game's old name on purpose. They are where a player's
   * compendium and run archive live, and renaming the game is not a reason to
   * throw those away - a new prefix would read as an empty profile to everyone
   * who has played before. */
  var CODEX_KEY = 'cavetyper.codex.v1';
  var RUNS_KEY = 'cavetyper.runs.v1';
  var LEGACY_BEST_KEY = 'cavetyper.best.v1';
  var MAX_RUNS = 60;

  function read(key, fallback) {
    try {
      var raw = global.localStorage.getItem(key);
      if (!raw) return fallback;
      var v = JSON.parse(raw);
      return v === null || v === undefined ? fallback : v;
    } catch (e) { return fallback; }
  }

  function write(key, value) {
    try { global.localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { return false; }
  }

  var codexCache = null;
  var runsCache = null;

  function codex() {
    if (!codexCache) codexCache = read(CODEX_KEY, {});
    return codexCache;
  }

  function runs() {
    if (!runsCache) {
      var r = read(RUNS_KEY, []);
      runsCache = Object.prototype.toString.call(r) === '[object Array]' ? r : [];
    }
    return runsCache;
  }

  var Records = {
    /* ---- specimen codex -------------------------------------------------- */

    /* Called the moment a specimen actually materialises in the chamber. */
    noteSeen: function (id, depth) {
      if (!id) return;
      var c = codex();
      var e = c[id];
      if (!e) {
        e = c[id] = { seen: 0, killed: 0, first: Date.now(), deepest: 0 };
      }
      e.seen++;
      if (depth > (e.deepest || 0)) e.deepest = depth;
      Records._dirty = true;
    },

    /* Only the local player's own kills — this is your record, not the team's. */
    noteKill: function (id, depth) {
      if (!id) return;
      var c = codex();
      var e = c[id];
      if (!e) e = c[id] = { seen: 1, killed: 0, first: Date.now(), deepest: 0 };
      e.killed++;
      if (depth > (e.deepest || 0)) e.deepest = depth;
      Records._dirty = true;
    },

    /* Writes are batched: noteSeen/noteKill fire mid-combat and a JSON
     * serialise per kill would be a stutter you can feel. */
    flush: function () {
      if (!Records._dirty) return;
      Records._dirty = false;
      write(CODEX_KEY, codex());
    },

    codexEntry: function (id) { return codex()[id] || null; },
    codexAll: function () { return codex(); },

    /* How much of the archive has been met, for the title screen. */
    codexProgress: function () {
      var all = CT.MonsterRegistry ? CT.MonsterRegistry.all() : [];
      var total = 0, found = 0;
      var c = codex();
      for (var i = 0; i < all.length; i++) {
        if (all[i].fallback) continue;
        total++;
        if (c[all[i].id]) found++;
      }
      return { found: found, total: total };
    },

    /* ---- run archive ----------------------------------------------------- */

    addRun: function (summary) {
      if (!summary) return null;
      var entry = {
        t: Date.now(),
        coop: !!summary.coop,
        depth: summary.deepest || summary.depth || 0,
        score: Math.round(summary.score || 0),
        wpm: Math.round(summary.wpm || 0),
        acc: Math.round((summary.accuracy || 0) * 100),
        words: summary.words || 0,
        kills: summary.kills || 0,
        streak: summary.streak || 0,
        bosses: summary.bosses || 0,
        secs: Math.round((summary.minutes || 0) * 60),
        reason: summary.reason || ''
      };
      var list = runs();
      list.unshift(entry);
      if (list.length > MAX_RUNS) list.length = MAX_RUNS;
      write(RUNS_KEY, list);
      Records.flush();
      return entry;
    },

    runs: function () { return runs().slice(); },

    /* Everything the archive screen puts across the top. */
    allTime: function () {
      var list = runs();
      var t = {
        runs: list.length, coopRuns: 0,
        bestDepth: 0, bestScore: 0, bestWpm: 0, bestStreak: 0,
        totalKills: 0, totalWords: 0, totalSecs: 0, totalBosses: 0,
        avgWpm: 0, avgAcc: 0, avgDepth: 0
      };
      if (!list.length) return t;
      var wpmSum = 0, accSum = 0, depthSum = 0;
      for (var i = 0; i < list.length; i++) {
        var r = list[i];
        if (r.coop) t.coopRuns++;
        if (r.depth > t.bestDepth) t.bestDepth = r.depth;
        if (r.score > t.bestScore) t.bestScore = r.score;
        if (r.wpm > t.bestWpm) t.bestWpm = r.wpm;
        if (r.streak > t.bestStreak) t.bestStreak = r.streak;
        t.totalKills += r.kills;
        t.totalWords += r.words;
        t.totalSecs += r.secs;
        t.totalBosses += r.bosses;
        wpmSum += r.wpm; accSum += r.acc; depthSum += r.depth;
      }
      t.avgWpm = Math.round(wpmSum / list.length);
      t.avgAcc = Math.round(accSum / list.length);
      t.avgDepth = Math.round(depthSum / list.length * 10) / 10;
      return t;
    },

    /* The title screen's one-line best. Derived from the archive, falling back
     * to the standalone key written by builds that predate it. */
    best: function () {
      var t = Records.allTime();
      if (t.runs) return { depth: t.bestDepth, score: t.bestScore, wpm: t.bestWpm };
      var legacy = read(LEGACY_BEST_KEY, null);
      return legacy && legacy.depth ? legacy : null;
    },

    /* Is this run a personal best on either axis worth shouting about? */
    isBest: function (summary) {
      var b = Records.best();
      if (!b) return true;
      var depth = summary.deepest || summary.depth || 0;
      return depth > b.depth || Math.round(summary.score || 0) > b.score;
    },

    clearRuns: function () { runsCache = []; write(RUNS_KEY, []); },
    clearCodex: function () { codexCache = {}; write(CODEX_KEY, {}); },

    /* ---- formatting shared by both screens ------------------------------- */

    fmtDuration: function (secs) {
      secs = Math.max(0, Math.round(secs));
      var h = Math.floor(secs / 3600);
      var m = Math.floor((secs % 3600) / 60);
      var s = secs % 60;
      if (h) return h + 'h ' + m + 'm';
      return m + ':' + String(s).padStart(2, '0');
    },

    fmtDate: function (ts) {
      var d = new Date(ts);
      var now = new Date();
      var sameDay = d.toDateString() === now.toDateString();
      var hh = String(d.getHours()).padStart(2, '0');
      var mm = String(d.getMinutes()).padStart(2, '0');
      if (sameDay) return 'today ' + hh + ':' + mm;
      var yesterday = new Date(now.getTime() - 86400000);
      if (d.toDateString() === yesterday.toDateString()) return 'yesterday ' + hh + ':' + mm;
      var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return months[d.getMonth()] + ' ' + d.getDate() + ' ' + hh + ':' + mm;
    }
  };

  Records._dirty = false;
  CT.Records = Records;
})(window);
