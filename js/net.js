/* Cave Typer — two-player peer-to-peer.
 *
 * Two transports behind one interface:
 *   'broker' — PeerJS against its public broker. The host gets a 4-character
 *              room code, the other player types it in. No server of our own.
 *   'manual' — raw WebRTC with copy/paste signalling, for when the broker is
 *              unreachable (offline, blocked, file:// weirdness).
 *
 * The host is authoritative. The client predicts its own shots locally and the
 * host's confirmations win any disagreement. */
(function (global) {
  'use strict';
  var CT = (global.CaveTyper = global.CaveTyper || {});

  var PROTOCOL = 3;
  var PEER_PREFIX = 'cvtypr-v3-';
  var CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';   // no 0/O/1/I
  var ICE = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' }
    ]
  };

  function makeCode(n) {
    var s = '';
    var buf = new Uint8Array(n || 4);
    if (global.crypto && global.crypto.getRandomValues) global.crypto.getRandomValues(buf);
    else for (var k = 0; k < buf.length; k++) buf[k] = Math.floor(Math.random() * 256);
    for (var i = 0; i < buf.length; i++) s += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length];
    return s;
  }

  function Net() {
    this.role = 'solo';         // 'solo' | 'host' | 'client'
    this.transport = null;      // 'broker' | 'manual'
    this.slot = 0;              // 0 = host, 1 = client
    this.connected = false;
    this.code = null;
    this.latency = 0;
    this.peerName = null;

    this._peer = null;
    this._conn = null;
    this._pc = null;
    this._dc = null;
    this._handlers = {};
    this._pingTimer = null;
    this._pingId = 0;
    this._pingSent = {};
    this._closed = false;
    this._outbox = [];
  }

  Net.prototype.on = function (type, fn) {
    (this._handlers[type] = this._handlers[type] || []).push(fn);
    return this;
  };

  Net.prototype._emit = function (type, a, b) {
    var hs = this._handlers[type];
    if (!hs) return;
    for (var i = 0; i < hs.length; i++) {
      try { hs[i](a, b); } catch (e) { if (global.console) console.error('[net] handler error', type, e); }
    }
  };

  Net.prototype.isMultiplayer = function () { return this.role !== 'solo'; };
  Net.prototype.isHost = function () { return this.role !== 'client'; };   // solo counts as host
  Net.prototype.playerCount = function () { return this.role === 'solo' ? 1 : 2; };

  /* ---- sending ----------------------------------------------------------- */

  Net.prototype.send = function (msg) {
    if (this.role === 'solo') return;
    var payload;
    try { payload = JSON.stringify(msg); }
    catch (e) { return; }
    if (this._conn && this._conn.open) { this._conn.send(payload); return; }
    if (this._dc && this._dc.readyState === 'open') { this._dc.send(payload); return; }
    // Not up yet — hold a small backlog so nothing said during handshake is lost.
    if (this._outbox.length < 64) this._outbox.push(payload);
  };

  Net.prototype._flush = function () {
    while (this._outbox.length) {
      var p = this._outbox.shift();
      if (this._conn && this._conn.open) this._conn.send(p);
      else if (this._dc && this._dc.readyState === 'open') this._dc.send(p);
      else { this._outbox.unshift(p); break; }
    }
  };

  Net.prototype._receive = function (raw) {
    var msg;
    try { msg = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch (e) { return; }
    if (!msg || typeof msg.t !== 'string') return;

    if (msg.t === 'ping') { this.send({ t: 'pong', id: msg.id }); return; }
    if (msg.t === 'pong') {
      var sent = this._pingSent[msg.id];
      if (sent) {
        var rtt = performance.now() - sent;
        // smooth so a single hiccup does not dominate the readout
        this.latency = this.latency ? this.latency * 0.7 + rtt * 0.3 : rtt;
        delete this._pingSent[msg.id];
      }
      return;
    }
    this._emit('message', msg);
    this._emit(msg.t, msg);
  };

  Net.prototype._onOpen = function () {
    if (this.connected) return;
    this.connected = true;
    this._flush();
    this._startPing();
    this._emit('open');
  };

  Net.prototype._onClose = function (reason) {
    if (this._closed) return;
    this._closed = true;
    this.connected = false;
    this._stopPing();
    this._emit('close', reason || 'disconnected');
  };

  Net.prototype._startPing = function () {
    var self = this;
    this._stopPing();
    this._pingTimer = setInterval(function () {
      var id = ++self._pingId;
      self._pingSent[id] = performance.now();
      self.send({ t: 'ping', id: id });
      // drop stale entries
      for (var k in self._pingSent) {
        if (performance.now() - self._pingSent[k] > 12000) delete self._pingSent[k];
      }
    }, 2000);
  };

  Net.prototype._stopPing = function () {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
  };

  /* ---- broker transport (PeerJS) ----------------------------------------- */

  Net.prototype.brokerAvailable = function () { return typeof global.Peer === 'function'; };

  Net.prototype.hostBroker = function (name) {
    var self = this;
    if (!this.brokerAvailable()) {
      this._emit('error', 'Room codes need the PeerJS library, which did not load. ' +
                          'Use Direct Link instead.');
      return;
    }
    this.role = 'host';
    this.transport = 'broker';
    this.slot = 0;
    this._closed = false;

    var attempts = 0;
    function tryOnce() {
      var code = makeCode(4);
      var peer = new global.Peer(PEER_PREFIX + code, { debug: 0, config: ICE });
      self._peer = peer;

      peer.on('open', function () {
        self.code = code;
        self._emit('code', code);
      });

      peer.on('connection', function (conn) {
        if (self._conn) { try { conn.close(); } catch (e) {} return; }   // one guest only
        self._conn = conn;
        conn.on('open', function () {
          self.send({ t: 'welcome-net', protocol: PROTOCOL, name: name || 'HOST' });
          self._onOpen();
        });
        conn.on('data', function (d) { self._receive(d); });
        conn.on('close', function () { self._onClose('Your partner disconnected.'); });
        conn.on('error', function (e) { self._emit('error', String(e && e.message || e)); });
      });

      peer.on('error', function (err) {
        var type = err && err.type;
        if (type === 'unavailable-id' && attempts < 6) {
          attempts++;
          try { peer.destroy(); } catch (e) {}
          tryOnce();
          return;
        }
        if (type === 'peer-unavailable') return;   // stale join attempt, ignore
        self._emit('error', friendlyPeerError(err));
      });

      peer.on('disconnected', function () {
        if (!self._closed && !self.connected) {
          try { peer.reconnect(); } catch (e) {}
        }
      });
    }
    tryOnce();
  };

  Net.prototype.joinBroker = function (code, name) {
    var self = this;
    if (!this.brokerAvailable()) {
      this._emit('error', 'Room codes need the PeerJS library, which did not load. ' +
                          'Use Direct Link instead.');
      return;
    }
    code = String(code || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
    if (code.length !== 4) { this._emit('error', 'A room code is 4 characters.'); return; }

    this.role = 'client';
    this.transport = 'broker';
    this.slot = 1;
    this.code = code;
    this._closed = false;

    var peer = new global.Peer(null, { debug: 0, config: ICE });
    this._peer = peer;

    var timeout = setTimeout(function () {
      if (!self.connected) self._emit('error', 'No answer from room ' + code + '. Check the code and that the host is still waiting.');
    }, 15000);

    peer.on('open', function () {
      var conn = peer.connect(PEER_PREFIX + code, { reliable: true });
      self._conn = conn;
      conn.on('open', function () {
        clearTimeout(timeout);
        self.send({ t: 'hello-net', protocol: PROTOCOL, name: name || 'GUEST' });
        self._onOpen();
      });
      conn.on('data', function (d) { self._receive(d); });
      conn.on('close', function () { self._onClose('Your partner disconnected.'); });
      conn.on('error', function (e) { self._emit('error', String(e && e.message || e)); });
    });

    peer.on('error', function (err) {
      clearTimeout(timeout);
      if (err && err.type === 'peer-unavailable') {
        self._emit('error', 'Room ' + code + ' is not open. Codes are case-insensitive but must be exact.');
        return;
      }
      self._emit('error', friendlyPeerError(err));
    });
  };

  function friendlyPeerError(err) {
    var type = err && err.type;
    if (type === 'browser-incompatible') return 'This browser does not support WebRTC data channels.';
    if (type === 'network') return 'Could not reach the matchmaking broker. Check your connection, or use Direct Link.';
    if (type === 'server-error') return 'The matchmaking broker is not responding. Try Direct Link.';
    if (type === 'ssl-unavailable') return 'The broker requires HTTPS. Serve the game over HTTPS or use Direct Link.';
    return 'Connection error' + (type ? ' (' + type + ')' : '') + '.';
  }

  /* ---- manual transport (copy/paste WebRTC) ------------------------------ */

  /* Host: produces an offer blob to hand to the other player. */
  Net.prototype.hostManual = function (name, onBlob) {
    var self = this;
    this.role = 'host';
    this.transport = 'manual';
    this.slot = 0;
    this._closed = false;

    var pc = new RTCPeerConnection(ICE);
    this._pc = pc;
    var dc = pc.createDataChannel('cavetyper', { ordered: true });
    this._dc = dc;
    this._wireChannel(dc, function () { self.send({ t: 'welcome-net', protocol: PROTOCOL, name: name || 'HOST' }); });

    pc.onicecandidate = function (e) {
      // Wait for gathering to finish, then emit one self-contained blob.
      if (e.candidate === null) onBlob(encodeBlob(pc.localDescription));
    };
    pc.onicegatheringstatechange = function () {
      if (pc.iceGatheringState === 'complete' && pc.localDescription) onBlob(encodeBlob(pc.localDescription));
    };
    pc.onconnectionstatechange = function () {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        self._onClose('The direct connection dropped.');
      }
    };

    pc.createOffer()
      .then(function (offer) { return pc.setLocalDescription(offer); })
      .catch(function (e) { self._emit('error', 'Could not create an offer: ' + e.message); });
  };

  /* Host: paste the answer blob back in. */
  Net.prototype.acceptManualAnswer = function (blob) {
    var self = this;
    var desc = decodeBlob(blob);
    if (!desc) { this._emit('error', 'That does not look like a valid reply code.'); return; }
    this._pc.setRemoteDescription(desc).catch(function (e) {
      self._emit('error', 'Could not accept that reply code: ' + e.message);
    });
  };

  /* Client: consume the host's offer blob, produce an answer blob. */
  Net.prototype.joinManual = function (blob, name, onBlob) {
    var self = this;
    var desc = decodeBlob(blob);
    if (!desc) { this._emit('error', 'That does not look like a valid invite code.'); return; }

    this.role = 'client';
    this.transport = 'manual';
    this.slot = 1;
    this._closed = false;

    var pc = new RTCPeerConnection(ICE);
    this._pc = pc;
    pc.ondatachannel = function (e) {
      self._dc = e.channel;
      self._wireChannel(e.channel, function () {
        self.send({ t: 'hello-net', protocol: PROTOCOL, name: name || 'GUEST' });
      });
    };
    pc.onicecandidate = function (e) {
      if (e.candidate === null) onBlob(encodeBlob(pc.localDescription));
    };
    pc.onicegatheringstatechange = function () {
      if (pc.iceGatheringState === 'complete' && pc.localDescription) onBlob(encodeBlob(pc.localDescription));
    };
    pc.onconnectionstatechange = function () {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        self._onClose('The direct connection dropped.');
      }
    };

    pc.setRemoteDescription(desc)
      .then(function () { return pc.createAnswer(); })
      .then(function (ans) { return pc.setLocalDescription(ans); })
      .catch(function (e) { self._emit('error', 'Could not answer that invite: ' + e.message); });
  };

  Net.prototype._wireChannel = function (dc, onOpen) {
    var self = this;
    dc.onopen = function () { if (onOpen) onOpen(); self._onOpen(); };
    dc.onmessage = function (e) { self._receive(e.data); };
    dc.onclose = function () { self._onClose('Your partner disconnected.'); };
    dc.onerror = function () { /* onclose follows */ };
  };

  /* SDP blobs are long; compress the obvious redundancy and base64 it so the
   * player is copying one opaque token rather than a page of text. */
  function encodeBlob(desc) {
    if (!desc) return '';
    var o = { t: desc.type === 'offer' ? 'o' : 'a', s: desc.sdp };
    var json = JSON.stringify(o);
    try {
      return 'CT1' + global.btoa(unescape(encodeURIComponent(json))).replace(/=+$/, '');
    } catch (e) {
      return 'CT0' + json;
    }
  }

  function decodeBlob(blob) {
    if (!blob) return null;
    blob = String(blob).trim().replace(/\s+/g, '');
    try {
      var json;
      if (blob.indexOf('CT1') === 0) {
        var b64 = blob.slice(3);
        while (b64.length % 4) b64 += '=';
        json = decodeURIComponent(escape(global.atob(b64)));
      } else if (blob.indexOf('CT0') === 0) {
        json = blob.slice(3);
      } else {
        json = blob;   // tolerate a raw pasted JSON description
      }
      var o = JSON.parse(json);
      if (o.sdp && o.type) return { type: o.type, sdp: o.sdp };
      if (!o.s) return null;
      return { type: o.t === 'o' ? 'offer' : 'answer', sdp: o.s };
    } catch (e) {
      return null;
    }
  }

  Net.prototype.close = function () {
    this._stopPing();
    try { if (this._conn) this._conn.close(); } catch (e) {}
    try { if (this._peer) this._peer.destroy(); } catch (e) {}
    try { if (this._dc) this._dc.close(); } catch (e) {}
    try { if (this._pc) this._pc.close(); } catch (e) {}
    this._conn = this._peer = this._dc = this._pc = null;
    this.connected = false;
    this.role = 'solo';
    this.transport = null;
    this.code = null;
    this._closed = false;
    this._outbox.length = 0;
  };

  CT.Net = Net;
  CT.NET_PROTOCOL = PROTOCOL;
  CT.makeRoomCode = makeCode;
})(window);
