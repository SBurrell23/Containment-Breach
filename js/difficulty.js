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
    baseWordLen: 4.3,
    wordLenGrowth: 7.8,

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
    // Low enough that a slow, long-reach specimen can actually crawl. The
    // floor exists to stop a creature appearing frozen, not to schedule it.
    minSpeed: 0.28,
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

  /* ---- specimen traits ---------------------------------------------------
   *
   * Every specimen used to behave identically: same walk, same share of the
   * chamber's words, same bite. These multipliers give each model its own
   * reason to be feared. A spider graft is on you in seconds and folds to two
   * words; a security husk takes forever to arrive and then will not die.
   *
   * The table is budget-neutral by construction. `words` only changes how a
   * chamber's fixed word budget is *divided*, never how large it is, so a room
   * full of fragile spiders is a room of many cheap targets rather than a free
   * one - and a splitter's offspring are paid for out of the parent's share.
   * tools/check-encounters.js plans real chambers and replays their damage, so
   * the effect on the curve is measured rather than assumed.
   *
   *   speed     walking speed; arrival time scales inversely with it
   *   words     share of the chamber's word budget
   *   damage    damage per bite
   *   interval  seconds between bites
   *   reach     melee stand-off - a long reach lashes from well out of the pack
   *   scale     model size
   *   split     on death, this many smaller copies claw their way out
   */
  var TRAITS = {
    // Grunts.
    spider_graft:  { speed: 1.95, words: 0.50, damage: 0.80, scale: 0.90 },
    lab_rat:       { speed: 1.60, words: 0.62, damage: 0.85, scale: 0.94 },
    roach_host:    { speed: 1.15, words: 0.85 },
    failed_clone:  { speed: 0.92, words: 1.15, damage: 1.10 },
    goo_crawler:   { speed: 0.55, words: 1.00, damage: 1.05,
                     split: { count: 2, words: 0.42, speed: 1.45, damage: 0.70, scale: 0.62 } },

    // Mids.
    security_husk: { speed: 0.62, words: 1.55, damage: 1.35, interval: 1.30, scale: 1.05 },
    tendril_stalk: { speed: 0.48, words: 1.20, interval: 1.15, reach: 2.60 },
    vat_grown:     { speed: 0.85, words: 1.25, damage: 1.15 },
    chimera_pack:  { speed: 1.55, words: 0.80, damage: 0.80, interval: 0.70 },
    swarm_mother:  { speed: 0.80, words: 1.15,
                     split: { count: 3, typeId: 'roach_host', tier: 'grunt',
                              words: 0.26, speed: 1.55, damage: 0.65, scale: 0.58 } }
  };

  var NO_TRAITS = { speed: 1, words: 1, damage: 1, interval: 1, reach: 1, scale: 1, split: null };

  function traitsFor(typeId) {
    var t = TRAITS[typeId];
    if (!t) return NO_TRAITS;
    var out = {};
    for (var k in NO_TRAITS) out[k] = t[k] === undefined ? NO_TRAITS[k] : t[k];
    return out;
  }

  /* How much typing a specimen is worth once its offspring are counted. The
   * chamber's budget is divided by this, so a splitter cannot smuggle extra
   * work past the pacing curve. */
  function costFactor(tr) {
    return tr.split ? 1 + tr.split.count * tr.split.words : 1;
  }

  /* Short tags for the compendium, so a player who has met a thing once can
   * look up why it killed them. */
  function traitTags(typeId) {
    var t = TRAITS[typeId];
    if (!t) return [];
    var out = [];
    if (t.speed >= 1.4) out.push('fast');
    else if (t.speed <= 0.7) out.push('slow');
    if (t.words <= 0.7) out.push('fragile');
    else if (t.words >= 1.3) out.push('durable');
    if (t.damage >= 1.3) out.push('brutal');
    if (t.interval <= 0.8) out.push('frenzied');
    if (t.reach >= 2) out.push('long reach');
    if (t.split) out.push('splits on death');
    return out;
  }

  /* ---- chamber themes ----------------------------------------------------
   *
   * About a third of chambers commit to one kind of specimen, which turns the
   * room into a single problem - a wall of fast fragile things, or two heavies
   * and nothing else - instead of the same balanced assortment every time. The
   * rest stay a random draw, so a theme still reads as an event.
   *
   * `count` rescales the monster count: a swarm wants more bodies for the same
   * words, a heavy chamber wants fewer and bigger.
   */
  var THEMES = [
    { id: 'vermin',   name: 'VERMIN SWARM',     minIndex: 1,  count: 1.40, types: ['lab_rat', 'roach_host'] },
    { id: 'arachnid', name: 'ARACHNID CLUSTER', minIndex: 2,  count: 1.35, types: ['spider_graft'] },
    { id: 'culture',  name: 'CULTURE SPILL',    minIndex: 4,  count: 0.80, types: ['goo_crawler'] },
    { id: 'pack',     name: 'PACK BEHAVIOUR',   minIndex: 9,  count: 1.10, types: ['chimera_pack', 'failed_clone'] },
    { id: 'heavy',    name: 'HEAVY SPECIMENS',  minIndex: 13, count: 0.55, types: ['security_husk', 'vat_grown'] },
    { id: 'growth',   name: 'UNCHECKED GROWTH', minIndex: 17, count: 0.75, types: ['swarm_mother', 'tendril_stalk'] }
  ];

  var THEME_CHANCE = 0.35;

  /* A theme is only offered if the models it names actually registered, so a
   * dropped model file costs variety and nothing else. */
  function pickTheme(rng, index, registry) {
    if (isBoss(index) || index < 1) return null;
    if (!rng.bool(THEME_CHANCE)) return null;
    var open = [];
    for (var i = 0; i < THEMES.length; i++) {
      var th = THEMES[i];
      if (index < th.minIndex) continue;
      var have = [];
      for (var j = 0; j < th.types.length; j++) {
        if (registry.get(th.types[j])) have.push(th.types[j]);
      }
      if (have.length) open.push({ id: th.id, name: th.name, count: th.count, types: have });
    }
    return open.length ? rng.pick(open) : null;
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
    var theme = null;
    var plannedWords = 0;

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

    /* Set so that the average arrival time across the chamber is the one the
     * pacing curve asked for, whatever mix of speeds is in the room. Without
     * it, a chamber of nothing but spider grafts arrives twice as early as
     * planned and deals roughly twice the damage — the theme would not be
     * changing the room's character, it would be secretly changing its
     * difficulty. Speed traits still do their job: they are relative to the
     * other things in the room, which is the comparison a player actually
     * makes. */
    var speedNorm = 1;

    /* Turn a chosen type and a word count into a spec, applying its traits.
     * `arrive` is when the thing is wanted at the player, before its own speed
     * trait pulls that earlier or pushes it later. */
    function makeSpec(type, words, opts) {
      var tr = traitsFor(type.id);
      var melee = (opts.boss ? TUNING.bossMeleeDist : TUNING.meleeDist) * tr.reach;
      var dist = opts.dist;
      // Clamped once, after the traits, not before and after. Clamping the
      // scheduled speed first put a floor under it that a slow trait could not
      // get below, so a long-reach specimen — which has much less ground to
      // cover before it can start swinging — arrived well ahead of schedule
      // despite being the slowest thing in the room.
      var base = (dist - melee) / Math.max(2.5, opts.arrive);
      return {
        uid: uid++,
        typeId: type.id,
        tier: type.tier,
        boss: !!opts.boss,
        gen: 0,
        x: opts.x,
        startDist: dist,
        spawnDelay: opts.delay,
        speed: CT.clamp(base * tr.speed * (opts.boss ? 1 : speedNorm),
                        TUNING.minSpeed, TUNING.maxSpeed),   // the only clamp
        meleeDist: melee,
        words: CT.Words.makeSet(rng, words, diff, !!opts.boss),
        damage: attackDamage(index, !!opts.boss) * tr.damage,
        attackInterval: TUNING.attackInterval * tr.interval *
                        (opts.boss ? TUNING.bossAttackIntervalMul : 1),
        scale: (opts.scale === undefined ? TUNING.tierScale[type.tier] : opts.scale) * tr.scale,
        split: tr.split
      };
    }

    /* Arrival time runs as 1/speed, so it is the mean of the reciprocals that
     * has to come out at 1, not the mean of the speeds. */
    function normaliseSpeed(types) {
      var acc = 0;
      for (var i = 0; i < types.length; i++) acc += 1 / traitsFor(types[i].id).speed;
      speedNorm = types.length ? acc / types.length : 1;
    }

    /* Split `budget` words across `types`, weighting by each type's word trait
     * and by a little noise, and charging splitters for their offspring. */
    function shareWords(types, budget) {
      var n = types.length;
      var weights = [], sum = 0, i;
      for (i = 0; i < n; i++) {
        var w = rng.range(0.8, 1.25) * traitsFor(types[i].id).words;
        weights.push(w); sum += w;
      }
      var assigned = [], actual = 0;
      for (i = 0; i < n; i++) {
        var cf = costFactor(traitsFor(types[i].id));
        var got = Math.max(1, Math.round((budget * weights[i] / sum) / cf));
        assigned.push(got);
        actual += got * cf;
      }
      // Walk the list until the true cost lands on the budget. A splitter moves
      // the total by more than one per word, so this cannot just count words.
      for (var guard = 0; Math.abs(actual - budget) >= 1 && guard < 600; guard++) {
        var k = guard % n;
        var cfk = costFactor(traitsFor(types[k].id));
        if (actual < budget) { assigned[k]++; actual += cfk; }
        else if (assigned[k] > 1) { assigned[k]--; actual -= cfk; }
        else break;
      }
      return { words: assigned, cost: actual };
    }

    if (boss) {
      var bossWords = Math.round(totalWords * TUNING.bossWordShare);
      var bt = pickType('boss');
      var bossDist = TUNING.spawnDistMax + 9;
      monsters.push(makeSpec(bt, bossWords, {
        boss: true,
        x: rng.range(-1.5, 1.5),
        dist: bossDist,
        delay: 0.9,
        // Bosses close slowly and then stay at range, chewing on the player.
        arrive: T * 0.9,
        scale: TUNING.tierScale.boss
      }));
      plannedWords += bossWords;

      // Adds trickle in over the fight in waves.
      var addWords = totalWords - bossWords;
      var addCount = Math.max(3, Math.round(monsterCount(index, players) * 0.9));
      var mix = tierMixFor(index);
      var addTypes = [];
      for (var a0 = 0; a0 < addCount; a0++) {
        addTypes.push(pickType(rng.next() < mix.mid ? 'mid' : 'grunt'));
      }
      normaliseSpeed(addTypes);
      var addShare = shareWords(addTypes, addWords);
      plannedWords += addShare.cost;
      for (var a = 0; a < addCount; a++) {
        var wave = Math.floor(a / Math.max(1, Math.ceil(addCount / TUNING.bossAddWaves)));
        monsters.push(makeSpec(addTypes[a], addShare.words[a], {
          x: laneX(a, addCount),
          dist: rng.range(TUNING.spawnDistMin, TUNING.spawnDistMax),
          delay: 2.5 + wave * (T / (TUNING.bossAddWaves + 0.5)) + rng.range(0, 1.4),
          arrive: Math.max(4, T * 0.45),
          scale: TUNING.tierScale[addTypes[a].tier] * rng.range(0.92, 1.08)
        }));
      }
    } else {
      theme = pickTheme(rng, index, registry);
      var n = monsterCount(index, players);
      if (theme) {
        n = Math.max(TUNING.minMonsters,
                     Math.min(TUNING.maxMonsters * 2, Math.round(n * theme.count)));
      }
      var mix2 = tierMixFor(index);

      var types = [];
      for (var i0 = 0; i0 < n; i0++) {
        if (theme) types.push(registry.get(rng.pick(theme.types)));
        else types.push(pickType(rng.next() < mix2.mid ? 'mid' : 'grunt'));
      }
      normaliseSpeed(types);
      var share = shareWords(types, totalWords);
      plannedWords = share.cost;

      var order = [];
      for (var i3 = 0; i3 < n; i3++) order.push(i3);
      rng.shuffle(order);

      /* Arrival slots go to the cheapest specimens first. The arrival ramp
       * assumes the player is clearing the room at a steady rate, which only
       * holds if what arrives early is also what dies early; put a specimen
       * carrying five times its neighbour's words at the front and everything
       * behind it lands while the player is still on the first one. Lightest
       * first is also the reading a player would expect anyway — the quick
       * fragile things reach you while the heavy ones are still lumbering. */
      var slot = [];
      for (var i5 = 0; i5 < n; i5++) slot.push(i5);
      slot.sort(function (a, b) { return share.words[a] - share.words[b]; });
      var rank = [];
      for (var i6 = 0; i6 < n; i6++) rank[slot[i6]] = i6;

      for (var i4 = 0; i4 < n; i4++) {
        var frac = n === 1 ? 0.8 : rank[i4] / (n - 1);
        var arriveAt = T * CT.lerp(TUNING.arrivalFirst, TUNING.arrivalLast, frac);
        var delay4 = rng.range(0, Math.min(2.2, T * 0.18));
        monsters.push(makeSpec(types[i4], share.words[i4], {
          x: laneX(order[i4], n),
          dist: rng.range(TUNING.spawnDistMin, TUNING.spawnDistMax),
          delay: delay4,
          arrive: arriveAt - delay4,
          scale: TUNING.tierScale[types[i4].tier] * rng.range(0.9, 1.12)
        }));
      }
    }

    return {
      index: index,
      seed: (runSeed ^ Math.imul(index + 1, 0x85ebca6b)) >>> 0,
      boss: boss,
      players: players,
      difficulty: diff,
      requiredWpm: requiredWpm(index),
      // The honest figure, offspring included, so the HUD does not promise a
      // number the chamber will overshoot the moment something splits.
      totalWords: Math.round(plannedWords),
      budgetWords: totalWords,
      nominalTime: T,
      theme: theme ? { id: theme.id, name: theme.name } : null,
      travelTime: boss ? TUNING.bossTravelTime : TUNING.travelTime,
      monsters: monsters
    };
  }

  /* Specs for whatever crawls out of a dying splitter. Host-authoritative: only
   * the host calls this and it ships the result, so the two ends can never
   * disagree about how many things are suddenly in the room. Offspring carry
   * split: null, so the cascade stops at one generation and the word budget the
   * parent was charged for stays correct. */
  function splitSpecs(parent, uidBase, seed, difficulty) {
    var sp = parent.split;
    if (!sp) return [];
    var rng = new CT.Rng((seed ^ Math.imul(parent.uid + 31, 0x9e3779b1)) >>> 0);
    var n = sp.count;
    var words = Math.max(1, Math.round(parent.words.length * sp.words));
    var at = parent.atDist === undefined ? parent.startDist : parent.atDist;
    var out = [];
    for (var i = 0; i < n; i++) {
      var spread = n === 1 ? 0 : (i / (n - 1) - 0.5) * 2;
      out.push({
        uid: uidBase + i,
        typeId: sp.typeId || parent.typeId,
        tier: sp.tier || parent.tier,
        boss: false,
        gen: (parent.gen || 0) + 1,
        x: parent.x + spread * 1.5 + rng.range(-0.3, 0.3),
        // Offspring recoil a few units back from where the parent burst rather
        // than appearing already in contact. A splitter that dropped two things
        // straight onto the player's face was free damage the word budget could
        // not pay for: the budget buys typing time, not the seconds you spend
        // being bitten. This way they still close fast — they inherit a big
        // speed multiplier — but they have to close.
        startDist: Math.max(parent.meleeDist + 3.0, at + 3.2) + rng.range(0, 1.2),
        // Short enough that the parent's gibs are still in the air.
        spawnDelay: 0.18 + i * 0.08,
        speed: CT.clamp(parent.speed * sp.speed, TUNING.minSpeed, TUNING.maxSpeed),
        meleeDist: parent.meleeDist,
        words: CT.Words.makeSet(rng, words, difficulty || 0, false),
        damage: parent.damage * (sp.damage === undefined ? 1 : sp.damage),
        attackInterval: parent.attackInterval * (sp.interval === undefined ? 1 : sp.interval),
        scale: (parent.scale || 1) * sp.scale,
        split: null
      });
    }
    return out;
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
    TRAITS: TRAITS,
    THEMES: THEMES,
    traitsFor: traitsFor,
    traitTags: traitTags,
    planEncounter: planEncounter,
    splitSpecs: splitSpecs,
    simulate: simulate
  };
})(typeof window !== 'undefined' ? window : globalThis);
