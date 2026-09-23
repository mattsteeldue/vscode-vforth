'use strict';
// vForth workspace model.
//
// Built from a vForth root directory (the one holding src/, inc/, lib/,
// help/). Provides:
//   - the core vocabulary: active "RENAME old NEW" lines of src/F18e.f
//   - index 1, NEEDS targets: inc/*.f and lib/*.f by file name
//   - index 2, providers: every word defined inside inc/*.f and lib/*.f
//   - help lookup through MAP-FN, as HELP does
//   - per-document analysis: sequential availability of words, with
//     NEEDS / INCLUDE closure, diagnostics and local definitions
// inc/doc/, lib/doc/ and any other sub-directory are ignored on purpose.
// File name matching is case-insensitive everywhere (FAT semantics).
//
// Pure module: no dependency on the vscode API.

const fs = require('fs');
const path = require('path');
const { scan, isNumber, inferWords, newContext } = require('./scanner');

const CORE_SOURCE = path.join('src', 'F18e.f');
const EXTRA_CORE = ['\\'];     // defined with its final name, no RENAME

// MAP-FN: same table as NDOM/NCDM in F18e.f
const NDOM = ':?/*|\\<>"';
const NCDM = '_^%&$_{}~';
function mapFn(name) {
  let s = '';
  for (const c of name) {
    const i = NDOM.indexOf(c);
    s += i < 0 ? c : NCDM[i];
  }
  return s;
}

// Case-insensitive listing of the regular files of one directory.
class DirIndex {
  constructor(dir) {
    this.dir = dir;
    this.map = new Map();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { /* absent */ }
    for (const e of entries) if (e.isFile()) this.map.set(e.name.toLowerCase(), e.name);
  }
  find(name) {
    const n = this.map.get(name.toLowerCase());
    return n ? path.join(this.dir, n) : null;
  }
  files(ext) {
    return [...this.map.values()].filter(n => n.toLowerCase().endsWith(ext)).sort();
  }
}

// Case-insensitive resolution of a relative path (INCLUDE argument).
function resolveCI(root, rel) {
  let cur = root;
  for (const seg of rel.split(/[\\/]+/).filter(Boolean)) {
    if (seg === '.') continue;
    if (seg === '..') { cur = path.dirname(cur); continue; }
    let hit = null;
    try {
      const low = seg.toLowerCase();
      hit = fs.readdirSync(cur).find(n => n.toLowerCase() === low) || null;
    } catch (e) { return null; }
    if (!hit) return null;
    cur = path.join(cur, hit);
  }
  try { return fs.statSync(cur).isFile() ? cur : null; } catch (e) { return null; }
}

function readText(file) {
  try { return fs.readFileSync(file, 'latin1'); } catch (e) { return null; }
}

// Summary of one source file: definitions, NEEDS and INCLUDE arguments,
// and every word it references (a file that loads successfully makes all
// of them available, whatever mechanism defined them).
function summarize(file, text, ctx) {
  const info = { path: file, stem: path.basename(file).replace(/\.f$/i, ''),
                 defs: new Map(), needs: [], includes: [], words: new Set() };
  for (const t of scan(text, ctx)) {
    if (t.kind === 'word') info.words.add(t.text.toUpperCase());
    if (t.kind === 'defname') {
      const u = t.text.toUpperCase();
      if (!info.defs.has(u)) info.defs.set(u, t.line);
    } else if (t.kind === 'needs') info.needs.push(t.text);
    else if (t.kind === 'include') info.includes.push(t.text);
  }
  return info;
}

class Model {
  constructor(root) {
    this.root = root;
    this.fileCache = new Map();
    this.load();
  }

  load() {
    const root = this.root;
    this.coreFile = path.join(root, CORE_SOURCE);
    this.help = new DirIndex(path.join(root, 'help'));
    this.inc = new DirIndex(path.join(root, 'inc'));
    this.lib = new DirIndex(path.join(root, 'lib'));
    this.fileCache.clear();

    // core: RENAME table, pointing at the definition of the old name
    this.core = new Map();                       // NAME -> line in F18e.f
    const text = readText(this.coreFile);
    if (text !== null) {
      const defLine = new Map();
      for (const t of scan(text)) {
        if (t.kind === 'defname' && !defLine.has(t.text)) defLine.set(t.text, t.line);
      }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const m = /^RENAME\s+(\S+)\s+(\S+)/.exec(lines[i]);
        if (m) this.core.set(m[2].toUpperCase(), defLine.has(m[1]) ? defLine.get(m[1]) : i);
      }
      for (const w of EXTRA_CORE) if (defLine.has(w)) this.core.set(w, defLine.get(w));
    }

    // user defining and parsing words found in inc/ and lib/ (fixpoint)
    this.ctx = newContext();
    const libFiles = [];
    for (const idx of [this.inc, this.lib]) {
      for (const name of idx.files('.f')) {
        const t = readText(path.join(idx.dir, name));
        if (t !== null) libFiles.push(t);
      }
    }
    for (let pass = 0; pass < 3; pass++) {
      const size = () => this.ctx.definers.size + this.ctx.parsers.size + this.ctx.commenters.size;
      const before = size();
      for (const t of libFiles) inferWords(scan(t, this.ctx), this.ctx);
      if (size() === before) break;
    }

    // index 2: providers of every word defined in inc/ and lib/
    this.providers = new Map();                  // NAME -> [{info, line}]
    for (const idx of [this.inc, this.lib]) {
      for (const name of idx.files('.f')) {
        const info = this.fileInfo(path.join(idx.dir, name));
        if (!info) continue;
        for (const [u, line] of info.defs) {
          if (!this.providers.has(u)) this.providers.set(u, []);
          this.providers.get(u).push({ info, line });
        }
      }
    }
  }

  fileInfo(file) {
    if (this.fileCache.has(file)) return this.fileCache.get(file);
    const text = readText(file);
    const info = text === null ? null : summarize(file, text, this.ctx);
    this.fileCache.set(file, info);
    return info;
  }

  isCore(u) { return this.core.has(u); }

  // Index 1: what "NEEDS name" loads. NEEDS tries inc/ first and falls back
  // to lib/ only when the word is still undefined afterwards.
  // Returns null (unresolvable), [] (core word: no-op) or a list of infos.
  needsTargets(name) {
    const u = name.toUpperCase();
    if (this.core.has(u)) return [];
    const fname = mapFn(name) + '.f';
    const out = [];
    const inc = this.inc.find(fname);
    const incInfo = inc && this.fileInfo(inc);
    if (incInfo) out.push(incInfo);
    if (!incInfo || !incInfo.defs.has(u)) {
      const lib = this.lib.find(fname);
      const libInfo = lib && this.fileInfo(lib);
      if (libInfo) out.push(libInfo);
    }
    return out.length ? out : null;
  }

  // Best NEEDS argument that makes word `u` available, or null.
  // Preference: a file named after the word (inc/, then lib/), then a file
  // defining it among others (inc/, then lib/). For the latter the NEEDS
  // argument is the word, defined in that file, whose MAP-FN is the stem.
  suggestNeeds(u) {
    const provs = this.providers.get(u);
    if (!provs || !provs.length) return null;
    const inInc = p => path.dirname(p.info.path) === this.inc.dir;
    const direct = p => p.info.stem.toLowerCase() === mapFn(u).toLowerCase();
    const ordered = [
      ...provs.filter(p => direct(p) && inInc(p)),
      ...provs.filter(p => direct(p) && !inInc(p)),
      ...provs.filter(p => !direct(p) && inInc(p)),
      ...provs.filter(p => !direct(p) && !inInc(p))
    ];
    for (const p of ordered) {
      if (direct(p)) return { name: u, prov: p };
      for (const d of p.info.defs.keys()) {
        if (mapFn(d).toLowerCase() === p.info.stem.toLowerCase()) return { name: d, prov: p };
      }
    }
    return null;
  }

  // MAP-FN maps both ":" and "\" to "_", so they would share help/_.txt;
  // these two words alone have dedicated help files.
  helpFile(name) {
    const special = { ':': 'colon', '\\': 'bslash' }[name];
    return this.help.find((special || mapFn(name)) + '.txt');
  }

  helpText(name) {
    const f = this.helpFile(name);
    return f ? readText(f) : null;
  }

  rel(file) { return path.relative(this.root, file).split(path.sep).join('/'); }

  // Full analysis of one document.
  //   options.preloaded : NEEDS arguments assumed already executed
  //   options.diagnostics: false to skip word diagnostics
  analyze(text, docPath, options = {}) {
    const ctx = inferWords(scan(text, this.ctx), newContext(this.ctx));
    const tokens = scan(text, ctx);
    const avail = new Set();
    const loaded = new Set();
    const diags = [];
    const localDefs = new Map();                 // NAME -> [{line, start, end, definer}]
    const semantic = [];                         // {tok, type}

    const addFile = info => {
      if (!info || loaded.has(info.path)) return;
      loaded.add(info.path);
      for (const u of info.defs.keys()) avail.add(u);
      for (const u of info.words) avail.add(u);
      for (const n of info.needs) doNeeds(n);
      for (const inc of info.includes) {
        const f = resolveCI(this.root, inc);
        if (f) addFile(this.fileInfo(f));
      }
    };
    const doNeeds = name => {
      const t = this.needsTargets(name);
      if (t) for (const info of t) addFile(info);
      return t;
    };
    for (const n of options.preloaded || []) doNeeds(n);

    let prev = null;
    let base = 10;                               // tracked through HEX / DECIMAL
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.kind === 'defname') {
        const u = t.text.toUpperCase();
        if (!localDefs.has(u)) localDefs.set(u, []);
        localDefs.get(u).push({ line: t.line, start: t.start, end: t.end, local: !!t.local,
                                definer: prev ? prev.text.toUpperCase() : '' });
        avail.add(u);
      } else if (t.kind === 'needs') {
        if (doNeeds(t.text) === null) {
          diags.push({ severity: 'error', tok: t,
            message: `NEEDS ${t.text}: neither inc/${mapFn(t.text)}.f nor lib/${mapFn(t.text)}.f exists` });
        }
      } else if (t.kind === 'include') {
        const f = resolveCI(this.root, t.text);
        if (f) addFile(this.fileInfo(f));
        else diags.push({ severity: 'info', tok: t,
          message: `INCLUDE ${t.text}: not found under the vForth root; its definitions are not tracked` });
      } else if (t.kind === 'word') {
        const u = t.text.toUpperCase();
        if (u === 'HEX') base = 16;
        else if (u === 'DECIMAL') base = 10;
        else if (u === 'BINARY') base = 2;
        if (prev && prev.text.toUpperCase() === 'BASE' && u === '!') base = 10;
        if (u === ')' && !localDefs.has(u) && !this.core.has(u) && !avail.has(u)) {
          if (options.diagnostics !== false) diags.push(this.strayParen(tokens, i));
        } else if (localDefs.has(u)) {
          semantic.push({ tok: t, type: 'local' });
        } else if (this.core.has(u) || isNumber(u, base)) {
          // grammar handles it
        } else if (this.providers.has(u)) {
          semantic.push({ tok: t, type: 'library' });
          if (!avail.has(u) && options.diagnostics !== false) {
            const s = this.suggestNeeds(u);
            const where = s ? ` (${this.rel(s.prov.info.path)})` : '';
            diags.push({ severity: 'warning', tok: t, code: s ? s.name : undefined,
              message: s ? `${t.text} is not in the core: requires NEEDS ${s.name}${where}`
                         : `${t.text} is not in the core` });
          }
        }
      }
      if (t.kind !== 'comment' && t.kind !== 'string') prev = t;
    }

    // 7-bit ASCII check; Latin-1 (e.g. ß, $DF) is allowed inside comments,
    // matching text left behind by old editors (e.g. UltraEdit) on \ and ( ) lines.
    const commentRanges = new Map();              // line -> [[start, end], ...]
    for (const t of tokens) {
      if (t.kind !== 'comment') continue;
      if (!commentRanges.has(t.line)) commentRanges.set(t.line, []);
      commentRanges.get(t.line).push([t.start, t.end]);
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const ranges = commentRanges.get(i);
      const re = /[^\x00-\x7F]/g;
      let m;
      while ((m = re.exec(lines[i])) !== null) {
        if (ranges && ranges.some(([s, e]) => m.index >= s && m.index < e)) continue;
        diags.push({ severity: 'error',
          tok: { line: i, start: m.index, end: m.index + 1 },
          message: `Non-ASCII character 0x${m[0].charCodeAt(0).toString(16).toUpperCase()}: sources must be 7-bit ASCII` });
      }
    }
    return { tokens, diags, localDefs, semantic };
  }

  // A ')' that is not a word: the ( or .( before it already ended at an
  // earlier ')', e.g. ".( port $FE (keyboard) )". Right after a .( string
  // that has no '"', offer to turn it into a ." string closed by this ')'.
  strayParen(tokens, i) {
    const t = tokens[i];
    const d = { severity: 'error', tok: t,
      message: 'Syntax error: unmatched ")"; the ( or .( before it already ended at the first ")"' };
    const str = tokens[i - 1], dot = tokens[i - 2];
    if (str && dot && str.kind === 'string' && str.line === t.line && dot.line === t.line &&
        dot.kind === 'word' && dot.text === '.(' && !str.text.includes('"')) {
      d.fix = { title: 'Use ." ... " instead of .( ... )',
                edits: [{ line: dot.line, start: dot.start, end: dot.end, text: '."' },
                        { line: t.line, start: t.start, end: t.end, text: '"' }] };
    }
    return d;
  }

  // Definition sites of `name` seen from a document analysis, best first.
  // Local definitions shadow core; core always prevails over inc/ and lib/.
  definitions(name, analysis, docPath, line) {
    const u = name.toUpperCase();
    const out = [];
    const loc = analysis && analysis.localDefs.get(u);
    if (loc) {
      const before = loc.filter(d => d.line <= line);
      const d = before.length ? before[before.length - 1] : loc[0];
      out.push({ file: docPath, line: d.line, start: d.start, end: d.end, kind: 'local' });
      return out;
    }
    if (this.core.has(u)) {
      out.push({ file: this.coreFile, line: this.core.get(u), kind: 'core' });
      return out;
    }
    const s = this.suggestNeeds(u);
    const provs = this.providers.get(u) || [];
    if (s) out.push({ file: s.prov.info.path, line: s.prov.line, kind: 'library' });
    for (const p of provs) {
      if (!s || p !== s.prov) out.push({ file: p.info.path, line: p.line, kind: 'library' });
    }
    return out;
  }

  resolveInclude(rel) { return resolveCI(this.root, rel); }
}

module.exports = { Model, mapFn, resolveCI, CORE_SOURCE };
