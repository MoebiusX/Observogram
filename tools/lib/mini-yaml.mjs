// tools/lib/mini-yaml.mjs
//
// A minimal YAML reader sized for the ObservabilityPack canonical example
// pack and for the repository files a scan reads (rule files, manifests,
// compose files). Browser-friendly (pure ES module, no Node APIs). Used by
// the Node validator, the crawler and the studio's adapter.
//
// SUPPORTED
//   - Block mappings: `key: value` and `key:` (nested block follows)
//   - Block sequences: `- item`, `- key: value` (compact sequence-of-mappings),
//     `- - item` (a sequence as an item), including items whose first key
//     carries a nested block (`- key:` then an indented mapping/sequence below)
//   - Flow mappings: `{k: v, k2: v2}`; flow sequences: `[a, b, c]` — also
//     when they run over several lines
//   - Literal block scalars: `|` (preserves newlines, strips common indent)
//   - Folded block scalars: `>`, folded as YAML folds them (an empty line
//     between paragraphs is one newline, a more-indented line keeps its line
//     breaks); in both, a line of spaces past the block's indent is text, and
//     a block with no content is empty
//   - Single- and double-quoted scalars, also over several lines
//   - Plain scalars over several lines: each deeper line below runs the
//     scalar on — the form PyYAML and go-yaml writers give a value past 80
//     columns. Lines fold as YAML folds them: a line break reads as a space,
//     an empty line as a newline, and in a double-quoted scalar a `\` at the
//     end of a line joins it to the next with neither
//   - Bare scalars: integers, floats, booleans, null, plain strings. With
//     `{ asWritten: true }` a number or a boolean is the text it is written
//     in (`99.0`, `007`, `True`) — as a Go reader decoding into a string
//     keeps it; null is still null
//   - With `{ valueBelowKey: true }`, a scalar or flow value standing on the
//     deeper line below its key (`key:` then `  value`). Off by default: the
//     writer below leaves a key with a line break in it unquoted, and read
//     this way such a key would come back as other keys
//   - Anchors and aliases (`&name`, `*name`), on values and on keys: an alias
//     reads as a copy of the node it names; an alias to no anchor reads as
//     its own text, as before. What the aliases of one call copy, in all its
//     documents — or of every call inside withAliasBudget(fn), but for those
//     inside apartFromAliasBudget(fn) — is bounded (ALIAS_COPY_BUDGET):
//     aliases of aliases grow exponentially from a few lines
//   - Merge keys naming aliases (`<<: *name`, `<<: [*a, *b]`, a block list of
//     aliases): each key the mapping does not state itself, from the earlier
//     source first
//   - A single pair in a flow sequence (`[a: 1]`), a flow mapping entry with
//     no value (`{a, b: 1}`)
//   - A quote opens a quoted scalar, and a bracket a flow collection, only
//     where a node starts (walkLine): inside a plain scalar (`it's`,
//     `x{a="[b"}`) both are text
//   - Full-line comments (`# ...`) and trailing comments
//   - Multi-document streams (`---`/`...`) via parseAll(); parse() returns
//     the first content-bearing document and tolerates a leading `---`
//
// INTENTIONAL NON-GOALS (not used in canonical packs we care about)
//   - Block chomping indicators (`|+`, `|-`): read as `|`
//   - Tag handles (`!!str`): read as text
//   - Complex keys (`? key`): throw
//   - A document that is one flow collection or one scalar (`{a: 1}` alone):
//     throws
//   - A merge key whose mapping is written in place (`<<: {a: 1}`): read as a
//     key named `<<`, as before — the writer of 0.8.40 and earlier wrote such
//     a key unquoted, and files it stored must read as they were written
//   - White space other than spaces and tabs (U+00A0, U+3000, …) at the edges
//     of a value or a key: trimmed, as before
//   - Flow collections nested past MAX_FLOW_NESTING levels, `- - ` items past
//     MAX_ITEM_NESTING on one line: refused
//
// Outside this subset the reader throws with the line number, reads the
// construct as text, or — at a line it cannot place — stops reading the
// block it is in there: a deeper line ends the document (`onStop` hears of
// each document so ended). A flow collection's content line in or left of
// its key's column (only closing brackets may stand there) leaves the flow
// as the text of its first line; that line is then read as the next key
// when it holds one, and otherwise the reader throws or ends the document
// there. A line number, in an error or to `onStop`, counts from the start of
// the text, `---` lines and all.

export function parse(text, options = {}) {
  const docs = parseAll(text, options);
  // Canonical packs are single-document. Return the first document that
  // carries content; tolerate (and skip past) leading `---` markers and
  // empty leading documents.
  for (const doc of docs) {
    if (doc !== null && doc !== undefined) return doc;
  }
  return docs.length ? docs[docs.length - 1] : null;
}

// Parse a (possibly multi-document) YAML stream into an array of documents.
// Documents are separated by a `---` line and optionally terminated by a
// `...` line, both at column 0 (indented `---`/`...` belong to scalars or
// values and are left untouched). Single-document input yields a one-element
// array, so callers that only care about the first document can use parse().
// `options.asWritten`: numbers and booleans read as the text they are
// written in; `options.valueBelowKey`: a value on the line below its key;
// `options.onStop(line)`: called for each document the reader ends before
// its last line, at a line it cannot place, with that line's number (from
// 1, in `text`) — what follows it in the document is not read. parse()
// reads every document too, and reports them all.
export function parseAll(text, options = {}) {
  if (typeof text !== 'string') throw new Error('mini-yaml: input must be a string');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);   // strip BOM
  text = text.replace(/\r\n?/g, '\n');
  const lines = text.split('\n');

  // Split into documents on bare `---` / `...` markers at column 0; each
  // document keeps the index of its first line in the text.
  const docs = [];
  let current = [];
  let first = 0;
  const hasContent = ls => ls.some(l => { const t = l.trim(); return t !== '' && !t.startsWith('#'); });
  lines.forEach((line, i) => {
    if (/^---(?:\s.*)?$/.test(line) || line === '---' || /^\.\.\.(?:\s.*)?$/.test(line) || line === '...') {
      if (hasContent(current)) docs.push({ lines: current, first });
      current = [];
      first = i + 1;
      return;
    }
    current.push(line);
  });
  if (hasContent(current)) docs.push({ lines: current, first });

  if (docs.length === 0) return [null];
  // One alias budget for the whole call — a `---` does not renew it — or the
  // one withAliasBudget opened around it.
  const budget = sharedBudget ?? { copied: 0, shared: false };
  const onStop = typeof options?.onStop === 'function' ? options.onStop : null;
  return docs.map((doc) => {
    const stream = new TokenStream(doc.lines, options, budget, doc.first);
    const value = parseAtIndent(stream, 0);
    if (onStop) {
      const unread = stream.nextSignificantIdx();
      if (unread !== -1) onStop(stream.lineNo(unread));
    }
    return value;
  });
}

// One alias budget for every parse made while `fn` runs (it must be
// synchronous): a caller that reads many texts and keeps what it reads — a
// scan of a repository — is bounded as one call. A call inside another
// shares the outer budget.
let sharedBudget = null;
export function withAliasBudget(fn) {
  if (sharedBudget) return fn();
  sharedBudget = { copied: 0, shared: true };
  try { return fn(); } finally { sharedBudget = null; }
}

// Parses made while `fn` runs (synchronous) each get their own budget again,
// outside the one withAliasBudget opened: reads whose result the caller does
// not keep, or a second reading of a text already charged.
export function apartFromAliasBudget(fn) {
  const outer = sharedBudget;
  sharedBudget = null;
  try { return fn(); } finally { sharedBudget = outer; }
}

class TokenStream {
  constructor(lines, options, budget, first = 0) {
    this.lines = lines;
    this.idx = 0;
    // The index, in the text, of the document's first line.
    this.first = first;
    // The document's anchors: `&name` → the node it names (a later anchor of
    // the same name replaces it, as YAML 1.2 says).
    this.anchors = new Map();
    // What the aliases of this call have copied (ALIAS_COPY_BUDGET), shared
    // by its documents.
    this.budget = budget;
    // The copies its aliases made: a merge key merges these (namesAliases).
    this.aliasCopies = new WeakSet();
    // The line whose `- - ` items are being read (its dashes counted once).
    this.nestLine = -1;
    // How deep the flow collection being read is (MAX_FLOW_NESTING).
    this.flowDepth = 0;
    // Numbers and booleans read as the text they are written in.
    this.asWritten = options?.asWritten === true;
    // A value on the deeper line below its key is read.
    this.valueBelowKey = options?.valueBelowKey === true;
  }
  hasMore() { return this.idx < this.lines.length; }
  // The number, from 1 in the whole text, of the document's line `i`.
  lineNo(i) { return this.first + i + 1; }
  // Index of the next significant (non-blank, non-comment) line. -1 at EOF.
  // Does NOT consume.
  nextSignificantIdx() {
    let i = this.idx;
    while (i < this.lines.length) {
      const tr = this.lines[i].replace(/^\s+/, '');
      if (tr !== '' && !tr.startsWith('#')) return i;
      i++;
    }
    return -1;
  }
}

function indentOf(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  return i;
}

// YAML's white space is a space or a tab; JavaScript's trim() also takes
// U+00A0, U+3000 and the like, which YAML keeps as text.
const isWhite = (c) => c === ' ' || c === '\t';
function trimWhiteStart(s) {
  let i = 0;
  while (i < s.length && isWhite(s[i])) i++;
  return i ? s.slice(i) : s;
}
function trimWhiteEnd(s) {
  let j = s.length;
  while (j > 0 && isWhite(s[j - 1])) j--;
  return j < s.length ? s.slice(0, j) : s;
}
const trimWhite = (s) => trimWhiteEnd(trimWhiteStart(s));

// How YAML reads one line, character by character. `st` carries what runs
// on across the lines of a flow collection: `quote` (the quoted scalar the
// walk is in: '"', "'" or ''), `depth` (the flow collections open), `start`
// (whether a node may start at the next character that is not white space)
// and `closed` (a quoted scalar has just closed). A node starts at the start
// of the text, after a `- ` or `? ` there, after a mapping colon, after an
// anchor or a tag where a node starts, and inside a flow collection after
// `[`, `{` or `,`. A quote opens a quoted scalar, and a bracket a flow
// collection, only where a node starts: inside a plain scalar (`it's`,
// `x{a="[b"}`) both are text. `visit(kind, i)` hears of each comment (`#`),
// mapping colon (`:`), flow comma (`,`) and flow bracket before `st` takes
// it in; when it returns true the walk stops there.
function walkLine(s, st, visit) {
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (st.quote === '"') {
      if (c === '\\') i++;
      else if (c === '"') { st.quote = ''; st.closed = true; }
      continue;
    }
    if (st.quote === "'") {
      if (c === "'") {
        if (s[i + 1] === "'") i++;                       // `''` is a quote in the text
        else { st.quote = ''; st.closed = true; }
      }
      continue;
    }
    if (isWhite(c)) continue;
    const next = s[i + 1];
    const whiteAfter = next === undefined || isWhite(next);
    const closed = st.closed;
    st.closed = false;
    // A comment starts after white space — any, as it always did here.
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) {
      if (visit('#', i)) return;
      continue;
    }
    if (st.start && (c === '"' || c === "'")) { st.quote = c; st.start = false; continue; }
    if ((c === '[' || c === '{') && (st.start || st.depth > 0)) {
      if (visit(c, i)) return;
      st.depth++;
      st.start = true;
      continue;
    }
    if ((c === ']' || c === '}') && st.depth > 0) {
      if (visit(c, i)) return;
      st.depth--;
      st.start = false;
      continue;
    }
    if (c === ',' && st.depth > 0) {
      if (visit(',', i)) return;
      st.start = true;
      continue;
    }
    // A mapping colon: followed by white space or the end — or, in a flow
    // collection, after a quoted key or before an entry's end (`{"a":1}`).
    if (c === ':' && (whiteAfter || (st.depth > 0 && (closed || next === ',' || next === ']' || next === '}')))) {
      if (visit(':', i)) return;
      st.start = true;
      continue;
    }
    if (st.start && st.depth === 0 && (c === '-' || c === '?') && whiteAfter) continue;
    if (st.start && (c === '&' || c === '!')) {
      // An anchor or a tag: the node it belongs to starts after it.
      while (i + 1 < s.length && !isWhite(s[i + 1]) && !',[]{}'.includes(s[i + 1])) i++;
      continue;
    }
    st.start = false;
  }
}

// Where the comment of a line starts (its `#`), or -1. In a flow collection
// on one line a `#` is read on, as before. `start` is false for a line that
// continues a plain scalar: no quote or bracket opens on it.
function commentAt(s, start = true) {
  const st = { quote: '', depth: 0, start, closed: false };
  let at = -1;
  walkLine(s, st, (kind, i) => {
    if (kind === '#' && st.depth === 0) { at = i; return true; }
    return false;
  });
  return at;
}

// Strip a trailing `#` comment, and the white space before it.
function stripTrailingComment(s, start = true) {
  const at = commentAt(s, start);
  return (at === -1 ? s : s.slice(0, at)).trimEnd();
}

// Find the first ":" that signals a mapping (followed by space, end of line,
// or end of string), outside quotes and flow brackets. Returns -1 if none.
function findMappingColon(s, start = true) {
  const st = { quote: '', depth: 0, start, closed: false };
  let at = -1;
  walkLine(s, st, (kind, i) => {
    if (kind === ':' && st.depth === 0) { at = i; return true; }
    return false;
  });
  return at;
}

function looksLikeMappingHead(s) {
  // A compact sequence item like `- key: value` looks like a mapping.
  // But `- { ... }` or `- [ ... ]` is a flow value, not a mapping head.
  if (s.startsWith('{') || s.startsWith('[')) return false;
  return findMappingColon(s) !== -1;
}

function parseAtIndent(stream, minIndent) {
  const sig = stream.nextSignificantIdx();
  if (sig === -1) return null;
  const line = stream.lines[sig];
  const ind = indentOf(line);
  if (ind < minIndent) return null;
  stream.idx = sig;
  const content = stripTrailingComment(line.slice(ind));
  if (content.startsWith('- ') || content === '-') {
    return parseBlockSequence(stream, ind);
  }
  return parseBlockMapping(stream, ind);
}

// `out` and `merges` let a compact sequence item hand over the mapping it
// started with its first key.
function parseBlockMapping(stream, indent, out = {}, merges = []) {
  while (true) {
    const sig = stream.nextSignificantIdx();
    if (sig === -1) break;
    const line = stream.lines[sig];
    const lineInd = indentOf(line);
    if (lineInd < indent) break;
    if (lineInd > indent) break;        // belongs to a nested node we don't own
    const content = stripTrailingComment(line.slice(indent));
    if (content.startsWith('- ') || content === '-') break;

    const colon = findMappingColon(content);
    if (colon === -1) {
      throw new Error(`yaml line ${stream.lineNo(sig)}: expected "key: value", got ${JSON.stringify(content)}`);
    }
    stream.idx = sig + 1;
    const key = resolveKey(stream, content.slice(0, colon).trim());
    // A nested mapping/sequence at greater indent, OR a compact sequence
    // whose items sit at the same indent as the parent mapping key (YAML
    // allows both styles), OR a value on this line.
    const value = readInlineValue(stream, indent, line.slice(indent + colon + 1), true);
    setEntry(out, merges, key, value, namesAliases(stream, value));
  }
  return withMerges(out, merges);
}

// The deepest `- - ` nesting read on one line: past it the line is refused
// (each level re-reads the line, so the cost grows with the square).
const MAX_ITEM_NESTING = 16;

// How many `- ` items open at the start of `s`, one inside the other.
function leadingDashes(s) {
  let n = 0;
  let i = 0;
  // Over the white space trimStart steps over too (the items are found so).
  while (s[i] === '-' && (i + 1 === s.length || /\s/.test(s[i + 1]))) {
    n++;
    i++;
    while (i < s.length && /\s/.test(s[i])) i++;
  }
  return n;
}

function parseBlockSequence(stream, indent) {
  const arr = [];
  while (true) {
    const sig = stream.nextSignificantIdx();
    if (sig === -1) break;
    const line = stream.lines[sig];
    const lineInd = indentOf(line);
    if (lineInd < indent) break;
    if (lineInd > indent) break;
    const content = stripTrailingComment(line.slice(indent));
    if (!(content.startsWith('- ') || content === '-')) break;
    stream.idx = sig + 1;
    const inline = content === '-' ? '' : content.slice(2);
    const raw = content === '-' ? '' : line.slice(indent + 2);
    const head = inline.trimStart();

    if (head === '-' || head.startsWith('- ')) {
      // A sequence as the item (`- - a`): its items in the column of its
      // first dash, the first on this line.
      if (stream.nestLine !== sig) {
        if (leadingDashes(line.slice(indent)) > MAX_ITEM_NESTING + 1) {
          throw new Error(`yaml line ${stream.lineNo(sig)}: sequences nested past ${MAX_ITEM_NESTING} levels on one line`);
        }
        stream.nestLine = sig;
      }
      const column = indent + 2 + (inline.length - head.length);
      stream.lines[sig] = ' '.repeat(column) + line.slice(column);
      stream.idx = sig;
      arr.push(parseBlockSequence(stream, column));
    } else if (head !== '' && !isBlockScalarHead(head) && looksLikeMappingHead(head)) {
      // Compact sequence-of-mappings: first key inline, the rest of the
      // mapping in the column of that first key (YAML standard: past `- `,
      // and past any further spaces after the dash).
      const pad = inline.length - head.length;
      arr.push(readCompactMapping(stream, indent + 2 + pad, head, raw.slice(pad)));
    } else {
      arr.push(readInlineValue(stream, indent, raw, false));
    }
  }
  return arr;
}

// A compact sequence item's mapping: its first key and value read from
// `head` (the item's text, comment stripped) and `raw` (the same, as
// written), the rest of its keys from the lines below at `itemIndent`.
function readCompactMapping(stream, itemIndent, head, raw) {
  const out = {};
  const merges = [];
  const colon = findMappingColon(head);
  const key = resolveKey(stream, head.slice(0, colon).trim());
  // `- key:` may carry a nested block at a deeper indent, e.g.
  //     - match:
  //         severity: critical
  //       receiver: pager
  const value = readInlineValue(stream, itemIndent, raw.slice(colon + 1), true);
  setEntry(out, merges, key, value, namesAliases(stream, value));
  return parseBlockMapping(stream, itemIndent, out, merges);
}

// The value after a key's `:` (or a sequence's `- `), read from `raw` — the
// rest of its line as written, comment and all — and, where YAML lets it run
// on, from the deeper lines below: a nested block, a block scalar, a quoted
// scalar to its closing quote, a flow collection to its closing bracket, a
// plain scalar folded over its continuation lines. `parentIndent` is the
// column of the key (or the dash): every line the value runs on to is
// deeper. A key's value may also be a sequence in the key's own column
// (`sameColumnSequence`).
function readInlineValue(stream, parentIndent, raw, sameColumnSequence) {
  const lead = raw.trimStart();
  const at = commentAt(lead);
  // Without its comment: `kept` loses only spaces and tabs at its end (what a
  // plain scalar folded onto the next line keeps), `text` any white space.
  const kept = trimWhiteEnd(at === -1 ? lead : lead.slice(0, at));
  const text = kept.trimEnd();
  const { anchor, rest, consumed } = takeAnchor(text);
  let value;
  if (rest === '') value = readNodeBelow(stream, parentIndent, sameColumnSequence);
  else if (isBlockScalarHead(rest)) value = readBlockScalar(stream, parentIndent, rest[0]);
  else value = readScalarOrFlow(stream, parentIndent, rest, lead.slice(consumed), at !== -1, kept.slice(consumed));
  if (anchor !== null) stream.anchors.set(anchor, value);
  return value;
}

// What stands below a key (or a `-`) with nothing after it: a nested block,
// a sequence in the key's own column, or nothing (null). A scalar on the
// deeper line below is read only with `valueBelowKey`; otherwise the block
// mapping throws on it, as it always did.
function readNodeBelow(stream, parentIndent, sameColumnSequence) {
  const ns = stream.nextSignificantIdx();
  if (ns === -1) return null;
  const line = stream.lines[ns];
  const childIndent = indentOf(line);
  const childContent = stripTrailingComment(line.slice(childIndent));
  const isSeqItem = childContent.startsWith('- ') || childContent === '-';
  if (childIndent > parentIndent) {
    if (isSeqItem) return parseBlockSequence(stream, childIndent);
    if (!stream.valueBelowKey || findMappingColon(childContent) !== -1) return parseBlockMapping(stream, childIndent);
    stream.idx = ns + 1;
    return readInlineValue(stream, parentIndent, line.slice(childIndent), false);
  }
  // compact sequence: `owners:\n- team-x\n- team-y` where the sequence items
  // share the parent's indent.
  if (sameColumnSequence && childIndent === parentIndent && isSeqItem) return parseBlockSequence(stream, childIndent);
  return null;
}

// A scalar or a flow collection that starts on the current line (`rest`
// without its comment; `raw` as written, from the same character; `kept`
// without its comment but for white space other than spaces and tabs).
function readScalarOrFlow(stream, parentIndent, rest, raw, commented, kept) {
  const c = rest[0];
  if (c === '"' || c === "'") {
    if (closingQuoteAt(rest, 1, c) === -1) {
      const value = readQuotedLines(stream, parentIndent, raw, c);
      if (value !== null) return value;
    }
    return parseValue(rest, stream);
  }
  if (c === '{' || c === '[') return parseValue(readFlowLines(stream, parentIndent, raw) ?? rest, stream);
  // An alias does not run on, nor does a plain scalar a comment ended.
  if (c === '*' || commented) return parseValue(rest, stream);
  return parseValue(runOnPlain(stream, parentIndent, rest, kept), stream);
}

// A plain scalar run on over the deeper lines below it. A line at or left of
// `parentIndent`, a comment line, or a `key: value` line ends it (none of
// them can be part of a plain scalar); so does a comment after a line's text.
// A quote or a bracket on a continuation line is the scalar's text. Only
// spaces and tabs fold away at a line break (`kept` is the first line so).
// Run on over nothing, the scalar is `first`, as before.
function runOnPlain(stream, parentIndent, first, kept = first) {
  let text = kept;
  let added = false;
  let empty = 0;
  for (let i = stream.idx; i < stream.lines.length; i++) {
    const line = stream.lines[i];
    const body = trimWhite(line);
    if (body === '') { empty++; continue; }
    if (indentOf(line) <= parentIndent || body[0] === '#') break;
    const at = commentAt(body, false);
    const more = at === -1 ? body : trimWhiteEnd(body.slice(0, at));
    if (findMappingColon(more, false) !== -1) break;
    text += empty ? '\n'.repeat(empty) : ' ';
    text += more;
    added = true;
    empty = 0;
    stream.idx = i + 1;
    if (at !== -1) break;
  }
  return added ? text : first;
}

// The index of the quote that closes a quoted scalar in `s`, from `from`;
// -1 when it does not close there.
function closingQuoteAt(s, from, quote) {
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (quote === '"') {
      if (c === '\\') { i++; continue; }
      if (c === '"') return i;
    } else if (c === "'") {
      if (s[i + 1] === "'") { i++; continue; }
      return i;
    }
  }
  return -1;
}

// A quoted scalar that does not close on its first line (`first`, from the
// opening quote): read on to the closing quote over the deeper lines below,
// and folded. A YAML reader ignores indentation inside a quoted scalar; this
// one lets a line at or left of `parentIndent` close it (`"` at the key's
// column) but not run it on, so a quote left open by mistake swallows no
// keys. null when such a line, or the end of the document, comes first, or
// text other than a comment follows the closing quote: the caller then reads
// the first line as before.
function readQuotedLines(stream, parentIndent, first, quote) {
  const lines = [first.slice(1)];
  for (let i = stream.idx; i < stream.lines.length; i++) {
    const line = stream.lines[i];
    if (trimWhite(line) !== '' && indentOf(line) <= parentIndent && !trimWhiteStart(line).startsWith(quote)) return null;
    const at = closingQuoteAt(line, 0, quote);
    if (at === -1) { lines.push(line); continue; }
    const after = trimWhite(line.slice(at + 1));
    if (after !== '' && !after.startsWith('#')) return null;
    lines.push(line.slice(0, at));
    stream.idx = i + 1;
    const body = foldQuoted(lines, quote === '"');
    return quote === '"' ? decodeDoubleQuoted(body) : body.replace(/''/g, "'");
  }
  return null;
}

// Whether `s` ends with a backslash that escapes the line break after it (an
// odd run of backslashes).
function escapedEnd(s) {
  let n = 0;
  for (let i = s.length - 1; i >= 0 && s[i] === '\\'; i--) n++;
  return n % 2 === 1;
}

// A line's text before a line break that folds: its white space at the end
// goes — but in a double-quoted scalar an escaped space or tab stays.
function trimFoldEnd(seg, double) {
  const head = trimWhiteEnd(seg);
  return head.length < seg.length && double && escapedEnd(head) ? head + seg[head.length] : head;
}

// The lines of a quoted scalar (the first after its opening quote, the last
// before its closing one) folded into one: a line break reads as a space
// and the white space around it goes; an empty line reads as a newline; in a
// double-quoted scalar a `\` at the end of a line joins it to the next with
// nothing (the empty lines after it still read as newlines), and an escaped
// space or tab before a break is kept.
function foldQuoted(lines, double) {
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    const seg = i === 0 ? lines[i] : trimWhiteStart(lines[i]);
    if (i === lines.length - 1) { out += seg; break; }
    let empty = 0;
    while (i + 1 < lines.length - 1 && trimWhite(lines[i + 1]) === '') { empty++; i++; }
    if (double && escapedEnd(seg)) out += seg.slice(0, -1) + '\n'.repeat(empty);
    else out += trimFoldEnd(seg, double) + (empty ? '\n'.repeat(empty) : ' ');
  }
  return out;
}

// A flow collection that does not close on its first line (`first`, from
// the opening bracket): its text over the deeper lines below, comments
// dropped, once the bracket closes. Lines join with a space — but a line
// break inside a quoted scalar folds as one does, and empty lines inside a
// plain scalar read as newlines. Comment lines may stand anywhere. A line at
// or left of `parentIndent` may close it (closing brackets and commas only,
// or the open quote's closing quote first) but never run it on. null when it
// closes on its first line, or is still open after such a line or at the
// end of the document.
function readFlowLines(stream, parentIndent, first) {
  const state = { quote: '', depth: 0, start: true, closed: false };
  const parts = [flowLineText(first, state)];
  if (state.depth <= 0) return null;
  let empty = 0;
  for (let i = stream.idx; i < stream.lines.length; i++) {
    const line = stream.lines[i];
    const body = trimWhite(line);
    if (body === '') { empty++; continue; }
    if (!state.quote && body[0] === '#') continue;
    const atOrLeft = indentOf(line) <= parentIndent;
    if (atOrLeft && !(state.quote && body.startsWith(state.quote)) && !closersOnly(body)) return null;
    const inQuote = state.quote;
    const afterNode = !state.start;
    // Its white space at the end stays for flowLineText: an escaped one is text.
    const next = flowLineText(trimWhiteStart(line), state);
    const last = parts.length - 1;
    if (inQuote === '"' && escapedEnd(parts[last])) {
      parts[last] = parts[last].slice(0, -1);
      if (empty) parts.push('\n'.repeat(empty));
    } else {
      parts.push(empty && (inQuote || afterNode) ? '\n'.repeat(empty) : ' ');
    }
    parts.push(next);
    empty = 0;
    if (state.depth <= 0) { stream.idx = i + 1; return parts.join(''); }
    // A quote-led line there may close a quoted scalar, never run the flow on.
    if (atOrLeft && !closersOnly(body)) return null;
  }
  return null;
}

// A line of closing brackets and commas, a comment after them at most.
function closersOnly(body) {
  let i = 0;
  while (i < body.length && (body[i] === ']' || body[i] === '}' || body[i] === ',' || isWhite(body[i]))) i++;
  return i > 0 && (body[0] === ']' || body[0] === '}') && (i === body.length || (body[i] === '#' && isWhite(body[i - 1])));
}

// One line of a flow collection without its comment, its state (brackets
// and quotes open) carried in `state` across lines. The white space at its
// end goes, but not an escaped one of an open double-quoted scalar.
function flowLineText(s, state) {
  let cut = -1;
  walkLine(s, state, (kind, i) => {
    if (kind === '#') { cut = i; return true; }
    return false;
  });
  const text = cut === -1 ? s : s.slice(0, cut);
  return state.quote === '"' ? trimFoldEnd(text, true) : trimWhiteEnd(text);
}

// A node's anchor (`&name`) in front of its content.
const ANCHOR_RE = /^&([^\s,[\]{}]+)(?:[ \t]+|$)/;
// An alias (`*name`): the whole value.
const ALIAS_RE = /^\*([^\s,[\]{}]+)$/;

function takeAnchor(s) {
  const m = ANCHOR_RE.exec(s);
  return m
    ? { anchor: m[1], rest: s.slice(m[0].length), consumed: m[0].length }
    : { anchor: null, rest: s, consumed: 0 };
}

// A key as written (`rawKey`, its quotes still on) → { key, merge }: an
// anchor in front of it is taken off and registered (it names the key, as
// YAML reads `&a key: value`); an alias of a scalar stands for that scalar
// (`*a : value`); `merge` for `<<` unquoted, a merge key.
function resolveKey(stream, rawKey) {
  if (rawKey === '<<') return { key: rawKey, merge: true };
  const alias = ALIAS_RE.exec(rawKey);
  if (alias && stream.anchors.has(alias[1])) {
    const named = stream.anchors.get(alias[1]);
    if (named === null || typeof named !== 'object') return { key: String(copyOf(stream, named)), merge: false };
  }
  const { anchor, rest } = takeAnchor(rawKey);
  if (anchor !== null && rest !== '') {
    const key = unquote(rest);
    stream.anchors.set(anchor, key);
    return { key, merge: false };
  }
  return { key: unquote(rawKey), merge: false };
}

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isMergeSource = (v) => isMap(v) || (Array.isArray(v) && v.length > 0 && v.every(isMap));

// Whether a value read is what aliases name — an alias's copy, or a list of
// them however it is written (`<<: *a`, `<<: [*a, *b]`, a block list of
// aliases): what a merge key merges here. A mapping written in place is not.
function namesAliases(ctx, value) {
  const copied = (v) => v !== null && typeof v === 'object' && ctx.aliasCopies.has(v);
  return copied(value) || (Array.isArray(value) && value.length > 0 && value.every(copied));
}

// One entry of a mapping. A merge key whose value names aliases of mappings
// (`aliased`) is held back until the mapping is complete; any other key —
// a `<<` written with its mapping in place included — is set as written.
function setEntry(out, merges, { key, merge }, value, aliased) {
  if (merge && aliased && isMergeSource(value)) merges.push(value);
  else out[key] = value;
}

// The merge keys' mappings into `out`: each key `out` does not state itself,
// from the earlier source first (YAML's merge key, `<<`).
function withMerges(out, merges) {
  for (const source of merges) {
    for (const map of Array.isArray(source) ? source : [source]) {
      for (const [k, v] of Object.entries(map)) if (!Object.hasOwn(out, k)) out[k] = v;
    }
  }
  return out;
}

// The most one call's aliases may copy, in all its documents: each node
// counts one and its depth in the copy (what writing it out indents), each
// string (a value or a key) its length too — so what the copies hold, and
// near enough what they would weigh written out, is bounded. A few anchors
// used many times is ordinary; aliases of aliases that double at each step
// grow exponentially from a few lines: reading stops before building them.
const ALIAS_COPY_BUDGET = 1_000_000;

function copyWeight(value, depth = 0) {
  if (typeof value === 'string') return 1 + depth + value.length;
  if (value === null || typeof value !== 'object') return 1 + depth;
  let n = 1 + depth;
  if (Array.isArray(value)) for (const v of value) n += copyWeight(v, depth + 1);
  else for (const k of Object.keys(value)) n += 1 + depth + k.length + copyWeight(value[k], depth + 1);
  return n;
}

// A copy of lists and mappings that shares the strings (they cannot change).
function copyNode(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(copyNode);
  const out = {};
  for (const k of Object.keys(value)) out[k] = copyNode(value[k]);
  return out;
}

// An alias reads as a copy: two places in the document are two values.
function copyOf(ctx, value) {
  ctx.budget.copied += copyWeight(value);
  if (ctx.budget.copied > ALIAS_COPY_BUDGET) {
    throw new Error(ctx.budget.shared
      ? `yaml: aliases copy more than ${ALIAS_COPY_BUDGET} nodes and characters in the texts read together (one budget for them all)`
      : `yaml: aliases copy more than ${ALIAS_COPY_BUDGET} nodes and characters`);
  }
  const copy = copyNode(value);
  if (copy !== null && typeof copy === 'object') ctx.aliasCopies.add(copy);
  return copy;
}

function isBlockScalarHead(s) {
  return /^[|>][-+]?/.test(s);
}

// Collect lines strictly more indented than `parentIndent`, preserving their
// content with the leading common indent stripped. Trailing blank lines are
// dropped; callers decide whether to preserve or fold line breaks.
function readBlockScalarLines(stream, parentIndent) {
  const collected = [];
  let blockIndent = null;
  while (stream.hasMore()) {
    const line = stream.lines[stream.idx];
    const isBlank = line.replace(/^\s+/, '') === '';
    if (isBlank) {
      // Spaces past the block's indent are text (a more-indented line).
      collected.push(blockIndent !== null && line.length > blockIndent && trimWhite(line) === '' ? line.slice(blockIndent) : '');
      stream.idx++;
      continue;
    }
    const ind = indentOf(line);
    if (ind <= parentIndent) break;
    if (blockIndent === null) blockIndent = ind;
    collected.push(line.slice(blockIndent));
    stream.idx++;
  }
  while (collected.length && collected[collected.length - 1] === '') collected.pop();
  return collected;
}

function readBlockScalar(stream, parentIndent, style) {
  const collected = readBlockScalarLines(stream, parentIndent);
  if (!collected.length) return '';            // a block with no content is empty
  if (style === '>') return foldBlockScalarLines(collected);
  return collected.join('\n') + '\n';
}

// A folded block scalar's lines (their common indent off, '' for an empty
// line), folded as YAML folds them: a line break between two lines of text
// reads as a space; one followed by empty lines reads as those empty lines
// alone (one newline each); a more-indented line (it starts with white
// space) keeps the line breaks around it.
function foldBlockScalarLines(lines) {
  const spaced = (s) => s[0] === ' ' || s[0] === '\t';
  let out = '';
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    out += line;
    let j = i + 1;
    while (j < lines.length && lines[j] === '') j++;
    if (j >= lines.length) break;
    const empty = j - i - 1;
    if (line !== '' && !spaced(line) && !spaced(lines[j])) out += empty ? '\n'.repeat(empty) : ' ';
    else out += '\n'.repeat(empty + 1);
    i = j;
  }
  return out + '\n';
}

// Parse a scalar / flow value. `ctx` is the document's stream: its anchors,
// and whether numbers and booleans read as written.
function parseValue(s, ctx) {
  s = s.trim();
  if (s === '') return null;
  if (s[0] === '&') {
    const { anchor, rest } = takeAnchor(s);
    if (anchor !== null) {
      const value = parseValue(rest, ctx);
      ctx.anchors.set(anchor, value);
      return value;
    }
  }
  if (s[0] === '*') {
    const alias = ALIAS_RE.exec(s);
    // An alias to no anchor reads as its own text, as it always did.
    if (alias && ctx.anchors.has(alias[1])) return copyOf(ctx, ctx.anchors.get(alias[1]));
  }
  if (s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
  if (s === 'true' || s === 'True' || s === 'TRUE') return ctx.asWritten ? s : true;
  if (s === 'false' || s === 'False' || s === 'FALSE') return ctx.asWritten ? s : false;
  if (s.startsWith('{') && s.endsWith('}')) return parseFlowMapping(s, ctx);
  if (s.startsWith('[') && s.endsWith(']')) return parseFlowSequence(s, ctx);
  if (s.startsWith('"') || s.startsWith("'")) return unquote(s);
  if (ctx.asWritten) return s;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+([eE][+-]?\d+)?$/.test(s)) return parseFloat(s);
  if (/^-?\d+[eE][+-]?\d+$/.test(s)) return parseFloat(s);
  return s;
}

function unquote(s) {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return decodeDoubleQuoted(s.slice(1, -1));
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

// Single-character escapes of a YAML double-quoted scalar (YAML 1.2 §5.7).
// JSON's set is a subset; the rest (\0 \a \v \e \<space> \N \_ \L \P and
// the \x / \U code points below) are what YAML writers such as PyYAML emit
// for non-ASCII and control characters, so a file they wrote must read.
const DOUBLE_QUOTED_ESCAPES = {
  '0': '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f',
  r: '\r', e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\',
  N: '\u0085', _: '\u00a0', L: '\u2028', P: '\u2029',
};
const DOUBLE_QUOTED_HEX_ESCAPES = { x: 2, u: 4, U: 8 };

// Decode the body of a double-quoted scalar (quotes already removed).
function decodeDoubleQuoted(body) {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') { out += c; continue; }
    const e = body[i + 1];
    if (e === undefined) throw new Error('yaml: unterminated escape in double-quoted scalar');
    if (Object.hasOwn(DOUBLE_QUOTED_ESCAPES, e)) { out += DOUBLE_QUOTED_ESCAPES[e]; i++; continue; }
    const width = DOUBLE_QUOTED_HEX_ESCAPES[e];
    if (width) {
      const hex = body.slice(i + 2, i + 2 + width);
      if (hex.length !== width || !/^[0-9a-fA-F]+$/.test(hex)) {
        throw new Error(`yaml: bad escape \\${e}${hex} in double-quoted scalar (expected ${width} hex digits)`);
      }
      const code = parseInt(hex, 16);
      if (code > 0x10FFFF) throw new Error(`yaml: escape \\${e}${hex} is not a Unicode code point`);
      // \u surrogate halves pair up as they do in JSON; \U is a full code point.
      out += e === 'U' ? String.fromCodePoint(code) : String.fromCharCode(code);
      i += 1 + width;
      continue;
    }
    throw new Error(`yaml: bad escape \\${e} in double-quoted scalar`);
  }
  return out;
}

// The deepest flow collections nest: past it the value is refused (each
// level re-reads the text inside it, so the cost grows with the square).
const MAX_FLOW_NESTING = 64;

function inFlow(ctx, read) {
  if (ctx.flowDepth >= MAX_FLOW_NESTING) throw new Error(`yaml: flow collections nested past ${MAX_FLOW_NESTING} levels`);
  ctx.flowDepth++;
  try { return read(); } finally { ctx.flowDepth--; }
}

function parseFlowMapping(s, ctx) {
  return inFlow(ctx, () => {
    const inner = s.slice(1, -1).trim();
    if (inner === '') return {};
    const parts = splitFlow(inner, ',');
    const out = {};
    const merges = [];
    for (const part of parts) {
      const p = part.trim();
      if (p === '') continue;
      const colon = findFlowColon(p);
      if (colon === -1) {
        // An entry with no value (`{a, b: 1}`) is a key whose value is null;
        // a flow collection as a key is a complex key, which is not read.
        if (p[0] === '{' || p[0] === '[') throw new Error(`yaml flow mapping: expected "k: v" in ${JSON.stringify(p)}`);
        setEntry(out, merges, resolveKey(ctx, p), null, false);
        continue;
      }
      const key = resolveKey(ctx, p.slice(0, colon).trim());
      const value = parseValue(p.slice(colon + 1).trim(), ctx);
      setEntry(out, merges, key, value, namesAliases(ctx, value));
    }
    return withMerges(out, merges);
  });
}

// The mapping colon of one flow mapping entry: as findMappingColon, read in
// a flow collection (where `"a":1` has one too).
function findFlowColon(s) {
  const st = { quote: '', depth: 1, start: true, closed: false };
  let at = -1;
  walkLine(s, st, (kind, i) => {
    if (kind === ':' && st.depth === 1) { at = i; return true; }
    return false;
  });
  return at;
}

function parseFlowSequence(s, ctx) {
  return inFlow(ctx, () => {
    const inner = s.slice(1, -1).trim();
    if (inner === '') return [];
    const parts = splitFlow(inner, ',');
    // A comma after the last entry (`[a, b,]`) adds no entry.
    if (parts.length > 1 && parts[parts.length - 1].trim() === '') parts.pop();
    return parts.map((part) => {
      const p = part.trim();
      const colon = p[0] === '{' || p[0] === '[' ? -1 : findFlowColon(p);
      if (colon === -1) return parseValue(p, ctx);
      // A single pair (`[a: 1]`) is a mapping of one key.
      const pair = {};
      setEntry(pair, [], resolveKey(ctx, p.slice(0, colon).trim()), parseValue(p.slice(colon + 1).trim(), ctx), false);
      return pair;
    });
  });
}

// Split a flow collection's inside at its own commas — not at those inside
// quotes or nested brackets (walkLine).
function splitFlow(s, sep = ',') {
  if (sep !== ',') throw new Error('mini-yaml: splitFlow splits at commas only');
  const st = { quote: '', depth: 1, start: true, closed: false };
  const out = [];
  let from = 0;
  walkLine(s, st, (kind, i) => {
    if (kind === ',' && st.depth === 1) { out.push(s.slice(from, i)); from = i + 1; }
    return false;
  });
  out.push(s.slice(from));
  return out;
}

// ============================================================
// Emitter — minimal block-style YAML writer. Symmetric to the parser:
// output round-trips through parse() back to a structurally equal value.
//
// Emits: block mappings, block sequences, literal block scalars (`|`),
// quoted strings when ambiguous, JSON-style scalars for numbers /
// booleans / null. Compact (no empty containers as inline `{}`/`[]`).
// ============================================================

const BLOCK_SCALAR_LENGTH = 4096;

export function emit(value, opts = {}) {
  const indent = opts.indent || 2;
  const out = emitValue(value, 0, indent, true);
  return out.endsWith('\n') ? out : out + '\n';
}

function emitValue(value, depth, indent, topLevel = false) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return String(value);
    return 'null'; // NaN / Infinity not representable; lose with care
  }
  if (typeof value === 'string') return emitScalarString(value);
  if (Array.isArray(value)) return emitSequence(value, depth, indent, topLevel);
  if (typeof value === 'object') return emitMapping(value, depth, indent, topLevel);
  return 'null';
}

function emitScalarString(s) {
  if (s === '') return "''";
  // Multi-line: use a literal block scalar. Caller handles placement.
  // We tag the result with a sentinel `__BLOCK__` so the parent renderer
  // knows to format it correctly. (Single-line emission shouldn't see this.)
  if (shouldEmitBlockScalarString(s)) return '__BLOCK__:' + s;
  if (needsQuoting(s)) return JSON.stringify(s); // double-quoted with JSON escapes
  return s;
}

function shouldEmitBlockScalarString(s) {
  return s.includes('\n') || s.length > BLOCK_SCALAR_LENGTH;
}

function needsQuoting(s) {
  if (s.length === 0) return true;
  // Special YAML keywords
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(s)) return true;
  // Numeric-looking
  if (/^[-+]?(\d+(\.\d+)?([eE][-+]?\d+)?|\.\d+([eE][-+]?\d+)?)$/.test(s)) return true;
  // Leading sigils / whitespace / structural chars
  if (/^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(s)) return true;
  // Trailing whitespace would lose data on parse
  if (/[\s]$/.test(s)) return true;
  // Trailing ":" reads as a mapping key with an empty value (`job:metric:`,
  // the recording-rule naming convention, is the common victim: as a
  // sequence item it re-parses as `{ "job:metric": null }`).
  if (/:$/.test(s)) return true;
  // Embedded ":<ws>" (mapping ambiguity) or "<ws>#" (comment ambiguity).
  // The parser treats a tab like a space in both positions.
  if (/:\s/.test(s)) return true;
  if (/\s#/.test(s)) return true;
  return false;
}

function emitMapping(obj, depth, indent, topLevel) {
  const keys = Object.keys(obj);
  if (keys.length === 0) return '{}';
  const pad = ' '.repeat(depth * indent);
  const childPad = ' '.repeat((depth + 1) * indent);
  const lines = [];
  for (const k of keys) {
    const v = obj[k];
    const key = emitKey(k);
    if (v === null || v === undefined) {
      lines.push(`${pad}${key}: null`);
      continue;
    }
    if (Array.isArray(v)) {
      if (v.length === 0) { lines.push(`${pad}${key}: []`); continue; }
      lines.push(`${pad}${key}:`);
      lines.push(emitSequence(v, depth + 1, indent));
      continue;
    }
    if (typeof v === 'object') {
      if (Object.keys(v).length === 0) { lines.push(`${pad}${key}: {}`); continue; }
      lines.push(`${pad}${key}:`);
      lines.push(emitMapping(v, depth + 1, indent));
      continue;
    }
    if (typeof v === 'string' && shouldEmitBlockScalarString(v)) {
      lines.push(`${pad}${key}: |`);
      // strip trailing single newline so block content doesn't double-up
      const content = v.replace(/\n$/, '');
      for (const line of content.split('\n')) lines.push(childPad + line);
      continue;
    }
    lines.push(`${pad}${key}: ${emitValue(v, depth + 1, indent)}`);
  }
  return lines.join('\n');
}

function emitSequence(arr, depth, indent) {
  const pad = ' '.repeat(depth * indent);
  // YAML compact sequence: continuation keys indent past `- ` (2 spaces).
  const lines = [];
  for (const item of arr) {
    if (item === null || item === undefined) { lines.push(`${pad}- null`); continue; }
    if (Array.isArray(item)) {
      if (item.length === 0) { lines.push(`${pad}- []`); continue; }
      lines.push(`${pad}-`);
      lines.push(emitSequence(item, depth + 1, indent));
      continue;
    }
    if (typeof item === 'object') {
      if (Object.keys(item).length === 0) { lines.push(`${pad}- {}`); continue; }
      // If the first key has a complex value (non-empty array/mapping or
      // multi-line string), emit `-` on its own line and the full mapping
      // one level deeper. Otherwise use the compact form: first key inline
      // with `- `, remaining keys at `depth + 1`. This avoids producing the
      // "- key:\n    <nested>" pattern which forks YAML parsers around the
      // continuation indent.
      const firstKey = Object.keys(item)[0];
      const firstVal = item[firstKey];
      const firstIsComplex =
        (Array.isArray(firstVal) && firstVal.length > 0) ||
        (firstVal !== null && typeof firstVal === 'object' && Object.keys(firstVal).length > 0) ||
        (typeof firstVal === 'string' && shouldEmitBlockScalarString(firstVal));
      if (firstIsComplex) {
        lines.push(`${pad}-`);
        lines.push(emitMapping(item, depth + 1, indent));
        continue;
      }
      const mapLines = emitMapping(item, depth + 1, indent).split('\n');
      const childPad = ' '.repeat((depth + 1) * indent);
      const head = `${pad}- ` + mapLines[0].slice(childPad.length);
      lines.push(head);
      for (let i = 1; i < mapLines.length; i++) lines.push(mapLines[i]);
      continue;
    }
    if (typeof item === 'string' && shouldEmitBlockScalarString(item)) {
      lines.push(`${pad}- |`);
      const content = item.replace(/\n$/, '');
      const childPad = ' '.repeat((depth + 1) * indent);
      for (const line of content.split('\n')) lines.push(childPad + line);
      continue;
    }
    lines.push(`${pad}- ${emitValue(item, depth + 1, indent)}`);
  }
  return lines.join('\n');
}

function emitKey(k) {
  // Most keys are bare identifiers. Quote if the key would be ambiguous.
  if (typeof k !== 'string') k = String(k);
  if (k === '') return "''";
  if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(k)) return k;
  // `<<` unquoted is a merge key to the reader: a key of that name is quoted.
  if (k === '<<') return JSON.stringify(k);
  if (needsQuoting(k) || /[:#]/.test(k)) return JSON.stringify(k);
  return k;
}
