/* Measures what CT.Words actually emits so difficulty.js's length model stays honest. */
const fs = require('fs'); const path = require('path'); const vm = require('vm');
const sandbox = { console, Math, JSON, Date };
sandbox.window = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of ['js/rng.js', 'js/wordbank.js', 'js/words.js', 'js/difficulty.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f });
}
const { Rng, Words, Difficulty: D } = sandbox.ContainmentBreach;

console.log('enc   diff  words  modeled  measured   sample words');
let worstErr = 0;
for (let e = 0; e <= 60; e += 5) {
  const diff = D.wordDifficulty(e);
  // Measure at the size an encounter actually asks for, averaged over many runs:
  // makeSet's dedup skews the mix badly when asked for an unrealistic count.
  const n = D.wordCount(e, 1);
  let total = 0, count = 0, sample = '';
  for (let trial = 0; trial < 300; trial++) {
    const set = Words.makeSet(new Rng(1234 + e * 977 + trial), n, diff, false);
    set.forEach(w => { total += w.length; count++; });
    if (trial === 0) sample = set.slice(0, 4).join(' ');
  }
  const avg = total / count;
  const modeled = D.avgWordChars(e) - 1;   // model adds 1 for the commit keystroke
  worstErr = Math.max(worstErr, Math.abs(avg - modeled));
  console.log(
    `${String(e).padStart(3)}  ${diff.toFixed(2)}   ${String(n).padStart(3)}   ` +
    `${modeled.toFixed(2).padStart(6)}   ${avg.toFixed(2).padStart(6)}    ${sample}`);
}
console.log('\nworst modeling error: ' + worstErr.toFixed(2) + ' chars');

console.log('\nboss words @ e29:', Words.makeSet(new Rng(9), 6, D.wordDifficulty(29), true).join(' '));
console.log('boss words @ e49:', Words.makeSet(new Rng(9), 6, D.wordDifficulty(49), true).join(' '));

// First-letter collisions inside a single encounter (auto-targeting wants none).
let collisions = 0, trials = 400;
for (let t = 0; t < trials; t++) {
  const set = Words.makeSet(new Rng(t * 31 + 7), 12, 0.4, false);
  const fl = {};
  set.forEach(w => { const c = w[0].toLowerCase(); fl[c] = (fl[c] || 0) + 1; });
  collisions += Object.keys(fl).filter(k => fl[k] > 1).length;
}
console.log(`\nfirst-letter collisions: ${(collisions / trials).toFixed(2)} per 12-word encounter`);
