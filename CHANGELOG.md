# Changelog

## [0.1.1] - 2026-09-19

- "Push file to SD image" renamed "Send file to SD image" (command id unchanged).
- New `vforth.pullFromSD` (Pick file from SD image): fetches the SD copy of the active file and overwrites the local one after confirmation.
- README: where Screen/Block data lives, and the scratch file.

## [0.1.0] - 2026-09-19

First version, built over 2026-09-18 and 2026-09-19.

### 2026-09-18

- **Language support** (phase 1): TextMate grammar generated from the
  active `RENAME` table of `src/F18e.f`; `NEEDS` diagnostics that follow the
  real `NEEDS`/`INCLUDE` load order (`inc/` first, then `lib/`, with the
  `MAP-FN` file-name mapping); unresolvable `NEEDS`/`INCLUDE`; 7-bit ASCII
  check; hover with the `help/` page; go to definition; outline; semantic
  colouring of library and local words.
- Inference of user defining words (e.g. `LAYER:`), user parsing words,
  `{ a b -- c }` locals, and `HEX`/`DECIMAL`/`BINARY` tracking for number
  recognition.
- `vforth.preloaded` documented: empty by default, because AUTOEXEC removes
  what it defines with `MARKER`, and what it loads afterwards depends on the
  user's answer to `ASK-Y/N`.
- **Push file to SD image** (phase 2): writes the active file into the CSpect
  SD image with `hdfmonkey put`. Needs no exclusive lock and no `REMOUNT`
  cycle, so it works while CSpect is running. Settings `vforth.sdImage`,
  `vforth.hdfmonkeyPath`, `vforth.sdDestPrefix`, `vforth.sdExcludeTopDirs`.
- **Open Screen #** (phase 3): a Screen of `!Blocks-64.bin` (16 lines x 64
  columns) as a native text document, with a ruler at column 64 and a border
  under line 16. Saving validates line count, line length, 7-bit ASCII and
  NUL bytes before writing anything.
- README: worked example of the settings, and the warning that
  `vforth.sdImage` is the `.img` itself, not `!Blocks-64.bin`.

### 2026-09-19

- **Open Block # (hex)**: a single 512-byte Block as raw bytes in the
  Microsoft Hex Editor extension, for blocks that are not source (graphics,
  `PERSISTENCE` snapshots, the message table). Offers to install Hex Editor
  if it is missing.
- **Next/Previous Screen/Block**, one pair of commands for both editors,
  bound to `Ctrl+Shift+F8` / `Ctrl+Shift+F7`. Two earlier choices collided
  with VS Code defaults while a Hex Editor webview had focus
  (`Ctrl+Shift+N`/`B`: New Window; `Ctrl+Alt+Right`/`Left`: Move Editor into
  Next/Previous Group).
- Fixed: after stepping between Blocks the Hex Editor webview lost keyboard
  focus. The old tab is now closed before the new one is opened.
- Scanner: the token after `[COMPILE]`/`POSTPONE` is an argument, and a
  colon definition that does `[COMPILE] \` (or `(`) is a comment word, so the
  text after it (e.g. `TESTING Test Suite` in `lib/testing.f`) is no longer
  scanned as words.
- Tests run for the first time with Node.js (v24.19.0): `test/selftest.js` and
  `test/sweep.js` against the vForth tree, 402 files. Diagnostics went from
  118 at the first delivery to 1 (`tutorial/054-dma.f`, `NEEDS DMA` with no
  `DMA.f`, deliberately left as is), after fixes in the vForth sources and the
  scanner change above.
- README reorganised, Requirements section added (`hdfmonkey`, Hex Editor),
  this changelog added.

### Known limits

- Every Screen/Block open or save round-trips the whole 16 MB
  `!Blocks-64.bin` through `hdfmonkey` (no byte-range I/O), about 0.3 s. A
  write from inside CSpect to another block during that window could be lost.
- `NEEDS`/`INCLUDE` inside a running CSpect session stays manual after a push.
- The code of the SD/Screen/Block commands (`extension.js`) is only tested by
  hand in VS Code; the Node test scripts cover the scanner and the model.
