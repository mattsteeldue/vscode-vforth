'use strict';
// vForth language support for VS Code - phase 1.
// All language knowledge lives in src/model.js and src/scanner.js; this file
// only adapts them to the VS Code API.

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
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
    vscode.commands.registerCommand('vforth.showLog', () => output.show())
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
