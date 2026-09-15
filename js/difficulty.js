/* Cave Typer — difficulty curve and encounter planning.
 *
 * Design target: a steady 100 WPM typist should die somewhere around the
 * 15 minute mark. Everything that governs that lives in TUNING below, and
 * CT.Difficulty.simulate() replays the curve headlessly so the target can be
 * checked without playing for a quarter of an hour. */
(function (global) {
  'use strict';
  var CT = (global.CaveTyper = global.CaveTyper || {});

  var TUNING = {
    // How many words an encounter contains (solo).
    baseWords: 9,
    wordsPerEncounter: 0.62,
    maxWords: 60,

    // The typing speed the encounter is tuned against, as a quadratic in the
    // encounter index. Quadratic rather than linear so that a 40 WPM player
    // still gets a few minutes of game before the floor drops out, while a
    // 150 WPM player still eventually meets a wall.
    //   required(e) = baseWpm + wpmPerEncounter*e + wpmAccel*e^2
    // Calibration: a player dies at roughly required(e) = 1.25 * theirWPM.
    // Verified in-engine with tools/check-pacing.js AND with a scripted player
    // driving the real game (see the autoplay harness notes in README.md).
    baseWpm: 20,
    wpmPerEncounter: 1.25,
    wpmAccel: 0.0385,

    // Average characters per word at a given difficulty. Must track what
    // CT.Words actually produces — see tools/check-words.js.
    baseWordLen: 4.4,
    wordLenGrowth: 7.4,

    // Word-generation difficulty scalar (feeds CT.Words).
    difficultyDivisor: 52,
    difficultyMax: 1.4,

    // Monsters.
    minMonsters: 2,
    maxMonsters: 9,
    monstersPerEncounter: 1 / 3.4,

    // Distances, in world units, from the player station. These are close for a
    // 68-degree FOV on purpose: a 1.5-unit grunt at 35 units is a dozen pixels
    // tall and unreadable, which is exactly what the arcade rail-shooters this
    // is built after avoided by keeping everything in your face.
    spawnDistMin: 17,
    spawnDistMax: 27,
    meleeDist: 4.2,
    bossMeleeDist: 7.5,
    minSpeed: 0.55,
    maxSpeed: 5.5,

    // When each monster should reach the player, as a fraction of the
    // encounter's nominal clear time.
    // Monsters arrive in a tight window rather than a long trickle. A wide
    // window lets a player who always shoots the closest thing dodge every
    // arrival by ordering alone, which flattens the difficulty curve to
    // nothing right up until it kills them.
    arrivalFirst: 0.40,
    arrivalLast: 0.95,

    // Combat.
    playerMaxHp: 100,
    attackInterval: 1.25,
    baseDamage: 4.2,
    damagePerEncounter: 0.30,
    // A boss should be a war of attrition you can partly out-type, not a
    // seven-second execution. It hits harder than a grunt but not 2x harder,
    // and much less often.
    bossDamageMul: 1.25,
    bossAttackIntervalMul: 1.7,

    // Patch-up between chambers. Keeps chip damage from being a death sentence
    // twenty encounters later, without ever handing back a whole health bar.
    healPerEncounter: 4,
    healPerEncounterScale: 0.15,
    healAfterBoss: 30,

    // Boss cadence and shape.
    bossEvery: 10,
    bossWordShare: 0.62,
    bossTimeBonus: 1.45,
    bossAddWaves: 3,

    // Travel between stations.
    travelTime: 4.2,
    bossTravelTime: 6.5,
    // Far enough apart that the route can fit a corner between the end of one
    // chamber's sightline (spawnDistMax + margin) and arrival at the next stop.
    // Travel time is fixed, so a longer gap just means the rail moves faster.
    stationSpacing: 46,

    // Two-player scaling: a second player adds this much work.
    coopWordMul: 0.82,
    coopMonsterMul: 0.75,

    // Per-tier size multipliers. The model files build anatomically sensible
    // creatures; these make them read at gameplay distance.
    tierScale: { grunt: 1.55, mid: 1.15, boss: 1.0 },

    // Scoring.
    scorePerWord: 10,
    scorePerKill: 50,
    bossKillScore: 1200,
    accuracyBonus: 2500
  };

  function isBoss(index /* 0-based */) {
    return ((index + 1) % TUNING.bossEvery) === 0;
  }

  function requiredWpm(index) {
    return TUNING.baseWpm + TUNING.wpmPerEncounter * index + TUNING.wpmAccel * index * index;
  }

  function wordDifficulty(index) {
    return Math.min(TUNING.difficultyMax, index / TUNING.difficultyDivisor);
  }

  /* Expected characters per word at this depth, including the space/commit
   * keystroke. Nominal times are computed in characters, not words, because a
   * late-game 13-character word is nearly three "standard" words of typing. */
  function avgWordChars(index) {
    return TUNING.baseWordLen + TUNING.wordLenGrowth * wordDifficulty(index) + 1;
  }

  function healFor(index, boss) {
    return boss ? TUNING.healAfterBoss : TUNING.healPerEncounter + TUNING.healPerEncounterScale * index;
  }

  function wordCount(index, players) {
    var n = TUNING.baseWords + TUNING.wordsPerEncounter * index;
    if (isBoss(index)) n *= 1.75;
    n *= (1 + (players - 1) * TUNING.coopWordMul);
    return Math.min(TUNING.maxWords * players, Math.round(n));
  }

  function monsterCount(index, players) {
    var n = TUNING.minMonsters + Math.floor(index * TUNING.monstersPerEncounter);
    n = Math.min(TUNING.maxMonsters, n);
    n = Math.round(n * (1 + (players - 1) * TUNING.coopMonsterMul));
    return Math.max(TUNING.minMonsters, Math.min(TUNING.maxMonsters * 2, n));
  }

  /* Nominal seconds the encounter is expected to take at the target WPM.
   * WPM is by convention 5 characters per "word", so the character budget per
   * second is wpm * 5 / 60. */
  function nominalTime(index, players) {
    var chars = wordCount(index, players) * avgWordChars(index);
    var cps = (requiredWpm(index) * 5 / 60) * players;   // two players share the load
    var t = chars / cps;
    if (isBoss(index)) t *= TUNING.bossTimeBonus;
    return t;
  }

  function attackDamage(index, boss) {
    var d = TUNING.baseDamage + TUNING.damagePerEncounter * index;
    return boss ? d * TUNING.bossDamageMul : d;
  }

  /* Which monster archetypes are legal at this depth. */
  function tierMixFor(index) {
    if (index < 3) return { grunt: 1.0, mid: 0.0 };
    if (index < 8) return { grunt: 0.85, mid: 0.15 };
    if (index < 16) return { grunt: 0.6, mid: 0.4 };
    if (index < 28) return { grunt: 0.42, mid: 0.58 };
    return { grunt: 0.3, mid: 0.7 };
  }

  /* ---- encounter planning ------------------------------------------------ */

  /* Returns a fully-specified encounter. Deterministic in (runSeed, index,
   * players) so the host and the client build an identical encounter; the host
   * still transmits it verbatim, but matching generation keeps them honest. */
  function planEncounter(runSeed, index, players, registry) {
    var rng = new CT.Rng((runSeed ^ Math.imul(index + 1, 0x85ebca6b)) >>> 0);
    var boss = isBoss(index);
    var diff = wordDifficulty(index);
    var totalWords = wordCount(index, players);
    var T = nominalTime(index, players);

    var grunts = registry.byTier('grunt');
    var mids = registry.byTier('mid');
    var bosses = registry.byTier('boss');

    var monsters = [];
    var uid = 0;

    function pickType(tier) {
      var pool = tier === 'boss' ? bosses : (tier === 'mid' ? mids : grunts);
      if (!pool.length) pool = grunts.length ? grunts : registry.all();
      return rng.pick(pool);
    }

    function laneX(i, n) {
      if (n <= 1) return rng.range(-1.2, 1.2);
      var spread = Math.min(6.5, 2.2 + n * 0.68);
      var t = n === 1 ? 0.5 : i / (n - 1);
      return (t - 0.5) * 2 * spread + rng.range(-0.8, 0.8);
    }

    if (boss) {
      var bossWords = Math.round(totalWords * TUNING.bossWordShare);
      var bt = pickType('boss');
      var bossDist = TUNING.spawnDistMax + 9;
      monsters.push({
        uid: uid++,
        typeId: bt.id,
        tier: 'boss',
        boss: true,
        x: rng.range(-1.5, 1.5),
        startDist: bossDist,
        spawnDelay: 0.9,
        // Bosses close slowly and then stay at range, chewing on the player.
        speed: CT.clamp((bossDist - TUNING.bossMeleeDist) / (T * 0.9), 0.35, 2.2),
        meleeDist: TUNING.bossMeleeDist,
        words: CT.Words.makeSet(rng, bossWords, diff, true),
        damage: attackDamage(index, true),
        attackInterval: TUNING.attackInterval * TUNING.bossAttackIntervalMul,
        scale: TUNING.tierScale.boss
      });

      // Adds trickle in over the fight in waves.
      var addWords = totalWords - bossWords;
      var addCount = Math.max(3, Math.round(monsterCount(index, players) * 0.9));
      var perAdd = Math.max(1, Math.round(addWords / addCount));
      var mix = tierMixFor(index);
      for (var a = 0; a < addCount; a++) {
        var wave = Math.floor(a / Math.max(1, Math.ceil(addCount / TUNING.bossAddWaves)));
        var at = pickType(rng.next() < mix.mid ? 'mid' : 'grunt');
        var dist = rng.range(TUNING.spawnDistMin, TUNING.spawnDistMax);
        var delay = 2.5 + wave * (T / (TUNING.bossAddWaves + 0.5)) + rng.range(0, 1.4);
        var arrive = Math.max(4, T * 0.45);
        monsters.push({
          uid: uid++,
          typeId: at.id,
          tier: at.tier,
          boss: false,
          x: laneX(a, addCount),
          startDist: dist,
          spawnDelay: delay,
          speed: CT.clamp((dist - TUNING.meleeDist) / arrive, TUNING.minSpeed, TUNING.maxSpeed),
          meleeDist: TUNING.meleeDist,
          words: CT.Words.makeSet(rng, perAdd, diff, false),
          damage: attackDamage(index, false),
          attackInterval: TUNING.attackInterval,
          scale: TUNING.tierScale[at.tier] * rng.range(0.92, 1.08)
        });
      }
    } else {
      var n = monsterCount(index, players);
      var mix2 = tierMixFor(index);
      // Distribute words with a bit of variance, then fix up the total.
      var weights = [], sum = 0;
      for (var i = 0; i < n; i++) { var w = rng.range(0.75, 1.3); weights.push(w); sum += w; }
      var assigned = [], acc = 0;
      for (var i2 = 0; i2 < n; i2++) {
        var wc = Math.max(1, Math.round(totalWords * weights[i2] / sum));
        assigned.push(wc); acc += wc;
      }
      // nudge to match the target exactly
      var d2 = totalWords - acc;
      var gi = 0;
      while (d2 !== 0 && gi < 500) {
        var k = gi % n;
        if (d2 > 0) { assigned[k]++; d2--; }
        else if (assigned[k] > 1) { assigned[k]--; d2++; }
        gi++;
      }

      var order = [];
      for (var i3 = 0; i3 < n; i3++) order.push(i3);
      rng.shuffle(order);

      for (var i4 = 0; i4 < n; i4++) {
        var slot = order[i4];
        var tier = rng.next() < mix2.mid ? 'mid' : 'grunt';
        // A monster carrying lots of words should be a beefier silhouette.
        if (assigned[i4] >= 5 && mids.length && rng.bool(0.6)) tier = 'mid';
        var type = pickType(tier);
        var dist4 = rng.range(TUNING.spawnDistMin, TUNING.spawnDistMax);
        var frac = n === 1 ? 0.8 : i4 / (n - 1);
        var arriveAt = T * CT.lerp(TUNING.arrivalFirst, TUNING.arrivalLast, frac);
        var delay4 = rng.range(0, Math.min(2.2, T * 0.18));
        monsters.push({
          uid: uid++,
          typeId: type.id,
          tier: type.tier,
          boss: false,
          x: laneX(slot, n),
          startDist: dist4,
          spawnDelay: delay4,
          speed: CT.clamp((dist4 - TUNING.meleeDist) / Math.max(2.5, arriveAt - delay4),
                          TUNING.minSpeed, TUNING.maxSpeed),
          meleeDist: TUNING.meleeDist,
          words: CT.Words.makeSet(rng, assigned[i4], diff, false),
          damage: attackDamage(index, false),
          attackInterval: TUNING.attackInterval,
          scale: TUNING.tierScale[type.tier] * rng.range(0.9, 1.12)
        });
      }
    }

    return {
      index: index,
      seed: (runSeed ^ Math.imul(index + 1, 0x85ebca6b)) >>> 0,
      boss: boss,
      players: players,
      difficulty: diff,
      requiredWpm: requiredWpm(index),
      totalWords: totalWords,
      nominalTime: T,
      travelTime: boss ? TUNING.bossTravelTime : TUNING.travelTime,
      monsters: monsters
    };
  }

  /* ---- headless pacing check --------------------------------------------
   * Plays a run at a fixed WPM with perfect accuracy and reports how far the
   * player gets and how long it took. Used by tools/check-pacing.js.
   *
   * The damage model mirrors what actually happens in game: monster i reaches
   * melee at arrival_i and attacks every attackInterval until it is killed, and
   * the player kills monsters roughly in arrival order. */
  function simulate(wpm, players, opts) {
    opts = opts || {};
    var hp = TUNING.playerMaxHp * (opts.hpMul || 1);
    var t = 0;
    var index = 0;
    var charsPerSec = (wpm / 60) * 5 * players;
    var log = [];

    while (index < 500 && hp > 0) {
      var words = wordCount(index, players);
      var boss = isBoss(index);
      var typingTime = (words * avgWordChars(index)) / charsPerSec;
      var T = nominalTime(index, players);
      var n = boss ? Math.max(4, Math.round(monsterCount(index, players) * 0.9) + 1)
                   : monsterCount(index, players);

      var dmg = 0;
      for (var i = 0; i < n; i++) {
        var frac = n === 1 ? 0.8 : i / (n - 1);
        var arrival = T * (TUNING.arrivalFirst + (TUNING.arrivalLast - TUNING.arrivalFirst) * frac);
        // Boss is present the whole fight and arrives on its own schedule.
        var isTheBoss = boss && i === 0;
        if (isTheBoss) arrival = T * 0.85;
        // Killed once the player has chewed through its share of the words.
        var killed = typingTime * ((i + 1) / n);
        if (isTheBoss) killed = typingTime;  // boss dies last
        var exposed = Math.max(0, killed - arrival);
        var per = attackDamage(index, isTheBoss);
        var interval = isTheBoss ? TUNING.attackInterval * TUNING.bossAttackIntervalMul : TUNING.attackInterval;
        dmg += (exposed / interval) * per;
      }
      // Two players split the incoming attention.
      dmg /= players;

      hp -= dmg;
      if (hp > 0) hp = Math.min(TUNING.playerMaxHp, hp + healFor(index, boss));

      t += typingTime + (boss ? TUNING.bossTravelTime : TUNING.travelTime);
      log.push({
        index: index, words: words, monsters: n,
        nominal: +T.toFixed(1), typing: +typingTime.toFixed(1),
        dmg: +dmg.toFixed(1), hp: +hp.toFixed(1), t: +t.toFixed(1), boss: boss,
        reqWpm: +requiredWpm(index).toFixed(0)
      });
      if (hp <= 0) break;
      index++;
    }

    return { encounters: index, seconds: t, minutes: t / 60, log: log };
  }

  CT.Difficulty = {
    TUNING: TUNING,
    isBoss: isBoss,
    avgWordChars: avgWordChars,
    healFor: healFor,
    requiredWpm: requiredWpm,
    wordDifficulty: wordDifficulty,
    wordCount: wordCount,
    monsterCount: monsterCount,
    nominalTime: nominalTime,
    attackDamage: attackDamage,
    planEncounter: planEncounter,
    simulate: simulate
  };
})(typeof window !== 'undefined' ? window : globalThis);
