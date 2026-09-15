/* Builds js/wordbank.js by mining an English dictionary for on-theme words.
 *
 * Writing a few thousand words by hand and hoping they are all real is how the
 * old bank ended up shipping "putri" and "outbrek". Mining instead means every
 * word is dictionary-backed by construction, and the theme comes from the stems
 * we mine for rather than from guesswork.
 *
 * Usage: node tools/build-wordbank.js <path-to-words_alpha.txt>
 */
const fs = require('fs');
const path = require('path');

const dictPath = process.argv[2];
const freqPath = process.argv[3];
if (!dictPath || !fs.existsSync(dictPath) || !freqPath || !fs.existsSync(freqPath)) {
  console.error('Usage: node tools/build-wordbank.js <words_alpha.txt> <count_1w.txt>');
  process.exit(2);
}

const MIN_LEN = 3, MAX_LEN = 16;
const words = fs.readFileSync(dictPath, 'utf8')
  .split(/\r?\n/).map(w => w.trim().toLowerCase())
  .filter(w => /^[a-z]+$/.test(w) && w.length >= MIN_LEN && w.length <= MAX_LEN);
const dict = new Set(words);

/* A spelling dictionary alone is not a quality filter: dwyl's list carries
 * thousands of obsolete, dialect and taxonomic entries — "arsmetry",
 * "coctoantigen", "psychanalysist" — that are technically real but read as
 * typos on screen. Requiring a word to ALSO appear in a frequency-ranked corpus
 * removes all of that while keeping genuine technical vocabulary: necrosis
 * ranks 22939, pathogen 25319 and stalactite 233237, while every junk word
 * above is absent from the corpus entirely. */
const MAX_RANK = 250000;
const rank = new Map();
fs.readFileSync(freqPath, 'utf8').split(/\r?\n/).forEach((line, i) => {
  const w = line.split('\t')[0];
  if (w && !rank.has(w)) rank.set(w, i + 1);
});
function common(w) { const r = rank.get(w); return r !== undefined && r <= MAX_RANK; }

/* ---- what counts as on-theme ------------------------------------------- */

// Stems the facility's vocabulary is built from. Mining by stem is what keeps
// a 14-letter word feeling like it belongs in a biology lab rather than being
// an arbitrary long word.
const STEMS = [
  // life sciences and the body
  'bio', 'necro', 'necr', 'patho', 'hemo', 'haemo', 'hemat', 'haemat', 'cyto', 'cyte',
  'derma', 'dermat', 'osteo', 'neuro', 'neural', 'myo', 'cardi', 'pulmon', 'gastro',
  'hepat', 'vascul', 'arter', 'venous', 'lymph', 'glandul', 'endocrin', 'hormon',
  'embryo', 'fetal', 'foetal', 'genet', 'genom', 'chromo', 'mitochond', 'meiot',
  'nucle', 'ribo', 'enzym', 'protein', 'peptid', 'amino', 'lipid', 'membran',
  'tissu', 'organ', 'skelet', 'vertebr', 'cranial', 'cranio', 'thorac', 'abdomin',
  'ocular', 'retin', 'cochle', 'olfact', 'tactil', 'ganglio', 'cerebr', 'cortic',
  'spinal', 'muscul', 'tendin', 'cartilag', 'follic', 'alveol', 'capillar',
  'plasma', 'platelet', 'leuco', 'leuko', 'erythro', 'phago', 'lyso', 'endo',
  // disease, decay, damage
  'infect', 'contagi', 'viral', 'virus', 'viro', 'bacteri', 'microb', 'fung', 'myco',
  'parasit', 'pathogen', 'toxic', 'toxin', 'venom', 'poison', 'sepsis', 'septic',
  'gangren', 'necrot', 'lesion', 'ulcer', 'malign', 'benign', 'lethal', 'morbid',
  'cadaver', 'corpse', 'decay', 'putrid', 'putref', 'ferment', 'fester', 'abscess',
  'pustul', 'blister', 'hemorrh', 'haemorrh', 'coagul', 'trauma', 'fractur',
  'lacerat', 'contus', 'abras', 'amput', 'ruptur', 'perforat', 'atroph', 'hypertroph',
  'spasm', 'seizur', 'paraly', 'comato', 'delir', 'psychos', 'neuros', 'febril',
  'inflamm', 'suppur', 'edema', 'oedema', 'ischemi', 'ischaemi', 'anemi', 'anaemi',
  'epidem', 'pandem', 'zoonot', 'virulen', 'contamin', 'putresc', 'degener',
  // lab, clinic, procedure
  'clinic', 'surg', 'scalpel', 'suture', 'incis', 'excis', 'dissect', 'vivisect',
  'autops', 'biops', 'specim', 'culture', 'inocul', 'incubat', 'steril', 'antisept',
  'disinfect', 'decontamin', 'quarantin', 'isolat', 'centrifug', 'pipette', 'titrat',
  'reagent', 'catalys', 'solvent', 'distill', 'filtrat', 'precipit', 'crystall',
  'synthes', 'analyt', 'assay', 'spectro', 'microscop', 'chromato', 'electro',
  'radioact', 'radiograph', 'radiolog', 'isotop', 'molecul', 'ionis', 'ioniz',
  'oxidis', 'oxidiz', 'peroxid', 'alkal', 'caustic', 'corros', 'volatil', 'combust',
  'inject', 'infus', 'transfus', 'sedat', 'anesthe', 'anaesthe', 'narcot', 'stimul',
  'inhibit', 'antibod', 'antigen', 'vaccin', 'serum', 'immuno', 'immunis', 'immuniz',
  'cytolog', 'histolog', 'serolog', 'bacteriolog', 'toxicolog', 'epidemiolog',
  // the facility and the cave
  'contain', 'restrict', 'classif', 'redact', 'protocol', 'breach', 'conduit',
  'reactor', 'pressuris', 'pressuriz', 'thermal', 'cryo', 'inciner', 'exhaust',
  'subterran', 'cavern', 'grotto', 'tunnel', 'stalact', 'stalagm', 'mineral',
  'geolog', 'sediment', 'fissure', 'crevic', 'chasm', 'abyss', 'burrow', 'excavat',
  'quarry', 'seismic', 'tectonic', 'calcif', 'limeston', 'gypsum', 'basalt',
  // dread
  'horror', 'terror', 'dread', 'fright', 'scream', 'shriek', 'writh', 'twitch',
  'convuls', 'shudder', 'tremor', 'stagger', 'devour', 'engulf', 'ravenous',
  'predat', 'carniv', 'mutat', 'aberr', 'anomal', 'monstr', 'grotesq', 'hideous',
  'ghastly', 'viscer', 'entrail', 'marrow', 'sinew', 'tendon', 'gristle',
  'cannibal', 'macabre', 'morgue', 'mortuar', 'embalm', 'exhum', 'putrefac',

  // more anatomy and physiology
  'thyroid', 'adrenal', 'pituitar', 'pancrea', 'splen', 'nephr', 'ureter',
  'intestin', 'colon', 'duoden', 'esophag', 'oesophag', 'trache', 'bronch',
  'laryng', 'pharyng', 'sinus', 'tympan', 'auricul', 'orbital', 'maxill',
  'mandibul', 'clavicl', 'sternal', 'costal', 'pelvic', 'femoral', 'tibial',
  'phalang', 'metabol', 'catabol', 'anabol', 'homeostas', 'osmot', 'diffus',
  'respirat', 'circulat', 'digest', 'excret', 'secret', 'synaps', 'axon',
  'dendrit', 'myelin', 'receptor', 'stimulus', 'reflex', 'motor', 'sensory',
  // chemistry and materials
  'chlor', 'sulph', 'sulf', 'nitr', 'phosph', 'carbon', 'hydro', 'oxygen',
  'ammoni', 'methyl', 'ethyl', 'benzen', 'polymer', 'monomer', 'colloid',
  'emulsi', 'suspens', 'saturat', 'concentr', 'dilut', 'aqueous', 'anhydr',
  'reactiv', 'inert', 'unstabl', 'decompos', 'sublim', 'condens', 'evapor',
  'viscos', 'density', 'soluble', 'insolubl', 'acidic', 'neutral', 'buffer',
  // instruments and the building
  'apparatus', 'instrument', 'equipment', 'machiner', 'mechan', 'hydraul',
  'pneumat', 'electric', 'circuit', 'voltage', 'current', 'generator',
  'turbine', 'compressor', 'ventilat', 'filtrat', 'scrubber', 'airlock',
  'bulkhead', 'corridor', 'chamber', 'laborator', 'facility', 'installat',
  'infrastruct', 'foundation', 'structur', 'collaps', 'unstable', 'derelict',
  'abandon', 'condemn', 'evacuat', 'emergen', 'catastroph', 'disaster',
  // states, motion, threat
  'lurk', 'stalk', 'creep', 'crawl', 'slither', 'scuttl', 'shamble', 'lumber',
  'pounce', 'lunge', 'snarl', 'growl', 'hiss', 'gnash', 'rend', 'maul',
  'savage', 'vicious', 'feral', 'rabid', 'frenzy', 'berserk', 'relentless',
  'inexorab', 'implacab', 'malevolen', 'sinister', 'ominous', 'foreboding',
  'desolat', 'forsaken', 'oblivion', 'perdition', 'torment', 'agonis', 'agoniz',
  'anguish', 'suffer', 'affliction', 'ailment', 'malady', 'symptom', 'syndrome',
  'diagnos', 'prognos', 'remedy', 'antidote', 'palliat', 'therapeut',
  // the dark and the deep
  'subsurface', 'underground', 'fathom', 'plummet', 'descent', 'spelunk',
  'karst', 'siphon', 'aquifer', 'phosphoresc', 'luminesc', 'bioluminesc',
  'fluoresc', 'incandesc', 'flicker', 'shadow', 'gloom', 'murky', 'opaque',
  'translucen', 'obscur', 'veiled', 'shroud', 'engulfed', 'submerg'
];

// Suffix families that read as clinical or technical.
const SUFFIXES = [
  'osis', 'itis', 'emia', 'aemia', 'pathy', 'ology', 'ologist', 'otomy', 'ectomy',
  'oscopy', 'ography', 'ometry', 'ometer', 'phobia', 'philia', 'trophy', 'plasia',
  'plasm', 'genesis', 'genic', 'cidal', 'lysis', 'lytic', 'phage', 'phagous',
  'vorous', 'aceous', 'iform', 'otoxic', 'ogenous', 'ocyte', 'blast', 'derm'
];

/* Shape filters. These are about how a word READS under time pressure, not
 * about whether it is real. */
const REJECT = [
  /(.)\1\1/,            // three identical letters in a row
  /[^aeiouy]{5}/,       // five consonants in a row is unreadable at speed
  /(eth|est)$/,         // archaic verb forms: cometh, doest
  /(ly|ness|ship|hood|ward|wise)$/   // bland, off-theme derivations
];

/* Inflections read as filler next to their root, but a blunt /s$/ or /ed$/ rule
 * would also throw away virus, sepsis, necrosis and sacred. A word only counts
 * as an inflection when stripping the ending leaves ANOTHER real word — which
 * is exactly the distinction wanted: infected -> infect (drop),
 * necrosis -> necrosi (keep). */
function isInflection(w) {
  if (w.endsWith('s') && (dict.has(w.slice(0, -1)) || dict.has(w.slice(0, -2) + 'y'))) return true;
  if (w.endsWith('ed') && (dict.has(w.slice(0, -2)) || dict.has(w.slice(0, -1)))) return true;
  if (w.endsWith('ing') && (dict.has(w.slice(0, -3)) || dict.has(w.slice(0, -3) + 'e'))) return true;
  return false;
}

/* dwyl's list and the frequency corpus both carry apostrophe-stripped
 * contractions, which read as misspellings on screen. */
const CONTRACTIONS = new Set([
  'havent', 'hasnt', 'hadnt', 'doesnt', 'dont', 'didnt', 'isnt', 'arent',
  'wasnt', 'werent', 'wont', 'wouldnt', 'cant', 'cannot', 'couldnt', 'shouldnt',
  'shant', 'mustnt', 'neednt', 'youre', 'youve', 'youll', 'theyre', 'theyve',
  'theyll', 'weve', 'well', 'were', 'ive', 'ill', 'im', 'hes', 'shes', 'its',
  'thats', 'whats', 'theres', 'heres', 'lets', 'aint', 'oclock'
]);

const BLOCK = new Set([
  // Words that are real but land badly in a game about being eaten.
  'rape', 'raped', 'rapes', 'suicide', 'suicidal', 'abortion', 'abortive',
  'cancer', 'cancers', 'cancerous', 'leukemia', 'leukaemia', 'aids', 'tumor',
  'tumour', 'tumors', 'tumours', 'carcinoma', 'carcinogen', 'carcinogenic',
  'carcinomas', 'chemotherapy', 'malignancy', 'malignant', 'terminal',
  'stillbirth', 'miscarriage', 'dementia', 'alzheimer', 'retard', 'retarded',
  'spastic', 'cripple', 'crippled', 'lunatic', 'insane', 'asylum'
]);

function acceptable(w) {
  if (w.length < MIN_LEN || w.length > MAX_LEN) return false;
  if (BLOCK.has(w) || CONTRACTIONS.has(w)) return false;
  if (!/[aeiouy]/.test(w)) return false;
  if (!common(w)) return false;
  if (isInflection(w)) return false;
  for (const re of REJECT) if (re.test(w)) return false;
  return true;
}

/* ---- mine ---------------------------------------------------------------- */

const picked = new Map();   // word -> stem that found it

/* Takes up to `perTag` words spread evenly across the candidate list rather
 * than the first N. The list arrives sorted by length, so slicing the head
 * would give every stem its shortest matches and starve the long end of the
 * bank — which is precisely where the late game lives. */
function addFrom(list, tag, perTag) {
  const ok = list.filter(w => !picked.has(w) && acceptable(w));
  if (!ok.length) return;
  if (ok.length <= perTag) {
    ok.forEach(w => picked.set(w, tag));
    return;
  }
  const step = ok.length / perTag;
  for (let i = 0; i < perTag; i++) {
    const w = ok[Math.floor(i * step)];
    if (w && !picked.has(w)) picked.set(w, tag);
  }
}

for (const stem of STEMS) {
  const hits = words.filter(w => w.startsWith(stem) || w.includes(stem));
  hits.sort((a, b) => a.length - b.length);
  // Cap per stem so one prolific root cannot dominate the bank.
  addFrom(hits, stem, 70);
}
for (const suf of SUFFIXES) {
  const hits = words.filter(w => w.endsWith(suf));
  hits.sort((a, b) => a.length - b.length);
  addFrom(hits, suf, 60);
}

/* ---- hand-written short words -------------------------------------------
 * Mining works poorly below six letters: the stems are longer than the words.
 * These are written by hand for the early game and validated like everything
 * else — anything not in the dictionary is dropped and reported. */
const SHORT = `
ash bug jar lab lid vat rat gas arm eye jaw rib gel pit fog dim raw rot wet dry
cut hit run cry hex ion pod tag web ice tar sap fur maw cog vet gut den bio ooze
ear gum hip toe nap sob gag pus wax dye fat sac rash sore scar limp gash rib jab
ail bat claw cave char chew cyst dank dose drag dusk fade fume gnaw grip hunt
lung molt muck pest prey pyre reek roar sane scab slit soil sump swab tomb vent
void wane warp wilt wisp yawn hulk husk moss murk pang raze sear silt slab
acid bone cage cell claw cold dark dust fang fear gore grim hive host limb mold
slab skin tank tube vial wall worm gaze husk drip flee gene hurt leak mask numb
pale pulp rust sick slug spew vein bile clot germ gasp echo bolt cast coil damp
ache bald bane bite blot boil brow bulk burn cane cave clan claw clog crag creak
dart daze dent dire dirt door drab dram dread dribble drone duct dull dwell ebb
edge etch fail fake fall fell fern fetid file fill film flap flay fled flex flog
flux foam foil fold fume fuse gale gall gape gill girt glow glut gnat gore gout
grab gram grate grave greed grid grim grit grow gulf gust hack hail halt hare
harm harsh haul haunt hazy heap heat heed herd hide hilt hind hole hollow hood
hook horn howl hulk hum hunch hurl husk idle inch itch jolt keen kelp kiln knit
knob knot lace lair lame lamp lance lapse lard lash latch lathe leap ledge leech
lever lick lime limp linen lisp lithe loam loath lobe lock lode loom loop lore
lost lump lure lurk lush mange mania mar mare marsh mash mask mass mast mate
maze mead meal mean meat mend mesh mess mica mild mine mire mist mite moan moat
mock moist mole monk mood moor mope moss moth mount mourn mud mull mush musk
mute myth nail name nape nave neat neck need nerve nest nick node noose norm
nose notch nova numb oath oaken oath odor omen onus ooze opal orb ore oust oval
oven over pact pail pain pale pall palm pane pang pant pare park pass past pate
path pawn peak peal pearl peat peck peel peer pelt pen perch peril pest pewter
phase pick pier pike pile pill pine pipe pith pity plait plan plate plea pled
plod plot pluck plume plump plumb plunge ply pod poke pole poll pond pool pore
pork port pose post pouch pound pour pox prank press prick pride prime print
prism probe prod prong proof prop prose prowl prune pry pull pulse pump punch
pup pure purge push pyre quail quake qualm quart quell quest queue quill quilt
quirk quiz raft rage raid rail rake ramp rank rant rasp rate rave raw reap rear
reed reef reel reign rein relic rend rent rest rib rice ridge rife rig rim rind
ring rinse riot rip rise risk rite rival roam roast robe rock rode roil role
roll romp roof room root rope rose rot rough round rouse rove rub rude rug ruin
rule rung runt ruse rush rut sack sag sage sail salt sand sane sash save scald
scale scalp scan scar scent scold scoop scope scorch score scorn scour scowl
scrap scrape screech screw scribe scroll scrub scum seal seam sear seat sect
seed seek seep seize sense sepal serf sever shade shaft shake shale shall shame
shank shape shard shave shear sheath shed sheen sheer shelf shell shield shift
shin shine shirk shoal shock shoot shore short shove shred shrewd shrill shrine
shrink shroud shrub shun shut sift sigh sign silo silt sinew singe sink siren
skew skid skirt skulk slab slack slag slake slam slant slap slash slate slave
sled sleek sleet slice slick slide slight slime slip slit slope slot slow sludge
slump slur smear smelt smite smoke smolder smoulder smother snag snap snare
snarl sneer sniff snout soak soar sob sod soot sore sound sour sow spade span
spare spark spawn speck speed spell spend spent spew spike spill spin spire
spite splash splice split spoil spoke spool spore sprawl spray spread sprig
spring sprout spur spurn spurt squall squat squeal squirm stab stack stag stain
stair stake stale stalk stall stamp stand stark start starve stash state stave
stead steam steel steep steer stem stench step stern stew stick stiff still
sting stink stir stock stoke stone stoop stop store storm stout stove strain
strait strand strap straw stray streak stream strew strict stride strife strike
string strip strive stroke strong struck stub stud stump stun stunt sturdy
submerge suck sulk sullen sump sunder surge swab swamp swarm swath sway swear
sweat sweep swell swerve swift swill swine swirl switch swoop sword tack taint
talon tame tang tangle tank taper tar tarn tatter taut teem tempt tend tense
tepid term terse thaw thick thief thin thorn thrash thread threat thresh thrive
throat throb throng throttle thrust thud thump tide tilt timber tinge tint tire
toil token toll tomb tone tong tool tooth topple torch torn torso toss tough
tow trace track tract trail train trait tramp trance trap trash tread treat
tremble trench trend trial tribe trick trim trip troll troop trough trout truce
truck trudge true trunk trust truth tuck tug tumble tundra tunnel turf turn
tusk twig twine twist twitch ulcer umber uncle undo unfit unit untie upend urge
usher usual utter vague vain vale valve vamp vane vapor vault veer veil vein
velum vend vent verge verse vessel vex viable vial vibe vice view vigil vile
vine viper virus visor vital vivid vocal void volt vomit vortex vouch vow vulgar
wade waft wage wail waist wake wall wan wander wane ward warn warp wary waste
watch water wave wax weak wean wear weave web wedge weed week weep weigh weir
weld welt wench wet whack whale wharf wheel whelp whet whiff while whim whine
whip whirl whisk wield wild wilt wince winch wind wing wink wipe wire wisp wit
withe wither woe wolf womb wonder wood wool word work worm worn worry worse
worth wound wrap wrath wreak wreck wrench wrest wretch wring wrist writ writhe
wrong wry yank yard yarn yawn year yeast yell yelp yield yoke yolk zeal zone
`.split(/\s+/).filter(Boolean);

let shortDropped = [];
for (const w of SHORT) {
  // Short words bypass the shape filters (they are hand-picked) but must still
  // be spelled correctly and appear in the corpus.
  if (!dict.has(w) || !common(w)) { shortDropped.push(w); continue; }
  if (BLOCK.has(w)) continue;
  if (!picked.has(w)) picked.set(w, 'short');
}

/* ---- emit ---------------------------------------------------------------- */

const all = [...picked.keys()].sort();
const byLen = {};
for (const w of all) (byLen[w.length] = byLen[w.length] || []).push(w);

const lengths = Object.keys(byLen).map(Number).sort((a, b) => a - b);
console.log(`mined ${all.length} words`);
if (shortDropped.length) console.log(`short words dropped (not in dict): ${shortDropped.join(' ')}`);
console.log('length histogram:');
lengths.forEach(L => console.log(`  ${String(L).padStart(2)}: ${String(byLen[L].length).padStart(4)}`));

// Every emitted word is re-checked against the dictionary here, so the file
// cannot be written with anything unverified in it.
const unverified = all.filter(w => !dict.has(w));
if (unverified.length) {
  console.error('REFUSING TO WRITE — unverified words: ' + unverified.slice(0, 20).join(' '));
  process.exit(1);
}

function chunk(arr, perLine) {
  const out = [];
  for (let i = 0; i < arr.length; i += perLine) {
    // The trailing space matters: without it the last word of one line and the
    // first word of the next concatenate when the strings are joined.
    const tail = (i + perLine < arr.length) ? ' ' : '';
    out.push('    ' + JSON.stringify(arr.slice(i, i + perLine).join(' ') + tail));
  }
  return out.join(' +\n');
}

let src = `/* Containment Breach — the word bank.
 *
 * GENERATED by tools/build-wordbank.js. Do not hand-edit: edit the stem lists
 * in that script and regenerate, so that every word stays dictionary-verified.
 *
 * Words are mined from an English dictionary by thematic stem rather than
 * written out by hand. Hand-writing a bank this size is how the previous one
 * ended up shipping "putri" and "outbrek" — truncations that looked like words
 * at a glance and were impossible to type from sight. Every entry below was
 * checked against the dictionary at build time.
 *
 * Buckets are by length, which is what the difficulty curve selects on.
 */
(function (global) {
  'use strict';
  var CT = (global.ContainmentBreach = global.ContainmentBreach || {});

  var BY_LENGTH = {};
`;
for (const L of lengths) {
  src += `\n  BY_LENGTH[${L}] = (\n${chunk(byLen[L], 10)}\n  ).split(' ');\n`;
}
src += `
  var ALL = [];
  for (var L in BY_LENGTH) ALL = ALL.concat(BY_LENGTH[L]);

  CT.WordBank = {
    byLength: BY_LENGTH,
    all: ALL,
    lengths: [${lengths.join(', ')}],
    count: ${all.length}
  };
})(typeof window !== 'undefined' ? window : globalThis);
`;

fs.writeFileSync(path.join(__dirname, '..', 'js', 'wordbank.js'), src);
console.log(`\nwrote js/wordbank.js (${all.length} words, ${(src.length / 1024).toFixed(0)} KB)`);
