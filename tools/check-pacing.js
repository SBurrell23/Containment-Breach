/* Headless pacing check: how long does a given WPM survive?
 * Usage: node tools/check-pacing.js */
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

const D = sandbox.CaveTyper.Difficulty;

function report(wpm, players) {
  const r = D.simulate(wpm, players);
  console.log(
    `${String(wpm).padStart(4)} WPM  x${players}   ->  encounter ${String(r.encounters).padStart(3)}  ` +
    `in ${r.minutes.toFixed(1).padStart(5)} min   bosses cleared: ${Math.floor(r.encounters / 10)}`
  );
  return r;
}

console.log('=== solo ===');
[30, 40, 60, 80, 100, 120, 150].forEach(w => report(w, 1));
console.log('=== co-op (both players at this WPM) ===');
[30, 40, 60, 80, 100, 120, 150].forEach(w => report(w, 2));

console.log('\n=== 100 WPM solo, encounter detail ===');
const r = D.simulate(100, 1);
r.log.filter((l, i) => i % 4 === 0 || l.boss || i >= r.log.length - 2).forEach(l => {
  console.log(
    `  e${String(l.index).padStart(3)}${l.boss ? ' BOSS' : '     '} req=${String(l.reqWpm).padStart(3)}wpm` +
    ` words=${String(l.words).padStart(3)} mon=${String(l.monsters).padStart(2)}` +
    ` nominal=${String(l.nominal).padStart(5)}s actual=${String(l.typing).padStart(5)}s` +
    ` dmg=${String(l.dmg).padStart(6)} hp=${String(l.hp).padStart(6)} t=${(l.t / 60).toFixed(1)}min`
  );
});
