# vForth for VS Code

Language support for [vForth](https://github.com/mattsteeldue/vforth-next),
the Forth system for the ZX Spectrum Next. Phase 1: language intelligence.

## Features

- **Syntax highlighting** generated from the core source. The core vocabulary
  is the set of active `RENAME old NEW` lines at the end of `src/F18e.f`;
  commented `\ RENAME` lines are excluded.
- **NEEDS diagnostics**: a word provided by `inc/` or `lib/` that is used
  before the corresponding `NEEDS` is flagged, with the `NEEDS` to add.
  Availability is sequential and follows the real `NEEDS` / `INCLUDE`
  closure, including the files loaded by the loaded files.
- **Unresolvable `NEEDS`** (no `inc/` nor `lib/` file) and `INCLUDE` paths
  not found under the vForth root.
- **7-bit ASCII check**: any non-ASCII character is an error, except inside
  comments (`\ ...` and `( ... )`), where Latin-1 bytes (e.g. `ß`, `$DF`) are
  allowed, matching text left behind by old editors such as UltraEdit.
- **Hover**: the `help/` page of the word, located through `MAP-FN` exactly
  as `HELP` does, plus where the word is defined and which `NEEDS` loads it.
- **Go to definition**: local definition first, then core (`src/F18e.f`),
  then `inc/` and `lib/`. The core always prevails over `inc/` and `lib/`.
  On a `NEEDS` or `INCLUDE` argument it opens the file.
- **Outline**: definitions of the current file.
- **Semantic colouring**: library words (`vforthLibrary`) and words defined
  in the current file (`vforthLocal`) are told apart from core words.

## Model

- Core: `src/F18e.f`, active `RENAME` table, plus `\` (defined directly).
- Index 1, `NEEDS` targets: `inc/*.f` then `lib/*.f`, by file name through
  `MAP-FN` (`: ? / * | \ < > "` -> `_ ^ % & $ _ { } ~`), case-insensitive.
  As in `NEEDS`, `lib/` is tried only if the word is still undefined after
  `inc/`.
- Index 2, providers: every word defined inside `inc/*.f` and `lib/*.f`.
  For a word defined in a multi-word file (e.g. `KEY-SCAN` in
  `inc/KEYBOARD.f`) the suggested `NEEDS` is the file's own word.
- `inc/doc/`, `lib/doc/`, `dev/`, `version/` are ignored. Files under
  `src/`, `version/`, `inc/doc/`, `lib/doc/` get no word diagnostics.
- User defining words (a colon body using `CREATE`, `<BUILDS` or another
  defining word, e.g. `LAYER:`) and user parsing words (a colon body using
  `CHAR`, `WORD`, `PARSE`) are inferred from the sources.
- `{ a b -- c }` locals are local definitions.
- `HEX` / `DECIMAL` / `BINARY` are tracked for number recognition.
- Every word referenced by a loaded file counts as available: a file that
  loads successfully had all of them defined.

Known limits: numbers in a `BASE` set by other means are not recognised
(they are ignored, never flagged); words created by unusual mechanisms
(e.g. `1FAMILY,` in the assembler) are not indexed as providers.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `vforth.root` | `""` | vForth root (holds `src/F18e.f`). Empty: auto-detect. |
| `vforth.preloaded` | `[]` | `NEEDS` arguments assumed already loaded before any file is opened. Empty by default: AUTOEXEC is self-cleaning (it `MARKER`s away whatever it defines for the splash screen), so nothing from it persists in the dictionary — there is no sensible non-empty default. Set this only if your own workflow loads extra utilities by hand before editing. |
| `vforth.diagnostics.enable` | `true` | Enable diagnostics. |
| `vforth.sdImage` | `""` | CSpect SD image (`.img`) path, for *vForth: Push file to SD image*. |
| `vforth.hdfmonkeyPath` | `"hdfmonkey"` | Path to the `hdfmonkey` executable. |
| `vforth.sdDestPrefix` | `""` | Prefix prepended, inside the image, to the file's path relative to `vforth.root` (e.g. `"tools/vForth"`). |
| `vforth.sdExcludeTopDirs` | `["dev","doc","dot","emu","forum","project","prompts","tools","version"]` | Top-level directories not normally deployed to the SD card; pushing from one asks for confirmation. |

Example, one real working setup (adjust the paths to your own):

```json
"vforth.sdImage": "C:\\Zx\\CSpect\\cspect-next-2gb.img",
"vforth.hdfmonkeyPath": "C:\\Zx\\CSpect\\hdfmonkey.exe",
"vforth.sdDestPrefix": "tools/vForth"
```

`vforth.sdImage` is the SD card **image** itself (the `.img` CSpect loads,
with a FAT filesystem inside) — not `!Blocks-64.bin` and not any other file
that lives *inside* that image. Pointing it at `!Blocks-64.bin` by mistake
is an easy slip (that path is right there in `vforth.root`) and fails with
`hdfmonkey` unable to read a FAT filesystem from it. `vforth.hdfmonkeyPath`
needs the full path unless `hdfmonkey` is already on `PATH`, since the
default is just `"hdfmonkey"`.

For `.f` files the extension sets UTF-8 (identical to ASCII for 7-bit
text), LF line endings and whitespace-only word separators, so that a
double click selects a whole Forth word.

Colours can be tuned with `editor.semanticTokenColorCustomizations`:

```json
"editor.semanticTokenColorCustomizations": {
  "rules": { "vforthLibrary": "#4EC9B0", "vforthLocal": "#DCDCAA" }
}
```

## Build

The grammar is generated from the core source; regenerate it whenever the
`RENAME` table changes:

```
perl build/vforth-build.pl
perl build/vforth-build.pl --report help-report.txt
```

`--report` also writes a help coverage report: words without a `help/`
page, pages matching no definition, and inconsistencies of the
"Available after NEEDS" line.

Standalone checks, no VS Code needed:

```
node test/selftest.js <vForth root> [file.f ...]
node test/sweep.js <vForth root>
```

## Install

No compilation is required (plain JavaScript, no dependencies). Either copy
this directory to `%USERPROFILE%\.vscode\extensions\mattsteeldue.vforth-0.1.0`
and restart VS Code, or package it with `npx @vscode/vsce package` and
install the resulting `.vsix` with *Extensions: Install from VSIX...*.

If another extension (e.g. a Fortran one) also claims `.f`, pin it:

```json
"files.associations": { "*.f": "vforth" }
```

Commands: *vForth: Reload index*, *vForth: Show log*, *vForth: Push file to SD image*, *vForth: Open Screen #*.

## Push file to SD image

Writes the active file onto the CSpect SD image with `hdfmonkey put`, so an
edited `.f` file can be tested without leaving VS Code. Unlike mounting the
image with imdisk (as `W:`, e.g. for a full-tree sync), `hdfmonkey` writes
into the HDF/FAT image directly and needs no exclusive lock, so it works
while CSpect is running — only pushing a single file, not a general
replacement for a full sync. It is a manual command (bind it to a key of
your choice); nothing is pushed automatically on save. Set `vforth.sdImage`
(and `vforth.hdfmonkeyPath` if `hdfmonkey` is not on `PATH`) first.

No `REMOUNT` cycle is needed, unlike with `hdfm-gooey`: reads and writes
both work at any time, CSpect open or closed, and a running vForth session
sees a pushed file immediately (`NEEDS`/`INCLUDE` right after the push) —
verified against a real image and a live CSpect session.

## Open Screen #

Opens a Screen (1024 bytes = 16 lines x 64 columns, 2 Blocks) from
`!Blocks-64.bin` on the SD image as an ordinary text document — prompts for
the screen number, e.g. *11* for the AUTOEXEC screen. Saving (`Ctrl+S`)
validates all 16 lines (max 64 chars each, 7-bit ASCII, no NUL — a NUL
silently aborts `LOAD`) and, only if valid, patches the 1024 bytes back
into `!Blocks-64.bin` on the image via `hdfmonkey`, leaving the rest of the
16 MB block store untouched.

A vertical ruler at column 64 and a bottom border under line 16 mark the
Screen's boundaries; syntax highlighting matches `.f` files, since a Screen
is ordinary vForth source. There is no byte-range read/write in
`hdfmonkey`, so every open and every save round-trips the whole 16 MB
block store through it (`get` then, on save, `put`) — measured at about
0.3 s combined against a real image with CSpect running, fast enough to
feel immediate.

Known limits: no visual indication of *which* Block/Screen number is
"live" elsewhere (e.g. currently `LOAD`ed) inside a running vForth session;
concurrent writes to *other* blocks from inside CSpect during the narrow
read-modify-write window could in principle be lost, since the whole file
is read, patched locally and written back whole — not just observed in
testing, but a structural possibility worth knowing about.
