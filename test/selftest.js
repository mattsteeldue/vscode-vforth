'use strict';
// Standalone check of the model against a vForth tree (no VS Code needed).
//   node test/selftest.js <vForth root> [file.f ...]
const fs = require('fs');
const path = require('path');
const { Model, mapFn } = require('../src/model');

const root = process.argv[2];
if (!root) { console.error('usage: node test/selftest.js <vForth root> [file.f ...]'); process.exit(2); }
const m = new Model(root);
console.log(`core ${m.core.size}, providers ${m.providers.size}, help ${m.help.map.size}`);

const probe = (w) => {
  const s = m.suggestNeeds(w.toUpperCase());
  console.log(`${w.padEnd(12)} core=${m.isCore(w.toUpperCase())} help=${m.helpFile(w) ? path.basename(m.helpFile(w)) : '-'}` +
              ` needs=${s ? s.name + ' <' + m.rel(s.prov.info.path) + '>' : '-'}`);
};
['DUP', ':', '\\', '2OVER', 'KEY-SCAN', 'ROLL', 'VALUE', 'CMOVE>', 'DRAW-LINE', 'NO-SUCH'].forEach(probe);

let files = process.argv.slice(3);
for (const f of files) {
  const text = fs.readFileSync(f, 'latin1');
  const a = m.analyze(text, f);
  console.log(`\n${f}: ${a.diags.length} diagnostics, ${a.localDefs.size} local definitions`);
  for (const d of a.diags.slice(0, 15)) console.log(`  ${d.tok.line + 1}:${d.tok.start + 1} ${d.severity} ${d.message}`);
}
