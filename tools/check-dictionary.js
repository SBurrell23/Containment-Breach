/* Validates every word in the bank against an English dictionary.
 * Usage: node tools/check-dictionary.js <path-to-words_alpha.txt> */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dictPath = process.argv[2];
if (!dictPath || !fs.existsSync(dictPath)) {
  console.error('Pass the path to a newline-separated word list.');
  process.exit(2);
}
const dict = new Set(fs.readFileSync(dictPath, 'utf8').split(/\r?\n/).map(w => w.trim().toLowerCase()).filter(Boolean));

/* Real words that dwyl's list happens not to carry. Each is here because it was
 * checked by hand, not to wave a failure through. */
const ALLOW = new Set(['lockdown']);
ALLOW.forEach(w => dict.add(w));

const sandbox = { console, Math, JSON, Date };
sandbox.window = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
const files = ['js/rng.js'];
if (fs.existsSync(path.join(__dirname, '..', 'js/wordbank.js'))) files.push('js/wordbank.js');
files.push('js/words.js');
for (const f of files) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f });

const CT = sandbox.CaveTyper;
const all = CT.Words.everyWord ? CT.Words.everyWord() : [];
if (!all.length) { console.error('CT.Words.everyWord() returned nothing.'); process.exit(2); }

const seen = new Set(), dupes = [], bad = [];
for (const w of all) {
  const k = w.toLowerCase();
  if (seen.has(k)) dupes.push(w); else seen.add(k);
  if (!dict.has(k)) bad.push(w);
}

const byLen = {};
for (const w of seen) { byLen[w.length] = (byLen[w.length] || 0) + 1; }

console.log(`total entries : ${all.length}`);
console.log(`unique        : ${seen.size}`);
console.log(`duplicates    : ${dupes.length}${dupes.length ? '  -> ' + dupes.slice(0, 20).join(' ') : ''}`);
console.log(`NOT IN DICT   : ${bad.length}`);
if (bad.length) {
  console.log('\n--- rejected ---');
  for (let i = 0; i < bad.length; i += 12) console.log('  ' + bad.slice(i, i + 12).join(' '));
}
console.log('\nlength histogram:');
Object.keys(byLen).map(Number).sort((a, b) => a - b).forEach(L => {
  console.log(`  ${String(L).padStart(2)}: ${String(byLen[L]).padStart(4)} ${'#'.repeat(Math.min(60, Math.ceil(byLen[L] / 8)))}`);
});
process.exit(bad.length ? 1 : 0);
