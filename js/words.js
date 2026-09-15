/* Cave Typer — word bank and difficulty-scaled word generation.
 *
 * Words are bucketed by length. Difficulty raises the length band, then starts
 * layering on modifiers (compound words, hyphenation, capitals, digits) so that
 * late-game words punish exactly the things that slow a fast typist down:
 * shift keys, symbols, and unfamiliar letter pairs. */
(function (global) {
  'use strict';
  var CT = (global.CaveTyper = global.CaveTyper || {});

  /* Ordinary English, short -> long. Deliberately common so early game flows. */
  var COMMON = {
    3: ('ash bug jar lab lid vat rat gas arm eye jaw rib gel ooze pit fog dim raw rot wet dry ' +
        'cut hit run cry hex ion pod tag web ice tar sap fur maw cog vet gut ash den bio dna').split(' '),
    4: ('acid bone cage cell claw cold dark dust fang fear gore grim hive host limb mold slab ' +
        'skin tank tube vial wall worm gaze husk drip flee gene hurt leak mask numb pale pulp ' +
        'rust sick slug spew toxi vein bile clot germ gasp echo').split(' '),
    5: ('agony blood bleak brain claws creep dread flesh gland grave larva lever mutat nerve ' +
        'organ panic plague probe scalp serum shard skull slime spawn spine spore sting swarm ' +
        'toxic tumor viral vomit wound decay fetid gauze hatch morgue putri').split(' '),
    6: ('airway anchor autopsy biopsy bunker cavern cursed defect dosage embryo enzyme fester ' +
        'fossil gasket gauges hazard incise larvae lesion marrow morgue mutate necrid plasma ' +
        'poison putrid quarry rabies reflex sample scream sealed sepsis sinews sutures tissue ' +
        'trauma venoms vessel virals writhe').split(' '),
    7: ('abattoir ammonia autopsy biohaz cadaver capsule caustic chamber clotted colonic ' +
        'corpses crawler culture decayed dissect entrail exposed fissure gristle harvest ' +
        'implant isolate lattice malaise mandible necrose nematod nostril nucleus organic ' +
        'outbrek parasit pathoge putrefy rupture scalpel sealant secrete serumic shrieks ' +
        'siphons specimen sterile stomach syringe tendril toxinic tumours viscera').split(' '),
    8: ('abnormal adhesive afflicts ambulate anaerobe antibody aperture asphyxia bacteria ' +
        'biohazard bleeding calcined carotid cauterize chitinous clinical coagulate collapse ' +
        'contagion corrosive cranium cytology dampened decanted demented dendrite detonate ' +
        'diagnosis dissolve embryonic emissions engorged epidermis epidemic eviscera excision ' +
        'exposure fermented festering filament fractured gangrene gestated glandular hemorrhage ' +
        'hypoxia incision incubate infected inflamed ingested inhibitor injected isolated ' +
        'laceration lobotomy malignant membrane metabolic morbidity mutation necrosis nocturnal ' +
        'olfactory organelle outbreak parasite pathogen peristal petrified pituitary placental ' +
        'protocol pulmonary putrefied quarantine reagents recessive redacted respirat ruptured ' +
        'salivate scavenger secretion sedative septic skeletal specimens sterilize stimulus ' +
        'subjects suppurate surgical symbiont syndrome synthesis tentacles terminal toxicity ' +
        'transfuse tremors ulcerate vacuoles ventral vertebrae virulent viscosity vivisect').split(' ')
  };

  /* Facility jargon — longer, nastier, thematically on-point. Used from mid-game up. */
  var TECHNICAL = ('containment decontaminate biocontainment centrifuge cryogenics ' +
    'electrophoresis immunosuppress microbiology neurotoxicity pathogenesis ' +
    'radiochemistry spectrometry transgenic xenobiology chromatography endocrinology ' +
    'haematology histopathology immunoglobulin mitochondria oligonucleotide ' +
    'phagocytosis recombinant staphylococcus teratogenic cytoplasmic epidemiology ' +
    'genotoxicity hypothalamus intravenous lymphocytes metamorphosis neurological ' +
    'osteoblastic parasitology physiological quarantined resuscitate serological ' +
    'thermoregulation ultrastructure vasoconstrict autoclaved bioreactor ' +
    'chemiluminescent desiccator electrophoretic formaldehyde glutaraldehyde ' +
    'hemocytometer incubation karyotyping luminescence micropipette nanoparticle ' +
    'organophosphate perfusion radioisotope sequencing titration ' +
    'vivisectionist zoonotic anaesthesia bioluminescent cauterization ' +
    'differentiation encephalopathy fluorescence gastrointestinal ' +
    'histocompatibility immunofluorescence lyophilization myelination ' +
    'neurodegenerative osmoregulation pharmacokinetics respiratory ' +
    'spectrophotometer transcriptase ultracentrifuge').split(' ');

  /* Facility asset tags — the late-game symbol/digit punishers. */
  var TAG_PREFIX = ('SPEC VAT LAB SEC BIO GEN TOX RAD VIV NEC HEM CRY INC SUB').split(' ');
  var TAG_WORDS = ('breach purge reflux lockdown override failsafe sterilize venting ' +
    'collapse cascade rupture bleedout meltdown scrubber').split(' ');

  /* Boss words: long compound horrors. */
  var BOSS_ROOTS_A = ('necro bio xeno hemo crypto myco viro terato patho thanato sarco ' +
    'osteo neuro dermo cyto gastro hyper sub trans meta proto').split(' ');
  var BOSS_ROOTS_B = ('genesis phage morphosis culture synthesis cascade reactor lattice ' +
    'vector chamber protocol anomaly organism specimen incubator terminus ' +
    'threshold aberrant construct').split(' ');

  function bucketFor(len) {
    if (len <= 3) return COMMON[3];
    if (len >= 8) return COMMON[8];
    return COMMON[len];
  }

  /* Difficulty is a 0..1-ish scalar derived from encounter index (can exceed 1). */
  function lengthBand(difficulty) {
    // 3-5 chars at the start, creeping to 11-15 by the time it is brutal.
    var lo = 3 + difficulty * 7.0;
    var hi = 5 + difficulty * 9.5;
    return [Math.max(3, Math.round(lo)), Math.max(4, Math.round(hi))];
  }

  function pickByLength(rng, lo, hi) {
    // Gather candidates across the band, preferring the technical list when long.
    var pool = [];
    for (var L = lo; L <= hi; L++) {
      var b = bucketFor(L);
      for (var i = 0; i < b.length; i++) if (b[i].length >= lo && b[i].length <= hi) pool.push(b[i]);
    }
    for (var j = 0; j < TECHNICAL.length; j++) {
      if (TECHNICAL[j].length >= lo && TECHNICAL[j].length <= hi) pool.push(TECHNICAL[j]);
    }
    if (!pool.length) {
      // Band sits above anything we have on file — build a compound instead.
      return rng.pick(BOSS_ROOTS_A) + rng.pick(BOSS_ROOTS_B);
    }
    return rng.pick(pool);
  }

  /* Modifiers, unlocked progressively. Each returns a transformed word. */
  function applyModifiers(word, rng, difficulty) {
    var out = word;

    // >0.30 : occasional hyphenated compound
    if (difficulty > 0.30 && rng.bool(Math.min(0.28, (difficulty - 0.30) * 0.6))) {
      out = out + '-' + pickByLength(rng, 3, 6);
    }
    // >0.45 : capitalisation (forces a shift key)
    if (difficulty > 0.45 && rng.bool(Math.min(0.35, (difficulty - 0.45) * 0.8))) {
      if (rng.bool(0.4)) out = out.toUpperCase();
      else out = out.charAt(0).toUpperCase() + out.slice(1);
    }
    // >0.60 : facility tag with digits
    if (difficulty > 0.60 && rng.bool(Math.min(0.30, (difficulty - 0.60) * 0.7))) {
      out = rng.pick(TAG_PREFIX) + '-' + rng.int(10, 99) + rng.pick(['', '', 'A', 'B', 'X']);
    }
    // >0.80 : underscore-joined protocol strings
    if (difficulty > 0.80 && rng.bool(Math.min(0.25, (difficulty - 0.80) * 0.6))) {
      out = rng.pick(TAG_WORDS) + '_' + rng.pick(TAG_WORDS);
    }
    return out;
  }

  var Words = {
    /* difficulty: 0 (encounter 1) .. ~1.3 (deep run). */
    make: function (rng, difficulty) {
      var band = lengthBand(difficulty);
      var w = pickByLength(rng, band[0], band[1]);
      return applyModifiers(w, rng, difficulty);
    },

    /* Boss words are always long compounds — a sustained, punishing read. */
    makeBoss: function (rng, difficulty) {
      var w = rng.pick(BOSS_ROOTS_A) + rng.pick(BOSS_ROOTS_B);
      if (difficulty > 0.5 && rng.bool(0.35)) w = w.charAt(0).toUpperCase() + w.slice(1);
      if (difficulty > 0.9 && rng.bool(0.3)) w = w + '-' + rng.int(100, 999);
      return w;
    },

    /* A list of `n` distinct-ish words. Avoids two words in the same encounter
     * starting with the same letter where it can, so auto-targeting is decisive. */
    makeSet: function (rng, n, difficulty, boss) {
      var out = [], seen = {}, firstLetters = {};
      var attempts = 0;
      while (out.length < n && attempts < n * 30) {
        attempts++;
        var w = boss ? Words.makeBoss(rng, difficulty) : Words.make(rng, difficulty);
        var key = w.toLowerCase();
        if (seen[key]) continue;
        var fl = key.charAt(0);
        // soft constraint: allow a repeat first letter only once we have tried a bit
        if (firstLetters[fl] && attempts < n * 12) continue;
        seen[key] = 1; firstLetters[fl] = (firstLetters[fl] || 0) + 1;
        out.push(w);
      }
      while (out.length < n) out.push(boss ? Words.makeBoss(rng, difficulty) : Words.make(rng, difficulty));
      return out;
    },

    /* Short, always-easy words — used for the downed-teammate revive prompt. */
    makeRevive: function (rng) {
      return rng.pick(['revive', 'stabilize', 'adrenaline', 'medkit', 'suture', 'restart', 'defib']);
    }
  };

  CT.Words = Words;
})(window);
