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
  calls for the same edit don't re-scan. Also owns `vforth.pushToSD`
  (phase 2): a manual, single-file "push to the CSpect SD image" command
  that shells out to `hdfmonkey put` (`vforth.hdfmonkeyPath`, default on
  `PATH`) against `vforth.sdImage`. `hdfmonkey` writes into the HDF/FAT
  image directly, unlike mounting it with imdisk, so it needs no exclusive
  lock and works while CSpect is running — that is the reason this exists
  instead of driving the project's own `util/sync2sd.ps1` (which requires
  CSpect and MAME both closed) for the single-file edit/test loop. No
  `REMOUNT` cycle is needed either (unlike `hdfm-gooey`): reads and writes
  both work at any time, CSpect open or closed, and a running vForth
  session sees a pushed file immediately — verified against the real image
  and a live CSpect (a REMOUNT requirement was first suspected, then
  disproved by controlled negative/positive tests, see project memory).
  Also owns `vforth.runInCSpect` (phase 4): `sendActiveFile()` (shared with
  `pushToSD`), then copies the user's `/nextzxos/autoexec.bas` to
  `/nextzxos/autoexec-vforth.bas` inside the image (kept if already there:
  a leftover is the real original, never back up our own file) and replaces
  `autoexec.bas` with a generated program (`makeAutoexec()`: +3DOS header,
  format copied from the user's real file; tokens `LAYER`=0x9C, `PAPER`=0xDA,
  `STOP`=0xE2, numbers followed by the hidden 5-byte form): colours, `.cp --force`
  original back FIRST, `.cd /<destPrefix>` (vForth opens `!Blocks-64.bin`,
  `inc`, `lib` relative to the cwd), `.vforth <rel path>`, `STOP`. It then
  spawns `CSpect.exe` detached without waiting (`vforth.cspectPath`/
  `cspectArgs`; not a `.lnk`/`.bat`). The restore runs in the emulated
  machine, not on process exit, because vForth's BYE can hang CSpect and
  several instances must be possible. `vforth.restoreAutoexec` is the manual
  fallback. Typical use: launching a single tutorial.
  Also owns `vforth.openScreen` (phase 3): opens a Screen (1024 bytes = 16
  lines x 64 cols, 2 Blocks) from `!Blocks-64.bin` as an ordinary text
  document, through a virtual `FileSystemProvider` on the `vforth-screen`
  scheme (not the `vforth` language — deliberately kept separate so the
  language-intelligence pipeline, which assumes a real path under
  `vforth.root`, never runs against it). `readFile`/`writeFile` round-trip
  the whole 16 MB block store through `hdfmonkey get`/`put` each time
  (`(2*screen-1)*512` offset, matching the offset formula in the target
  project's own docs) since `hdfmonkey` has no byte-range I/O; save-time
  validation (line count, line length, 7-bit ASCII, no NUL) throws with a
  clear line/column message rather than writing corrupted or truncated
  content. `editor.rulers: [64]` (via `configurationDefaults["[vforth-screen]"]`)
  and a `screenBottomBorder` decoration under line 16 mark the Screen's
  bounds. `vforth.openBlock` is the same idea at Block granularity (512
  bytes, `(block-1)*512` offset) but raw, with no text layer or
  validation beyond the byte count staying exactly 512 — for non-source
  blocks (graphics, `PERSISTENCE` snapshots, the message table) the Screen
  editor cannot open. It delegates the actual editing UI to the Microsoft
  Hex Editor extension (`ms-vscode.hexeditor`, offered for install if
  missing) via `vscode.openWith`, rather than building a hex UI in this
  extension — same reasoning as reusing the native text editor for
  Screens instead of a custom grid. `vforth.nextScreenOrBlock` /
  `vforth.previousScreenOrBlock` (`Ctrl+Shift+F8` / `Ctrl+Shift+F7`,
  scoped via a `resourceScheme` `when` clause) step to the adjacent Screen
  or Block and close the old tab, via `activeUriByScheme()` — checks
  `activeTextEditor` first (Screens), then the active tab's `input.uri`
  (Blocks: a custom editor has no `TextEditor` to read from at all). Two
  earlier key choices both leaked through to a live VS Code default while
  a Hex Editor webview had focus, because the `when` clause does not
  reliably scope in that case: `Ctrl+Shift+N`/`Ctrl+Shift+B` (New Window)
  and `Ctrl+Alt+Right`/`Ctrl+Alt+Left` (Move Editor into Next/Previous
  Group — a real default, confirmed wrong when assumed free; `AltGr` was
  also considered and rejected, since on Windows it is normally reported
  as that same `Ctrl+Alt` combination, not a distinct modifier VS Code's
  keybinding format can target). `Ctrl+Shift+F7`/`F8` is what the user
  picked and confirmed free — don't revert to either earlier pair.

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
