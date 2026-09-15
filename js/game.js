/* Cave Typer — the game itself.
 *
 * States: 'idle' -> 'intro' -> 'combat' -> 'cleared' -> 'travel' -> 'intro' ...
 *                                                    \-> 'over'
 *
 * Multiplayer model: the host owns every authoritative number (word indices,
 * player health, score, when an encounter ends). The client predicts its own
 * shots so its own typing always feels instant, and every host message carries
 * an ABSOLUTE value rather than a delta, so a lost or reordered message can
 * never leave the two sides drifting apart. */
(function (global) {
  'use strict';
  var CT = (global.CaveTyper = global.CaveTyper || {});
  var S = function () { return CT.Settings; };
  var D = function () { return CT.Difficulty; };

  var PLAYER_COLORS = [0x7dff4a, 0x36e0ff];
  var _rigPos = new THREE.Vector3();
  var _panV = new THREE.Vector3();
  var BLEEDOUT_TIME = 26;      // seconds a downed co-op player has left
  var REVIVE_HP = 45;

  function Game(stage) {
    this.stage = stage;
    this.effects = new CT.Effects(stage);
    this.labels = new CT.UI.Labels(stage);
    this.hud = new CT.UI.Hud();
    this.net = new CT.Net();
    this.cave = null;

    this.root = new THREE.Group();
    stage.scene.add(this.root);

    this.state = 'idle';
    this.monsters = [];
    this.players = [];
    this.mySlot = 0;
    this.encounterIndex = 0;
    this.runSeed = 0;
    this.score = 0;
    this.stationS = 0;      // arc length along the cave route (authoritative)
    this.stationX = 0;      // world position of the rail stop, derived
    this.stationZ = 0;
    this.time = 0;
    this._stateT = 0;
    this._syncT = 0;
    this._msyncT = 0;
    this._plan = null;
    this._pendingPlan = null;
    this._downMarkers = [];
    this._reviveWord = null;
    this._deepest = 0;

    var self = this;
    this.typing = new CT.Typing({
      onWord: function (m, word) { self.onWordCompleted(m, word); },
      onGoodKey: function () { CT.Audio.key(); },
      onBadKey: function () { CT.Audio.keyBad(); self.stage.addShake(0.03); },
      onMiss: function () { CT.Audio.keyBad(); },
      onAcquire: function (m) { self.sendClaim(m, false); },
      onRelease: function (m) { self.sendClaim(m, true); },
      onWordTaken: function (m) { CT.Audio.wordTaken(); self.sendClaim(m, false); }
    });

    this._wireNet();
  }

  /* ---- lifecycle --------------------------------------------------------- */

  Game.prototype.startRun = function (seed, opts) {
    opts = opts || {};
    this.runSeed = seed >>> 0;
    this.encounterIndex = 0;
    this.score = 0;
    this.time = 0;
    this._deepest = 0;
    this.typing.reset();
    this.clearMonsters();

    var count = this.net.playerCount();
    this.mySlot = this.net.role === 'client' ? 1 : 0;
    this.players = [];
    for (var i = 0; i < count; i++) {
      this.players.push({
        slot: i,
        name: opts.names && opts.names[i] ? opts.names[i] : (i === 0 ? 'PLAYER 1' : 'PLAYER 2'),
        hp: D().TUNING.playerMaxHp,
        maxHp: D().TUNING.playerMaxHp,
        down: false,
        bleed: 0,
        wpm: 0,
        accuracy: 1,
        words: 0,
        kills: 0,
        color: PLAYER_COLORS[i]
      });
    }

    if (this.cave) this.cave.dispose();
    this.cave = new CT.Cave(this.stage, this.runSeed);

    this.stationS = 0;
    this.placeRig(0);
    this.cave.streamTo(40);

    this.hud.buildPlayers(this.players, this.mySlot);
    this.hud.show(true);
    this.hud.setScore(0);
    this.effects.setCoop(count > 1, this.mySlot);
    this.effects.setWeaponVisible(true);

    CT.Audio.init();
    CT.Audio.startAmbience();
    CT.Audio.startMusic();

    this._buildDownMarkers();
    this.beginEncounter(0);
  };

  Game.prototype.endRun = function (reason) {
    if (this.state === 'over') return;
    this.state = 'over';
    this.typing.release();
    CT.Audio.gameOver();
    CT.Audio.setMusicIntensity(0);
    this.hud.setBoss(null);
    this.effects.setWeaponVisible(false);
    if (CT.Records) CT.Records.flush();
    if (this.net.isHost() && this.net.isMultiplayer()) {
      this.net.send({ t: 'over', reason: reason, score: this.score, index: this.encounterIndex });
    }
    if (this.onGameOver) this.onGameOver(this.buildSummary(reason));
  };

  Game.prototype.buildSummary = function (reason) {
    var st = this.typing.stats;
    var me = this.players[this.mySlot];
    return {
      reason: reason || 'You were torn apart.',
      depth: this.encounterIndex + 1,
      deepest: Math.max(this._deepest, this.encounterIndex + 1),
      bosses: Math.floor((this.encounterIndex + 1) / D().TUNING.bossEvery),
      score: Math.round(this.score),
      wpm: this.typing.wpm(),
      accuracy: this.typing.accuracy(),
      words: st.words,
      kills: me ? me.kills : 0,
      streak: st.bestStreak,
      minutes: this.time / 60,
      coop: this.net.isMultiplayer()
    };
  };

  Game.prototype.quit = function () {
    this.state = 'idle';
    this.clearMonsters();
    this.labels.clear();
    this.hud.show(false);
    this.hud.setBoss(null);
    this.effects.setWeaponVisible(false);
    CT.Audio.stopAll();
    if (CT.Records) CT.Records.flush();
    if (this.net.isMultiplayer()) { this.net.send({ t: 'bye' }); this.net.close(); }
  };

  /* ---- encounters -------------------------------------------------------- */

  Game.prototype.beginEncounter = function (index) {
    this.encounterIndex = index;
    this._deepest = Math.max(this._deepest, index + 1);
    this.clearMonsters();
    this.typing.release();

    if (this.net.role === 'client') {
      // The host drives. If its plan already arrived, use it; otherwise wait.
      if (this._pendingPlan && this._pendingPlan.index === index) {
        this._applyPlan(this._pendingPlan);
        this._pendingPlan = null;
      } else {
        this.state = 'waiting';
        this._stateT = 0;
        return;
      }
    } else {
      var plan = D().planEncounter(this.runSeed, index, this.net.playerCount(), CT.MonsterRegistry);
      if (this.net.isMultiplayer()) this.net.send({ t: 'enc', plan: plan });
      this._applyPlan(plan);
    }
  };

  Game.prototype._applyPlan = function (plan) {
    this._plan = plan;
    this.encounterIndex = plan.index;
    this.encounterSeed = plan.seed;
    this.state = 'intro';
    this._stateT = 0;

    for (var i = 0; i < plan.monsters.length; i++) {
      this.monsters.push(new CT.Monster(plan.monsters[i], this));
    }

    this.hud.setEncounter(plan.index, plan.boss, plan.totalWords);
    var intensity = Math.min(1.4, plan.index / 34);
    CT.Audio.setMusicIntensity(intensity);
    CT.Audio.setMusicCombat(true);

    if (plan.boss) {
      CT.Audio.bossRoar();
      var bm = this.bossMonster();
      this.hud.say('CONTAINMENT BREACH\n' + (bm ? bm.name : 'SPECIMEN'), true, 2600);
      this.stage.addShake(0.7);
    } else {
      CT.Audio.alarm();
      if (plan.index === 0) {
        this.hud.say('TYPE THE WORDS\nTO FIRE', false, 3200);
      } else if (plan.index % 5 === 4) {
        this.hud.say('CHAMBER ' + (plan.index + 1), false, 1400);
      }
    }
  };

  /* Put the camera rig on the route at the current arc position, facing down
   * the corridor. `sway` is an extra yaw for the rail's wobble during travel. */
  Game.prototype.placeRig = function (sway) {
    var p = this.cave.pointAt(this.stationS, _rigPos);
    this.stationX = p.x;
    this.stationZ = p.z;
    this.stage.rigRoot.position.set(p.x, 0, p.z);
    this.stage.rigRoot.rotation.y = this.cave.headingAt(this.stationS) + (sway || 0);
  };

  /* Stereo pan for a world position, measured across the camera rig's own right
   * axis rather than world X — otherwise every sound flips sides when the cave
   * turns a corner. */
  Game.prototype.panFor = function (worldPos) {
    _panV.copy(worldPos);
    this.stage.rigRoot.worldToLocal(_panV);
    return CT.clamp(_panV.x / 12, -1, 1);
  };

  Game.prototype.bossMonster = function () {
    for (var i = 0; i < this.monsters.length; i++) if (this.monsters[i].boss) return this.monsters[i];
    return null;
  };

  Game.prototype.clearMonsters = function () {
    for (var i = 0; i < this.monsters.length; i++) this.monsters[i].dispose();
    this.monsters.length = 0;
    this.labels.clear();
    // Drop the held aim with the specimens it was pointing at, or the camera
    // would carry the last chamber's angle into the next one.
    this._aimAt = null;
  };

  Game.prototype.aliveCount = function () {
    var n = 0;
    for (var i = 0; i < this.monsters.length; i++) if (this.monsters[i].alive) n++;
    return n;
  };

  /* ---- shooting ---------------------------------------------------------- */

  /* The local player finished a word. */
  Game.prototype.onWordCompleted = function (m, word) {
    var slot = this.mySlot;
    var p = this.players[slot];
    if (p) { p.words++; }

    if (this.net.isHost()) {
      var killed = m.takeWordHit();
      this.shotFx(m, slot, killed);
      this.awardWord(slot, word, m, killed);
      if (this.net.isMultiplayer()) {
        this.net.send({ t: 'hit', uid: m.uid, wi: m.wordIndex, slot: slot, killed: killed });
      }
    } else {
      // Predict locally so our own typing never feels laggy; the host's next
      // 'hit' carries the absolute index and silently corrects any divergence.
      var killedLocal = m.takeWordHit();
      this.shotFx(m, slot, killedLocal);
      this.net.send({ t: 'shot', uid: m.uid, slot: slot });
    }
    this.typing.validate();
  };

  Game.prototype.awardWord = function (slot, word, m, killed) {
    var T = D().TUNING;
    var gain = T.scorePerWord * (1 + word.length * 0.08) * (1 + this.encounterIndex * 0.04);
    if (killed) {
      gain += m.boss ? T.bossKillScore : T.scorePerKill * (1 + this.encounterIndex * 0.05);
      if (this.players[slot]) this.players[slot].kills++;
    }
    this.score += gain;
  };

  /* Visuals + audio for a shot, from either player. */
  Game.prototype.shotFx = function (m, slot, killed) {
    var hitPos = m.hitWorld(new THREE.Vector3());
    var pan = this.panFor(m.group.position);
    var color = slot === 1 ? 0x36e0ff : 0xffe9b0;

    // Every shot leaves its own player's rifle, so in co-op the partner's barrel
    // visibly bucks and flashes when they fire — otherwise the only sign anyone
    // else is in the cave is health draining off a specimen you were not
    // looking at. Their shot shakes the camera a little, but nowhere near as
    // much as your own: the recoil is theirs, not yours.
    var from = this.effects.muzzleWorld(new THREE.Vector3(), slot);
    this.effects.muzzleFlash(killed ? 1.5 : 1, slot);
    if (slot === this.mySlot) this.stage.fireFeedback(killed ? 1.4 : 1);
    else this.stage.addShake(0.05);
    this.effects.tracer(from, hitPos, color);
    this.effects.impact(hitPos, m.gooColor);

    if (killed && slot === this.mySlot && CT.Records) {
      CT.Records.noteKill(m.def.id, this.encounterIndex + 1);
    }

    if (killed) {
      var center = m.headWorld(new THREE.Vector3());
      center.y -= m.height * 0.3;
      this.effects.gib(center, m.gooColor, m.boss);
      CT.Audio.shotHeavy(pan);
      CT.Audio.death(pan, m.boss);
      this.stage.addShake(m.boss ? 1.0 : 0.22);
    } else {
      CT.Audio.shot(pan, 1);
      CT.Audio.hit(pan);
    }
  };

  /* ---- monster attacks --------------------------------------------------- */

  Game.prototype.onMonsterAttack = function (m) {
    if (!this.net.isHost()) return;      // host is the only source of damage
    if (this.state !== 'combat') return;

    // Attack whichever living player has been hit least recently, so in co-op
    // the pressure spreads rather than deleting one player.
    var target = null;
    for (var i = 0; i < this.players.length; i++) {
      var p = this.players[i];
      if (p.down) continue;
      if (!target || (p._lastHit || 0) < (target._lastHit || 0)) target = p;
    }
    if (!target) return;

    target._lastHit = this.time;
    var dmg = m.spec.damage;
    target.hp = Math.max(0, target.hp - dmg);

    var pan = this.panFor(m.group.position);
    CT.Audio.monsterAttack(pan);
    this.applyHurt(target.slot);

    if (target.hp <= 0) this.downPlayer(target.slot);

    if (this.net.isMultiplayer()) {
      this.net.send({ t: 'atk', uid: m.uid, slot: target.slot, hp: target.hp });
    }
  };

  Game.prototype.applyHurt = function (slot) {
    if (slot !== this.mySlot) return;
    CT.Audio.playerHurt();
    this.stage.hurtFeedback();
    this.hud.hurtFlash();
  };

  Game.prototype.downPlayer = function (slot) {
    var p = this.players[slot];
    if (!p || p.down) return;
    p.down = true;
    p.hp = 0;
    p.bleed = BLEEDOUT_TIME;

    if (slot === this.mySlot) {
      this.typing.release();
      CT.Audio.playerDown();
    }

    if (this.net.isMultiplayer()) {
      if (this.net.isHost()) this.net.send({ t: 'down', slot: slot, bleed: p.bleed });
      var anyUp = false;
      for (var i = 0; i < this.players.length; i++) if (!this.players[i].down) anyUp = true;
      if (!anyUp) {
        if (this.net.isHost()) this.endRun('Both operatives went down in chamber ' + (this.encounterIndex + 1) + '.');
        return;
      }
      // A revive word appears over the downed player.
      this._reviveWord = CT.Words.makeRevive(new CT.Rng(this.runSeed ^ (slot + 1) * 7919 ^ Math.floor(this.time * 13)));
      if (this.net.isHost()) this.net.send({ t: 'revword', slot: slot, word: this._reviveWord });
      this.hud.say(p.name + ' IS DOWN\nTYPE "' + this._reviveWord.toUpperCase() + '"', true, 3000);
    } else {
      this.endRun('You were torn apart in chamber ' + (this.encounterIndex + 1) + '.');
    }
  };

  Game.prototype.revivePlayer = function (slot) {
    var p = this.players[slot];
    if (!p || !p.down) return;
    p.down = false;
    p.hp = REVIVE_HP;
    p.bleed = 0;
    this._reviveWord = null;
    CT.Audio.revive();
    this.hud.say(p.name + ' IS BACK UP', false, 1600);
    if (this.net.isHost() && this.net.isMultiplayer()) {
      this.net.send({ t: 'revive', slot: slot, hp: p.hp });
    }
  };

  Game.prototype.downedPartner = function () {
    if (!this.net.isMultiplayer()) return null;
    for (var i = 0; i < this.players.length; i++) {
      if (i !== this.mySlot && this.players[i].down) return this.players[i];
    }
    return null;
  };

  /* A small glowing marker where each player stands, so a downed partner has a
   * place in the world for their revive prompt to hang over. */
  Game.prototype._buildDownMarkers = function () {
    for (var i = 0; i < this._downMarkers.length; i++) {
      this.stage.rigRoot.remove(this._downMarkers[i].mesh);
      this._downMarkers[i].geo.dispose();
      this._downMarkers[i].mat.dispose();
    }
    this._downMarkers = [];
    if (!this.net.isMultiplayer()) return;
    for (var s = 0; s < 2; s++) {
      var geo = new THREE.OctahedronGeometry(0.34, 0);
      var mat = new THREE.MeshStandardMaterial({
        color: 0x0a0a0a, emissive: PLAYER_COLORS[s], emissiveIntensity: 1.6,
        transparent: true, opacity: 0.85, flatShading: true
      });
      var mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(s === 0 ? -2.3 : 2.3, 0.5, -1.6);
      mesh.visible = false;
      mesh.userData.noShadow = true;
      this.stage.rigRoot.add(mesh);
      this._downMarkers.push({ mesh: mesh, geo: geo, mat: mat });
    }
  };

  /* ---- input ------------------------------------------------------------- */

  Game.prototype.handleKey = function (ch) {
    if (this.state !== 'combat' && this.state !== 'intro') return;
    var me = this.players[this.mySlot];
    if (!me) return;

    // A downed player can only type the revive word for themselves... which is
    // nobody's job but their partner's. Downed players type nothing.
    if (me.down) return;

    // Reviving a partner takes priority over *starting* a new word, but never
    // interrupts one already in progress — otherwise the revive prompt silently
    // eats keystrokes out of the middle of whatever you were shooting.
    var partner = this.downedPartner();
    if (partner && this._reviveWord && !this.typing.target) {
      var expect = this._reviveWord.charAt(this._reviveTyped ? this._reviveTyped.length : 0);
      if (!this._reviveTyped) this._reviveTyped = '';
      if (ch.toLowerCase() === expect.toLowerCase()) {
        this._reviveTyped += expect;
        CT.Audio.key();
        if (this._reviveTyped.length >= this._reviveWord.length) {
          this._reviveTyped = '';
          if (this.net.isHost()) this.revivePlayer(partner.slot);
          else this.net.send({ t: 'dorevive', slot: partner.slot });
        }
        return;
      }
      this._reviveTyped = '';
      // fall through: they may have meant to shoot something
    }

    this.typing.key(ch, this.monsters, this.mySlot);
  };

  Game.prototype.handleBackspace = function () {
    if (this._reviveTyped) { this._reviveTyped = this._reviveTyped.slice(0, -1); return; }
    this.typing.backspace();
  };

  Game.prototype.handleEscape = function () {
    this._reviveTyped = '';
    this.typing.release();
  };

  /* ---- frame ------------------------------------------------------------- */

  Game.prototype.update = function (dt) {
    this.time += dt;
    this._stateT += dt;

    var st = this.state;

    if (st === 'combat' || st === 'intro') {
      this.typing.addCombatTime(dt * 1000);
    }

    if (st === 'intro') {
      // Short beat before control returns, so the chamber can be read.
      if (this._stateT > (this._plan && this._plan.boss ? 1.6 : 0.65)) {
        this.state = 'combat';
        this._stateT = 0;
      }
    }

    if (st === 'waiting') {
      // Client waiting on the host's encounter plan.
      if (this._pendingPlan) {
        var p = this._pendingPlan;
        this._pendingPlan = null;
        this._applyPlan(p);
      } else if (this._stateT > 12) {
        this.endRun('Lost contact with the host.');
      }
    }

    this.updateMonsters(dt);
    this.updateBleedout(dt);

    if (st === 'combat' && this.net.isHost() && this.aliveCount() === 0 && this.monsters.length) {
      this.encounterCleared();
    }

    if (st === 'cleared') {
      if (this._stateT > 1.1) this.beginTravel();
    }

    if (st === 'travel') this.updateTravel(dt);

    this.updateHud(dt);
    this.updateLabels();
    this.updateNetSync(dt);

    if (this.cave) this.cave.update(dt, this.time, this.stationS);
    this.effects.update(dt, this.time);

    // Nudge the camera toward whatever we are shooting at, and keep it there
    // between words. Recentring the moment a word lands would drag the crosshair
    // away from the specimen the player is most likely to shoot next — and
    // since targeting now picks whatever is nearest the crosshair, that would
    // quietly fight the player's own aim. The aim only lets go when the
    // specimen dies.
    var tgt = this.typing.target;
    if (tgt && tgt.alive) this._aimAt = tgt;
    if (this._aimAt && (!this._aimAt.alive || this._aimAt.removed || !this._aimAt.active)) {
      this._aimAt = null;
    }
    this.stage.lookToward(this._aimAt ? this._aimAt.headWorld(new THREE.Vector3()) : null);
  };

  Game.prototype.updateMonsters = function (dt) {
    var self = this;
    var onAttack = this.net.isHost() ? function (m) { self.onMonsterAttack(m); } : null;
    var dead = [];
    for (var i = 0; i < this.monsters.length; i++) {
      var m = this.monsters[i];
      m.update(dt, onAttack);

      // Ambient menace from anything close and still breathing.
      if (m.alive && m.active && m.dist < m.meleeDist + 3 && this.time - m.lastGrowl > 3.5 + Math.random() * 3) {
        m.lastGrowl = this.time;
        CT.Audio.growl(this.panFor(m.group.position), m.boss || m.tier === 'mid');
      }
      if (m.removed) dead.push(i);
    }
    for (var d = dead.length - 1; d >= 0; d--) {
      this.monsters[dead[d]].dispose();
      this.monsters.splice(dead[d], 1);
    }
    this.typing.validate();
  };

  Game.prototype.updateBleedout = function (dt) {
    if (!this.net.isMultiplayer()) return;
    for (var i = 0; i < this.players.length; i++) {
      var p = this.players[i];
      if (!p.down) continue;
      if (this.net.isHost()) {
        p.bleed -= dt;
        // Letting a partner bleed out ends the run for both. The whole point of
        // the timer is that a downed teammate is an emergency you drop
        // everything for; leaving the survivor to solo an encounter that was
        // scaled for two would just be a slower loss.
        if (p.bleed <= 0) {
          this.endRun(p.name + ' bled out in chamber ' + (this.encounterIndex + 1) + '.');
          return;
        }
      }
    }
  };

  Game.prototype.encounterCleared = function () {
    if (this.state !== 'combat') return;
    this.state = 'cleared';
    this._stateT = 0;
    this.typing.release();

    var boss = this._plan && this._plan.boss;
    var heal = D().healFor(this.encounterIndex, boss);
    for (var i = 0; i < this.players.length; i++) {
      var p = this.players[i];
      if (!p.down) p.hp = Math.min(p.maxHp, p.hp + heal);
    }

    CT.Audio.encounterClear();
    CT.Audio.setMusicCombat(false);
    this.hud.setBoss(null);
    this.hud.say(boss ? 'SPECIMEN NEUTRALISED' : 'CHAMBER CLEAR', false, 1300);
    // Between chambers is the one moment a localStorage write cannot be felt.
    if (CT.Records) CT.Records.flush();

    if (this.net.isMultiplayer() && this.net.isHost()) {
      this.net.send({ t: 'clear', index: this.encounterIndex, hp: this.players.map(function (x) { return x.hp; }) });
    }
  };

  Game.prototype.beginTravel = function () {
    this.state = 'travel';
    this._stateT = 0;
    this._travelFrom = this.stationS;
    this._travelTo = this.stationS + D().TUNING.stationSpacing;
    this._travelTime = this._plan ? this._plan.travelTime : D().TUNING.travelTime;
    this.clearMonsters();
    CT.Audio.advance();
    if (this.net.isMultiplayer() && this.net.isHost()) {
      this.net.send({ t: 'travel', index: this.encounterIndex + 1, from: this._travelFrom, to: this._travelTo });
    }
  };

  Game.prototype.updateTravel = function (dt) {
    var k = CT.clamp(this._stateT / this._travelTime, 0, 1);
    // ease in/out so the rail feels mechanical rather than linear
    var e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    this.stationS = CT.lerp(this._travelFrom, this._travelTo, e);
    // A little sway on the rail, on top of the route's own heading.
    this.placeRig(Math.sin(this._stateT * 1.7) * 0.02 * (1 - Math.abs(k - 0.5) * 2));
    this.cave.streamTo(this.stationS + 40);

    if (k >= 1) {
      this.placeRig(0);
      if (this.net.role === 'client') {
        this.state = 'waiting';
        this._stateT = 0;
        if (this._pendingPlan) { var p = this._pendingPlan; this._pendingPlan = null; this._applyPlan(p); }
      } else {
        this.beginEncounter(this.encounterIndex + 1);
      }
    }
  };

  Game.prototype.updateHud = function (dt) {
    var me = this.players[this.mySlot];
    if (me) {
      me.wpm = this.typing.wpm();
      me.accuracy = this.typing.accuracy();
    }
    this.hud.updatePlayers(this.players);
    this.hud.setScore(this.score);
    this.hud.setTypeline(this.typing.progress(), this.mySlot);

    var boss = this.bossMonster();
    if (boss && boss.active) this.hud.setBoss(boss.name, boss.hpFrac());
    else if (this.state !== 'combat' && this.state !== 'intro') this.hud.setBoss(null);

    for (var i = 0; i < this._downMarkers.length; i++) {
      var pl = this.players[i];
      var mk = this._downMarkers[i];
      var show = !!(pl && pl.down);
      mk.mesh.visible = show;
      if (show) {
        mk.mesh.rotation.y = this.time * 1.4;
        mk.mesh.position.y = 0.45 + Math.sin(this.time * 3) * 0.08;
        mk.mat.emissiveIntensity = 1.2 + Math.sin(this.time * 7) * 0.6;
      }
    }
  };

  Game.prototype.updateLabels = function () {
    var items = [];
    var prog = this.typing.progress();
    var tgt = this.typing.target;

    for (var i = 0; i < this.monsters.length; i++) {
      var m = this.monsters[i];
      if (!m.active || !m.alive || m.spawnT < 0.2) continue;
      var w = m.currentWord();
      if (!w) continue;
      var isMine = (m === tgt);
      items.push({
        key: 'm' + m.uid,
        name: m.name,
        word: w,
        typed: isMine && prog ? prog.typed : '',
        typedBySlot: isMine ? this.mySlot : -1,
        // The partner's progress on the same word, shown as a second bar rather
        // than as highlighted letters — two prefixes coloured on one word is
        // unreadable, and only your own matters for what to press next.
        other: m.otherClaim(this.mySlot),
        error: isMine && prog ? prog.error : false,
        hpFrac: m.hpFrac(),
        boss: m.boss,
        worldPos: m.headWorld(new THREE.Vector3())
      });
    }

    // Revive prompt over a downed partner.
    var partner = this.downedPartner();
    if (partner && this._reviveWord) {
      var mk = this._downMarkers[partner.slot];
      if (mk) {
        var wp = new THREE.Vector3();
        mk.mesh.getWorldPosition(wp);
        wp.y += 1.1;
        items.push({
          key: 'revive',
          name: partner.name + ' — BLEEDING OUT ' + Math.ceil(partner.bleed) + 's',
          word: this._reviveWord,
          typed: this._reviveTyped || '',
          typedBySlot: this.mySlot,
          error: false,
          hpFrac: partner.bleed / BLEEDOUT_TIME,
          boss: false,
          kind: 'revive',
          worldPos: wp
        });
      }
    }

    this.labels.sync(items);
  };

  /* ---- networking -------------------------------------------------------- */

  Game.prototype.sendClaim = function (m, release) {
    if (!this.net.isMultiplayer() || !m) return;
    this.net.send({ t: 'claim', uid: m.uid, slot: this.mySlot, rel: !!release, typed: release ? '' : this.typing.typed });
  };

  Game.prototype.updateNetSync = function (dt) {
    if (!this.net.isMultiplayer()) return;

    // Keep the partner's on-screen typing progress roughly live.
    this._claimT = (this._claimT || 0) + dt;
    if (this._claimT > 0.09 && this.typing.target) {
      this._claimT = 0;
      this.net.send({ t: 'claim', uid: this.typing.target.uid, slot: this.mySlot, rel: false, typed: this.typing.typed });
    }

    if (!this.net.isHost()) return;

    this._syncT += dt;
    if (this._syncT > 0.25) {
      this._syncT = 0;
      this.net.send({
        t: 'sync',
        hp: this.players.map(function (p) { return Math.round(p.hp * 10) / 10; }),
        down: this.players.map(function (p) { return p.down ? 1 : 0; }),
        bleed: this.players.map(function (p) { return Math.round(p.bleed * 10) / 10; }),
        kills: this.players.map(function (p) { return p.kills; }),
        shots: this.players.map(function (p) { return p.words; }),
        score: Math.round(this.score)
      });
    }

    // Positions are simulated independently on both sides; a light periodic
    // correction stops any integration drift from becoming visible.
    this._msyncT += dt;
    if (this._msyncT > 0.5 && this.state === 'combat') {
      this._msyncT = 0;
      var d = [];
      for (var i = 0; i < this.monsters.length; i++) {
        var m = this.monsters[i];
        if (!m.alive || !m.active) continue;
        d.push(m.uid, Math.round(m.dist * 100) / 100, m.wordIndex);
      }
      if (d.length) this.net.send({ t: 'msync', d: d });
    }
  };

  Game.prototype.findMonster = function (uid) {
    for (var i = 0; i < this.monsters.length; i++) if (this.monsters[i].uid === uid) return this.monsters[i];
    return null;
  };

  Game.prototype._wireNet = function () {
    var self = this;
    var net = this.net;

    net.on('enc', function (msg) {
      if (!msg.plan) return;
      if (self.state === 'waiting' || self.state === 'idle') {
        self._pendingPlan = msg.plan;
      } else {
        self._pendingPlan = msg.plan;   // consumed at the end of travel
      }
    });

    net.on('shot', function (msg) {
      if (!net.isHost()) return;
      var m = self.findMonster(msg.uid);
      if (!m || !m.alive) return;
      var word = m.currentWord();
      var killed = m.takeWordHit();
      self.shotFx(m, msg.slot, killed);
      if (word) self.awardWord(msg.slot, word, m, killed);
      var p = self.players[msg.slot];
      if (p) p.words++;
      net.send({ t: 'hit', uid: m.uid, wi: m.wordIndex, slot: msg.slot, killed: killed });
    });

    net.on('hit', function (msg) {
      if (net.isHost()) return;
      var m = self.findMonster(msg.uid);
      if (!m) return;
      // Our own shots were already played out locally by prediction.
      if (msg.slot !== self.mySlot) self.shotFx(m, msg.slot, msg.killed);
      // Absolute reconciliation: idempotent, and self-correcting after a drop.
      if (msg.wi > m.wordIndex) { m.wordIndex = msg.wi; m.hurtT = 1; }
      if (msg.killed && m.alive) {
        m.wordIndex = m.totalWords;
        m.alive = false; m.dying = true; m.dieT = 0; m.state = 'die';
        m.claim[0] = m.claim[1] = null;
      }
      self.typing.validate();
    });

    net.on('atk', function (msg) {
      if (net.isHost()) return;
      var p = self.players[msg.slot];
      if (!p) return;
      p.hp = msg.hp;
      self.applyHurt(msg.slot);
      var m = self.findMonster(msg.uid);
      if (m) CT.Audio.monsterAttack(self.panFor(m.group.position));
    });

    net.on('sync', function (msg) {
      if (net.isHost()) return;
      for (var i = 0; i < self.players.length; i++) {
        if (msg.hp && msg.hp[i] !== undefined) self.players[i].hp = msg.hp[i];
        if (msg.down) self.players[i].down = !!msg.down[i];
        if (msg.bleed) self.players[i].bleed = msg.bleed[i];
        // The host owns both tallies; our own local count is only a prediction.
        if (msg.kills && msg.kills[i] !== undefined) self.players[i].kills = msg.kills[i];
        if (msg.shots && msg.shots[i] !== undefined) self.players[i].words = msg.shots[i];
      }
      if (msg.score !== undefined) self.score = msg.score;
    });

    net.on('msync', function (msg) {
      if (net.isHost() || !msg.d) return;
      for (var i = 0; i + 2 < msg.d.length; i += 3) {
        var m = self.findMonster(msg.d[i]);
        if (!m || !m.alive) continue;
        // Ease toward the host's position rather than snapping.
        m.dist = CT.lerp(m.dist, msg.d[i + 1], 0.5);
        if (msg.d[i + 2] > m.wordIndex) m.wordIndex = msg.d[i + 2];
      }
    });

    net.on('claim', function (msg) {
      var m = self.findMonster(msg.uid);
      if (!m) return;
      if (msg.rel) m.clearClaim(msg.slot);
      else m.setClaim(msg.slot, msg.typed || '');
    });

    net.on('clear', function (msg) {
      if (net.isHost()) return;
      if (msg.hp) for (var i = 0; i < self.players.length; i++) {
        if (msg.hp[i] !== undefined) self.players[i].hp = msg.hp[i];
      }
      if (self.state === 'combat' || self.state === 'intro') {
        self.state = 'cleared';
        self._stateT = 0;
        self.typing.release();
        CT.Audio.encounterClear();
        CT.Audio.setMusicCombat(false);
        self.hud.setBoss(null);
        self.hud.say(self._plan && self._plan.boss ? 'SPECIMEN NEUTRALISED' : 'CHAMBER CLEAR', false, 1300);
      }
    });

    net.on('travel', function (msg) {
      if (net.isHost()) return;
      self.state = 'travel';
      self._stateT = 0;
      self._travelFrom = msg.from;
      self._travelTo = msg.to;
      self._travelTime = self._plan ? self._plan.travelTime : D().TUNING.travelTime;
      self.encounterIndex = msg.index;
      self.clearMonsters();
      CT.Audio.advance();
    });

    net.on('down', function (msg) {
      if (net.isHost()) return;
      var p = self.players[msg.slot];
      if (!p || p.down) return;
      p.down = true; p.hp = 0; p.bleed = msg.bleed;
      if (msg.slot === self.mySlot) { self.typing.release(); CT.Audio.playerDown(); }
    });

    net.on('revword', function (msg) {
      if (net.isHost()) return;
      self._reviveWord = msg.word;
      self._reviveTyped = '';
      var p = self.players[msg.slot];
      if (p && msg.slot !== self.mySlot) {
        self.hud.say(p.name + ' IS DOWN\nTYPE "' + msg.word.toUpperCase() + '"', true, 3000);
      }
    });

    net.on('dorevive', function (msg) {
      if (!net.isHost()) return;
      self.revivePlayer(msg.slot);
    });

    net.on('revive', function (msg) {
      if (net.isHost()) return;
      var p = self.players[msg.slot];
      if (!p) return;
      p.down = false; p.hp = msg.hp; p.bleed = 0;
      self._reviveWord = null; self._reviveTyped = '';
      CT.Audio.revive();
      self.hud.say(p.name + ' IS BACK UP', false, 1600);
    });

    net.on('over', function (msg) {
      if (net.isHost()) return;
      self.score = msg.score !== undefined ? msg.score : self.score;
      self.encounterIndex = msg.index !== undefined ? msg.index : self.encounterIndex;
      self.endRun(msg.reason);
    });

    net.on('close', function (reason) {
      if (self.state === 'idle' || self.state === 'over') return;
      self.endRun(reason || 'Your partner disconnected.');
    });
  };

  Game.prototype.dispose = function () {
    this.clearMonsters();
    if (this.cave) this.cave.dispose();
    this.effects.dispose();
    this.stage.scene.remove(this.root);
  };

  CT.Game = Game;
  CT.PLAYER_COLORS = PLAYER_COLORS;
})(window);
