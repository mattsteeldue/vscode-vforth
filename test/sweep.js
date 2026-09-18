'use strict';
// Analyze every .f file of demo/ tutorial/ inc/ lib/ and summarize diagnostics.
//   node test/sweep.js <vForth root> [max-lines]
const fs = require('fs');
const path = require('path');
const { Model } = require('../src/model');
const R = process.argv[2];
const max = +(process.argv[3] || 60);
const m = new Model(R);
let n = 0, files = 0;
const agg = new Map();
for (const d of ['demo', 'tutorial', 'inc', 'lib']) {
  for (const f of fs.readdirSync(path.join(R, d)).sort()) {
    const p = path.join(R, d, f);
    if (!/\.f$/i.test(f) || !fs.statSync(p).isFile()) continue;
    files++;
    for (const x of m.analyze(fs.readFileSync(p, 'latin1'), p).diags) {
      n++;
      const k = x.severity + ' ' + x.message.replace(/ \(.*\)/, '');
      if (!agg.has(k)) agg.set(k, []);
      agg.get(k).push(d + '/' + f + ':' + (x.tok.line + 1));
    }
  }
}
console.log(`${files} files, ${n} diagnostics`);
[...agg].sort((a, b) => b[1].length - a[1].length).slice(0, max)
  .forEach(([k, v]) => console.log(`${String(v.length).padStart(3)} ${k} | ${v.slice(0, 3).join(' ')}`));
