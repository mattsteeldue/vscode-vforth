'use strict';
// vForth language support for VS Code - phase 1.
// All language knowledge lives in src/model.js and src/scanner.js; this file
// only adapts them to the VS Code API.

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { Model, CORE_SOURCE } = require('./src/model');

const LANG = 'vforth';
const TOKEN_TYPES = ['vforthLibrary', 'vforthLocal'];
const LEGEND = new vscode.SemanticTokensLegend(TOKEN_TYPES, []);

let model = null;
let output = null;
const analyses = new Map();            // uri -> {version, analysis}
let diagnostics = null;
const semanticChanged = new vscode.EventEmitter();

function log(msg) { if (output) output.appendLine(msg); }

function config() { return vscode.workspace.getConfiguration('vforth'); }

// ------------------------------------------------------------------ root
async function findRoot() {
  const configured = (config().get('root') || '').trim();
  if (configured) {
    if (fs.existsSync(path.join(configured, CORE_SOURCE))) return configured;
    vscode.window.showWarningMessage(`vForth: ${CORE_SOURCE} not found under vforth.root (${configured}).`);
    return null;
  }
  for (const f of vscode.workspace.workspaceFolders || []) {
    for (const c of [f.uri.fsPath, path.join(f.uri.fsPath, 'tools', 'vForth')]) {
      if (fs.existsSync(path.join(c, CORE_SOURCE))) return c;
    }
  }
  const hits = await vscode.workspace.findFiles('**/src/F18e.f', '**/version/**', 5);
  if (hits.length) return path.dirname(path.dirname(hits[0].fsPath));
  return null;
}

async function loadModel() {
  const root = await findRoot();
  if (!root) {
    model = null;
    log('vForth root not found: set "vforth.root" to the directory holding src/F18e.f');
    return;
  }
  const t0 = Date.now();
  model = new Model(root);
  log(`vForth root: ${root}`);
  log(`  core ${model.core.size} words, ${model.providers.size} library words, ` +
      `${model.help.map.size} help pages, ${Date.now() - t0} ms`);
  log(`  user defining words: ${[...model.ctx.definers].join(' ')}`);
  log(`  user parsing words : ${[...model.ctx.parsers].join(' ')}`);
}

// ------------------------------------------------------------------ analysis
function excluded(doc) {
  if (!model) return true;
  const rel = path.relative(model.root, doc.uri.fsPath).split(path.sep).join('/');
  if (rel.startsWith('..')) return false;
  return /^(src|version|inc\/doc|lib\/doc)\//i.test(rel);
}

function analysisOf(doc) {
  if (!model || doc.languageId !== LANG) return null;
  const key = doc.uri.toString();
  const hit = analyses.get(key);
  if (hit && hit.version === doc.version) return hit.analysis;
  const analysis = model.analyze(doc.getText(), doc.uri.fsPath, {
    preloaded: config().get('preloaded') || [],
    diagnostics: !excluded(doc)
  });
  analyses.set(key, { version: doc.version, analysis });
  return analysis;
}

const SEVERITY = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information
};

function refreshDiagnostics(doc) {
  if (doc.languageId !== LANG) return;
  if (!model || !config().get('diagnostics.enable') || excluded(doc)) {
    diagnostics.delete(doc.uri);
    return;
  }
  const a = analysisOf(doc);
  diagnostics.set(doc.uri, a.diags.map(d => {
    const r = new vscode.Range(d.tok.line, d.tok.start, d.tok.line, d.tok.end);
    const diag = new vscode.Diagnostic(r, d.message, SEVERITY[d.severity]);
    diag.source = 'vForth';
    if (d.code) diag.code = d.code;
    return diag;
  }));
}

function refreshAll() {
  analyses.clear();
  for (const doc of vscode.workspace.textDocuments) refreshDiagnostics(doc);
  semanticChanged.fire();
}

function tokenAt(doc, pos) {
  const a = analysisOf(doc);
  if (!a) return null;
  for (const t of a.tokens) {
    if (t.line === pos.line && pos.character >= t.start && pos.character <= t.end) return { t, a };
  }
  return null;
}

// ------------------------------------------------------------------ providers
const hoverProvider = {
  provideHover(doc, pos) {
    const hit = tokenAt(doc, pos);
    if (!hit) return null;
    const { t, a } = hit;
    if (t.kind === 'comment' || t.kind === 'string' || t.kind === 'arg') return null;
    const md = new vscode.MarkdownString();
    const range = new vscode.Range(t.line, t.start, t.line, t.end);

    if (t.kind === 'needs') {
      const targets = model.needsTargets(t.text);
      if (targets === null) md.appendMarkdown(`**NEEDS ${t.text}**: no file found`);
      else if (!targets.length) md.appendMarkdown(`**${t.text.toUpperCase()}** is a core word: NEEDS does nothing`);
      else md.appendMarkdown(`**NEEDS ${t.text}** loads ` + targets.map(i => `\`${model.rel(i.path)}\``).join(', then '));
      appendHelp(md, t.text);
      return new vscode.Hover(md, range);
    }
    if (t.kind === 'include') {
      const f = model.resolveInclude(t.text);
      md.appendMarkdown(f ? `**INCLUDE** \`${model.rel(f)}\`` : `**INCLUDE ${t.text}**: not found under the vForth root`);
      return new vscode.Hover(md, range);
    }

    const u = t.text.toUpperCase();
    const defs = model.definitions(u, a, doc.uri.fsPath, t.line);
    if (defs.length) {
      const d = defs[0];
      if (d.kind === 'local') md.appendMarkdown(`**${u}** - defined in this file, line ${d.line + 1}`);
      else if (d.kind === 'core') md.appendMarkdown(`**${u}** - core (\`${model.rel(d.file)}\`:${d.line + 1})`);
      else {
        const s = model.suggestNeeds(u);
        md.appendMarkdown(`**${u}** - \`${model.rel(d.file)}\`:${d.line + 1}` +
                          (s ? `, available after \`NEEDS ${s.name}\`` : ''));
      }
    }
    const helped = appendHelp(md, t.text);
    if (!defs.length && !helped) return null;
    return new vscode.Hover(md, range);
  }
};

function appendHelp(md, name) {
  const text = model.helpText(name);
  if (!text) return false;
  md.appendMarkdown(`\n\n*help/${path.basename(model.helpFile(name))}*`);
  md.appendCodeblock(text.replace(/\s+$/, ''), 'text');
  appendSeeAlso(md, text);
  return true;
}

// "See also A, B, C." may wrap across lines; it ends at the first period
// followed by whitespace or end of text. Words with a known definition
// become links to vforth.gotoWord (a code block cannot hold links).
function appendSeeAlso(md, text) {
  const m = /See also\s+([\s\S]*?)(?:\.(?:\s|$)|$)/.exec(text);
  if (!m) return;
  const names = m[1].split(/,|\s+and\s+/).map(s => s.trim()).filter(Boolean);
  const parts = names.map(n => {
    if (!model.definitions(n, null, '', 0).length) return `\`${n}\``;
    const args = encodeURIComponent(JSON.stringify([n]));
    return `[\`${n}\`](command:vforth.gotoWord?${args} "Go to definition")`;
  });
  if (!parts.length) return;
  md.isTrusted = { enabledCommands: ['vforth.gotoWord'] };
  md.appendMarkdown(`\n\nSee also: ${parts.join(', ')}`);
}

async function gotoWord(name) {
  const d = model.definitions(String(name), null, '', 0)[0];
  if (!d) return;
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(d.file));
  const r = new vscode.Range(d.line, d.start || 0, d.line, d.end || 0);
  await vscode.window.showTextDocument(doc, { selection: r });
}

const definitionProvider = {
  provideDefinition(doc, pos) {
    const hit = tokenAt(doc, pos);
    if (!hit) return null;
    const { t, a } = hit;
    if (t.kind === 'needs') {
      const targets = model.needsTargets(t.text);
      if (targets && targets.length) {
        return targets.map(i => new vscode.Location(vscode.Uri.file(i.path), new vscode.Position(0, 0)));
      }
      // NEEDS of a core word: fall through to the core definition
    } else if (t.kind === 'include') {
      const f = model.resolveInclude(t.text);
      return f ? new vscode.Location(vscode.Uri.file(f), new vscode.Position(0, 0)) : null;
    } else if (t.kind !== 'word' && t.kind !== 'defname') {
      return null;
    }
    return model.definitions(t.text, a, doc.uri.fsPath, t.line).map(d =>
      new vscode.Location(vscode.Uri.file(d.file),
        new vscode.Range(d.line, d.start || 0, d.line, d.end || 0)));
  }
};

const SYMBOL_KIND = {
  CONSTANT: vscode.SymbolKind.Constant, '2CONSTANT': vscode.SymbolKind.Constant,
  VARIABLE: vscode.SymbolKind.Variable, '2VARIABLE': vscode.SymbolKind.Variable,
  VALUE: vscode.SymbolKind.Variable, '2VALUE': vscode.SymbolKind.Variable,
  USER: vscode.SymbolKind.Variable, CREATE: vscode.SymbolKind.Struct,
  CODE: vscode.SymbolKind.Method, VOCABULARY: vscode.SymbolKind.Namespace,
  MARKER: vscode.SymbolKind.Event
};

const symbolProvider = {
  provideDocumentSymbols(doc) {
    const a = analysisOf(doc);
    if (!a) return [];
    const out = [];
    for (const [u, list] of a.localDefs) {
      for (const d of list) {
        if (d.definer === '{' || d.local) continue;
        const r = new vscode.Range(d.line, d.start, d.line, d.end);
        out.push(new vscode.SymbolInformation(u, SYMBOL_KIND[d.definer] || vscode.SymbolKind.Function,
          d.definer, new vscode.Location(doc.uri, r)));
      }
    }
    return out.sort((x, y) => x.location.range.start.line - y.location.range.start.line);
  }
};

const semanticProvider = {
  onDidChangeSemanticTokens: semanticChanged.event,
  provideDocumentSemanticTokens(doc) {
    const a = analysisOf(doc);
    const b = new vscode.SemanticTokensBuilder(LEGEND);
    if (!a) return b.build();
    for (const s of a.semantic) {
      b.push(s.tok.line, s.tok.start, s.tok.end - s.tok.start,
             TOKEN_TYPES.indexOf(s.type === 'library' ? 'vforthLibrary' : 'vforthLocal'), 0);
    }
    return b.build();
  }
};

// ------------------------------------------------------------------ deploy
// Talks to the CSpect SD image with hdfmonkey, which writes directly into
// the HDF/FAT image without the exclusive lock an imdisk mount would need,
// and without needing CSpect's REMOUNT cycle either (unlike hdfm-gooey):
// reads and writes both work at any time, CSpect open or closed, and an
// open vForth session sees the change immediately - verified against the
// real image and a live CSpect.
function sdSettings() {
  return {
    sdImage: (config().get('sdImage') || '').trim(),
    hdfmonkeyPath: (config().get('hdfmonkeyPath') || 'hdfmonkey').trim(),
    destPrefix: (config().get('sdDestPrefix') || '').trim().replace(/^\/+|\/+$/g, '')
  };
}

function sdPath(destPrefix, rel) { return destPrefix ? `${destPrefix}/${rel}` : rel; }

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr })); else resolve({ stdout, stderr });
    });
  });
}

// Sends the active file to the SD image. Returns {rel, destPath} on success,
// null if nothing was sent (warning shown, cancelled, or failed).
async function sendActiveFile() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { vscode.window.showWarningMessage('vForth: no active file to push.'); return null; }
  if (!model) { vscode.window.showWarningMessage('vForth root not found; set "vforth.root".'); return null; }

  const doc = editor.document;
  if (doc.uri.scheme !== 'file') { vscode.window.showWarningMessage('vForth: active file is not a local file.'); return null; }
  const rel = path.relative(model.root, doc.uri.fsPath).split(path.sep).join('/');
  if (rel.startsWith('..')) { vscode.window.showWarningMessage('vForth: active file is not under vforth.root.'); return null; }

  const { sdImage, hdfmonkeyPath, destPrefix } = sdSettings();
  if (!sdImage) { vscode.window.showErrorMessage('vForth: set "vforth.sdImage" to the CSpect SD image (.img) path first.'); return null; }
  const excludeTopDirs = config().get('sdExcludeTopDirs') || [];

  const top = rel.split('/')[0];
  if (excludeTopDirs.includes(top)) {
    const choice = await vscode.window.showWarningMessage(
      `vForth: "${top}/" is not normally deployed to the SD card (see vforth.sdExcludeTopDirs). Push "${rel}" anyway?`,
      { modal: true }, 'Push anyway');
    if (choice !== 'Push anyway') return null;
  }

  if (doc.isDirty) await doc.save();

  const destPath = sdPath(destPrefix, rel);
  try {
    const { stdout } = await run(hdfmonkeyPath, ['put', sdImage, doc.uri.fsPath, destPath]);
    log(`push ${rel} -> ${destPath}: ok${stdout ? '\n' + stdout : ''}`);
    vscode.window.setStatusBarMessage(`vForth: pushed ${rel} to SD image`, 4000);
    return { rel, destPath };
  } catch (err) {
    log(`push ${rel} -> ${destPath}: FAILED\n${err.stderr || err.message}`);
    vscode.window.showErrorMessage(`vForth: push failed (${err.message}). See "vForth: Show log".`);
    return null;
  }
}

async function pushToSD() { await sendActiveFile(); }


// Inverse of pushToSD: fetches the SD image's copy of the active file (same
// relative path, same vforth.sdDestPrefix) and overwrites the local one.
async function pullFromSD() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { vscode.window.showWarningMessage('vForth: no active file to pick.'); return; }
  if (!model) { vscode.window.showWarningMessage('vForth root not found; set "vforth.root".'); return; }

  const doc = editor.document;
  if (doc.uri.scheme !== 'file') { vscode.window.showWarningMessage('vForth: active file is not a local file.'); return; }
  const rel = path.relative(model.root, doc.uri.fsPath).split(path.sep).join('/');
  if (rel.startsWith('..')) { vscode.window.showWarningMessage('vForth: active file is not under vforth.root.'); return; }

  const { sdImage, hdfmonkeyPath, destPrefix } = sdSettings();
  if (!sdImage) { vscode.window.showErrorMessage('vForth: set "vforth.sdImage" to the CSpect SD image (.img) path first.'); return; }

  const srcPath = sdPath(destPrefix, rel);
  const tmp = path.join(os.tmpdir(), 'vforth-pick-scratch.bin');
  try {
    try { fs.unlinkSync(tmp); } catch (e) { /* no previous scratch file */ }
    await run(hdfmonkeyPath, ['get', sdImage, srcPath, tmp]);
    const incoming = fs.readFileSync(tmp);
    if (!doc.isDirty && fs.readFileSync(doc.uri.fsPath).equals(incoming)) {
      vscode.window.setStatusBarMessage(`vForth: ${rel} is identical on the SD image`, 4000);
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `vForth: overwrite "${rel}" with the copy on the SD image?` + (doc.isDirty ? ' Unsaved changes will be lost.' : ''),
      { modal: true }, 'Overwrite');
    if (choice !== 'Overwrite') return;
    if (doc.isDirty) await vscode.commands.executeCommand('workbench.action.files.revert');
    fs.writeFileSync(doc.uri.fsPath, incoming);
    log(`pick ${srcPath} -> ${rel}: ok`);
    vscode.window.setStatusBarMessage(`vForth: picked ${rel} from SD image`, 4000);
  } catch (err) {
    log(`pick ${srcPath} -> ${rel}: FAILED\n${err.stderr || err.message}`);
    vscode.window.showErrorMessage(`vForth: pick failed (${err.message}). See "vForth: Show log".`);
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { /* already gone */ }
  }
}

// ------------------------------------------------------------------ run
// "Run file in CSpect": Send the active file, swap /nextzxos/autoexec.bas on
// the SD image for a short program, and start CSpect without waiting for it.
// The user's own autoexec.bas is first copied inside the image to
// /nextzxos/autoexec-vforth.bas, and the generated program puts it back as
// its very first action (before .vforth runs), so the swap lasts only the
// few seconds of boot and does not depend on how vForth exits (BYE) or on
// when, or whether, CSpect is closed. Several instances on different files
// are therefore possible. Same idea as the NextBASIC extension, but the
// restore is done by the emulated machine instead of by VS Code.
// Typical use: launch a single tutorial (or demo) file.
const AUTOEXEC = '/nextzxos/autoexec.bas';
const AUTOEXEC_SAVED = '/nextzxos/autoexec-vforth.bas';
let storageDir = null;

// NextBASIC number: digits, then the hidden 5-byte form the interpreter uses.
function bnum(n) { return `${n}\x0e\x00\x00${String.fromCharCode(n & 255, n >> 8)}\x00`; }

// +3DOS header (128 bytes) + BASIC lines 10, 20, ... (autostart line 10).
function makeAutoexec(texts) {
  const line = Buffer.concat(texts.map((text, i) => {
    const t = Buffer.from(text, 'latin1');
    return Buffer.concat([Buffer.from([0, (i + 1) * 10, (t.length + 1) & 255, (t.length + 1) >> 8]), t, Buffer.from([0x0d])]);
  }));
  const h = Buffer.alloc(128);
  h.write('PLUS3DOS', 0, 'latin1');
  h[8] = 0x1a; h[9] = 1; h[10] = 0;
  h.writeUInt32LE(128 + line.length, 11);
  h[15] = 0;                                   // BASIC program
  h.writeUInt16LE(line.length, 16);
  h.writeUInt16LE(10, 18);                     // autostart line
  h.writeUInt16LE(line.length, 20);            // offset to variables
  let sum = 0;
  for (let i = 0; i < 127; i++) sum += h[i];
  h[127] = sum & 255;
  return Buffer.concat([h, line]);
}

// Splits on spaces, keeping "double quoted" parts together.
function splitArgs(s) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

async function sdHas(sdImage, hdfmonkeyPath, file) {
  try {
    await run(hdfmonkeyPath, ['get', sdImage, file, path.join(storageDir, 'probe.tmp')]);
    return true;
  } catch (e) {
    return false;
  }
}

// Puts autoexec-vforth.bas back as autoexec.bas from the host side (used when
// CSpect could not be started, or by the "Restore autoexec.bas" command).
async function restoreAutoexec() {
  const { sdImage, hdfmonkeyPath } = sdSettings();
  if (!sdImage) { vscode.window.showErrorMessage('vForth: set "vforth.sdImage" to the CSpect SD image (.img) path first.'); return; }
  fs.mkdirSync(storageDir, { recursive: true });
  const tmp = path.join(storageDir, 'autoexec.restore');
  try {
    await run(hdfmonkeyPath, ['get', sdImage, AUTOEXEC_SAVED, tmp]);
  } catch (e) {
    vscode.window.showInformationMessage(`vForth: nothing to restore (${AUTOEXEC_SAVED} not found).`);
    return;
  }
  try {
    await run(hdfmonkeyPath, ['put', sdImage, tmp, AUTOEXEC]);
    await run(hdfmonkeyPath, ['rm', sdImage, AUTOEXEC_SAVED]);
    log('autoexec.bas restored');
    vscode.window.setStatusBarMessage('vForth: autoexec.bas restored', 4000);
  } catch (err) {
    log(`restore autoexec.bas: FAILED\n${err.stderr || err.message}`);
    vscode.window.showErrorMessage(`vForth: could not restore autoexec.bas (${err.message}). See "vForth: Show log".`);
  }
}

async function runInCSpect() {
  const { sdImage, hdfmonkeyPath, destPrefix } = sdSettings();
  const cspectPath = (config().get('cspectPath') || '').trim();
  if (!sdImage) { vscode.window.showErrorMessage('vForth: set "vforth.sdImage" to the CSpect SD image (.img) path first.'); return; }
  if (!cspectPath) { vscode.window.showErrorMessage('vForth: set "vforth.cspectPath" to CSpect.exe first.'); return; }

  const sent = await sendActiveFile();
  if (!sent) return;

  fs.mkdirSync(storageDir, { recursive: true });
  const orig = path.join(storageDir, 'autoexec.orig');
  const gen = path.join(storageDir, 'autoexec.gen');
  try {
    // A leftover autoexec-vforth.bas (an earlier run that did not get to restore)
    // is the real original: keep it, never back up our own generated file.
    let hadOriginal = await sdHas(sdImage, hdfmonkeyPath, AUTOEXEC_SAVED);
    if (!hadOriginal && await sdHas(sdImage, hdfmonkeyPath, AUTOEXEC)) {
      await run(hdfmonkeyPath, ['get', sdImage, AUTOEXEC, orig]);
      await run(hdfmonkeyPath, ['put', sdImage, orig, AUTOEXEC_SAVED]);
      hadOriginal = true;
    }
    // vForth opens !Blocks-64.bin, inc/, lib/ and the file itself relative to the
    // current directory, so go to the project folder first and pass a relative path.
    const lines = [
      `\x9c${bnum(1)},${bnum(2)}:\xda${bnum(0)}:\xeaBLACK`,   // LAYER 1,2 : PAPER 0 : REM BLACK
      hadOriginal ? `.cp --force ${AUTOEXEC_SAVED} ${AUTOEXEC}` : `.rm ${AUTOEXEC}`
    ];
    if (destPrefix) lines.push(`.cd /${destPrefix}`);
    lines.push(`.vforth ${sent.rel}`);
    lines.push('\xe2');                              // STOP (token): experiment, BYE hangs CSpect
    fs.writeFileSync(gen, makeAutoexec(lines));
    await run(hdfmonkeyPath, ['put', sdImage, gen, AUTOEXEC]);
  } catch (err) {
    log(`run: autoexec swap FAILED\n${err.stderr || err.message}`);
    vscode.window.showErrorMessage(`vForth: could not prepare autoexec.bas (${err.message}). See "vForth: Show log".`);
    return;
  }

  const args = splitArgs(config().get('cspectArgs') || '');
  if (!args.some(a => /^-mmc=/i.test(a))) args.push(`-mmc=${sdImage}`);
  log(`run: ${cspectPath} ${args.join(' ')}`);
  const child = spawn(cspectPath, args, { cwd: path.dirname(cspectPath), stdio: 'ignore', detached: true });
  child.on('error', async err => {
    log(`run: CSpect FAILED to start: ${err.message}`);
    vscode.window.showErrorMessage(`vForth: could not start CSpect (${err.message}).`);
    await restoreAutoexec();
  });
  child.unref();
  vscode.window.setStatusBarMessage(`vForth: running ${sent.rel} in CSpect`, 4000);
}

// ------------------------------------------------------------------ screens
// A Screen (1024 bytes = 16 lines x 64 chars, 2 Blocks) inside !Blocks-64.bin
// opened as an ordinary VS Code text document, backed by a virtual
// FileSystemProvider (scheme vforth-screen). Reads/writes the whole 16 MB
// block store through hdfmonkey each time (~0.3 s round trip measured
// against the real image, with CSpect running) since hdfmonkey has no
// byte-range get/put - there is no faster path available.
const SCREEN_SCHEME = 'vforth-screen';
const BLOCKS_FILE = '!Blocks-64.bin';
const SCREEN_LINES = 16;
const SCREEN_COLS = 64;
const screenFSEmitter = new vscode.EventEmitter();

function screenNumberOf(uri) {
  const m = /(\d+)/.exec(uri.path);
  if (!m) throw vscode.FileSystemError.FileNotFound(uri);
  return parseInt(m[1], 10);
}

function decodeScreen(buf) {
  const lines = [];
  for (let i = 0; i < SCREEN_LINES; i++) {
    let line = '';
    for (let c = 0; c < SCREEN_COLS; c++) line += String.fromCharCode(buf[i * SCREEN_COLS + c]);
    lines.push(line.replace(/ +$/, ''));
  }
  return lines.join('\n');
}

// Throws with a message naming the offending line/column on any violation
// (line count, line length, non-ASCII, NUL) instead of saving silently
// truncated or corrupted content.
function encodeScreen(text) {
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (lines.length > SCREEN_LINES) throw new Error(`vForth Screen: has ${SCREEN_LINES} lines max, got ${lines.length}.`);
  const buf = Buffer.alloc(SCREEN_LINES * SCREEN_COLS, 0x20);
  lines.forEach((line, i) => {
    if (line.length > SCREEN_COLS) throw new Error(`vForth Screen: line ${i + 1} is ${line.length} chars, max ${SCREEN_COLS}.`);
    for (let c = 0; c < line.length; c++) {
      const code = line.charCodeAt(c);
      if (code === 0) throw new Error(`vForth Screen: line ${i + 1} col ${c + 1} is a NUL byte (silently aborts LOAD).`);
      if (code > 127) throw new Error(`vForth Screen: line ${i + 1} col ${c + 1} is not 7-bit ASCII.`);
      buf[i * SCREEN_COLS + c] = code;
    }
  });
  return buf;
}

async function fetchBlocks() {
  const { sdImage, hdfmonkeyPath, destPrefix } = sdSettings();
  if (!sdImage) throw new Error('vForth: set "vforth.sdImage" first.');
  const tmp = path.join(os.tmpdir(), 'vforth-blocks-scratch.bin');
  await run(hdfmonkeyPath, ['get', sdImage, sdPath(destPrefix, BLOCKS_FILE), tmp]);
  return tmp;
}

const screenFS = {
  onDidChangeFile: screenFSEmitter.event,
  watch() { return new vscode.Disposable(() => {}); },
  stat() { return { type: vscode.FileType.File, ctime: 0, mtime: Date.now(), size: SCREEN_LINES * SCREEN_COLS }; },
  readDirectory() { return []; },
  createDirectory() {},
  async readFile(uri) {
    const n = screenNumberOf(uri);
    const tmp = await fetchBlocks();
    const buf = fs.readFileSync(tmp);
    const offset = (2 * n - 1) * 512;
    if (offset < 0 || offset + SCREEN_LINES * SCREEN_COLS > buf.length) throw vscode.FileSystemError.FileNotFound(uri);
    return Buffer.from(decodeScreen(buf.subarray(offset, offset + SCREEN_LINES * SCREEN_COLS)), 'utf8');
  },
  async writeFile(uri, content) {
    const n = screenNumberOf(uri);
    const patch = encodeScreen(Buffer.from(content).toString('utf8'));   // throws on validation failure
    const { sdImage, hdfmonkeyPath, destPrefix } = sdSettings();
    const tmp = await fetchBlocks();
    const buf = fs.readFileSync(tmp);
    patch.copy(buf, (2 * n - 1) * 512);
    fs.writeFileSync(tmp, buf);
    await run(hdfmonkeyPath, ['put', sdImage, tmp, sdPath(destPrefix, BLOCKS_FILE)]);
    log(`Screen ${n}: saved to SD image.`);
    screenFSEmitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  },
  delete() { throw vscode.FileSystemError.NoPermissions('vForth Screens cannot be deleted here.'); },
  rename() { throw vscode.FileSystemError.NoPermissions('vForth Screens cannot be renamed.'); }
};

// Bottom border under the last line, marking the 16-line boundary (a
// vertical ruler at column 64 comes for free from configurationDefaults).
const screenBottomBorder = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  borderStyle: 'solid',
  borderWidth: '0 0 2px 0',
  borderColor: new vscode.ThemeColor('editorRuler.foreground')
});

function updateScreenDecoration(editor) {
  if (!editor || editor.document.uri.scheme !== SCREEN_SCHEME) return;
  const last = Math.min(SCREEN_LINES - 1, editor.document.lineCount - 1);
  if (last < 0) return;
  editor.setDecorations(screenBottomBorder, [editor.document.lineAt(last).range]);
}

// ------------------------------------------------------------------ blocks (raw hex)
// A Block (512 bytes, half a Screen) from !Blocks-64.bin, opened as raw
// bytes through the same hdfmonkey get/put round trip as Screens, but with
// no text encode/decode or validation - meant for non-text blocks
// (graphics, PERSISTENCE snapshots, the message table) that the Screen
// text editor cannot touch (it rejects non-ASCII bytes on save). Editing
// itself is delegated to the Hex Editor extension (ms-vscode.hexeditor),
// not a custom hex UI, the same way Screens reuse the native text editor.
const BLOCK_SCHEME = 'vforth-block';
const BLOCK_SIZE = 512;
const HEX_EDITOR_EXT = 'ms-vscode.hexeditor';
const blockFSEmitter = new vscode.EventEmitter();

function blockNumberOf(uri) {
  const m = /(\d+)/.exec(uri.path);
  if (!m) throw vscode.FileSystemError.FileNotFound(uri);
  return parseInt(m[1], 10);
}

function blockOffset(b) { return (b - 1) * BLOCK_SIZE; }

const blockFS = {
  onDidChangeFile: blockFSEmitter.event,
  watch() { return new vscode.Disposable(() => {}); },
  stat() { return { type: vscode.FileType.File, ctime: 0, mtime: Date.now(), size: BLOCK_SIZE }; },
  readDirectory() { return []; },
  createDirectory() {},
  async readFile(uri) {
    const b = blockNumberOf(uri);
    const offset = blockOffset(b);
    const tmp = await fetchBlocks();
    const buf = fs.readFileSync(tmp);
    if (offset < 0 || offset + BLOCK_SIZE > buf.length) throw vscode.FileSystemError.FileNotFound(uri);
    return new Uint8Array(buf.subarray(offset, offset + BLOCK_SIZE));
  },
  async writeFile(uri, content) {
    const b = blockNumberOf(uri);
    const offset = blockOffset(b);
    if (content.length !== BLOCK_SIZE) {
      throw new Error(`vForth Block: must stay exactly ${BLOCK_SIZE} bytes (got ${content.length}) - the file size on the image must never change.`);
    }
    const { sdImage, hdfmonkeyPath, destPrefix } = sdSettings();
    const tmp = await fetchBlocks();
    const buf = fs.readFileSync(tmp);
    Buffer.from(content).copy(buf, offset);
    fs.writeFileSync(tmp, buf);
    await run(hdfmonkeyPath, ['put', sdImage, tmp, sdPath(destPrefix, BLOCKS_FILE)]);
    log(`Block ${b}: saved to SD image.`);
    blockFSEmitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  },
  delete() { throw vscode.FileSystemError.NoPermissions('vForth Blocks cannot be deleted here.'); },
  rename() { throw vscode.FileSystemError.NoPermissions('vForth Blocks cannot be renamed.'); }
};

// Finds the vforth-screen/vforth-block URI behind whichever kind of editor
// is active: activeTextEditor covers Screens (plain text documents), the
// active tab's input covers Blocks (a custom editor - Hex Editor - has no
// TextEditor at all).
function activeUriByScheme(scheme) {
  const ed = vscode.window.activeTextEditor;
  if (ed && ed.document.uri.scheme === scheme) return ed.document.uri;
  const tab = vscode.window.tabGroups.activeTabGroup && vscode.window.tabGroups.activeTabGroup.activeTab;
  const input = tab && tab.input;
  if (input && input.uri && input.uri.scheme === scheme) return input.uri;
  return null;
}

async function closeUri(uri) {
  const key = uri.toString();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input && tab.input.uri && tab.input.uri.toString() === key) {
        await vscode.window.tabGroups.close(tab);
        return;
      }
    }
  }
}

async function openBlock(explicitB, replaceUri) {
  const { sdImage } = sdSettings();
  if (!sdImage) { vscode.window.showErrorMessage('vForth: set "vforth.sdImage" to the CSpect SD image (.img) path first.'); return; }
  if (!vscode.extensions.getExtension(HEX_EDITOR_EXT)) {
    const choice = await vscode.window.showErrorMessage(
      `vForth: editing a Block in hex needs the "Hex Editor" extension (${HEX_EDITOR_EXT}), which is not installed.`,
      'Install');
    if (choice === 'Install') {
      await vscode.commands.executeCommand('workbench.extensions.installExtension', HEX_EDITOR_EXT);
      vscode.window.showInformationMessage('vForth: Hex Editor installed - run "vForth: Open Block #" again.');
    }
    return;
  }
  let b = explicitB;
  if (b === undefined) {
    const input = await vscode.window.showInputBox({
      prompt: 'vForth: Block number to open (hex)',
      validateInput: v => /^\d+$/.test((v || '').trim()) ? null : 'Enter a non-negative integer'
    });
    if (input === undefined) return;
    b = parseInt(input.trim(), 10);
  }
  if (b < 1) { vscode.window.showWarningMessage('vForth: Block 0 is not stored.'); return; }
  const uri = vscode.Uri.from({ scheme: BLOCK_SCHEME, path: `/Block ${b}.bin` });
  // Close the old tab BEFORE opening the new one, and last one opened is
  // the new Block: closing after opening (as done for Screens, where it
  // works fine) left the Hex Editor webview without keyboard focus after
  // stepping, needing a manual click before Ctrl+Shift+F7/F8 worked again.
  if (replaceUri) await closeUri(replaceUri);
  try {
    await vscode.commands.executeCommand('vscode.openWith', uri, 'hexEditor.hexedit', { preserveFocus: false, preview: false });
  } catch (err) {
    vscode.window.showErrorMessage(`vForth: could not open Block ${b} (${err.message}).`);
    log(`open Block ${b}: FAILED\n${err.stderr || err.message}`);
  }
}

async function stepBlock(delta) {
  const uri = activeUriByScheme(BLOCK_SCHEME);
  if (!uri) { vscode.window.showWarningMessage('vForth: no Block editor is active.'); return; }
  await openBlock(blockNumberOf(uri) + delta, uri);
}

async function openScreen(explicitN, replaceUri) {
  const { sdImage } = sdSettings();
  if (!sdImage) { vscode.window.showErrorMessage('vForth: set "vforth.sdImage" to the CSpect SD image (.img) path first.'); return; }
  let n = explicitN;
  if (n === undefined) {
    const input = await vscode.window.showInputBox({
      prompt: 'vForth: Screen number to open',
      validateInput: v => /^\d+$/.test((v || '').trim()) ? null : 'Enter a non-negative integer'
    });
    if (input === undefined) return;
    n = parseInt(input.trim(), 10);
  }
  const uri = vscode.Uri.from({ scheme: SCREEN_SCHEME, path: `/Screen ${n}.f` });
  let doc;
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch (err) {
    vscode.window.showErrorMessage(`vForth: could not open Screen ${n} (${err.message}). See "vForth: Show log".`);
    log(`open Screen ${n}: FAILED\n${err.stderr || err.message}`);
    return;
  }
  await vscode.languages.setTextDocumentLanguage(doc, 'vforth-screen');
  updateScreenDecoration(await vscode.window.showTextDocument(doc, { preview: false }));
  if (replaceUri) await closeUri(replaceUri);
}

async function stepScreen(delta) {
  const uri = activeUriByScheme(SCREEN_SCHEME);
  if (!uri) { vscode.window.showWarningMessage('vForth: no Screen editor is active.'); return; }
  await openScreen(screenNumberOf(uri) + delta, uri);
}

// vForth: Next/Previous Screen or Block - acts on whichever of the two is
// the active editor (a Screen is a text editor, a Block a custom editor -
// Hex Editor - so both are checked; see activeUriByScheme).
async function stepScreenOrBlock(delta) {
  if (activeUriByScheme(SCREEN_SCHEME)) return stepScreen(delta);
  if (activeUriByScheme(BLOCK_SCHEME)) return stepBlock(delta);
  vscode.window.showWarningMessage('vForth: no Screen or Block editor is active.');
}

// ------------------------------------------------------------------ activation
async function activate(context) {
  output = vscode.window.createOutputChannel('vForth');
  storageDir = context.globalStorageUri.fsPath;
  diagnostics = vscode.languages.createDiagnosticCollection('vforth');
  context.subscriptions.push(output, diagnostics, semanticChanged);

  await loadModel();

  const sel = { language: LANG };
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(sel, hoverProvider),
    vscode.languages.registerDefinitionProvider(sel, definitionProvider),
    vscode.languages.registerDocumentSymbolProvider(sel, symbolProvider),
    vscode.languages.registerDocumentSemanticTokensProvider(sel, semanticProvider, LEGEND)
  );

  let timer = null;
  const later = (fn, ms) => { clearTimeout(timer); timer = setTimeout(fn, ms); };
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(refreshDiagnostics),
    vscode.workspace.onDidChangeTextDocument(e => later(() => refreshDiagnostics(e.document), 300)),
    vscode.workspace.onDidCloseTextDocument(doc => { diagnostics.delete(doc.uri); analyses.delete(doc.uri.toString()); }),
    vscode.workspace.onDidChangeConfiguration(async e => {
      if (e.affectsConfiguration('vforth')) { await loadModel(); setupWatcher(context); refreshAll(); }
    }),
    vscode.commands.registerCommand('vforth.reloadIndex', async () => {
      await loadModel(); refreshAll();
      vscode.window.showInformationMessage(model ? `vForth index reloaded (${model.root})` : 'vForth root not found');
    }),
    vscode.commands.registerCommand('vforth.showLog', () => output.show()),
    vscode.commands.registerCommand('vforth.gotoWord', gotoWord),
    vscode.commands.registerCommand('vforth.pushToSD', pushToSD),
    vscode.commands.registerCommand('vforth.pullFromSD', pullFromSD),
    vscode.commands.registerCommand('vforth.runInCSpect', runInCSpect),
    vscode.commands.registerCommand('vforth.restoreAutoexec', restoreAutoexec),
    vscode.commands.registerCommand('vforth.openScreen', () => openScreen()),
    vscode.commands.registerCommand('vforth.openBlock', () => openBlock()),
    vscode.commands.registerCommand('vforth.nextScreenOrBlock', () => stepScreenOrBlock(1)),
    vscode.commands.registerCommand('vforth.previousScreenOrBlock', () => stepScreenOrBlock(-1)),
    vscode.workspace.registerFileSystemProvider(SCREEN_SCHEME, screenFS, { isCaseSensitive: true }),
    vscode.workspace.registerFileSystemProvider(BLOCK_SCHEME, blockFS, { isCaseSensitive: true }),
    screenBottomBorder,
    vscode.window.onDidChangeActiveTextEditor(updateScreenDecoration),
    vscode.workspace.onDidChangeTextDocument(e => {
      const ed = vscode.window.visibleTextEditors.find(x => x.document === e.document);
      if (ed) updateScreenDecoration(ed);
    })
  );
  setupWatcher(context);
  refreshAll();
}

// Reload the index when the core, the libraries or the help pages change.
let watcher = null;
function setupWatcher(context) {
  if (watcher) { watcher.dispose(); watcher = null; }
  if (!model) return;
  watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(model.root, '{src/F18e.f,inc/*.[fF],lib/*.[fF],help/*}'));
  let t = null;
  const reload = () => { clearTimeout(t); t = setTimeout(async () => { await loadModel(); refreshAll(); }, 1000); };
  watcher.onDidChange(reload); watcher.onDidCreate(reload); watcher.onDidDelete(reload);
  context.subscriptions.push(watcher);
}

function deactivate() {}

module.exports = { activate, deactivate };
