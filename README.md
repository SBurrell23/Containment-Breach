# CAVE TYPER

### [▶ Play it](https://sburrell23.github.io/Cave-Typer/)

A typing rail-shooter. The containment field in a deep cave research lab failed at
03:14 and everything in the vivarium got out. Your rifle fires on dictation: a word
floats over every specimen's head, and finishing that word is one gunshot into it.

You do not move. A transit rail carries you from chamber to chamber, Time Crisis
style. Tougher specimens take more words; every tenth chamber holds a boss. It goes
on forever, the words get longer and then nastier, and eventually something reaches
you and starts taking your health bar apart. The game is how deep you get.

Vanilla JavaScript, three.js, WebRTC. **Every asset is generated in code** — all the
geometry, all the textures, and all the sound. There is not a single image, model or
audio file in the project.

---

## Running it locally

```bash
node tools/serve.js
```

Then open <http://localhost:8123>. There is no build step and no dependencies —
`tools/serve.js` is a thirty-line static server whose only trick is sending
`Cache-Control: no-store`, so an edited file actually shows up on reload instead of
coming back from the browser cache. Any other static server works just as well for
simply playing:

```bash
python -m http.server 8123
```

The page is written as classic scripts with no ES modules and no `fetch`, so opening
`index.html` directly off disk should work too; serving it over HTTP is the path
that has actually been tested, and is what the two-player link expects.

Two things load from cdnjs: **three.js r128** and **PeerJS 1.5.4**. The game refuses
to start with a clear message if three.js is missing. PeerJS is only needed for
room-code multiplayer — solo play and the Direct Link fallback work without it.

---

## Playing

**Type the word over a specimen to shoot it.** That is the whole control scheme.

| Key | What it does |
| --- | --- |
| letters / digits / punctuation | Fire. The first character you type picks your target. |
| `Backspace` | Step back one letter. At the start of a word, drop the lock. |
| `Esc` | Drop the lock. Press again to pause. |
| `Enter` | Start a solo run from the title screen. |

- **The first letter picks your target.** Press a key and you lock onto the nearest
  specimen whose word starts with it. You stay locked until the word is finished.
  Encounters are generated so that no two words start with the same letter wherever
  possible, which makes targeting decisive rather than a lottery.
- **A specimen's health bar is the number of words left in it.** Grunts die in one
  to three. Bosses take dozens of long compound words.
- **Everything is walking toward you.** Anything that reaches you starts tearing at
  your health and does not stop. Kill the closest threat first.
- Clearing a chamber patches you up a little — never all the way. Damage accumulates
  across a run.

### Two players

Both players share one cave and one set of specimens. A specimen someone else is
already typing turns their colour, and your keystrokes will find a different target
first, so you naturally split the room instead of fighting over it. Encounters are
scaled up for two, so a co-op run is not easier — it is denser.

If a player is dropped to zero they go **down** with a 26-second bleed-out timer, and
a revive word appears over them. Type it fast. If it runs out, the run ends for both
of you.

**Room code (needs internet).** One player opens **TWO-PLAYER LINK → HOST → OPEN
ROOM** and reads the four-character code out. The other goes to **JOIN**, types it,
and connects. Matchmaking runs through PeerJS's public broker; the game itself is a
direct peer-to-peer data channel and never touches a server of ours.

**Direct Link (no broker).** If the broker is blocked or you are on an isolated
network, **DIRECT LINK** does the WebRTC handshake by copy-paste: the host generates
an invite blob, the other player pastes it in and gets a reply blob back, the host
pastes that, and you are connected. Slower to set up, nothing in the middle.

Both transports are tested and work. Host is authoritative for everything that
matters — word counts, health, score, when a chamber is cleared — while the client
predicts its own shots locally so its own typing never feels laggy. Every host
message carries an absolute value rather than a delta, so a dropped or reordered
message self-corrects on the next one instead of leaving the two sides drifting.

---

## Settings

**SETTINGS** from the title screen or the pause menu. Everything persists to
`localStorage`.

**Graphics** — detail preset (cave and specimen geometry density), render scale
(0.5×–1×, the biggest performance lever), MSAA antialiasing (rebuilds the renderer),
frame rate cap (30/60/120/144/unlimited), dynamic shadows, additive glow sprites,
particle density, fog density, field of view, and light flicker.

**Audio** — master, weapon/monster SFX, cave ambience, music drones, and keystroke
clicks, all independent.

**Gameplay & accessibility** — screen shake amount, damage vignette, live WPM
readout, larger word text, high-contrast word plates, and a strict mode where a
mistyped letter locks the word until you backspace it.

---

## Difficulty

The target: **a steady 100 WPM typist should die somewhere around fifteen minutes in.**

Everything that governs that lives in `TUNING` at the top of
[`js/difficulty.js`](js/difficulty.js). An encounter's nominal clear time is computed
in *characters*, not words, because a late-game 13-character hyphenated word is
nearly three "standard" five-character words of typing. The WPM the game expects of
you is a quadratic in the chamber number, so a slower typist still gets a real run
before the floor drops out, and a very fast one still eventually meets a wall.

Measured by driving the actual game with a scripted player at 96–98% accuracy (see
Development below), not by the offline model:

| Typist | Reaches | Time |
| --- | --- | --- |
| 40 WPM | chamber 10 | ~4 min |
| 70 WPM | chamber 24 | ~11 min |
| **100 WPM** | **chamber 30–35** | **12–16 min, averaging ~14.5** |
| 130 WPM | chamber 40 | ~16 min |

The 100 WPM row is five runs; the others are single runs, so treat them as indicative.
Run-to-run spread is real and mostly comes from which specimens a chamber rolls — a
chamber of slow `TENDRIL STALK`s is a very different problem from one of fast
`LAB RAT`s carrying the same number of words.

Word difficulty escalates in stages rather than just getting longer: common short
words, then facility jargon, then hyphenated compounds, then capitalisation (which
costs you a shift key), then asset tags with digits (`SPEC-57X`), then
underscore-joined protocol strings (`failsafe_sterilize`). Bosses always speak in
long compounds — `Cryptothreshold`, `gastroorganism`.

---

## Layout

```
index.html              script order and the whole DOM
css/style.css           HUD, floating labels, menus
js/rng.js               seeded RNG + value noise — all procedural generation funnels here
js/words.js             word bank and difficulty-scaled word generation
js/settings.js          settings store + the self-rendering options menu
js/audio.js             every sound in the game, synthesised from oscillators and noise
js/difficulty.js        the curve, encounter planning, and a headless pacing simulator
js/scene.js             renderer, camera rig, lighting, quality plumbing
js/cave.js              procedural cave tunnel + ruined-lab set dressing, streamed in chunks
js/effects.js           pooled tracers, impacts, gore, muzzle flash, viewmodel
js/entities.js          monster registry, fallback models, and the live monster entity
js/typing.js            targeting, matching, and typing stats
js/ui.js                HUD, floating world labels, screen management
js/net.js               two-player peer-to-peer over two transports
js/game.js              the game state machine and multiplayer sync
js/main.js              bootstrap, menus, input routing, frame loop
js/monsters/_SPEC.md    the contract every monster model is built against
js/monsters/grunts.js   5 minor specimens
js/monsters/mids.js     5 major specimens
js/monsters/bosses.js   4 apex specimens
tools/serve.js          no-cache static dev server
tools/check-pacing.js   headless difficulty curve check
tools/check-words.js    checks the generated words against the length model
```

### Adding a monster

Read [`js/monsters/_SPEC.md`](js/monsters/_SPEC.md) — it is the full contract:
registration, the `build(opts)` signature, the returned instance shape, orientation
(origin at the feet, +Y up, facing +Z), and the `update(dt, ctx)` animation states
(`spawn` / `idle` / `walk` / `attack` / `hurt` / `die`, plus an `hpFrac` that bosses
are expected to visibly degrade with).

Drop a new file in `js/monsters/`, add a `<script>` tag for it, and it is in the
rotation. The registry validates what each file registered and drops anything
malformed rather than taking the game down with it, and a model whose `build()` or
`update()` throws is caught and swapped for a working placeholder.

---

## Development

Check the difficulty curve and the word generator without playing for a quarter of
an hour:

```bash
node tools/check-pacing.js
```

```bash
node tools/check-words.js
```

`check-pacing.js` is an offline approximation and runs optimistic — it does not model
a player who always shoots the closest thing first. Treat it as a fast sanity check
on the shape of the curve, and trust the in-engine numbers for absolute values.

For real numbers, drive the actual game. `window.CaveTyper._debug()` returns
`{ stage, game }`, and stepping `game.update(dt)` by hand plays the game as fast as
the machine can run it — that is how the pacing table above was measured, and how
the two-player sync was verified with two browser tabs stepped alternately.

---

## Deployment

Pushing to `main` publishes to <https://sburrell23.github.io/Cave-Typer/> via
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml). The workflow stages
only what the browser needs — `index.html`, `css/`, `js/` — so the dev server and the
tooling are not published. Before uploading it checks that every script the page
references actually exists in the artifact and that all of them parse, so a typo in a
`<script>` tag fails the build rather than shipping a blank page.

---

## Browser support

Needs WebGL and the Web Audio API. Two-player needs WebRTC data channels. Tested in
Chromium. Audio only starts after your first click or keypress — browsers require a
user gesture before an `AudioContext` will make noise.
