/* Cave Typer — settings store + self-rendering options menu.
 *
 * The schema below is the single source of truth: it drives the defaults, the
 * persisted shape, and the DOM of the options screen. Add a row here and it
 * appears in the menu. */
(function (global) {
  'use strict';
  var CT = (global.CaveTyper = global.CaveTyper || {});

  var STORAGE_KEY = 'cavetyper.settings.v1';

  var SCHEMA = [
    {
      group: 'Graphics',
      items: [
        { key: 'quality', label: 'Detail Preset', type: 'select', def: 'high',
          options: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']],
          hint: 'Geometry detail for the cave and the specimens.' },
        { key: 'resolutionScale', label: 'Render Scale', type: 'range', def: 1.0,
          min: 0.5, max: 1.0, step: 0.05, fmt: function (v) { return Math.round(v * 100) + '%'; },
          hint: 'Lower renders fewer pixels. The single biggest performance lever.' },
        { key: 'antialias', label: 'Antialiasing (MSAA)', type: 'toggle', def: true,
          hint: 'Smooths edges. Changing this rebuilds the renderer.' },
        { key: 'fpsCap', label: 'Frame Rate Cap', type: 'select', def: '120',
          options: [['30', '30 FPS'], ['60', '60 FPS'], ['120', '120 FPS'], ['144', '144 FPS'], ['0', 'Unlimited']],
          hint: 'Capped at 120 by default. Uncapped, the loop will happily render '
              + 'four hundred frames a second of a cave nobody is looking at.' },
        { key: 'shadows', label: 'Shadows', type: 'toggle', def: false,
          hint: 'Dynamic shadow maps. Expensive; off by default.' },
        { key: 'glow', label: 'Glow / Bloom Sprites', type: 'toggle', def: true,
          hint: 'Additive halos on lights, muzzle flashes and bio-luminescence.' },
        { key: 'particles', label: 'Particle Density', type: 'range', def: 1.0,
          min: 0, max: 1.5, step: 0.1, fmt: function (v) { return Math.round(v * 100) + '%'; } },
        { key: 'lightFlicker', label: 'Flickering Lights', type: 'toggle', def: true }
      ]
    },
    {
      group: 'Audio',
      items: [
        { key: 'masterVolume', label: 'Master Volume', type: 'range', def: 0.8,
          min: 0, max: 1, step: 0.05, fmt: function (v) { return Math.round(v * 100) + '%'; } },
        { key: 'sfxVolume', label: 'Weapon / Monster SFX', type: 'range', def: 0.9,
          min: 0, max: 1, step: 0.05, fmt: function (v) { return Math.round(v * 100) + '%'; } },
        { key: 'ambienceVolume', label: 'Cave Ambience', type: 'range', def: 0.5,
          min: 0, max: 1, step: 0.05, fmt: function (v) { return Math.round(v * 100) + '%'; },
          hint: 'The dripping, echoing bed the whole cave sits on.' },
        { key: 'musicVolume', label: 'Music', type: 'range', def: 0.4,
          min: 0, max: 1, step: 0.05, fmt: function (v) { return Math.round(v * 100) + '%'; },
          hint: 'The scored loop, mixed to sit behind the rifle and the specimens.' },
        { key: 'keyClicks', label: 'Keystroke Clicks', type: 'toggle', def: true }
      ]
    },
    {
      group: 'Gameplay & Accessibility',
      items: [
        { key: 'screenShake', label: 'Screen Shake', type: 'range', def: 1.0,
          min: 0, max: 1.5, step: 0.1, fmt: function (v) { return Math.round(v * 100) + '%'; } },
        { key: 'damageFlash', label: 'Damage Vignette', type: 'toggle', def: true },
        { key: 'showWpm', label: 'Live WPM Readout', type: 'toggle', def: true },
        { key: 'bigText', label: 'Larger Word Text', type: 'toggle', def: false,
          hint: 'Bumps the floating word labels up a size.' },
        { key: 'highContrast', label: 'High-Contrast Words', type: 'toggle', def: false,
          hint: 'Solid backing plate behind every word label.' },
        { key: 'strictBackspace', label: 'Errors Lock Until Corrected', type: 'toggle', def: false,
          hint: 'On: a mistyped letter must be backspaced. Off: wrong keys are ignored.' }
      ]
    }
  ];

  var defaults = {};
  for (var g = 0; g < SCHEMA.length; g++) {
    for (var i = 0; i < SCHEMA[g].items.length; i++) {
      var it = SCHEMA[g].items[i];
      defaults[it.key] = it.def;
    }
  }

  /* Bumped when a default changes in a way that should reach players who have
   * already saved settings. save() writes every key, so the moment someone
   * touches any option their file pins every default forever - without this, a
   * changed default would only ever reach people who had never opened the
   * options screen. Each migration only rewrites a value that is still sitting
   * on the old default, so a deliberate choice is left alone. */
  var SCHEMA_VERSION = 2;
  var MIGRATIONS = {
    // v2: the frame cap defaults to 120 rather than unlimited.
    2: function (p) { if (p.fpsCap === '0') p.fpsCap = '120'; }
  };

  var listeners = [];
  var values = {};

  function load() {
    var raw = null;
    try { raw = global.localStorage.getItem(STORAGE_KEY); } catch (e) { raw = null; }
    var parsed = {};
    if (raw) { try { parsed = JSON.parse(raw) || {}; } catch (e2) { parsed = {}; } }

    var from = parsed.__v || 1;
    var migrated = raw && from < SCHEMA_VERSION;
    if (migrated) {
      for (var v = from + 1; v <= SCHEMA_VERSION; v++) {
        if (MIGRATIONS[v]) MIGRATIONS[v](parsed);
      }
    }

    for (var k in defaults) {
      if (Object.prototype.hasOwnProperty.call(defaults, k)) {
        values[k] = Object.prototype.hasOwnProperty.call(parsed, k) ? parsed[k] : defaults[k];
      }
    }
    if (migrated || !raw) save();
  }

  function save() {
    var out = { __v: SCHEMA_VERSION };
    for (var k in values) if (Object.prototype.hasOwnProperty.call(values, k)) out[k] = values[k];
    try { global.localStorage.setItem(STORAGE_KEY, JSON.stringify(out)); } catch (e) { /* private mode */ }
  }

  var Settings = {
    schema: SCHEMA,
    get: function (k) { return values[k]; },
    /* fpsCap is stored as a string because it comes from a <select>. */
    getNum: function (k) { return parseFloat(values[k]) || 0; },
    set: function (k, v) {
      if (values[k] === v) return;
      var old = values[k];
      values[k] = v;
      save();
      for (var i = 0; i < listeners.length; i++) listeners[i](k, v, old);
    },
    all: function () { var o = {}; for (var k in values) o[k] = values[k]; return o; },
    onChange: function (fn) { listeners.push(fn); },
    reset: function () {
      for (var k in defaults) Settings.set(k, defaults[k]);
    },

    /* Builds the options UI into `container`. Idempotent. */
    render: function (container) {
      container.innerHTML = '';
      SCHEMA.forEach(function (grp) {
        var sec = document.createElement('div');
        sec.className = 'opt-group';
        var h = document.createElement('h3');
        h.textContent = grp.group;
        sec.appendChild(h);

        grp.items.forEach(function (item) {
          var row = document.createElement('div');
          row.className = 'opt-row';

          var lab = document.createElement('label');
          lab.className = 'opt-label';
          lab.textContent = item.label;
          lab.htmlFor = 'opt-' + item.key;
          row.appendChild(lab);

          var ctrl = document.createElement('div');
          ctrl.className = 'opt-ctrl';

          if (item.type === 'toggle') {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.id = 'opt-' + item.key;
            btn.className = 'toggle';
            var paint = function () {
              var on = !!Settings.get(item.key);
              btn.classList.toggle('on', on);
              btn.textContent = on ? 'ON' : 'OFF';
              btn.setAttribute('aria-pressed', on ? 'true' : 'false');
            };
            btn.addEventListener('click', function () {
              Settings.set(item.key, !Settings.get(item.key));
              paint();
            });
            paint();
            ctrl.appendChild(btn);

          } else if (item.type === 'range') {
            var input = document.createElement('input');
            input.type = 'range';
            input.id = 'opt-' + item.key;
            input.min = item.min; input.max = item.max; input.step = item.step;
            input.value = Settings.get(item.key);
            var out = document.createElement('span');
            out.className = 'opt-value';
            var fmt = item.fmt || function (v) { return String(v); };
            out.textContent = fmt(parseFloat(input.value));
            input.addEventListener('input', function () {
              var v = parseFloat(input.value);
              Settings.set(item.key, v);
              out.textContent = fmt(v);
            });
            ctrl.appendChild(input);
            ctrl.appendChild(out);

          } else if (item.type === 'select') {
            var sel = document.createElement('select');
            sel.id = 'opt-' + item.key;
            item.options.forEach(function (o) {
              var op = document.createElement('option');
              op.value = o[0]; op.textContent = o[1];
              sel.appendChild(op);
            });
            sel.value = String(Settings.get(item.key));
            sel.addEventListener('change', function () { Settings.set(item.key, sel.value); });
            ctrl.appendChild(sel);
          }

          row.appendChild(ctrl);
          sec.appendChild(row);

          if (item.hint) {
            var hint = document.createElement('div');
            hint.className = 'opt-hint';
            hint.textContent = item.hint;
            sec.appendChild(hint);
          }
        });

        container.appendChild(sec);
      });

      var resetWrap = document.createElement('div');
      resetWrap.className = 'opt-group';
      var rb = document.createElement('button');
      rb.type = 'button';
      rb.className = 'btn ghost';
      rb.textContent = 'Restore Defaults';
      rb.addEventListener('click', function () { Settings.reset(); Settings.render(container); });
      resetWrap.appendChild(rb);
      container.appendChild(resetWrap);
    }
  };

  load();
  CT.Settings = Settings;
})(window);
