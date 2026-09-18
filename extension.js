'use strict';
// vForth language support for VS Code - phase 1.
// All language knowledge lives in src/model.js and src/scanner.js; this file
// only adapts them to the VS Code API.

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
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
  return true;
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

async function pushToSD() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { vscode.window.showWarningMessage('vForth: no active file to push.'); return; }
  if (!model) { vscode.window.showWarningMessage('vForth root not found; set "vforth.root".'); return; }

  const doc = editor.document;
  if (doc.uri.scheme !== 'file') { vscode.window.showWarningMessage('vForth: active file is not a local file.'); return; }
  const rel = path.relative(model.root, doc.uri.fsPath).split(path.sep).join('/');
  if (rel.startsWith('..')) { vscode.window.showWarningMessage('vForth: active file is not under vforth.root.'); return; }

  const { sdImage, hdfmonkeyPath, destPrefix } = sdSettings();
  if (!sdImage) { vscode.window.showErrorMessage('vForth: set "vforth.sdImage" to the CSpect SD image (.img) path first.'); return; }
  const excludeTopDirs = config().get('sdExcludeTopDirs') || [];

  const top = rel.split('/')[0];
  if (excludeTopDirs.includes(top)) {
    const choice = await vscode.window.showWarningMessage(
      `vForth: "${top}/" is not normally deployed to the SD card (see vforth.sdExcludeTopDirs). Push "${rel}" anyway?`,
      { modal: true }, 'Push anyway');
    if (choice !== 'Push anyway') return;
  }

  if (doc.isDirty) await doc.save();

  const destPath = sdPath(destPrefix, rel);
  try {
    const { stdout } = await run(hdfmonkeyPath, ['put', sdImage, doc.uri.fsPath, destPath]);
    log(`push ${rel} -> ${destPath}: ok${stdout ? '\n' + stdout : ''}`);
    vscode.window.setStatusBarMessage(`vForth: pushed ${rel} to SD image`, 4000);
  } catch (err) {
    log(`push ${rel} -> ${destPath}: FAILED\n${err.stderr || err.message}`);
    vscode.window.showErrorMessage(`vForth: push failed (${err.message}). See "vForth: Show log".`);
  }
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

async function openScreen() {
  const { sdImage } = sdSettings();
  if (!sdImage) { vscode.window.showErrorMessage('vForth: set "vforth.sdImage" to the CSpect SD image (.img) path first.'); return; }
  const input = await vscode.window.showInputBox({
    prompt: 'vForth: Screen number to open',
    validateInput: v => /^\d+$/.test((v || '').trim()) ? null : 'Enter a non-negative integer'
  });
  if (input === undefined) return;
  const n = parseInt(input.trim(), 10);
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
  updateScreenDecoration(await vscode.window.showTextDocument(doc));
}

// ------------------------------------------------------------------ activation
async function activate(context) {
  output = vscode.window.createOutputChannel('vForth');
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
    vscode.commands.registerCommand('vforth.pushToSD', pushToSD),
    vscode.commands.registerCommand('vforth.openScreen', openScreen),
    vscode.workspace.registerFileSystemProvider(SCREEN_SCHEME, screenFS, { isCaseSensitive: true }),
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
