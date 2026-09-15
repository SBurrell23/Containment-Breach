/* Containment Breach — bootstrap, menus, input routing, and the frame loop. */
(function (global) {
  'use strict';
  var CT = (global.ContainmentBreach = global.ContainmentBreach || {});
  var S = function () { return CT.Settings; };
  var UI = CT.UI;
  var $ = UI.$;

  var stage = null, game = null;
  var lastTime = 0, nextSlot = 0, fpsAvg = 60;
  var paused = false;
  var running = false;

  /* ---- fatal errors ------------------------------------------------------ */

  function fatal(msg) {
    var f = $('fatal');
    $('fatal-msg').textContent = String(msg);
    f.classList.remove('hidden');
    if (global.console) console.error('[ContainmentBreach]', msg);
  }

  global.addEventListener('error', function (e) {
    if (!running) fatal((e.message || 'Unknown error') + '\n' + (e.filename || '') + ':' + (e.lineno || ''));
  });

  /* ---- best score -------------------------------------------------------- */

  function paintBest() {
    var b = CT.Records.best();
    var prog = CT.Records.codexProgress();
    $('best-readout').textContent = b
      ? 'deepest chamber ' + b.depth + '  \u00b7  best ' + b.score.toLocaleString() + '  \u00b7  ' + b.wpm + ' wpm'
      : 'no descent on record';
    var mc = $('model-count');
    if (mc && prog.total) {
      mc.textContent = prog.found + ' of ' + prog.total + ' specimen types catalogued';
    }
  }

  /* ---- boot -------------------------------------------------------------- */

  function boot() {
    if (typeof THREE === 'undefined') {
      fatal('three.js failed to load.\n\nThe game needs three.js r128 from cdnjs. Check your ' +
            'network connection, or download three.min.js and point the script tag in ' +
            'index.html at a local copy.');
      return;
    }

    var dropped = CT.MonsterRegistry.validate();
    if (dropped.length && global.console) {
      console.warn('[ContainmentBreach] dropped malformed monster definitions:', dropped.join(', '));
    }

    try {
      stage = new CT.Stage($('stage'));
      game = new CT.Game(stage);
    } catch (e) {
      fatal('Could not start the renderer.\n\n' + (e && e.stack || e));
      return;
    }

    game.onGameOver = showGameOver;
    wireMenus();
    wireInput();
    wireNetUi();
    applyBodyClasses();
    paintBest();

    S().onChange(function (k) {
      applyBodyClasses();
      if (k === 'particles' && game && game.cave) game.cave._buildDust();
      if (k === 'quality' && game && game.cave) {
        // Rebuild the cave at the new detail level; monsters pick it up on spawn.
        game.cave.rebuild();
        game.cave.streamTo(game.stationS + 40);
      }
      if (k.indexOf('Volume') >= 0 || k === 'keyClicks') CT.Audio.refreshVolumes();
    });

    UI.Screens.show('title');
    running = true;
    lastTime = nextSlot = performance.now();
    requestAnimationFrame(frame);
  }

  function applyBodyClasses() {
    document.body.classList.toggle('bigtext', !!S().get('bigText'));
    document.body.classList.toggle('contrast', !!S().get('highContrast'));
  }

  /* ---- frame loop -------------------------------------------------------- */

  function frame(now) {
    requestAnimationFrame(frame);

    /* Frame cap. Each drawn frame is scheduled against a slot clock rather than
     * an accumulator that resets to zero: resetting throws away the overshoot,
     * so a 60 cap on a 76 Hz display degenerates into an uneven mix of one- and
     * two-refresh waits. Advancing the slot by exactly one budget keeps the
     * long-run average on the cap; the resync guard stops a stalled tab from
     * banking a burst of catch-up frames. */
    var cap = S().getNum('fpsCap');
    if (cap > 0) {
      var budget = 1000 / cap;
      if (now < nextSlot) return;
      nextSlot += budget;
      if (nextSlot < now) nextSlot = now + budget;
    } else {
      nextSlot = now;
    }

    var raw = (now - lastTime) / 1000;
    lastTime = now;
    // First frame, or a tab that was asleep: do not hand the sim a huge dt.
    if (!(raw > 0) || raw > 0.5) raw = 1 / 60;

    var dt = Math.min(raw, 0.05);          // never let a stall teleport monsters
    fpsAvg = fpsAvg * 0.92 + (1 / Math.max(raw, 0.0001)) * 0.08;

    var simulate = !paused || (game && game.net.isMultiplayer());
    if (game && game.state !== 'idle' && simulate) {
      try { game.update(dt); }
      catch (e) { fatal('Simulation error:\n' + (e && e.stack || e)); running = false; return; }
    }

    if (game) {
      game.hud.setPerf(
        game.typing.wpm(), game.typing.accuracy(), fpsAvg,
        game.net.isMultiplayer() ? game.net.latency : 0
      );
    }

    stage.update(dt, now / 1000);
    stage.render();
  }

  /* ---- input ------------------------------------------------------------- */

  function wireInput() {
    global.addEventListener('keydown', function (e) {
      // Let the user type in real inputs without the game eating it.
      var tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        if (e.key === 'Escape') e.target.blur();
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        onEscape();
        return;
      }

      if (UI.Screens.isOpen()) {
        // On the title screen, Enter starts a solo run.
        if (e.key === 'Enter' && UI.Screens.current === 'title') { e.preventDefault(); playSolo(); }
        return;
      }

      if (!game || paused) return;

      if (e.key === 'Backspace') {
        e.preventDefault();
        game.handleBackspace();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return; }

      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (CT.Typing.isTypeable(e.key)) {
        e.preventDefault();
        CT.Audio.resume();
        game.handleKey(e.key);
      }
    });

    // Pausing on blur avoids coming back to a corpse.
    global.addEventListener('blur', function () {
      if (game && game.state !== 'idle' && game.state !== 'over' && !UI.Screens.isOpen()) {
        if (!game.net.isMultiplayer()) openPause();
      }
    });

    // Any pointer interaction unlocks WebAudio.
    global.addEventListener('pointerdown', function () { CT.Audio.resume(); }, { passive: true });
  }

  function onEscape() {
    var scr = UI.Screens.current;
    if (scr === 'options') { closeOptions(); return; }
    if (scr === 'howto' || scr === 'mp' || scr === 'codex' || scr === 'archive') {
      CT.Audio.uiBack();
      CT.Codex.stop();
      UI.Screens.show('title');
      paintBest();
      return;
    }
    if (scr === 'pause') { resume(); return; }
    if (scr) return;

    // In game: first Escape drops the typing lock, a second one pauses.
    if (game && game.typing.target) { game.handleEscape(); return; }
    openPause();
  }

  /* ---- menus ------------------------------------------------------------- */

  var ACTIONS = {
    'play-solo': playSolo,
    'open-mp': function () { CT.Audio.uiClick(); UI.Screens.show('mp'); },
    'open-options': openOptions,
    'open-codex': openCodex,
    'open-archive': openArchive,
    'clear-archive': clearArchive,
    'open-howto': function () { CT.Audio.uiClick(); UI.Screens.show('howto'); },
    'back-title': function () {
      CT.Audio.uiBack();
      CT.Codex.stop();          // release the compendium's GL context
      leaveMp();
      UI.Screens.show('title');
      paintBest();
    },
    'close-options': closeOptions,
    'resume': resume,
    'quit-run': quitRun,
    'retry': function () {
      CT.Audio.uiClick();
      if (game.net.isMultiplayer()) {
        if (game.net.isHost()) startCoopRun();
        else game.hud.say('waiting for the host', false, 1500);
      } else playSolo();
    },
    'host-room': hostRoom,
    'join-room': joinRoom,
    'copy-code': copyCode,
    'start-coop': startCoopRun,
    'direct-host': directHost,
    'direct-join': directJoin,
    'copy-direct': copyDirect,
    'submit-direct': submitDirect
  };

  function wireMenus() {
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-action]');
      if (btn) {
        var fn = ACTIONS[btn.dataset.action];
        if (fn) { e.preventDefault(); fn(); }
        return;
      }
      var tab = e.target.closest('[data-mptab]');
      if (tab) {
        CT.Audio.uiClick();
        var name = tab.dataset.mptab;
        document.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('active', t === tab); });
        document.querySelectorAll('.mp-pane').forEach(function (p) {
          p.classList.toggle('active', p.dataset.mppane === name);
        });
      }
    });

    var joinInput = $('join-code');
    joinInput.addEventListener('input', function () {
      joinInput.value = joinInput.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 4);
    });
    joinInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); joinRoom(); }
    });

    UI.Screens.show('title');
  }

  function playSolo() {
    CT.Audio.uiClick();
    CT.Audio.init();
    leaveMp();
    startRun(makeSeed(), ['PLAYER 1']);
  }

  function makeSeed() { return (Math.random() * 0xffffffff) >>> 0; }

  function startRun(seed, names) {
    UI.Screens.show('loading');
    $('loading-title').textContent = 'DESCENDING';
    $('loadbar-fill').style.width = '15%';
    $('loading-note').textContent = 'carving chamber geometry…';

    // Let the loading frame actually paint before the (brief) cave build.
    setTimeout(function () {
      $('loadbar-fill').style.width = '70%';
      try {
        game.startRun(seed, { names: names });
      } catch (err) {
        fatal('Could not start the run:\n' + (err && err.stack || err));
        return;
      }
      $('loadbar-fill').style.width = '100%';
      setTimeout(function () {
        // Only hand control back if the run is genuinely still going — a run
        // that ended between the click and this timer already owns the screen.
        if (game.state === 'idle' || game.state === 'over') return;
        UI.Screens.show(null);
        paused = false;
      }, 140);
    }, 60);
  }

  var optionsReturn = 'title';
  function openOptions() {
    CT.Audio.uiClick();
    optionsReturn = UI.Screens.current || (paused ? 'pause' : null);
    S().render($('options-body'));
    UI.Screens.show('options');
  }
  function closeOptions() {
    CT.Audio.uiBack();
    applyBodyClasses();
    UI.Screens.show(optionsReturn);
    if (!optionsReturn) paused = false;
  }

  function openPause() {
    if (!game || game.state === 'idle' || game.state === 'over') return;
    paused = true;
    CT.Audio.uiBack();
    $('pause-note').textContent = game.net.isMultiplayer()
      ? 'Co-op runs do not pause — the cave keeps moving.'
      : 'Chamber ' + (game.encounterIndex + 1);
    UI.Screens.show('pause');
  }

  function resume() {
    CT.Audio.uiClick();
    paused = false;
    UI.Screens.show(null);
    lastTime = nextSlot = performance.now();
  }

  function quitRun() {
    CT.Audio.uiBack();
    paused = false;
    game.quit();
    resetMpUi();
    UI.Screens.show('title');
    paintBest();
  }

  function showGameOver(summary) {
    paused = false;
    var isBest = CT.Records.isBest(summary);
    CT.Records.addRun(summary);
    $('over-title').textContent = summary.coop ? 'BOTH OPERATIVES LOST' : 'CONTAINMENT LOST';
    $('over-depth').innerHTML = '<b>' + summary.deepest + '</b>CHAMBERS DEEP';

    var mins = Math.floor(summary.minutes);
    var secs = Math.floor((summary.minutes - mins) * 60);
    var cells = [
      ['score', Math.round(summary.score).toLocaleString(), true],
      ['wpm', Math.round(summary.wpm), true],
      ['accuracy', Math.round(summary.accuracy * 100) + '%', false],
      ['words fired', summary.words, false],
      ['specimens', summary.kills, false],
      ['best streak', summary.streak, false],
      ['bosses', summary.bosses, false],
      ['survived', mins + ':' + String(secs).padStart(2, '0'), false]
    ];
    $('over-stats').innerHTML = cells.map(function (c) {
      return '<div class="stat' + (c[2] ? ' hl' : '') + '"><div class="sv">' + c[1] +
             '</div><div class="sl">' + c[0].toUpperCase() + '</div></div>';
    }).join('');

    $('over-best').textContent = (isBest ? 'NEW PERSONAL BEST — ' : '') + summary.reason;
    $('over-best').className = 'status' + (isBest ? ' ok' : '');
    UI.Screens.show('over');
  }

  /* ---- compendium + archive ---------------------------------------------- */

  function openCodex() {
    CT.Audio.uiClick();
    UI.Screens.show('codex');
    // Rendered after the screen is visible so the viewport has a real size to
    // size the WebGL canvas and camera against.
    var prog = CT.Codex.render($('codex-viewport'), $('codex-grid'), $('codex-info'));
    $('codex-progress').textContent = prog.found + ' / ' + prog.total + ' catalogued';
  }

  function openArchive() {
    CT.Audio.uiClick();
    UI.Screens.show('archive');
    paintArchive();
  }

  function paintArchive() {
    var t = CT.Records.allTime();
    var list = CT.Records.runs();

    var cells = [
      ['runs', t.runs, false],
      ['deepest', t.bestDepth ? 'CH ' + t.bestDepth : '\u2013', true],
      ['best score', t.bestScore ? t.bestScore.toLocaleString() : '\u2013', true],
      ['best wpm', t.bestWpm || '\u2013', true],
      ['avg wpm', t.avgWpm || '\u2013', false],
      ['avg acc', t.runs ? t.avgAcc + '%' : '\u2013', false],
      ['specimens', t.totalKills.toLocaleString(), false],
      ['words fired', t.totalWords.toLocaleString(), false],
      ['bosses', t.totalBosses, false],
      ['time in cave', CT.Records.fmtDuration(t.totalSecs), false]
    ];
    $('archive-alltime').innerHTML = cells.map(function (c) {
      return '<div class="stat' + (c[2] ? ' hl' : '') + '"><div class="sv">' + c[1] +
             '</div><div class="sl">' + c[0].toUpperCase() + '</div></div>';
    }).join('');

    if (!list.length) {
      $('archive-list').innerHTML =
        '<div class="ar-empty">Nothing on file yet. Every descent that ends is logged here — ' +
        'solo or co-op, however badly it went.</div>';
      return;
    }

    $('archive-list').innerHTML = list.map(function (r) {
      var isBest = r.depth === t.bestDepth && r.score === t.bestScore;
      return '<div class="ar-row' + (r.coop ? ' coop' : '') + (isBest ? ' best' : '') + '">' +
        '<span class="ar-when">' + CT.Records.fmtDate(r.t) + '</span>' +
        '<span class="ar-mode">' + (r.coop ? 'CO-OP' : 'SOLO') + '</span>' +
        '<span class="ar-cell">' + r.depth + '<small>chamber</small></span>' +
        '<span class="ar-cell">' + r.score.toLocaleString() + '<small>score</small></span>' +
        '<span class="ar-cell">' + r.wpm + '<small>wpm</small></span>' +
        '<span class="ar-cell">' + r.kills + '<small>kills</small></span>' +
        '</div>';
    }).join('');
  }

  function clearArchive() {
    if (!CT.Records.runs().length) return;
    if (!global.confirm('Delete every logged run? The specimen compendium is kept.')) return;
    CT.Audio.uiBack();
    CT.Records.clearRuns();
    paintArchive();
    paintBest();
  }

  /* ---- multiplayer UI ---------------------------------------------------- */

  function setStatus(id, text, cls) {
    var el = $(id);
    el.textContent = text;
    el.className = 'status' + (cls ? ' ' + cls : '');
  }

  function resetMpUi() {
    $('room-code').textContent = '••••';
    setStatus('host-status', '');
    setStatus('join-status', '');
    setStatus('direct-status', '');
    $('direct-step').classList.add('hidden');
    $('dot-p1').classList.remove('on');
    $('dot-p2').classList.remove('on');
    $('lobby-p1').textContent = '—';
    $('lobby-p2').textContent = 'waiting…';
    $('mp-start').classList.add('hidden');
    $('mp-wait').classList.add('hidden');
  }

  function leaveMp() {
    if (game && game.net.isMultiplayer()) { game.net.send({ t: 'bye' }); game.net.close(); }
    resetMpUi();
  }

  function wireNetUi() {
    var net = game.net;

    net.on('code', function (code) {
      $('room-code').textContent = code;
      setStatus('host-status', 'Room open. Read "' + code + '" to the other player.', 'ok');
      $('dot-p1').classList.add('on');
      $('lobby-p1').textContent = 'you (host)';
    });

    net.on('open', function () {
      $('dot-p1').classList.add('on');
      $('dot-p2').classList.add('on');
      if (net.isHost()) {
        $('lobby-p1').textContent = 'you (host)';
        $('lobby-p2').textContent = 'connected';
        $('mp-start').classList.remove('hidden');
        setStatus('host-status', 'Partner linked. Begin when ready.', 'ok');
        setStatus('direct-status', 'Partner linked. Begin when ready.', 'ok');
      } else {
        $('lobby-p1').textContent = 'host';
        $('lobby-p2').textContent = 'you';
        $('mp-wait').classList.remove('hidden');
        setStatus('join-status', 'Linked. Waiting for the host to begin.', 'ok');
        setStatus('direct-status', 'Linked. Waiting for the host to begin.', 'ok');
      }
      CT.Audio.init();
      CT.Audio.uiClick();
    });

    net.on('error', function (msg) {
      setStatus(net.role === 'client' ? 'join-status' : 'host-status', msg, 'err');
      setStatus('direct-status', msg, 'err');
    });

    net.on('close', function (reason) {
      if (!UI.Screens.isOpen() || UI.Screens.current === 'mp') {
        setStatus('host-status', reason, 'err');
        setStatus('join-status', reason, 'err');
        setStatus('direct-status', reason, 'err');
      }
      $('dot-p2').classList.remove('on');
      $('mp-start').classList.add('hidden');
      $('mp-wait').classList.add('hidden');
    });

    net.on('hello-net', function (msg) { net.peerName = msg.name; });
    net.on('welcome-net', function (msg) { net.peerName = msg.name; });

    net.on('start', function (msg) {
      if (net.isHost()) return;
      startRun(msg.seed >>> 0, msg.names || ['PLAYER 1', 'PLAYER 2']);
    });

    net.on('bye', function () {
      if (game.state !== 'idle' && game.state !== 'over') game.endRun('Your partner left the run.');
      else { net.close(); resetMpUi(); }
    });
  }

  function hostRoom() {
    CT.Audio.uiClick();
    CT.Audio.init();
    game.net.close();
    resetMpUi();
    setStatus('host-status', 'Opening a room…');
    game.net.hostBroker('PLAYER 1');
  }

  function joinRoom() {
    CT.Audio.uiClick();
    CT.Audio.init();
    var code = $('join-code').value.trim().toUpperCase();
    if (code.length !== 4) { setStatus('join-status', 'A room code is 4 characters.', 'err'); return; }
    game.net.close();
    setStatus('join-status', 'Connecting to ' + code + '…');
    game.net.joinBroker(code, 'PLAYER 2');
  }

  function copyCode() {
    var code = $('room-code').textContent;
    if (!code || code.charAt(0) === '•') return;
    copyText(code, 'host-status', 'Code copied.');
  }

  function copyDirect() { copyText($('direct-out').value, 'direct-status', 'Copied — send it to the other player.'); }

  function copyText(text, statusId, okMsg) {
    if (global.navigator.clipboard && global.navigator.clipboard.writeText) {
      global.navigator.clipboard.writeText(text)
        .then(function () { setStatus(statusId, okMsg, 'ok'); })
        .catch(function () { setStatus(statusId, 'Copy it manually.', 'err'); });
    } else {
      setStatus(statusId, 'Copy it manually.', 'err');
    }
  }

  var directRole = null;

  function directHost() {
    CT.Audio.uiClick();
    CT.Audio.init();
    game.net.close();
    directRole = 'host';
    $('direct-step').classList.remove('hidden');
    $('direct-step').classList.remove('joining');
    $('direct-out-label').textContent = '1. Send this INVITE to the other player';
    $('direct-in-label').textContent = '2. Paste their REPLY here';
    $('direct-out').value = 'generating…';
    $('direct-in').value = '';
    setStatus('direct-status', 'Gathering network candidates (a few seconds)…');
    game.net.hostManual('PLAYER 1', function (blob) {
      $('direct-out').value = blob;
      setStatus('direct-status', 'Invite ready. Send it, then paste their reply below.', 'ok');
    });
  }

  function directJoin() {
    CT.Audio.uiClick();
    CT.Audio.init();
    game.net.close();
    directRole = 'client';
    $('direct-step').classList.remove('hidden');
    // Swaps the two boxes, so step 1 is still the one at the top.
    $('direct-step').classList.add('joining');
    $('direct-in-label').textContent = '1. Paste the host’s INVITE here, then press SUBMIT';
    $('direct-out-label').textContent = '2. Send this REPLY back to the host';
    $('direct-out').value = '';
    $('direct-in').value = '';
    setStatus('direct-status', 'Paste the invite the host sent you, then press SUBMIT.');
  }

  function submitDirect() {
    var text = $('direct-in').value.trim();
    if (!text) { setStatus('direct-status', 'Paste the code from the other player first.', 'err'); return; }
    CT.Audio.uiClick();
    if (directRole === 'host') {
      setStatus('direct-status', 'Accepting reply…');
      game.net.acceptManualAnswer(text);
    } else {
      setStatus('direct-status', 'Answering…');
      game.net.joinManual(text, 'PLAYER 2', function (blob) {
        $('direct-out').value = blob;
        setStatus('direct-status', 'Reply ready — send it back to the host.', 'ok');
      });
    }
  }

  function startCoopRun() {
    if (!game.net.connected) { setStatus('host-status', 'Nobody is linked yet.', 'err'); return; }
    CT.Audio.uiClick();
    var seed = makeSeed();
    var names = ['PLAYER 1', 'PLAYER 2'];
    game.net.send({ t: 'start', seed: seed, names: names });
    startRun(seed, names);
  }

  /* ---- go ---------------------------------------------------------------- */

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  CT._debug = function () { return { stage: stage, game: game }; };
})(window);
