/* Cave Typer — HUD, floating world labels, and screen management. */
(function (global) {
  'use strict';
  var CT = (global.CaveTyper = global.CaveTyper || {});
  var S = function () { return CT.Settings; };

  function $(id) { return document.getElementById(id); }

  /* ---- floating labels ---------------------------------------------------
   * DOM rather than sprites: the typed prefix has to be crisp and individually
   * coloured at any distance, and text in a canvas texture never is. */

  function Labels(stage) {
    this.stage = stage;
    this.host = $('world-ui');
    this.pool = [];
    this.active = {};        // uid -> entry
    this._v = new THREE.Vector3();
    this._cam = new THREE.Vector3();
  }

  Labels.prototype._acquire = function () {
    var e = this.pool.pop();
    if (e) { e.el.style.display = ''; return e; }
    var el = document.createElement('div');
    el.className = 'mlabel';
    var name = document.createElement('div'); name.className = 'mname';
    var hp = document.createElement('div'); hp.className = 'mhp';
    var hpi = document.createElement('i'); hp.appendChild(hpi);
    var word = document.createElement('div'); word.className = 'mword';
    // Partner's progress on the same word. A second coloured prefix on the same
    // letters would be unreadable, and only your own tells you what to press,
    // so theirs is a bar instead.
    var mate = document.createElement('div'); mate.className = 'mmate';
    var matei = document.createElement('i'); mate.appendChild(matei);
    var stem = document.createElement('div'); stem.className = 'mstem';
    el.appendChild(name); el.appendChild(hp); el.appendChild(word);
    el.appendChild(mate); el.appendChild(stem);
    this.host.appendChild(el);
    return { el: el, name: name, hp: hp, hpi: hpi, word: word, stem: stem,
             mate: mate, matei: matei,
             lastWord: null, lastTyped: -1, lastHp: -1, lastCls: '', lastLift: -1,
             lastMate: -2 };
  };

  Labels.prototype._release = function (entry) {
    entry.el.style.display = 'none';
    entry.lastWord = null; entry.lastTyped = -1; entry.lastHp = -1; entry.lastCls = '';
    entry.lastMate = -2;
    this.pool.push(entry);
  };

  /* Estimated on-screen size of a label, used only to de-overlap labels against
   * each other — cheap enough to run every frame, unlike reading offsetWidth.
   *
   * The word line is JetBrains Mono, whose advance is a flat 0.6em, so character
   * count times size plus letter-spacing is exact. The name line is Chakra Petch,
   * which is proportional; 0.52em is its measured average for the upper-case
   * specimen names this renders, and it only ever matters when a long name is
   * wider than the word beneath it. */
  var WORD_ADVANCE = 0.6, WORD_TRACKING = 0.5;
  var NAME_ADVANCE = 0.52, NAME_TRACKING = 1.8;

  function labelMetrics(it, far) {
    var big = document.body.classList.contains('bigtext');
    var fs = it.boss ? (big ? 31 : 24) : (far ? (big ? 20 : 15) : (big ? 25 : 19));
    var nfs = it.boss ? 11 : 10;
    var wordW = (it.word ? it.word.length : 0) * (fs * WORD_ADVANCE + WORD_TRACKING) + 12;
    var nameW = (it.name ? it.name.length : 0) * (nfs * NAME_ADVANCE + NAME_TRACKING) + 12;
    return { w: Math.max(wordW, nameW, 50), h: fs + 28 };
  }

  /* items: [{key, word, typed, typedBySlot, error, hpFrac, name, boss, worldPos, kind}] */
  Labels.prototype.sync = function (items) {
    var seen = {};
    var cam = this.stage.camera;
    cam.getWorldPosition(this._cam);
    var w = this.host.clientWidth, h = this.host.clientHeight;

    /* --- pass 1: project, measure, and lift labels clear of each other ---
     * A chamber with eight specimens bunched down the middle would otherwise
     * stack five unreadable words on the same pixels. Nearer monsters keep
     * their natural anchor; anything behind them floats up out of the way and
     * grows a stem back down to its owner. */
    var placed = [];
    for (var pi = 0; pi < items.length; pi++) {
      var p = items[pi];
      this._v.copy(p.worldPos).project(cam);
      p._behind = this._v.z > 1;
      p._x = (this._v.x * 0.5 + 0.5) * w;
      p._y = (-this._v.y * 0.5 + 0.5) * h;
      p._off = p._behind || this._v.x < -1.6 || this._v.x > 1.6 || this._v.y < -1.6 || this._v.y > 1.8;
      p._dist = this._cam.distanceTo(p.worldPos);
      p._far = p._dist > 26;
      p._lift = 0;
      if (!p._off) placed.push(p);
    }
    // Closest first: they are the urgent threat and should stay put.
    placed.sort(function (a, b) { return a._dist - b._dist; });
    for (var a1 = 0; a1 < placed.length; a1++) {
      var A = placed[a1];
      var ma = labelMetrics(A, A._far);
      for (var guard = 0; guard < 12; guard++) {
        var moved = false;
        for (var b1 = 0; b1 < a1; b1++) {
          var B = placed[b1];
          var mb = labelMetrics(B, B._far);
          if (Math.abs(A._x - B._x) > (ma.w + mb.w) * 0.5) continue;
          var ay = A._y - A._lift, by = B._y - B._lift;
          // Labels hang upward from the anchor, so they occupy [y-h, y].
          if (ay - ma.h < by && ay > by - mb.h) {
            A._lift += (by - mb.h) - (ay - ma.h) + 4;
            moved = true;
          }
        }
        if (!moved) break;
      }
      // Never push a label off the top of the screen.
      if (A._y - A._lift - ma.h < 4) A._lift = A._y - ma.h - 4;
      if (A._lift < 0) A._lift = 0;
    }

    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      seen[it.key] = 1;
      var entry = this.active[it.key];
      if (!entry) { entry = this._acquire(); this.active[it.key] = entry; }

      if (it._off) { entry.el.style.visibility = 'hidden'; continue; }
      entry.el.style.visibility = '';
      var x = it._x;
      var y = it._y - it._lift;
      entry.el.style.transform = 'translate(-50%,-100%) translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px)';

      var lift = Math.round(it._lift);
      if (lift !== entry.lastLift) {
        entry.stem.style.height = lift > 6 ? lift + 'px' : '0px';
        entry.lastLift = lift;
      }

      var cls = 'mlabel';
      if (it.kind === 'revive') cls += ' revive';
      if (it.boss) cls += ' boss';
      if (it.typedBySlot === 1) cls += ' p2';
      if (it.typed && it.typed.length) cls += ' locked';
      if (it._far) cls += ' far';
      if (lift > 6) cls += ' lifted';
      if (cls !== entry.lastCls) { entry.el.className = cls; entry.lastCls = cls; }

      if (entry.lastName !== it.name) { entry.name.textContent = it.name; entry.lastName = it.name; }

      if (it.hpFrac === null || it.hpFrac === undefined) {
        entry.hp.style.display = 'none';
      } else {
        entry.hp.style.display = '';
        var pct = Math.max(0, Math.min(1, it.hpFrac));
        if (pct !== entry.lastHp) { entry.hpi.style.width = (pct * 100).toFixed(1) + '%'; entry.lastHp = pct; }
      }

      // partner's share of the same word
      var mateFrac = -1, mateSlot = 0;
      if (it.other && it.word && it.other.typed) {
        mateFrac = Math.min(1, it.other.typed.length / it.word.length);
        mateSlot = it.other.slot;
      }
      if (mateFrac !== entry.lastMate) {
        entry.lastMate = mateFrac;
        if (mateFrac < 0) {
          entry.mate.style.display = 'none';
        } else {
          entry.mate.style.display = '';
          entry.mate.className = 'mmate' + (mateSlot === 1 ? ' p2' : '');
          entry.matei.style.width = (mateFrac * 100).toFixed(1) + '%';
        }
      }

      var typedLen = it.typed ? it.typed.length : 0;
      if (it.word !== entry.lastWord || typedLen !== entry.lastTyped || it.error !== entry.lastError) {
        entry.word.innerHTML = renderWord(it.word, typedLen, it.error);
        entry.lastWord = it.word;
        entry.lastTyped = typedLen;
        entry.lastError = it.error;
      }
    }

    for (var key in this.active) {
      if (!seen[key]) { this._release(this.active[key]); delete this.active[key]; }
    }
  };

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function renderWord(word, typedLen, error) {
    if (!word) return '';
    var done = escapeHtml(word.slice(0, typedLen));
    var rest = escapeHtml(word.slice(typedLen));
    var html = '';
    if (done) html += '<b>' + done + '</b>';
    if (error && rest) {
      html += '<span class="err">' + rest.charAt(0) + '</span>' + rest.slice(1);
    } else {
      html += rest;
    }
    return html;
  }

  Labels.prototype.clear = function () {
    for (var key in this.active) { this._release(this.active[key]); }
    this.active = {};
  };

  /* ---- HUD --------------------------------------------------------------- */

  function Hud() {
    this.el = $('hud');
    this.encNum = $('enc-num');
    this.encTag = $('enc-tag');
    this.score = $('score');
    this.bossBar = $('boss-bar');
    this.bossName = $('boss-name');
    this.bossHp = $('boss-hp').firstElementChild;
    this.players = $('players');
    this.typebar = $('typebar');
    this.typebarWord = $('typebar-word');
    this.wpm = $('wpm-readout');
    this.net = $('net-readout');
    this.fps = $('fps-readout');
    this.toast = $('toast');
    this.flash = $('damage-flash');
    this.cards = [];
    this._toastTimer = null;
    this._scoreShown = 0;
  }

  Hud.prototype.show = function (v) { this.el.classList.toggle('hidden', !v); };

  Hud.prototype.buildPlayers = function (players, mySlot) {
    this.players.innerHTML = '';
    this.cards = [];
    for (var i = 0; i < players.length; i++) {
      var p = players[i];
      var card = document.createElement('div');
      card.className = 'pcard' + (i === 1 ? ' p2' : '') + (i === mySlot ? ' me' : '');
      var coop = players.length > 1;
      card.innerHTML =
        '<div class="prow"><span class="pname"></span><span class="phpnum"></span></div>' +
        '<div class="phpbar"><i></i></div>' +
        '<div class="pstat"></div>' +
        (coop ? '<div class="ptally"></div>' : '');
      this.players.appendChild(card);
      this.cards.push({
        el: card,
        name: card.querySelector('.pname'),
        hpnum: card.querySelector('.phpnum'),
        bar: card.querySelector('.phpbar i'),
        stat: card.querySelector('.pstat'),
        tally: card.querySelector('.ptally')
      });
    }
  };

  Hud.prototype.updatePlayers = function (players) {
    for (var i = 0; i < this.cards.length && i < players.length; i++) {
      var p = players[i], c = this.cards[i];
      var frac = Math.max(0, p.hp) / p.maxHp;
      c.name.textContent = p.name;
      c.hpnum.textContent = Math.max(0, Math.ceil(p.hp)) + ' / ' + p.maxHp;
      c.bar.style.width = (frac * 100).toFixed(1) + '%';
      c.el.classList.toggle('hurt', frac < 0.34);
      c.el.classList.toggle('down', !!p.down);
      var bits = [];
      if (S().get('showWpm')) bits.push(Math.round(p.wpm) + ' WPM');
      bits.push(Math.round(p.accuracy * 100) + '% ACC');
      if (p.down) bits.unshift('DOWN');
      c.stat.textContent = bits.join('   ');

      // Co-op keeps a running tally per player: who is actually carrying.
      if (c.tally) {
        var k = p.kills || 0, sh = p.words || 0;
        c.tally.textContent = k + (k === 1 ? ' KILL   ' : ' KILLS   ') +
                              sh + (sh === 1 ? ' SHOT' : ' SHOTS');
      }
    }
  };

  Hud.prototype.setEncounter = function (index, boss, totalWords) {
    this.encNum.textContent = String(index + 1).padStart(2, '0');
    this.encTag.textContent = boss ? 'CONTAINMENT BREACH' : (totalWords ? totalWords + ' HOSTILE WORDS' : '');
    this.encTag.classList.toggle('boss', !!boss);
  };

  Hud.prototype.setScore = function (v) {
    this._scoreShown = v;
    this.score.textContent = String(Math.round(v));
  };

  Hud.prototype.setBoss = function (name, frac) {
    if (name === null) { this.bossBar.classList.add('hidden'); return; }
    this.bossBar.classList.remove('hidden');
    this.bossName.textContent = name;
    this.bossHp.style.width = (Math.max(0, Math.min(1, frac)) * 100).toFixed(1) + '%';
  };

  Hud.prototype.setTypeline = function (prog, slot) {
    if (!prog) {
      this.typebar.classList.remove('active');
      this.typebarWord.innerHTML = '';
      return;
    }
    this.typebar.classList.add('active');
    var done = escapeHtml(prog.word.slice(0, prog.typed.length));
    var rest = escapeHtml(prog.word.slice(prog.typed.length));
    var html = '<b>' + done + '</b>';
    if (prog.error && rest) html += '<span class="err">' + rest.charAt(0) + '</span><span class="rest">' + rest.slice(1) + '</span>';
    else html += '<span class="rest">' + rest + '</span>';
    this.typebarWord.innerHTML = html;
    document.body.classList.toggle('is-p2', slot === 1);
  };

  Hud.prototype.setPerf = function (wpm, acc, fps, latency) {
    this.wpm.textContent = S().get('showWpm')
      ? Math.round(wpm) + ' WPM  ·  ' + Math.round(acc * 100) + '% ACC'
      : '';
    this.fps.textContent = fps ? Math.round(fps) + ' FPS' : '';
    this.net.textContent = latency ? Math.round(latency) + ' MS' : '';
  };

  Hud.prototype.say = function (text, danger, ms) {
    this.toast.textContent = text;
    this.toast.classList.toggle('danger', !!danger);
    this.toast.classList.add('show');
    if (this._toastTimer) clearTimeout(this._toastTimer);
    var self = this;
    this._toastTimer = setTimeout(function () { self.toast.classList.remove('show'); }, ms || 1700);
  };

  Hud.prototype.hurtFlash = function () {
    if (!S().get('damageFlash')) return;
    var f = this.flash;
    f.classList.add('on');
    setTimeout(function () { f.classList.remove('on'); }, 70);
  };

  /* ---- screens ----------------------------------------------------------- */

  var Screens = {
    current: 'title',
    stack: [],
    show: function (name) {
      var all = document.querySelectorAll('.screen');
      for (var i = 0; i < all.length; i++) all[i].classList.remove('active');
      if (name) {
        var el = $('screen-' + name);
        if (el) el.classList.add('active');
      }
      Screens.current = name;
      document.body.classList.toggle('playing', !name);
    },
    isOpen: function () { return !!Screens.current; }
  };

  CT.UI = {
    $: $,
    Labels: Labels,
    Hud: Hud,
    Screens: Screens,
    renderWord: renderWord,
    escapeHtml: escapeHtml
  };
})(window);
