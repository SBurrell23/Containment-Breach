/* Trait-aware pacing check.
 *
 * js/difficulty.js has its own simulate(), but that one works from the tuning
 * constants alone: every specimen walks at the scheduled speed and bites for
 * the scheduled damage. Once specimens have traits — a spider that arrives in
 * half the time, a husk that arrives in twice, a goo that leaves two more
 * things behind when it dies — that model no longer describes what the planner
 * actually builds.
 *
 * So this one plans real encounters with CT.Difficulty.planEncounter and runs
 * the room forward on a fixed timestep: the player types at a constant rate at
 * whichever specimen is about to reach them, specimens bite on their own timers
 * once they arrive, and splitters put their offspring in the room at the moment
 * they die. Averaged over many seeds it says what the curve really costs.
 *
 * Usage: node tools/check-encounters.js [wpm] [players] [seeds]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sandbox = { console, Math, JSON, Date };
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

for (const f of ['js/rng.js', 'js/wordbank.js', 'js/words.js', 'js/difficulty.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f });
}

const CT = sandbox.CaveTyper;
const D = CT.Difficulty;
const T = D.TUNING;

/* The real registry needs THREE to build models. The planner only reads id,
 * tier and name, so scrape those out of the model files by hand. */
const TYPES = [];
for (const f of ['js/monsters/grunts.js', 'js/monsters/mids.js', 'js/monsters/bosses.js']) {
  const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  // Each model file uses its own local name for the table it registers into,
  // so match on the shape of an entry rather than on the table's name.
  const re = /\['([a-z_]+)'\]\s*=\s*\{\s*\n\s*id:\s*'([a-z_]+)',\s*\n\s*name:\s*'([^']*)',\s*\n\s*tier:\s*'(grunt|mid|boss)'/g;
  let m;
  while ((m = re.exec(src))) TYPES.push({ id: m[2], name: m[3], tier: m[4] });
}
if (!TYPES.length) { console.error('could not scrape any monster types'); process.exit(1); }

/* --flat strips every trait back to 1, which is what the chambers looked like
 * before specimens had personalities. It is the control: it separates "traits
 * made the game harder" from "this simulator is stricter than the one in
 * difficulty.js", which are very different problems. */
const FLAT = process.argv.includes('--flat');
if (FLAT) for (const k of Object.keys(D.TRAITS)) delete D.TRAITS[k];

const registry = {
  all: () => TYPES,
  byTier: (tier) => TYPES.filter(t => t.tier === tier),
  get: (id) => TYPES.find(t => t.id === id) || null
};

/* ---- one chamber, played out --------------------------------------------- */

const DT = 0.05;

function chars(words) {
  let c = 0;
  for (const w of words) c += w.length + 1;   // + the commit keystroke
  return c;
}

function liveFromSpec(spec, spawnedAt) {
  const travel = Math.max(0, spec.startDist - spec.meleeDist) / spec.speed;
  return {
    spec: spec,
    typeId: spec.typeId,
    spawnT: spawnedAt + spec.spawnDelay,
    arriveT: spawnedAt + spec.spawnDelay + travel,
    charsLeft: chars(spec.words),
    alive: true,
    // Monsters start their swing timer part-way through, same as in game.
    nextAttack: spawnedAt + spec.spawnDelay + travel + spec.attackInterval * 0.65
  };
}

/* Returns { seconds, damage, monsters, split } for one planned encounter. */
function playChamber(plan, cps, players, seed) {
  const rng = new CT.Rng(seed >>> 0);
  const live = plan.monsters.map(s => liveFromSpec(s, 0));
  let uid = plan.monsters.length + 64;
  let t = 0, dealt = 0, splits = 0;
  const budget = cps * players;

  while (live.some(m => m.alive) && t < 900) {
    t += DT;

    // The player works on whatever is about to reach them. That is both what a
    // competent player does and the assumption the arrival schedule is built
    // on, so it is the honest case to measure.
    let target = null;
    for (const m of live) {
      if (!m.alive || m.spawnT > t) continue;
      if (!target || m.arriveT < target.arriveT ||
          (m.arriveT === target.arriveT && m.charsLeft < target.charsLeft)) target = m;
    }
    if (target) {
      target.charsLeft -= budget * DT;
      if (target.charsLeft <= 0) {
        target.alive = false;
        if (target.spec.split) {
          // Died wherever it had walked to by now.
          const walked = Math.max(target.spec.meleeDist,
            target.spec.startDist - Math.max(0, t - target.spawnT) * target.spec.speed);
          const kids = D.splitSpecs(Object.assign({}, target.spec, { atDist: walked, x: target.spec.x }),
                                    uid, plan.seed, plan.difficulty);
          uid += kids.length;
          splits += kids.length;
          for (const k of kids) live.push(liveFromSpec(k, t));
        }
      }
    }

    for (const m of live) {
      if (!m.alive || t < m.arriveT) continue;
      while (m.nextAttack <= t) {
        dealt += m.spec.damage;
        m.nextAttack += m.spec.attackInterval;
      }
    }
  }
  rng.next();
  return { seconds: t, damage: dealt / players, monsters: live.length, split: splits };
}

/* ---- a whole run ---------------------------------------------------------- */

function playRun(wpm, players, runSeed) {
  const cps = (wpm / 60) * 5;
  let hp = T.playerMaxHp;
  let t = 0, index = 0;
  const log = [];

  while (index < 400 && hp > 0) {
    const plan = D.planEncounter(runSeed, index, players, registry);
    const r = playChamber(plan, cps, players, plan.seed);
    hp -= r.damage;
    t += r.seconds + plan.travelTime;
    log.push({
      index, boss: plan.boss, theme: plan.theme ? plan.theme.id : '',
      words: plan.totalWords, budget: plan.budgetWords,
      monsters: plan.monsters.length, split: r.split,
      nominal: plan.nominalTime, actual: r.seconds,
      dmg: r.damage, hp, t
    });
    if (hp <= 0) break;
    hp = Math.min(T.playerMaxHp, hp + D.healFor(index, plan.boss));
    index++;
  }
  return { encounters: index, minutes: t / 60, log };
}

/* ---- report --------------------------------------------------------------- */

const wpmArg = Number(process.argv[2] || 0);
const playersArg = Number(process.argv[3] || 0);
const seeds = Number(process.argv[4] || 12);

function avg(a) { return a.reduce((x, y) => x + y, 0) / a.length; }

function report(wpm, players) {
  const runs = [];
  for (let i = 0; i < seeds; i++) runs.push(playRun(wpm, players, (i * 2654435761 + 12345) >>> 0));
  const e = avg(runs.map(r => r.encounters));
  const m = avg(runs.map(r => r.minutes));
  const lo = Math.min(...runs.map(r => r.minutes));
  const hi = Math.max(...runs.map(r => r.minutes));
  console.log(
    `${String(wpm).padStart(4)} WPM  x${players}   ->  encounter ${e.toFixed(1).padStart(5)}  ` +
    `in ${m.toFixed(1).padStart(5)} min   (${lo.toFixed(1)}-${hi.toFixed(1)})`
  );
  return runs;
}

if (wpmArg) {
  const runs = report(wpmArg, playersArg || 1);
  console.log('\nchamber detail (first seed):');
  for (const l of runs[0].log) {
    console.log(
      `  e${String(l.index).padStart(3)}${l.boss ? ' BOSS' : '     '}` +
      ` ${(l.theme || '-').padEnd(9)} words=${String(l.words).padStart(3)}` +
      ` mon=${String(l.monsters).padStart(2)}${l.split ? '+' + l.split : '  '}` +
      ` nominal=${l.nominal.toFixed(1).padStart(5)}s actual=${l.actual.toFixed(1).padStart(5)}s` +
      ` dmg=${l.dmg.toFixed(1).padStart(5)} hp=${l.hp.toFixed(1).padStart(6)}` +
      ` t=${(l.t / 60).toFixed(1)}min`
    );
  }
} else {
  console.log(`=== solo (mean of ${seeds} seeds) ===`);
  [30, 40, 60, 80, 100, 120, 150].forEach(w => report(w, 1));
  console.log(`=== co-op, both players at this WPM ===`);
  [30, 40, 60, 80, 100, 120, 150].forEach(w => report(w, 2));

  // How often a chamber commits to a theme, and how the word budget lands.
  const counts = {};
  let chambers = 0, drift = [];
  for (let s = 0; s < 40; s++) {
    for (let i = 0; i < 45; i++) {
      const p = D.planEncounter((s * 7919 + 17) >>> 0, i, 1, registry);
      chambers++;
      counts[p.theme ? p.theme.id : '(none)'] = (counts[p.theme ? p.theme.id : '(none)'] || 0) + 1;
      drift.push(p.totalWords - p.budgetWords);
    }
  }
  console.log('\n=== chamber themes over ' + chambers + ' chambers ===');
  Object.keys(counts).sort((a, b) => counts[b] - counts[a]).forEach(k => {
    console.log(`  ${k.padEnd(9)} ${String(counts[k]).padStart(5)}  ${(100 * counts[k] / chambers).toFixed(1)}%`);
  });
  const worst = Math.max(...drift.map(Math.abs));
  console.log(`\nword-budget drift: mean ${avg(drift).toFixed(2)}, worst ${worst} ` +
              `(offspring are charged to the parent, so this should stay near zero)`);
}
