'use strict';
// vForth source scanner.
//
// Splits source text into whitespace-delimited tokens and classifies them.
// Parsing words that consume the rest of the line, the next token, or the
// text up to a delimiter are honoured, so that comments, strings and parsed
// arguments are never mistaken for word references. Everything is
// line-bounded, because vForth reads source files one line at a time
// (F_INCLUDE / F_GETLINE).
//
// Token kinds:
//   word     a word reference, to be looked up
//   defname  the name being created by a defining word
//   needs    the argument of NEEDS
//   include  the argument of INCLUDE
//   arg      a token parsed by CHAR, [CHAR] or a user parsing word
//   comment  \ ...  and  ( ... )
//   string   the text after ."  ,"  S"  Z"  PAD"  .(  and the like
//
// A context object may extend the built-in sets:
//   ctx.definers  Set of user defining words (next token is a defname)
//   ctx.parsers   Set of user parsing words  (next token is an arg)
//
// Pure module: no dependency on the vscode API.

const DEFINING = new Set([
  ':', 'CODE', 'CONSTANT', 'VARIABLE', 'USER', 'CREATE', '<BUILDS',
  'VOCABULARY', 'MARKER', 'VALUE', '2CONSTANT', '2VARIABLE', '2VALUE',
  'DEFER', 'FIELD', '+FIELD'
]);
const PARSING = new Set(['CHAR', '[CHAR]']);
// Words whose body parses the input stream at run time.
const PARSE_PRIMITIVES = new Set(['CHAR', 'WORD', 'PARSE', 'PARSE-NAME']);

// Any word ending in '"' (." ," S" C" Z" PAD" ABORT" ...) parses up to
// the next '"'. The lone '"' is not such a word.
function isQuoteWord(u) { return u.length > 1 && u.endsWith('"') && !u.startsWith('('); }

// Decimal, $hex and %binary literals, optional leading '-', optional '.'
// (double-cell). With base 16 plain hex digits are numbers as well.
function isNumber(u, base) {
  if (/^-?(?:\$[0-9A-F]+|%[01]+|[0-9]+)(?:\.[0-9]*)?$/.test(u)) return true;
  if (/^-?[0-9]*\.[0-9]+$/.test(u)) return true;
  if (base === 16 && /^-?[0-9A-F]+(?:\.[0-9A-F]*)?$/.test(u)) return true;
  return false;
}

// Scan one line; returns tokens {kind, text, line, start, end}.
function scanLine(text, line, ctx) {
  const definers = ctx && ctx.definers;
  const parsers = ctx && ctx.parsers;
  const out = [];
  const re = /\S+/g;
  let m;
  let pending = null;          // kind to assign to the next token
  let soft = false;            // pending may yield to a \ or ( comment
  while ((m = re.exec(text)) !== null) {
    const tok = m[0];
    const start = m.index;
    const end = start + tok.length;
    if (pending) {
      // "CONSTANT \ note" inside a colon body, or a user parsing word followed
      // by a comment: a \ or ( with more text after it is a comment. A bare
      // "\" or "(" at end of line is a name, as in ": \" in F18e.f.
      const yields = soft && (tok === '\\' || tok === '(') && /\S/.test(text.slice(end));
      if (!yields) {
        out.push({ kind: pending, text: tok, line, start, end });
        pending = null;
        continue;
      }
      pending = null;
    }
    const u = tok.toUpperCase();
    if (u === '{') {
      // LOCALS: { a b -- c } on one line; names are local definitions
      out.push({ kind: 'word', text: tok, line, start, end });
      let n;
      while ((n = re.exec(text)) !== null) {
        const s2 = n.index, e2 = s2 + n[0].length;
        if (n[0] === '}') { out.push({ kind: 'word', text: n[0], line, start: s2, end: e2 }); break; }
        out.push({ kind: n[0] === '--' || n[0] === '|' ? 'arg' : 'defname',
                   text: n[0], line, start: s2, end: e2, local: true });
      }
      continue;
    }
    if (u === '\\') {
      out.push({ kind: 'comment', text: text.slice(start), line, start, end: text.length });
      break;
    }
    if (u === '(' || u === '.(' || isQuoteWord(u)) {
      const delim = u === '(' || u === '.(' ? ')' : '"';
      const close = text.indexOf(delim, end + 1);   // skip the single blank
      const stop = close < 0 ? text.length : close + 1;
      if (u === '(') {
        out.push({ kind: 'comment', text: text.slice(start, stop), line, start, end: stop });
      } else {
        out.push({ kind: 'word', text: tok, line, start, end });
        out.push({ kind: 'string', text: text.slice(end, stop), line, start: end, end: stop });
      }
      re.lastIndex = stop;
      continue;
    }
    out.push({ kind: 'word', text: tok, line, start, end });
    soft = true;
    if (DEFINING.has(u) || (definers && definers.has(u))) pending = 'defname';
    else if (u === 'NEEDS') pending = 'needs';
    else if (u === 'INCLUDE') pending = 'include';
    else if (PARSING.has(u)) { pending = 'arg'; soft = false; }
    else if (parsers && parsers.has(u)) pending = 'arg';
  }
  return out;
}

function scan(source, ctx) {
  const lines = source.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    for (const t of scanLine(lines[i], i, ctx)) out.push(t);
  }
  return out;
}

// Infer user defining and parsing words from colon definitions:
//   - a body using CREATE, <BUILDS or another defining word makes a
//     defining word (e.g. LAYER: in lib/GRAPHICS.f);
//   - otherwise a body using CHAR, WORD, PARSE or PARSE-NAME makes a
//     parsing word (e.g. [UDG] in demo/chomp-chomp.f).
// Updates ctx.definers and ctx.parsers in place; returns ctx.
function inferWords(tokens, ctx) {
  let colon = false;          // the last word was ':'
  let cur = null;             // name of the colon definition being scanned
  let parses = false;
  const close = () => {
    if (cur && parses && !ctx.definers.has(cur)) ctx.parsers.add(cur);
    cur = null; parses = false;
  };
  for (const t of tokens) {
    if (t.kind === 'defname') {
      if (colon) { close(); cur = t.text.toUpperCase(); }
      colon = false;
      continue;
    }
    if (t.kind !== 'word') continue;
    const u = t.text.toUpperCase();
    colon = u === ':';
    if (u === ';') { close(); continue; }
    if (!cur || colon) continue;
    if (u === 'CREATE' || u === '<BUILDS' || DEFINING.has(u) || ctx.definers.has(u)) {
      ctx.definers.add(cur);
      ctx.parsers.delete(cur);
    } else if (PARSE_PRIMITIVES.has(u)) {
      parses = true;
    }
  }
  close();
  return ctx;
}

function newContext(base) {
  return { definers: new Set(base ? base.definers : []),
           parsers: new Set(base ? base.parsers : []) };
}

module.exports = { scan, scanLine, isNumber, isQuoteWord, inferWords, newContext, DEFINING };
