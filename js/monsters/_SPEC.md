# Cave Typer — Monster Model Contract (v1)

Theme: **science experiment gone wrong.** A deep research cave-lab where the specimens
got out. Monsters are mutated lab animals, failed human test subjects, escaped
bio-engineered horrors, and things that were never supposed to be alive. Visual
language: wet organic flesh + surgical/industrial hardware (tubes, clamps, canisters,
electrodes, exposed bone), sickly bio-luminescent glow (acid green, cyan, magenta).

## Hard environment rules

- **Classic script file.** No `import`/`export`, no ES modules. The file is loaded with
  a plain `<script src="...">` tag.
- `THREE` is a **global** and is **three.js r128**. Use only r128 APIs.
  - `BufferGeometry` and the built-in geometry constructors (`BoxGeometry`,
    `SphereGeometry`, `CylinderGeometry`, `ConeGeometry`, `TorusGeometry`,
    `TorusKnotGeometry`, `IcosahedronGeometry`, `OctahedronGeometry`,
    `DodecahedronGeometry`, `TetrahedronGeometry`, `LatheGeometry`, `TubeGeometry`,
    `ExtrudeGeometry`, `ShapeGeometry`, `RingGeometry`, `PlaneGeometry`,
    `CapsuleGeometry` **is NOT available in r128 — do not use it**).
  - Materials: `MeshStandardMaterial`, `MeshPhongMaterial`, `MeshBasicMaterial`,
    `MeshLambertMaterial`, `PointsMaterial`, `LineBasicMaterial`.
  - `THREE.sRGBEncoding` is the renderer output encoding; just use plain hex colors.
- **No external assets whatsoever.** No image files, no model files, no fonts, no
  network requests. A procedurally drawn `CanvasTexture` is allowed but use it
  sparingly (at most 1–2 per monster).
- **No randomness except the provided seeded RNG.** Do not call `Math.random()`.
- **No lights** inside a monster, except a **boss** may add at most one
  `THREE.PointLight` with a small distance (<= 8).
- Keep it cheap: a grunt should be under ~40 meshes, a mid under ~60, a boss under ~110.
  Prefer low segment counts (spheres at 8–12 segments look great with flat/low-poly
  shading and cost nothing).

## Registration

Each file appends to a global registry. At the top of your file:

```js
window.CaveTyper = window.CaveTyper || {};
window.CaveTyper.monsters = window.CaveTyper.monsters || {};
```

Then for each monster:

```js
window.CaveTyper.monsters['specimen_id'] = {
  id: 'specimen_id',
  name: 'SPECIMEN NAME',   // short, ALL CAPS, shown in the HUD. <= 18 chars.
  tier: 'grunt',           // 'grunt' | 'mid' | 'boss'
  size: { height: 1.8, radius: 0.7 },  // approximate bounds in world units
  build: function (opts) { /* ... */ return instance; }
};
```

### `opts`

```js
{
  rng:     function () { return /* float in [0,1) */ },  // seeded — the ONLY randomness
  palette: {            // theme colors as hex ints, vary per run
    flesh:  0x8a6a72,   // main body / skin
    flesh2: 0x5c4450,   // darker / shadowed flesh
    accent: 0xb8452f,   // muscle, wounds, organic accent
    glow:   0x7dff4a,   // bio-luminescence / hazard glow (emissive)
    glow2:  0x36e0ff,   // secondary glow
    bone:   0xd9d2bd,   // bone, teeth, claws
    metal:  0x6b7076,   // lab hardware, clamps, tubes
    goo:    0x9bff2e    // dripping specimen fluid
  },
  quality: 'low' | 'medium' | 'high',  // scale segment counts off this
  scale:   1.0          // extra uniform scale the engine may apply; already applied
                        // by the engine to group.scale — you do NOT need to use it
}
```

### The returned `instance`

```js
{
  group:      THREE.Group,      // REQUIRED
  headAnchor: THREE.Object3D,   // REQUIRED — an Object3D child positioned slightly
                                // ABOVE the head; the floating word label is anchored
                                // to its world position.
  materials:  [ THREE.Material ], // REQUIRED — every material you created, flat array.
                                // The engine mutates `.emissive` on these for hit
                                // flashes and `.opacity` for the death fade, so
                                // materials MUST be created per-instance (never shared
                                // between two build() calls) and must be created with
                                // `transparent: true` NOT required — the engine sets
                                // `transparent` and `opacity` itself when dying.
  hitPoints:  [ THREE.Object3D ], // OPTIONAL — objects whose world positions are good
                                // places to spawn impact sparks (torso, head, limbs).
                                // If omitted the engine uses the head anchor.
  update:     function (dt, ctx) {},  // REQUIRED, see below
  dispose:    function () {}          // REQUIRED — dispose all geometries + materials
}
```

### Orientation and origin — very important

- **Origin at the feet**, centered on the footprint. The engine places
  `group.position` directly on the cave floor, so the monster must stand on `y = 0`.
- **+Y is up.**
- The monster **faces +Z**. The player/camera is always in the `+Z` direction from
  the monster. Faces, eyes, claws, mouths must point toward `+Z`.
- Total height should match `size.height` reasonably closely (the engine uses it to
  place health bars and to space monsters apart). `size.radius` is the horizontal
  half-extent.

### `update(dt, ctx)`

Called once per frame. `dt` is seconds (already clamped, <= 0.05). Animate by writing
to `position` / `rotation` / `scale` of parts you kept references to in a closure.
**Never** move `group.position` — the engine owns that. You *may* rotate/offset the
group's *children*, and you may set `group.rotation.z`/`x` for lean and
`group.position.y` is engine-owned so use an inner "body" Group for bob/hop instead.

```js
ctx = {
  time:     0,        // seconds since this instance spawned (monotonic)
  state:    'idle',   // 'spawn' | 'idle' | 'walk' | 'attack' | 'hurt' | 'die'
  moveSpeed: 0,       // world units/sec it is currently advancing (0 when stationary)
  attackT:  0,        // 0..1 progress through the current attack swing (only meaningful
                      //      while state === 'attack'); rises 0->1 then resets
  hurtT:    0,        // 1 right after a word-shot lands, decays to 0 over ~0.25s
  dieT:     0,        // 0..1 death animation progress; at 1 the engine removes the group
  spawnT:   1,        // 0..1 spawn-in progress (0 = just appeared). Use it to rise out
                      //      of the floor / unfold. Reaches 1 and stays there.
  hpFrac:   1         // 0..1 remaining health, for rage/damage states
}
```

Animation expectations per state:

- `spawn` — emerge. Scale up from ~0, rise from below the floor, unfurl. Use `spawnT`.
- `idle` — breathing / twitching / floating. Subtle.
- `walk` — clear locomotion cycle whose rate scales with `ctx.moveSpeed`. It is shambling
  toward the player.
- `attack` — a distinct telegraphed lunge/swipe/bite driven by `attackT`.
- `hurt` — a recoil driven by `hurtT` (engine also flashes the materials white for you).
- `die` — collapse/dissolve driven by `dieT`. The engine fades opacity to 0 over the
  same window, so a simple crumple + sink works well.

## Style guidance

- Silhouette first — these are read at 15–40 units away in fog, so make the profile
  distinctive. Bold asymmetry reads better than fine detail.
- Use `emissive` + `emissiveIntensity` for glowing eyes, exposed organs, fluid tanks,
  and vents. The scene is dark and foggy, so glow is the primary read.
- `flatShading: true` on organic parts gives a nice low-poly gore look and is cheap.
- Vary the build with `rng()` so every spawn is a bit different: limb lengths, tumour
  placement, number of eyes, horn counts, color jitter via
  `new THREE.Color(palette.flesh).offsetHSL((rng()-0.5)*0.06, 0, (rng()-0.5)*0.12)`.
- Lab-accident details sell the theme: a numbered specimen tag, a cracked containment
  collar, IV tubes trailing from the spine, an embedded syringe rack, a ribcage held
  shut with metal staples, a cranial electrode halo.

## Self-check before you finish

Your file will be loaded in a browser. Make sure:

1. It parses as a classic script (no `import`, no `export`, no top-level `await`).
2. No `Math.random()` anywhere.
3. No `THREE.CapsuleGeometry`, no `THREE.BufferGeometryUtils`, no `OrbitControls`,
   no addons of any kind — only what ships in `three.min.js` r128.
4. Every `build()` call creates **fresh** geometries and materials (nothing shared at
   module scope that gets mutated).
5. `dispose()` disposes every geometry and every material.
6. `materials` contains every material, and each one has an `emissive` property
   (i.e. use Standard/Phong/Lambert for anything that should flash; `MeshBasicMaterial`
   has no `emissive` — if you use Basic materials, **leave them out of the
   `materials` array**).
7. Calling `update(0.016, {time:0,state:'idle',moveSpeed:0,attackT:0,hurtT:0,dieT:0,spawnT:1,hpFrac:1})`
   throws nothing.
