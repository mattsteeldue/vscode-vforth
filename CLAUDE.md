# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A VS Code extension providing language support for **vForth** (a Forth system
for the ZX Spectrum Next): syntax highlighting, `NEEDS`/`INCLUDE` diagnostics,
hover help, go-to-definition, outline, and semantic colouring. Plain
JavaScript, no build step, no dependencies (`npm install` is not needed to
run or test the code — only `@vscode/vsce` is needed to package a `.vsix`).

The extension operates on a *separate* vForth source tree (the target
project being edited, e.g. `mattsteeldue/vforth-next`), not on files in this
repo. `vforth.root` (or auto-detection) points the extension at that tree's
`src/F18e.f`, `inc/`, `lib/`, `help/`.

## Commands

Regenerate the grammar whenever the core `RENAME` table in the target
project's `src/F18e.f` changes:

```
perl build/vforth-build.pl --root <vForth root>
perl build/vforth-build.pl --root <vForth root> --report help-report.txt
```

(`--root` defaults to three levels above `build/`, i.e. `../../..`, which
assumes this extension lives under `<vForth root>/tools/vscode-vforth` or
similar; pass it explicitly otherwise.)

Standalone checks against a real vForth tree, no VS Code needed:

```
node test/selftest.js <vForth root> [file.f ...]
node test/sweep.js <vForth root> [max-lines]
```

`selftest.js` sanity-checks core/provider/help lookups for a handful of known
words and, if given files, prints their diagnostics. `sweep.js` runs
`analyze()` over every `.f` file in `demo/`, `tutorial/`, `inc/`, `lib/` of
the target tree and aggregates diagnostics by message, most frequent first —
the fast way to check a scanner/model change didn't introduce regressions or
new false positives across a whole real codebase.

There is no test framework, no lint config, and no `npm` scripts section;
these two scripts are the entire test suite.

## Architecture

Three-layer split, deliberately decoupled from VS Code:

- **`src/scanner.js`** — pure tokenizer. Splits a line into whitespace-delimited
  tokens and classifies each as `word` / `defname` / `needs` / `include` /
  `arg` / `comment` / `string`, honouring parsing words (`CHAR`, `."`, `NEEDS`,
  user-inferred definers/parsers, `{ ... }` locals) so that comments, string
  literals and parsed arguments are never mistaken for word references.
  Scanning is strictly line-bounded because vForth itself reads source one
  line at a time. `inferWords()` does a fixpoint scan of colon-definition
  bodies to detect **user-defined defining words** (body uses `CREATE`,
  `<BUILDS`, or another defining word — e.g. `LAYER:`) and **user-defined
  parsing words** (body uses `CHAR`/`WORD`/`PARSE`/`PARSE-NAME`). No
  dependency on `vscode` or `fs`.

- **`src/model.js`** — builds and queries the whole-workspace picture:
  - the **core** vocabulary, from active `RENAME old NEW` lines at the end of
    the target's `src/F18e.f` (each name mapped to its definition line);
  - **index 1** (`needsTargets`): what `NEEDS name` loads — tries `inc/` by
    file name via `MAP-FN` (`: ? / * | \ < > "` → `_ ^ % & $ _ { } ~`,
    case-insensitive), falling back to `lib/` only if still undefined;
  - **index 2** (`providers`): every word defined anywhere under `inc/*.f`
    and `lib/*.f`, used to suggest the right `NEEDS` argument for a word not
    named after its file (`suggestNeeds`);
  - **`analyze(text, docPath, options)`**: per-document analysis — replays
    the file's `NEEDS`/`INCLUDE` closure sequentially (so availability
    reflects real load order, including files loaded transitively by loaded
    files), tracks local definitions, `HEX`/`DECIMAL`/`BINARY` base changes
    for number recognition, and emits diagnostics + semantic token spans.
  - Also pure (no `vscode` dependency) — this is what `test/selftest.js` and
    `test/sweep.js` exercise directly.

- **`extension.js`** — thin VS Code adapter only. Wires `Model` output into
  hover/definition/document-symbol/semantic-token providers and the
  diagnostics collection; owns the file-system watcher that reloads the
  model when the target's core, `inc/`, `lib/`, or `help/` change; debounces
  re-analysis on text edits (300 ms) and model reloads (1 s). Holds an
  `analyses` cache keyed by document URI + version so repeated provider
  calls for the same edit don't re-scan.

- **`build/vforth-build.pl`** — offline generator, not run by the extension
  at runtime. Reads the same `RENAME` table from the target's `src/F18e.f`
  and independently regenerates `syntaxes/vforth.tmLanguage.json` (TextMate
  grammar), plus an optional help-coverage report. Keep its `MAP-FN` table,
  `DEFINING`/`CONTROL` word lists in sync with `src/model.js` /
  `src/scanner.js` by hand if those change — they are intentionally
  duplicated (Perl vs. JS, build-time vs. run-time) rather than shared.

### Key invariants to preserve

- Core always prevails over `inc/`/`lib/` in lookups (`definitions()`,
  `suggestNeeds()`), and local definitions always shadow core.
- `MAP-FN` (file-name mapping for `NEEDS`) and `NEEDS`'s inc-then-lib
  fallback order are copied from vForth's own `NDOM`/`NCDM` semantics — do
  not "fix" this to look more conventional; it must match the real Forth
  system's behaviour byte for byte.
- Scanning must stay line-bounded (no multi-line lookahead) — this mirrors
  how the real vForth reader (`F_INCLUDE`/`F_GETLINE`) consumes source.
- `inc/doc/`, `lib/doc/`, `dev/`, `version/` are intentionally excluded from
  indexing/diagnostics; `src/`, `version/`, `inc/doc/`, `lib/doc/` get no
  word diagnostics even when opened directly (see `excluded()` in
  `extension.js`).
- File and path matching against the target tree is case-insensitive
  everywhere (`DirIndex`, `resolveCI`) to match FAT/Spectrum Next semantics.
