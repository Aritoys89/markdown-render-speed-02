// A self-contained Markdown renderer with no dependencies. parse() returns
// the same HTML that marked 18.1.3 produces under its default settings
// (GitHub-flavored mode on, hard breaks off). The design follows the
// CommonMark 0.31.2 and GFM 0.29 specifications, checked against marked's
// actual output. Rendering happens in two stages: first a block stage that
// walks the lines and builds a tree of containers and leaf blocks, then an
// inline stage (delimiter-stack emphasis, links, code spans, autolinks)
// that runs over each text block.

// ------------------------------------------------------------ small text tools

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escape the five characters that are special in HTML, the way marked does
// for plain text and code. One scan that copies clean stretches whole and
// only splices in an entity where one is needed.
function escapeHtml(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    let rep = '';
    if (code === 38) rep = '&amp;';
    else if (code === 60) rep = '&lt;';
    else if (code === 62) rep = '&gt;';
    else if (code === 34) rep = '&quot;';
    else if (code === 39) rep = '&#39;';
    else continue;
    out += s.slice(start, i) + rep;
    start = i + 1;
  }
  return start === 0 ? s : out + s.slice(start);
}

// A numeric character reference is only usable when it names a real scalar
// value: zero, anything past the Unicode ceiling, and the surrogate halves
// all collapse to the replacement character instead.
function decodeNumericEntity(cp) {
  const bad = !Number.isFinite(cp) || cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF);
  return bad ? '\uFFFD' : String.fromCodePoint(cp);
}
// Strip backslash escapes from a link destination or title: a backslash in
// front of an ASCII punctuation character disappears and the character
// itself stays. Done in one left-to-right pass, so a backslash-escaped '&'
// can never be mistaken for the start of a character reference later.
function decodeLinkText(raw) {
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (ch === '\\' && isAsciiPunct(next)) {
      out += next;
      i += 2;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

// Read a character reference beginning at s[i] (which holds '&'), for the
// attribute-like spots such as link destinations and titles. Only numeric
// references are recognised here; anything else is left for the caller.
// On success returns the decoded character plus how many source characters
// the reference consumed, otherwise null.
function matchEntity(s, i) {
  const n = s.length;
  let p = i + 1;
  if (p >= n || s[p] !== '#') return null;
  p++;
  let base = 10;
  if (p < n && (s[p] === 'x' || s[p] === 'X')) { base = 16; p++; }
  const digitsFrom = p;
  const digitOk = base === 16
    ? (c) => (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
    : (c) => c >= '0' && c <= '9';
  while (p < n && digitOk(s[p])) p++;
  const digits = p - digitsFrom;
  const tooMany = digits > (base === 16 ? 6 : 7);
  if (digits === 0 || tooMany || p >= n || s[p] !== ';') return null;
  const value = parseInt(s.slice(digitsFrom, p), base);
  return { text: decodeNumericEntity(value), len: p - i + 1 };
}

const ASCII_PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));

// The ASCII punctuation set from the CommonMark spec, used for backslash
// escapes and for the emphasis delimiter rules.
function isAsciiPunct(ch) {
  if (ch === undefined) return false;
  return ASCII_PUNCT.has(ch);
}

// Unicode whitespace, per the spec's list: the six ASCII whitespace
// characters plus the non-breaking space, the Ogham space mark, the
// U+2000–U+200A range, the line/paragraph separators, and the narrow
// no-break space, ideographic space and byte-order mark. Anything past the
// end of a string also counts as whitespace, which is how the emphasis
// rules treat the edges of a line.
function isWsCh(ch) {
  if (ch === undefined) return true;
  if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') return true;
  if (ch === '\u00A0' || ch === '\u1680' || ch === '\u2028' || ch === '\u2029') return true;
  if (ch === '\u202F' || ch === '\u205F' || ch === '\u3000' || ch === '\uFEFF') return true;
  return ch >= '\u2000' && ch <= '\u200A';
}

// ------------------------------------------------------------ block tree tools

// A fresh block node. `lastLineBlank` and `open` are the two pieces of
// container state the block parser maintains as it walks the lines.
function newBlock(type) {
  const node = {
    type,
    children: [],
    parent: null,
    lastLineBlank: false,
    open: true,
  };
  return node;
}

// Attach a child to a container and clear the container's blank-line flag:
// adding a child means the container has just seen a non-blank line.
function addChild(parent, child) {
  child.parent = parent;
  parent.children.push(child);
  parent.lastLineBlank = false;
  return child;
}

// The cursor that walks one source line: `pos` is the index into the raw
// line, `col` its column, and a positive `partialTab` means the tab at
// `pos` has that many columns still unconsumed.
function makeState(line) {
  return { line, pos: 0, col: 0, partialTab: 0 };
}

// Turn a run of spaces and tabs into plain spaces, with each tab jumping
// the column forward to the next multiple of four from startCol.
function expandWsRun(run, startCol) {
  let col = startCol;
  let out = '';
  let ix = 0;
  while (ix < run.length) {
    const ch = run[ix];
    if (ch === '\t') {
      const pad = 4 - (col % 4);
      out += ' '.repeat(pad);
      col += pad;
    } else {
      out += ch;
      col++;
    }
    ix++;
  }
  return out;
}

// Marked expands the whitespace run that follows a blockquote marker (tabs
// counted from just after the marker's leading spaces) before it strips
// the marker and one whitespace character. st.pos sits just past '>';
// rewrite the line accordingly and step over that one character.
function quoteSepExpand(st, leadCols) {
  const line = st.line;
  let runEnd = st.pos;
  while (runEnd < line.length && (line[runEnd] === ' ' || line[runEnd] === '\t')) runEnd++;
  if (runEnd === st.pos) return;
  const expanded = expandWsRun(line.slice(st.pos, runEnd), leadCols + 1);
  st.line = line.slice(0, st.pos) + expanded + line.slice(runEnd);
  st.pos++;
  st.col++;
}

// Consume up to maxCols columns of indentation from the cursor, honouring
// tabs (a tab is worth the columns up to the next multiple of four) and
// leaving a partially consumed tab recorded in partialTab. Returns how many
// columns were actually consumed.
function advanceIndent(st, maxCols) {
  let consumed = 0;
  if (st.partialTab > 0) {
    if (st.partialTab <= maxCols) {
      st.col += st.partialTab;
      st.pos++;
      consumed += st.partialTab;
      st.partialTab = 0;
    } else {
      st.col += maxCols;
      st.partialTab -= maxCols;
      return maxCols;
    }
  }
  while (consumed < maxCols && st.pos < st.line.length) {
    const ch = st.line[st.pos];
    if (ch === ' ') {
      st.pos++;
      st.col++;
      consumed++;
    } else if (ch === '\t') {
      const tabCols = 4 - (st.col % 4);
      if (tabCols <= maxCols - consumed) {
        st.pos++;
        st.col += tabCols;
        consumed += tabCols;
      } else {
        st.partialTab = tabCols - (maxCols - consumed);
        st.col += maxCols;
        consumed = maxCols;
      }
    } else {
      break;
    }
  }
  return consumed;
}

// How wide the whitespace run at the cursor is, in columns, and where it
// ends — without moving the cursor.
function measureIndent(st) {
  let cols = 0;
  let p = st.pos;
  let c = st.col;
  if (st.partialTab > 0) {
    cols += st.partialTab;
    p++;
    c += st.partialTab;
  }
  while (p < st.line.length) {
    const ch = st.line[p];
    if (ch === ' ') {
      cols++;
      p++;
      c++;
    } else if (ch === '\t') {
      const width = 4 - (c % 4);
      cols += width;
      p++;
      c += width;
    } else {
      break;
    }
  }
  return { cols, pos: p };
}

// The rest of the line from the cursor, with a partially consumed tab
// spelled out as the spaces it still stands for.
function remainderText(st) {
  if (st.partialTab > 0) return ' '.repeat(st.partialTab) + st.line.slice(st.pos + 1);
  return st.line.slice(st.pos);
}

// Inside a container, marked expands a tab in the leading whitespace run of
// a fenced code content line to the next multiple-of-4 column, counting
// columns from the start of the original line. startCol is the original
// column of text[0].
function leadExpand(text, stUsed) {
  if (!/^[ \t]*\t/.test(text)) return text;
  return expandLeadTab(text, stUsed.col - (stUsed.partialTab || 0));
}

function expandLeadTab(text, startCol) {
  let col = startCol;
  let i = 0;
  let out = '';
  while (i < text.length) {
    const ch = text[i];
    if (ch === ' ') {
      out += ' ';
      col++;
      i++;
    } else if (ch === '\t') {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w;
      i++;
    } else {
      break;
    }
  }
  if (i === 0) return text;
  return out + text.slice(i);
}

// True when the string holds nothing but spaces and tabs.
function isBlankText(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

// Marked post-processes every block-HTML match by dropping trailing blank
// lines: if more than one line follows the last non-blank line, the match
// is cut back to that line (and loses any trailing newline with them).
function geTrim(a) {
  const lines = a.split('\n');
  let last = lines.length - 1;
  while (last >= 0 && isBlankText(lines[last])) last--;
  if (lines.length - last <= 2) return a;
  return lines.slice(0, last + 1).join('\n');
}

const RE_ATX = /^(#{1,6})(?:[ \t]+(.*)|[ \t]*$)/;
const RE_ATX_CLOSE = /[ \t]+#+[ \t]*$/;
const RE_SETEXT = /^(=+|-+)[ \t]*$/;
const RE_HR = /^(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})[ \t]*$/;
const RE_FENCE = /^(`{3,}|~{3,})(.*)$/;

// Tag names that can open an HTML block of type 6 (the CommonMark list).
const HTML_BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem',
  'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'search',
  'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'title', 'tr', 'track', 'ul',
]);

/** Match a list marker at the token position (pos, col) of the line. The
 *  caller has already established that indentation there is at most 3. */
function matchListMarker(line, pos, col, baseCol) {
  let i = pos;
  let bullet = false; let bchar = null; let start = null; let dchar = null;
  const c0 = line[i];
  if (c0 === '*' || c0 === '+' || c0 === '-') { bullet = true; bchar = c0; i++; }
  else if (c0 >= '0' && c0 <= '9') {
    let j = i;
    while (j < line.length && line[j] >= '0' && line[j] <= '9' && j - i < 9) j++;
    if (j === i || j >= line.length || (line[j] !== '.' && line[j] !== ')')) return null;
    start = parseInt(line.slice(i, j), 10);
    dchar = line[j];
    i = j + 1;
  } else return null;
  const markerLen = i - pos;
  // Following whitespace: end of line (blank item) or 1+ spaces/tabs.
  if (i >= line.length) {
    return { bullet, bchar, start, dchar, markerLen, blankAfter: true, contentPos: i, contentCol: col + markerLen + 1, contentIndent: (col + markerLen + 1) - baseCol };
  }
  if (line[i] !== ' ' && line[i] !== '\t') return null;
  let j = i; let cj = col + markerLen; let spaces = 0;
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) {
    if (line[j] === ' ') { spaces++; cj++; j++; }
    else { const t = 4 - (cj % 4); spaces += t; cj += t; j++; }
  }
  const blankAfter = j >= line.length;
  if (blankAfter) {
    return { bullet, bchar, start, dchar, markerLen, blankAfter: true, contentPos: i, contentCol: col + markerLen + 1, contentIndent: (col + markerLen + 1) - baseCol };
  }
  if (spaces >= 1 && spaces <= 4) {
    return { bullet, bchar, start, dchar, markerLen, blankAfter: false, contentPos: j, contentCol: cj, contentIndent: cj - baseCol };
  }
  // 5+ spaces: the content is taken to begin one column after the marker.
  return { bullet, bchar, start, dchar, markerLen, blankAfter: false, contentPos: i, contentCol: col + markerLen, contentIndent: (col + markerLen + 1) - baseCol, wideSpace: true };
}

function listInterrupts(lm, inParagraph, paraInItem) {
  if (inParagraph) {
    if (lm.blankAfter) return false;
    // Marked lets an ordered list with any start number interrupt a
    // paragraph that sits inside a list item; elsewhere only 1 interrupts.
    if (!lm.bullet && lm.start !== 1 && !paraInItem) return false;
  }
  return true;
}
function sameListType(data, lm) {
  if (data.bullet !== lm.bullet) return false;
  return data.bullet ? data.char === lm.bchar : data.char === lm.dchar;
}

/** CommonMark HTML block start conditions; returns 1..7 or 0. */
function htmlBlockStart(rest, inParagraph) {
  if (rest[0] !== '<') return 0;
  if (/^<(script|pre|style|textarea)(?=[\t ]|>|$)/.test(rest)) return 1;
  if (rest.startsWith('<!--')) return 2;
  if (rest.startsWith('<?')) return 3;
  if (/^<![A-Z]/.test(rest)) return 4;
  if (rest.startsWith('<![CDATA[')) return 5;
  const m = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(rest);
  if (m && HTML_BLOCK_TAGS.has(m[1].toLowerCase())) {
    const after = rest.slice(m[0].length);
    if (/^(?:[ \t>]|\/>|$)/.test(after)) return 6;
  }
  if (!inParagraph) {
    if (/^<[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:[^ \t"'=<>`]+|'[^']*'|"[^"]*"))?)*[ \t]*\/?>[ \t]*$/.test(rest)) return 7;
    if (/^<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>[ \t]*$/.test(rest)) return 7;
  }
  return 0;
}
function htmlBlockEnd(cond, line) {
  switch (cond) {
    case 1: return /<\/(script|pre|style|textarea)>/i.test(line);
    case 2: return line.includes('-->');
    case 3: return line.includes('?>');
    case 4: return line.includes('>');
    case 5: return line.includes(']]>');
    default: return false;
  }
}

/** Marked's htmlBeginRegex test on a line whose leading spaces have been
 *  stripped: a block-level HTML beginning (list-item gathering breaks). */
function htmlBeginTest(t) {
  if (t.startsWith('<!--') || t.startsWith('<?') || t.startsWith('<![CDATA[')) return true;
  if (/^<![A-Za-z]/.test(t)) return true;
  const m = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)/.exec(t);
  if (!m) return false;
  const tag = m[2].toLowerCase();
  const after = t.slice(m[0].length);
  if (m[1] === '' && (tag === 'script' || tag === 'pre' || tag === 'style' || tag === 'textarea')) {
    return after === '' || after[0] === '>' || after[0] === ' ' || after[0] === '\t';
  }
  if (HTML_BLOCK_TAGS.has(tag)) {
    return after === '' || after[0] === ' ' || after[0] === '>' || after.startsWith('/>');
  }
  return false;
}

/** Marked's item-gathering "begin" tests (fencesBegin / headingBegin /
 *  htmlBegin / blockquoteBegin / nextBullet / hr, each allowing at most n
 *  leading spaces) on one line of an item's parent text. The lazy-branch
 *  variant tests only fence / heading / html / hr against the previous
 *  gathered line. */
function beginBreakTest(s, n, lazyOnly) {
  let lead = 0;
  while (lead < s.length && s[lead] === ' ') lead++;
  if (lead > n) return false;
  const t = s.slice(lead);
  if (t.startsWith('```') || t.startsWith('~~~')) return true;
  if (/^#{1,6}(?:[ \t]|$)/.test(t)) return true;
  if (htmlBeginTest(t)) return true;
  if (RE_HR.test(t)) return true;
  if (!lazyOnly) {
    if (t[0] === '>') return true;
    const m = /^(?:[*+-]|\d{1,9}[.)])/.exec(t);
    if (m) {
      const a = t.slice(m[0].length);
      if (a === '' || a[0] === ' ' || a[0] === '\t') return true;
    }
  }
  return false;
}

// GFM table helpers ---------------------------------------------------------

function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) {
    let bs = 0;
    for (let k = s.length - 2; k >= 0 && s[k] === '\\'; k--) bs++;
    if (bs % 2 === 0) s = s.slice(0, -1);
  }
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') { cur += '\u0001'; i++; continue; }
    if (ch === '\\' && s[i + 1] !== undefined) { cur += ch + s[i + 1]; i++; continue; }
    if (ch === '`') {
      // A backtick run starts a code span only when another run follows
      // before the next unescaped pipe; the span's pipes are not cell
      // boundaries (marked's splitter works exactly this way — an
      // unescaped pipe inside a would-be span ends the span search).
      let j = i; while (s[j] === '`') j++;
      let k = j; let close = -1;
      while (k < s.length) {
        if (s[k] === '\\') { k += 2; continue; }
        if (s[k] === '|') break;
        if (s[k] === '`') { let e = k; while (s[e] === '`') e++; close = e; break; }
        k++;
      }
      if (close === -1) { cur += s.slice(i, j); i = j - 1; continue; }
      cur += s.slice(i, close).replace(/\\\|/g, '\u0001');
      i = close - 1; continue;
    }
    if (ch === '|') { cells.push(cur); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.trim().replace(/\u0001/g, '|'));
}

function matchTableDelimiter(line) {
  if (!line.includes('|')) return null;
  const cells = splitTableRow(line);
  if (!cells) return null;
  const aligns = [];
  for (const c of cells) {
    const m = /^(:?)-+(:?)$/.exec(c.replace(/ /g, ''));
    if (!m) return null;
    aligns.push(m[1] && m[2] ? 'center' : m[2] ? 'right' : m[1] ? 'left' : null);
  }
  return aligns;
}

// The block pass ------------------------------------------------------------

function parseBlocks(src) {
  const root = newBlock('document');
  const stack = [root];
  const lines = src.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const srcEndsNl = src.endsWith('\n');

  const tip = () => stack[stack.length - 1];

  function finalize(b) {
    // Marked leaks its "top" lexer state out of a list: once a nested
    // list token completes inside an item, the rest of that item is lexed
    // with paragraph tokens (verbatim lines) instead of text assembly.
    if (b.type === 'list' && b.parent && b.parent.type === 'item') b.parent.topLeaked = true;
    if (b.type === 'code' && !b.fenced) {
      let trimmed = false;
      while (b.lines.length && isBlankText(b.lines[b.lines.length - 1])) { b.lines.pop(); trimmed = true; }
      if (trimmed) b.lastLineBlank = true;
    }
    if (b.type === 'code' && b.fenced) {
      // The trailing-blank handling lives in the render step instead.
    }
    if (b.type === 'list') {
      let loose = false;
      const items = b.children;
      for (let i = 0; i < items.length && !loose; i++) {
        const item = items[i];
        if (item.lastLineBlank && i < items.length - 1) { loose = true; break; }
        const ch = item.children;
        for (let j = 0; j < ch.length; j++) {
          if ((i < items.length - 1 || j < ch.length - 1) && endsBlank(ch[j])) { loose = true; break; }
        }
      }
      b.listData.tight = !loose;
    }
    b.open = false;
  }
  function endsBlank(b) {
    if (b.lastLineBlank) return true;
    if ((b.type === 'list' || b.type === 'item') && b.children && b.children.length) {
      return endsBlank(b.children[b.children.length - 1]);
    }
    return false;
  }
  function closeBlocks(uptoIdx) {
    while (stack.length - 1 > uptoIdx) finalize(stack.pop());
  }

  /** Decide whether an HTML block whose last line is source line li renders
   *  with a trailing newline. Marked lexes each container's text slice
   *  separately (lines joined with '\n'; a last list item's slice is also
   *  trimmed of trailing whitespace) and its HTML match keeps the block's
   *  final newline exactly when a single newline follows the block inside
   *  that slice: more slice content on the very next line, a sibling list
   *  item after exactly one blank line, or a slice that ends one newline
   *  after the block. Blank lines inside the slice are swallowed by the
   *  match and stripped again, so they always remove the newline.
   *  stackBelow is the block's parent chain (the block itself excluded). */
  function computeHtmlEofEnd(stackBelow, li) {
    const innermost = stackBelow[stackBelow.length - 1];
    let blanks = 0;
    for (let j = li + 1; j < lines.length; j++) {
      const st = makeState(lines[j]);
      let matched = true;
      let sibling = false;
      for (let si = 1; si < stackBelow.length; si++) {
        const b = stackBelow[si];
        if (b.type === 'blockquote') {
          const colBefore = st.col;
          advanceIndent(st, 3);
          if (st.partialTab === 0 && st.line[st.pos] === '>') {
            const leadCols = st.col - colBefore;
            st.pos++; st.col++;
            quoteSepExpand(st, leadCols);
          } else { matched = false; break; }
        } else if (b.type === 'item') {
          if (b.deadEmpty) { matched = false; break; }
          const snap = { line: st.line, pos: st.pos, col: st.col, partialTab: st.partialTab };
          const beforeCol = st.col;
          advanceIndent(st, b.indent);
          if (st.col - beforeCol >= b.indent || isBlankText(remainderText(st))) {
            // The line belongs to the item: slice content or a blank.
          } else {
            // The item ends here. The line still ends the item's slice on
            // the item's own terms when it opens a sibling item of the
            // same list (checked from the state before the item's indent)
            // — but only for the innermost item, the one whose slice the
            // HTML block actually sits in; a sibling of an outer item
            // ends every enclosing slice at once.
            Object.assign(st, snap);
            if (si === stackBelow.length - 1) {
              const ind = measureIndent(st);
              if (ind.cols <= 3) {
                const lm = matchListMarker(st.line, ind.pos, st.col + ind.cols, st.col);
                if (lm) {
                  for (let q = si - 1; q >= 1; q--) {
                    if (stackBelow[q].type === 'list') {
                      if (sameListType(stackBelow[q].listData, lm)) sibling = true;
                      break;
                    }
                  }
                }
              }
            }
            matched = false; break;
          }
        }
        // 'list' containers are transparent to the line scan.
      }
      if (sibling) return blanks === 1;
      if (!matched) {
        if (innermost.type === 'blockquote') return blanks === 1;
        return false; // a last list item's slice is trimmed; document never fails
      }
      const rem = remainderText(st);
      if (rem === '') { blanks++; continue; }
      // A whitespace-only or content line ends the match's newline run:
      // the block keeps its newline exactly when no pure blank line
      // intervened (the run is the line's own terminator plus blanks).
      return blanks === 0;
    }
    // Ran out of lines: the slice ends with the document / container.
    if (innermost.type === 'item') return false;
    if (innermost.type === 'blockquote') return blanks === 1;
    return blanks + (srcEndsNl ? 1 : 0) === 1;
  }

  /** The remainder of `line` after mechanically matching the container
   *  stack up to index uptoIdx (phase 1 rules, no gathering tests), or
   *  null when a container fails to match. */
  function levelRest(line, uptoIdx) {
    const st = makeState(line);
    for (let si = 1; si <= uptoIdx; si++) {
      const b = stack[si];
      if (b.type === 'blockquote') {
        const colBefore = st.col;
        advanceIndent(st, 3);
        if (st.partialTab === 0 && st.line[st.pos] === '>') {
          const leadCols = st.col - colBefore;
          st.pos++; st.col++;
          quoteSepExpand(st, leadCols);
        } else return null;
      } else if (b.type === 'item') {
        if (b.deadEmpty) return null;
        const beforeCol = st.col;
        advanceIndent(st, b.indent);
        if (st.col - beforeCol >= b.indent || isBlankText(remainderText(st))) { /* matched */ }
        else return null;
      } else if (b.type !== 'list') {
        return null;
      }
    }
    return remainderText(st);
  }

  /** The deepest list item (stack index) that marked's gathering would
   *  still include source line li in, testing items outermost-first from
   *  baseIdx and threading the line's form inward (dedent on indent
   *  inclusion, verbatim on lazy inclusion); baseIdx itself when no item
   *  above it rejects the line (or none is tested), and -1 when the
   *  previous line does not even reach baseIdx's frame. Mirrors the
   *  gathering loop of marked's list tokenizer per item: begin-breaks on
   *  the line, indent inclusion, and the lazy branch (rejected when the
   *  previous gathered line was blank, is indented code, or itself
   *  begins a fence / heading / HTML block / hr). */
  function gatherDepth(li, baseIdx, restNow) {
    let prevText = li > 0 ? levelRest(lines[li - 1], baseIdx) : null;
    if (prevText === null) return -1;
    let curText = restNow;
    let deepest = baseIdx;
    for (let si = baseIdx + 1; si < stack.length; si++) {
      const b = stack[si];
      if (b.type !== 'item') continue; // lists are transparent
      const R = b.indent;
      const n = Math.max(0, Math.min(3, R - 1));
      // The previous gathered line's form inside this item's text.
      let prevForm; let prevBlank;
      if (b.firstLine === li - 1) {
        prevForm = b.firstText || '';
        prevBlank = isBlankText(prevForm);
      } else {
        prevBlank = isBlankText(prevText);
        const zp = expandLeadTab(prevText, 0);
        prevForm = (prevBlank || zp.search(/[^ ]/) >= R) ? zp.slice(R) : prevText;
      }
      if (beginBreakTest(curText, n, false)) return deepest;
      const z = expandLeadTab(curText, 0);
      if (z.search(/[^ ]/) >= R || isBlankText(curText)) {
        curText = z.slice(R);
      } else {
        if (prevBlank) return deepest;
        if (prevForm.replace(/\t/g, '    ').search(/[^ ]/) >= 4) return deepest;
        if (beginBreakTest(prevForm, n, true)) return deepest;
        // Lazy inclusion: the line enters the item text verbatim.
      }
      prevText = prevForm;
      deepest = si;
    }
    return deepest;
  }

  /** Whether marked's list-item gathering would still include source line
   *  li in every list item enclosing the fenced code block at the stack
   *  tip, given that phase 1 matched containers only up to lastMatched.
   *  A failed block quote anywhere above the fence ends it (its text is
   *  gathered from '>'-marked lines only). */
  function fenceGatherOk(li, lastMatched, restNow) {
    const top = stack.length - 1;
    for (let si = lastMatched + 1; si < top; si++) if (stack[si].type === 'blockquote') return false;
    let deepestItem = lastMatched;
    for (let si = lastMatched + 1; si < top; si++) if (stack[si].type === 'item') deepestItem = si;
    return gatherDepth(li, lastMatched, restNow) === deepestItem;
  }

  for (let li = 0; li < lines.length; li++) {
    const rawLine = lines[li];
    const st = makeState(rawLine);

    // Phase 1: match open containers (blockquote markers, list item indents).
    let lastMatched = 0;
    let allMatched = true;
    const levelBlank = [];
    // stL mirrors st but keeps a list item's partial indent consumption when
    // the item fails to match: lazy paragraph continuations are read from it.
    const stL = { line: rawLine, pos: 0, col: 0, partialTab: 0 };
    for (let si = 1; si < stack.length; si++) {
      const b = stack[si];
      const snap = { line: st.line, pos: st.pos, col: st.col, partialTab: st.partialTab };
      const snapL = { line: stL.line, pos: stL.pos, col: stL.col, partialTab: stL.partialTab };
      if (b.type === 'blockquote') {
        const colBefore = st.col;
        advanceIndent(st, 3);
        advanceIndent(stL, 3);
        if (st.partialTab === 0 && st.line[st.pos] === '>') {
          const leadCols = st.col - colBefore;
          st.pos++; st.col++;
          stL.pos++; stL.col++;
          quoteSepExpand(st, leadCols);
          quoteSepExpand(stL, leadCols);
          lastMatched = si;
          levelBlank[si] = isBlankText(remainderText(st));
        } else { allMatched = false; Object.assign(st, snap); Object.assign(stL, snapL); break; }
      } else if (b.type === 'item') {
        if (b.deadEmpty) { allMatched = false; break; }
        const beforeCol = st.col;
        advanceIndent(st, b.indent);
        advanceIndent(stL, b.indent);
        if (st.col - beforeCol >= b.indent || isBlankText(remainderText(st))) { lastMatched = si; levelBlank[si] = isBlankText(remainderText(st)); }
        else {
          allMatched = false; Object.assign(st, snap);
          // Marked gathers item text line by line before lexing it, so a
          // line that fails this (deepest) item's indent can still be
          // gathered lazily into the item. When the stack tip is a fenced
          // code block, the fence's own continuation test then ends the
          // fence (a failed quote above it), but the item survives and
          // the line becomes item content instead of closing the list.
          const tipB = tip();
          if (tipB.type === 'code' && tipB.fenced && !isBlankText(remainderText(st)) &&
              !stack.slice(si + 1).some((x) => x.type === 'item') &&
              gatherDepth(li, si - 1, remainderText(st)) === si) {
            lastMatched = si;
            levelBlank[si] = false;
          }
          break;
        }
      } else if (b.type === 'list') {
        lastMatched = si;
        levelBlank[si] = isBlankText(remainderText(st));
      } else {
        break; // a leaf block: containers above it cannot exist
      }
    }

    let cur = tip();
    const restNow = remainderText(st);
    const blank = isBlankText(restNow);

    // A stashed whitespace-only line in a block quote (see the
    // blank-line handler) is resolved by this line: if the quote still
    // matched, its text continues past the stashed line, so the line
    // was a space that ended the paragraph; if the quote failed to
    // match, its text ended at the stashed line and the line joins.
    if (cur.type === 'paragraph' && cur.wsStash !== undefined && !blank) {
      const quoteIdx = stack.indexOf(cur.parent);
      if (lastMatched >= quoteIdx) {
        cur.wsStash = undefined;
        finalize(stack.pop());
        li--;
        continue;
      }
      // The quote's text ended at the stashed line: it joins the
      // paragraph, and the paragraph and the unmatched containers
      // close before this line — no lazy continuation can follow a
      // whitespace-only line in a block quote.
      cur.lines.push(cur.wsStash);
      cur.wsStash = undefined;
      finalize(stack.pop());
      closeBlocks(lastMatched);
      li--;
      continue;
    }

    // Deferred code-tail handling: a paragraph in a list item whose last
    // line entered as a merged indented-code token (marked assembles
    // item paragraphs from text/code token merges) interacts with the
    // lines that follow it in specific ways:
    // - Blank lines after the code line are stashed (see the blank-line
    //   handler): they join the paragraph only if another code line
    //   follows; with exactly one blank and the item text ending there,
    //   the code token still contributes a trailing newline; with two
    //   or more, it contributes nothing extra.
    // - A non-blank line that belongs to the item text right after the
    //   code line (no blank between) also leaves a trailing newline in
    //   the paragraph text (the code token's raw ends with one).
    if (cur.type === 'paragraph' && (cur.codeBlanks || cur.codeTail) && !blank) {
      let itemIdx = -1;
      for (let b = cur.parent; b; b = b.parent) {
        if (b.type === 'list') continue;
        if (b.type === 'item') itemIdx = stack.indexOf(b);
        break;
      }
      const belongs = itemIdx >= 0 && lastMatched >= itemIdx;
      if (cur.codeBlanks) {
        if (allMatched && measureIndent(st).cols >= 4) {
          for (const b of cur.codeBlanks) cur.lines.push(b);
          cur.codeBlanks = null;
        } else {
          // With exactly one blank and the item text ending there, the
          // code token's trailing newline survives — but only when the
          // item is not the list's last (marked trims the last item's
          // text). Defer: flag the paragraph; the flag is applied if a
          // sibling item is added to the same list.
          if (cur.codeBlanks.length === 1 && !belongs) cur.codeNlCandidate = true;
          cur.codeBlanks = null;
          finalize(stack.pop());
          li--;
          continue;
        }
      } else if (cur.codeTail && belongs && !(allMatched && measureIndent(st).cols >= 4)) {
        cur.lines.push('');
        cur.codeTail = false;
      }
    }

    // Leaf blocks that continue by content: fenced/indented code, HTML, table.
    if (cur.type === 'code' || cur.type === 'html' || cur.type === 'table') {
      // A fenced code block keeps consuming lines while every list item
      // enclosing it would still gather the line into its text (marked
      // gathers item text line by line before lexing it, so the fence
      // inside ends exactly where the gathering of some enclosing item
      // ends); a failed block quote always ends it.
      const fenceRunsOn = cur.type === 'code' && cur.fenced && !allMatched &&
        fenceGatherOk(li, lastMatched, restNow);
      if (!allMatched && !fenceRunsOn) {
        closeBlocks(lastMatched);
        cur = tip();
        // fall through to the general flow below with the updated tip
      } else if (cur.type === 'code' && cur.fenced) {
        const closeRe = cur.fenceChar === '`' ? /^`{3,}[ \t]*$/ : /^~{3,}[ \t]*$/;
        const m = /^ {0,3}(`+|~+)/.exec(restNow);
        if (m && m[1][0] === cur.fenceChar && m[1].length >= cur.fenceLen && closeRe.test(restNow.replace(/^ {0,3}/, ''))) {
          finalize(stack.pop());
        } else if (cur.fenceIndent) {
          // Marked's fence dedent removes min(the line's leading
          // whitespace character count, the fence's) CHARACTERS.
          let txt = restNow;
          let lead = 0;
          while (lead < txt.length && (txt[lead] === ' ' || txt[lead] === '\t')) lead++;
          const cut = Math.min(lead, cur.fenceIndent);
          txt = txt.slice(cut);
          if (stack.length > 2) {
            let col = st.col - (st.partialTab || 0);
            for (let q = 0; q < cut; q++) col += restNow[q] === '\t' ? 4 - (col % 4) : 1;
            txt = expandLeadTab(txt, col);
          }
          cur.lines.push(txt);
          if (allMatched && !isBlankText(txt)) cur.established = true;
        } else {
          let txt = restNow;
          if (stack.length > 2) txt = expandLeadTab(txt, st.col - (st.partialTab || 0));
          cur.lines.push(txt);
          if (allMatched && !isBlankText(txt)) cur.established = true;
        }
        continue;
      } else if (cur.type === 'code') {
        // indented code
        if (blank) {
          const st2 = { line: st.line, pos: st.pos, col: st.col, partialTab: st.partialTab };
          advanceIndent(st2, 4);
          cur.lines.push(remainderText(st2));
          cur.lastLineBlank = true;
          continue;
        }
        const ind = measureIndent(st);
        if (ind.cols >= 4) {
          advanceIndent(st, 4);
          cur.lines.push(remainderText(st));
          cur.lastLineBlank = false;
          continue;
        }
        finalize(stack.pop());
        cur = tip();
        // fall through: the line starts something else
      } else if (cur.type === 'html') {
        if (cur.cond >= 6 && blank) {
          finalize(stack.pop());
          continue; // the blank line itself is consumed
        }
        // Inside a container, marked's assembly of the container text
        // expands tabs in a line's leading whitespace run to the next
        // multiple-of-4 column (counted from the original line start);
        // at the top level the line stays raw.
        cur.lines.push(cur.parent && cur.parent.type !== 'document' ? leadExpand(restNow, st) : restNow);
        if (htmlBlockEnd(cur.cond, restNow)) {
          cur.eofEnd = computeHtmlEofEnd(stack.slice(0, -1), li);
          finalize(stack.pop());
        }
        continue;
      } else if (cur.type === 'table') {
        // A whitespace-only line of spaces ending in a single tab still
        // counts as a (empty) row in marked; other blank lines end it.
        if (blank && !/^ *\t$/.test(restNow)) { finalize(stack.pop()); continue; }
        // A line that starts a different block ends the table; any other
        // non-blank line is another row.
        const stripped = restNow.replace(/^ {0,3}/, '');
        let starts = false;
        if (!blank && (/^ {4}/.test(restNow) || /^ {0,3}\t/.test(restNow))) {
          // Marked's table token does not extend over an indented
          // line (four spaces, or a tab within the first three) that
          // has content after the indent.
          starts = true;
        } else if (stripped[0] === '>' || RE_ATX.test(stripped) || RE_HR.test(stripped) ||
            (stripped[0] === '<' && htmlBeginTest(stripped.replace(/^ {0,3}/, '')))) {
          starts = true;
        } else {
          const fm = RE_FENCE.exec(stripped);
          if (fm && !(fm[1][0] === '`' && fm[2].includes('`'))) starts = true;
          else if (matchListMarker(restNow, restNow.length - stripped.length, 0, 0)) starts = true;
        }
        if (!starts) {
          const cells = splitTableRow(restNow);
          while (cells.length < cur.align.length) cells.push('');
          cur.rows.push(cells.slice(0, cur.align.length));
          continue;
        }
        finalize(stack.pop());
        cur = tip();
        // fall through: the line starts something else
      }
    }

    // Blank lines close an open paragraph; containers stay open.
    if (blank && cur.type !== 'code' && cur.type !== 'html') {
      if (cur.type === 'paragraph' && cur.wsStash !== undefined) {
        // A blank line after a stashed whitespace-only line (below):
        // just count it; the next non-blank line or end of input
        // resolves the stash.
        cur.wsAfter = (cur.wsAfter || 0) + 1;
        continue;
      }
      if (cur.type === 'paragraph' && restNow !== '' && cur.parent && cur.parent.type === 'blockquote' && /^\s*>/.test(lines[li])) {
        // A whitespace-only but non-empty line in a block quote:
        // marked's paragraph tokenizer consumes it as a paragraph line
        // only when it is the last line of the quote's text; otherwise
        // it is a space that ends the paragraph. Stash it and let the
        // next line decide (see the decision point after Phase 1).
        let inItem = false;
        for (let b = cur.parent; b; b = b.parent) if (b.type === 'item') { inItem = true; break; }
        if (!inItem) { cur.wsStash = restNow; continue; }
      }
      if (cur.type === 'paragraph' && cur.codeTail && allMatched) {
        // Marked assembles an item paragraph line by line (its block
        // lexer runs with top=false inside items): a line indented 4+
        // is an indented-code token merged into the paragraph text, and
        // such a token's raw spans the blank lines that follow it when
        // another indented line comes next — but its text is trimmed of
        // trailing blank lines, so the blanks join the paragraph only
        // if a code-continuation line actually follows. Stash them on
        // the paragraph; the next line decides (see the decision point
        // after Phase 1).
        let inItem = false;
        for (let b = cur.parent; b; b = b.parent) {
          if (b.type === 'list') continue;
          inItem = b.type === 'item';
          break;
        }
        if (inItem) {
          let ws = leadExpand(restNow, st);
          ws = ws.replace(/^ {1,4}/, '');
          (cur.codeBlanks ??= []).push(ws);
          cur.lastLineBlank = true;
          continue;
        }
      }
      if (cur.type === 'paragraph' && li === lines.length - 1 && restNow !== '') {
        // A whitespace-only final line joins the paragraph (marked quirk).
        cur.lines.push(restNow);
        continue;
      }
      if (cur.type === 'paragraph') {
        cur.lastLineBlank = true;
        finalize(stack.pop());
      }
      // Mark the direct child of the deepest item this blank line belongs to
      // (blank at that item's own level) as ending blank, for looseness.
      for (let si = stack.length - 1; si >= 1; si--) {
        if (stack[si].type !== 'item' || !levelBlank[si]) continue;
        const item = stack[si];
        const child = si + 1 < stack.length ? stack[si + 1] : item.children[item.children.length - 1];
        if (child) child.lastLineBlank = true;
        else {
          item.lastLineBlank = true;
          // An item still empty when a blank line arrives is finished:
          // later indented lines no longer belong to it.
          if (item.children.length === 0) item.deadEmpty = true;
        }
        break;
      }
      // A blank line without a quote marker ends an open block quote.
      if (!allMatched) {
        let hasQuote = false;
        for (let si = lastMatched + 1; si < stack.length; si++) if (stack[si].type === 'blockquote') { hasQuote = true; break; }
        if (hasQuote) {
          closeBlocks(lastMatched);
          while (tip().type === 'list') finalize(stack.pop());
        }
      }
      continue;
    }

    // A table delimiter row converts an open paragraph's last line into a
    // table header (GFM tables interrupt paragraphs).
    if (cur.type === 'paragraph' && !blank) {
      const delim = matchTableDelimiter(restNow);
      if (delim) {
        const headerCells = splitTableRow(cur.lines[cur.lines.length - 1]);
        if (headerCells && headerCells.length === delim.length) {
          const headerLine = cur.lines.pop();
          void headerLine;
          if (cur.lines.length === 0) {
            cur.type = 'table';
            cur.align = delim; cur.header = headerCells; cur.rows = [];
            delete cur.lines;
          } else {
            const parent = cur.parent;
            finalize(stack.pop());
            const tbl = addChild(parent, newBlock('table'));
            tbl.align = delim; tbl.header = headerCells; tbl.rows = [];
            stack.push(tbl);
          }
          continue;
        }
      }
    }

    // Phase 2: open new blocks, starting from the last matched container.
    let container = stack[lastMatched];
    let closedUnmatched = false;
    let consumedLine = false;
    const ensureClosed = (keepList) => {
      if (!closedUnmatched) {
        if (!allMatched) closeBlocks(lastMatched);
        closedUnmatched = true;
      }
      if (!keepList) while (tip().type === 'list') finalize(stack.pop());
      container = tip();
    };

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const curTip = tip();
      const inPara = curTip.type === 'paragraph';
      const ind = measureIndent(st);
      const tokPos = ind.pos;
      const rest = st.line.slice(tokPos);
      if (isBlankText(rest)) break;

      // Block quote.
      if (ind.cols <= 3 && st.line[tokPos] === '>') {
        ensureClosed();
        if (tip().type === 'paragraph') finalize(stack.pop());
        advanceIndent(st, ind.cols);
        st.pos++; st.col++;
        quoteSepExpand(st, ind.cols);
        const bq = addChild(tip(), newBlock('blockquote'));
        stack.push(bq); container = bq;
        continue;
      }

      // ATX heading.
      let m;
      if (ind.cols <= 3 && (m = RE_ATX.exec(rest))) {
        ensureClosed();
        if (tip().type === 'paragraph') finalize(stack.pop());
        let content = m[2] || '';
        content = content.replace(RE_ATX_CLOSE, '').replace(/[ \t]+$/, '').replace(/^[ \t]+/, '');
        if (/^#+$/.test(content.trim())) content = '';
        const h = addChild(tip(), newBlock('heading'));
        h.level = m[1].length; h.text = content; h.open = false;
        consumedLine = true;
        break;
      }

      // Fenced code.
      if (ind.cols <= 3 && (m = RE_FENCE.exec(rest))) {
        if (m[1][0] === '`' && m[2].includes('`')) { /* not a fence */ }
        else {
          ensureClosed();
          if (tip().type === 'paragraph') finalize(stack.pop());
          const code = addChild(tip(), newBlock('code'));
          code.fenced = true; code.fenceChar = m[1][0]; code.fenceLen = m[1].length;
          // Marked strips up to the fence's own indentation from the
          // content lines of backtick fences, but not of tilde fences.
          // The count is in whitespace CHARACTERS, not columns (a tab
          // counts as one), measured on the container-stripped line.
          code.fenceIndent = m[1][0] === '`'
            ? (ind.pos - st.pos) + (st.partialTab > 0 ? st.partialTab - 1 : 0)
            : 0;
          code.info = m[2].trim();
          code.lines = [];
          stack.push(code);
          consumedLine = true;
          break;
        }
      }

      // HTML block.
      if (ind.cols <= 3) {
        const cond = htmlBlockStart(rest, inPara);
        if (cond) {
          ensureClosed();
          if (tip().type === 'paragraph') finalize(stack.pop());
          const hb = addChild(tip(), newBlock('html'));
          hb.cond = cond; hb.lines = [tip().type === 'document' ? remainderText(st) : leadExpand(remainderText(st), st)];
          if (htmlBlockEnd(cond, hb.lines[0]) && cond < 6) {
            hb.open = false;
            hb.eofEnd = computeHtmlEofEnd(stack, li);
          }
          else stack.push(hb);
          consumedLine = true;
          break;
        }
      }

      // Setext heading (only when every container matched). The conversion
      // is deferred to collectRefs: leading link reference definitions must
      // be lifted out of the heading text first.
      if (inPara && allMatched && ind.cols <= 3 && (m = RE_SETEXT.exec(rest))) {
        const para = stack.pop();
        para.setext = m[1][0] === '=' ? 1 : 2;
        para.setextLine = rest.trim();
        para.open = false;
        consumedLine = true;
        break;
      }

      // Thematic break.
      if (ind.cols <= 3 && RE_HR.test(rest)) {
        ensureClosed();
        if (tip().type === 'paragraph') finalize(stack.pop());
        const hr = addChild(tip(), newBlock('hr'));
        hr.open = false;
        consumedLine = true;
        break;
      }

      // List item.
      if (ind.cols <= 3) {
        const lm = matchListMarker(st.line, tokPos, st.col + ind.cols, st.col);
        if (lm && listInterrupts(lm, inPara && allMatched, inPara && stack.some(b => b.type === 'item'))) {
          ensureClosed(true);
          if (tip().type === 'paragraph') finalize(stack.pop());
          let list = null;
          if (tip().type === 'list' && sameListType(tip().listData, lm)) {
            list = tip();
          } else {
            if (tip().type === 'list') finalize(stack.pop());
            list = addChild(tip(), newBlock('list'));
            list.listData = { bullet: lm.bullet, char: lm.bullet ? lm.bchar : lm.dchar, start: lm.start, tight: true };
            stack.push(list);
          }
          // A previous item whose paragraph ended on a code line plus
          // exactly one blank gets its deferred trailing newline now
          // that the item turns out not to be the list's last.
          const prevItem = list.children[list.children.length - 1];
          if (prevItem) {
            const lastChild = prevItem.children[prevItem.children.length - 1];
            if (lastChild && lastChild.type === 'paragraph' && lastChild.codeNlCandidate) {
              lastChild.lines.push('');
              lastChild.codeNlCandidate = false;
            }
          }
          const item = addChild(list, newBlock('item'));
          item.indent = lm.contentIndent;
          stack.push(item); container = item;
          // Position the stream at the item's content.
          if (lm.wideSpace) {
            st.pos = tokPos + lm.markerLen; st.col = st.col + ind.cols + lm.markerLen;
            advanceIndent(st, 1);
          } else {
            st.pos = lm.contentPos; st.col = lm.contentCol;
            st.partialTab = 0;
          }
          item.firstLine = li;
          item.firstText = lm.blankAfter ? '' : remainderText(st);
          if (lm.blankAfter) { consumedLine = true; }
          // If the rest of the line is blank, the item simply stays empty.
          if (isBlankText(remainderText(st))) { consumedLine = true; break; }
          continue;
        }
      }

      // Indented code (never interrupts a paragraph).
      if (!inPara && ind.cols >= 4) {
        ensureClosed();
        advanceIndent(st, 4);
        const code = addChild(tip(), newBlock('code'));
        code.fenced = false; code.lines = [remainderText(st)];
        stack.push(code);
        consumedLine = true;
        break;
      }

      break;
    }

    if (consumedLine) continue;

    // Phase 3: the line is text for the current tip.
    const text = remainderText(st);
    cur = tip();
    if (cur.type === 'paragraph') {
      // A paragraph sitting directly in a list item follows marked's item
      // text assembly: a matched line is dedented by the item indent (st),
      // an unmatched (lazy) line is kept raw after the outer containers
      // (st, restored at the failed item) — and either way a leading run
      // of 4+ spaces loses exactly one group of 4.
      let inItemPara = false;
      for (let b = cur.parent; b; b = b.parent) {
        if (b.type === 'list') continue;
        inItemPara = b.type === 'item' && !b.topLeaked;
        break;
      }
      if (inItemPara) {
        let txt = remainderText(st);
        if (stack.length > 2) txt = leadExpand(txt, st);
        if (!allMatched) {
          // A lazy line that begins a new block (marked's item-gathering
          // begin tests) is not gathered into the item's text at all:
          // close the unmatched containers and let the line be
          // reprocessed at the level it did match.
          let itemB = null;
          for (let b = cur.parent; b; b = b.parent) {
            if (b.type === 'list') continue;
            if (b.type === 'item') itemB = b;
            break;
          }
          if (itemB) {
            const n = Math.max(0, Math.min(3, itemB.indent - 1));
            if (beginBreakTest(txt, n, false)) {
              closeBlocks(lastMatched);
              while (tip().type === 'list') finalize(stack.pop());
              li--;
              continue;
            }
          }
        }
        if (txt.startsWith('    ')) txt = txt.slice(4);
        if (!allMatched && cur.lines.length >= 2 && /^ {0,3}(=+|-+)[ \t]*$/.test(txt)) {
          let hasQuote = false;
          for (let si = lastMatched + 1; si < stack.length; si++) if (stack[si].type === 'blockquote') { hasQuote = true; break; }
          if (hasQuote) txt = '    ' + txt.replace(/^ +/, '');
        }
        // A text line joining right after a merged code line leaves the
        // code token's trailing newline behind (an empty line in the
        // paragraph text); the decision point after Phase 1 covers the
        // matched case, this covers a lazy line.
        if (cur.codeTail && !cur.codeBlanks && measureIndent(st).cols < 4) cur.lines.push('');
        cur.lines.push(txt);
        // Whether this line entered the paragraph as a merged indented
        // code token (4+ columns in the item's text): a following blank
        // line is then absorbed into the paragraph instead of ending it.
        cur.codeTail = measureIndent(st).cols >= 4;
        continue;
      }
      let lazyText = remainderText(stL);
      let lazySt = stL;
      // Whether this line is lazy for an enclosing block quote (it failed
      // to match one). Marked lexes a block quote in segments: a segment
      // break happens where a '>' line follows a non-'>' line or the other
      // way round, so a lazy line only starts a new segment when the
      // previous paragraph line was matched.
      let quoteLazy = false;
      if (!allMatched) {
        for (let si = lastMatched + 1; si < stack.length; si++) if (stack[si].type === 'blockquote') { quoteLazy = true; break; }
      }
      if (quoteLazy && (cur.quoteCodeNl || !cur.prevLazy) && measureIndent(stL).cols >= 4) {
        // A lazy segment is lexed on its own, so a lazy line indented 4+
        // in the quote's text forms an indented code token there, which
        // then merges into the open paragraph with its text dedented —
        // and keeps its trailing newline, so the next paragraph line
        // lands after a blank line.
        const stQ = { line: stL.line, pos: stL.pos, col: stL.col, partialTab: stL.partialTab };
        advanceIndent(stQ, 4);
        cur.lines.push(remainderText(stQ));
        cur.quoteCodeNl = true;
        cur.prevLazy = true;
        continue;
      }
      if (cur.quoteCodeNl) { cur.lines.push(''); cur.quoteCodeNl = false; }
      cur.prevLazy = quoteLazy;
      if (stack.length > 2) lazyText = leadExpand(lazyText, lazySt);
      if (!allMatched && cur.lines.length >= 2 && /^ {0,3}(=+|-+)[ \t]*$/.test(lazyText)) {
        // A lazy setext-underline line joining a multi-line paragraph inside
        // a block quote is captured with a 4-space prefix by marked.
        let hasQuote = false;
        for (let si = lastMatched + 1; si < stack.length; si++) if (stack[si].type === 'blockquote') { hasQuote = true; break; }
        if (hasQuote) lazyText = '    ' + lazyText.replace(/^ +/, '');
      }
      cur.lines.push(lazyText);
      continue;
    }
    if (isBlankText(text)) continue;
    if (!allMatched && !closedUnmatched) {
      // No new block started and no paragraph is open here: close the
      // unmatched containers and start fresh from the matched one.
      closeBlocks(lastMatched);
      while (tip().type === 'list') finalize(stack.pop());
      cur = tip();
    }
    if (cur.type === 'paragraph') { cur.lines.push(stack.length > 2 ? leadExpand(text, st) : text); continue; }
    // A table may start here (header line + delimiter line next).
    if (li + 1 < lines.length && stack.length <= 2) {
      const delim = matchTableDelimiter(lines[li + 1].replace(/^ {0,3}/, ''));
      if (delim) {
        const header = splitTableRow(text);
        if (header && header.length === delim.length) {
          const tbl = addChild(cur, newBlock('table'));
          tbl.align = delim; tbl.header = header; tbl.rows = [];
          stack.push(tbl);
          li++; // consume the delimiter line
          continue;
        }
      }
    }
    const para = addChild(cur, newBlock('paragraph'));
    para.lines = [stack.length > 1 ? leadExpand(text, st) : text];
    stack.push(para);
  }

  // End of input: any HTML block still open runs to the end of the source.
  // Only a top-level block's text keeps the source's final newline; inside
  // a container the slice ends with the block's last line itself.
  for (const b of stack) if (b.type === 'html') b.eofEnd = b.parent && b.parent.type === 'document' ? srcEndsNl : false;
  // A paragraph ending the input with stashed code-tail blanks just
  // drops them: the item is the list's last, and marked trims the last
  // item's text, so the code token contributes no trailing newline.
  {
    const t = tip();
    if (t.type === 'paragraph' && t.codeBlanks) t.codeBlanks = null;
    // A stashed whitespace-only line at end of input is the quote
    // text's last line: it joins the paragraph.
    if (t.type === 'paragraph' && t.wsStash !== undefined) { t.lines.push(t.wsStash); t.wsStash = undefined; }
  }
  closeBlocks(0);
  return root;
}

// Link reference definitions -------------------------------------------------

/** Parse one link reference definition at s[pos]; returns
 *  {label, dest, title, end} or null. Whitespace (with single newlines) may
 *  appear between the parts, as the spec allows within a paragraph. */
function tryParseDef(s, pos) {
  const n = s.length;
  let i = pos;
  let lead = 0;
  while (i < n && s[i] === ' ' && lead < 3) { i++; lead++; }
  if (s[i] !== '[') return null;
  i++;
  const labelStart = i;
  let labelEnd = -1;
  while (i < n) {
    const ch = s[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '[') return null;
    if (ch === ']') { labelEnd = i; break; }
    i++;
  }
  if (labelEnd === -1) return null;
  const rawLabel = s.slice(labelStart, labelEnd);
  if (rawLabel.length > 999 || rawLabel.trim() === '') return null;
  i = labelEnd + 1;
  if (s[i] !== ':') return null;
  i++;
  const skipWs = () => { while (i < n && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n')) i++; };
  skipWs();
  // Destination.
  let destRaw;
  if (s[i] === '<') {
    let j = i + 1; let ok = false;
    while (j < n) {
      const ch = s[j];
      if (ch === '\\' && isAsciiPunct(s[j + 1])) { j += 2; continue; }
      if (ch === '>') { ok = true; break; }
      if (ch === '<' || ch === '\n') return null;
      j++;
    }
    if (!ok) return null;
    destRaw = s.slice(i + 1, j);
    i = j + 1;
  } else {
    const start = i;
    let depth = 0;
    while (i < n) {
      const ch = s[i];
      if (ch === '\\' && isAsciiPunct(s[i + 1])) { i += 2; continue; }
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch < ' ') break;
      if (ch === '(') depth++;
      else if (ch === ')') { if (depth === 0) break; depth--; }
      i++;
    }
    if (i === start) return null;
    destRaw = s.slice(start, i);
  }
  const destEnd = i;
  // Optional title: first try after skipping whitespace (may cross a line).
  let title = null;
  let end = -1;
  const saveI = i;
  skipWs();
  const hadWs = i > saveI;
  const q = s[i];
  if (hadWs && (q === '"' || q === "'" || q === '(')) {
    const close = q === '(' ? ')' : q;
    let j = i + 1; let ok = false;
    while (j < n) {
      const ch = s[j];
      if (ch === '\\') { j += 2; continue; }
      if (ch === close) { ok = true; break; }
      if (q === '(' && ch === '(') { ok = false; break; }
      j++;
    }
    if (ok) {
      const titleRaw = s.slice(i + 1, j);
      let k = j + 1;
      while (k < n && (s[k] === ' ' || s[k] === '\t')) k++;
      if (k >= n || s[k] === '\n') {
        title = decodeLinkText(titleRaw);
        end = k < n ? k + 1 : k;
      }
    }
  }
  if (end === -1) {
    // No title: the definition must end right after the destination,
    // allowing only spaces/tabs before the line's end.
    let k = destEnd;
    while (k < n && (s[k] === ' ' || s[k] === '\t')) k++;
    if (k >= n || s[k] === '\n') end = k < n ? k + 1 : k;
    else return null;
  }
  void saveI;
  return {
    label: normalizeLabel(rawLabel),
    dest: decodeLinkText(destRaw),
    title,
    end,
  };
}

/** Lift link reference definitions out of every paragraph in the tree. */
function collectRefs(root, refs) {
  const processPara = (b) => {
    let text = b.lines.join('\n');
    let pos = 0;
    while (pos < text.length) {
      const d = tryParseDef(text, pos);
      if (!d) break;
      if (!refs.has(d.label)) refs.set(d.label, { dest: d.dest, title: d.title });
      pos = d.end;
    }
    text = text.slice(pos);
    if (b.setext) {
      if (text.trim() !== '') {
        b.type = 'heading';
        b.level = b.setext;
        b.text = text.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
        delete b.lines;
      } else {
        // The heading text was only definitions: the underline line itself
        // becomes paragraph text and merges with the following paragraph.
        b.lines = [b.setextLine];
        b.defOnly = false;
        b.wantMerge = true;
      }
      delete b.setext;
    } else {
      b.lines = text === '' ? [] : text.split('\n');
      b.defOnly = text === '';
    }
  };
  const walk = (b) => {
    if (b.type === 'paragraph') processPara(b);
    for (const c of b.children) walk(c);
  };
  walk(root);
  const mergePass = (b) => {
    const ch = b.children;
    for (let idx = 0; idx + 1 < ch.length; idx++) {
      if (ch[idx].wantMerge && ch[idx + 1].type === 'paragraph') {
        ch[idx].lines = ch[idx].lines.concat(ch[idx + 1].lines);
        ch.splice(idx + 1, 1);
        // The underline-turned-text merges with the one following
        // paragraph; the flag must not let it swallow every later
        // paragraph as well.
        ch[idx].wantMerge = false;
        idx--;
      }
    }
    for (const c of ch) mergePass(c);
  };
  mergePass(root);
}

// ------------------------------------------------------------- inline parsing

function normalizeLabel(raw) {
  return raw.replace(/\s+/g, ' ').trim().toLowerCase()
    .replace(/\u00DF/g, 'ss').replace(/\u017F/g, 's').replace(/\u03C2/g, '\u03C3');
}

const TAG_NAME = '[A-Za-z][A-Za-z0-9-]*';
const ATTR = "(?:\\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\\s*=\\s*(?:[^\\s\"'=<>`]+|'[^']*'|\"[^\"]*\"))?)";
const RE_OPEN_TAG = new RegExp('^<' + TAG_NAME + ATTR + '*\\s*/?>');
const RE_CLOSE_TAG = new RegExp('^</' + TAG_NAME + '\\s*>');
const RE_AUTOLINK = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*)>/;
const RE_EMAILLINK = /^<([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/;

/** Try to read inline HTML at s[i] === '<'. Returns {text, len} or null. */
// Try to read inline HTML at s[i] === '<'. Returns {text, len} or null.
function matchInlineHtml(s, i) {
  const rest = s.slice(i);
  let m;
  if ((m = RE_OPEN_TAG.exec(rest))) return { text: m[0], len: m[0].length };
  if ((m = RE_CLOSE_TAG.exec(rest))) return { text: m[0], len: m[0].length };
  // Comments: marked accepts the abruptly closed <!--> and <!--->, and
  // otherwise any content up to the first --> (even containing --).
  if (rest.startsWith('<!--')) {
    if (rest[4] === '>') return { text: '<!-->', len: 5 };
    if (rest[4] === '-' && rest[5] === '>') return { text: '<!--->', len: 6 };
    const end = rest.indexOf('-->', 4);
    if (end === -1) return null;
    return { text: rest.slice(0, end + 3), len: end + 3 };
  }
  // Processing instructions and CDATA sections each run to their own
  // terminator; a declaration (<! followed by a letter) runs to the
  // next '>'.
  const delimited = [['<?', '?>', 2], ['<![CDATA[', ']]>', 9]];
  for (const [open, close, from] of delimited) {
    if (rest.startsWith(open)) {
      const end = rest.indexOf(close, from);
      if (end === -1) return null;
      return { text: rest.slice(0, end + close.length), len: end + close.length };
    }
  }
  if (/^<![A-Za-z]/.test(rest)) {
    const end = rest.indexOf('>', 2);
    if (end !== -1) return { text: rest.slice(0, end + 1), len: end + 1 };
  }
  return null;
}

// Marked's link tokenizer validates the label against its own grammar:
// a sequence of plain runs (no brackets, backslash or backtick), escapes,
// bracket groups (whose contents may hold one level of bracketed groups,
// escapes and ordinary characters — backticks inside are ordinary), and
// code spans written as a maximal backtick run, non-backtick content and
// another maximal backtick run of any length. As a special case, a final
// run of two or more backticks right before the closing bracket is also
// acceptable. A label failing this never forms a link.
function scanLabelGroup(src, i) {
  // src[i] === '['; returns the index just past the group's ']' or -1.
  const n = src.length;
  let pos = i + 1;
  while (pos < n) {
    const ch = src[pos];
    if (ch === ']') return pos + 1;
    if (ch === '\\') {
      pos += 2;
      continue;
    }
    if (ch === '[') {
      let k = pos + 1;
      let closed = false;
      while (k < n) {
        if (src[k] === ']') { closed = true; break; }
        if (src[k] === '\\') { k += 2; continue; }
        if (src[k] === '[') return -1;
        k++;
      }
      if (!closed) return -1;
      pos = k + 1;
      continue;
    }
    pos++;
  }
  return -1;
}

// Whether a label's text is well-formed under the same grammar: escapes,
// bracket groups, HTML constructs and code spans are all consumed as
// units, and a bare ']' outside any of them fails the label.
function labelOk(src) {
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '\\') {
      i += 2;
    } else if (c === '[') {
      const end = scanLabelGroup(src, i);
      if (end === -1) return false;
      i = end;
    } else if (c === ']') {
      return false;
    } else if (c === '<') {
      const tagEnd = matchLabelTag(src, i);
      i = tagEnd === -1 ? i + 1 : tagEnd;
    } else if (c === '`') {
      // A code span: a maximal backtick run, non-backtick content, and a
      // closing run of any length. A run that reaches the end of the
      // label is only acceptable when it is two or more backticks long.
      let j = i;
      while (j < n && src[j] === '`') j++;
      if (j === n) return j - i >= 2;
      let k = j;
      while (k < n && src[k] !== '`') k++;
      if (k === n) return false;
      let e = k;
      while (e < n && src[e] === '`') e++;
      i = e;
    } else {
      i++;
    }
  }
  return true;
}

// The emphasis mask marked applies before tokenising: a bracketed label
// followed by a parenthesised tail is hidden from the emphasis scan when
// the tail matches this lax grammar (escapes, plain characters and one
// level of nested paren groups), whatever the tail's link validity.
// Returns the index just past the tail's closing ')' or -1.
function blockSkipTailEnd(s, i) {
  const n = s.length;
  let pos = i + 1;
  while (pos < n) {
    const c = s[pos];
    if (c === '\\') {
      pos += 2;
    } else if (c === '(') {
      let k = pos + 1;
      let closed = false;
      while (k < n) {
        if (s[k] === '\\') {
          k += 2;
        } else if (s[k] === ')') {
          closed = true;
          break;
        } else if (s[k] === '(') {
          return -1;
        } else {
          k++;
        }
      }
      if (!closed) return -1;
      pos = k + 1;
    } else if (c === ')') {
      return pos + 1;
    } else {
      pos++;
    }
  }
  return -1;
}

// The lax label grammar of the same mask, after marked's punctuation
// pass has normalised the label: inside a complete code span (a backtick
// run paired with the next run of exactly the same length) every inner
// backtick is hidden, so the span reads as one unit whose contents —
// brackets included — are ordinary. Outside spans, brackets break the
// match and an unpaired run breaks it too.
function blockSkipLabelOk(src) {
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '[' || c === ']') return false;
    if (c === '`') {
      let j = i;
      while (j < n && src[j] === '`') j++;
      const run = j - i;
      let closeEnd = -1;
      let k = j;
      while (k < n) {
        if (src[k] === '`') {
          let e = k;
          while (e < n && src[e] === '`') e++;
          if (e - k === run) { closeEnd = e; break; }
          k = e;
        } else {
          k++;
        }
      }
      if (closeEnd === -1) return false;
      i = closeEnd;
    } else {
      i++;
    }
  }
  return true;
}

// Parse the (destination "title") part of an inline link; s[i] === '('.
// Returns {dest, title, end} or null.
function parseInlineLink(s, i) {
  const n = s.length;
  let j = i + 1;
  const skipSpaces = () => {
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
  };
  skipSpaces();
  let destRaw;
  if (s[j] === '<') {
    // Angle-bracketed destination: no '<', newline or unescaped '>' inside.
    let k = j + 1;
    let closed = false;
    while (k < n) {
      const ch = s[k];
      if (ch === '\\' && isAsciiPunct(s[k + 1])) {
        k += 2;
      } else if (ch === '>') {
        closed = true;
        break;
      } else if (ch === '<' || ch === '\n') {
        return null;
      } else {
        k++;
      }
    }
    if (!closed) return null;
    destRaw = s.slice(j + 1, k);
    j = k + 1;
  } else {
    // Bare destination: runs to whitespace or a control character, with
    // balanced parentheses allowed and escapes honoured.
    const start = j;
    let depth = 0;
    while (j < n) {
      const ch = s[j];
      if (ch === '\\' && isAsciiPunct(s[j + 1])) {
        j += 2;
      } else if (ch === ' ' || ch === '\t' || ch === '\n' || ch < ' ') {
        break;
      } else if (ch === '(') {
        depth++;
        j++;
      } else if (ch === ')') {
        if (depth === 0) break;
        depth--;
        j++;
      } else {
        j++;
      }
    }
    destRaw = s.slice(start, j);
  }
  const hadWs = j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n');
  skipSpaces();
  let titleRaw = null;
  const q = s[j];
  // A title is only read when it was separated from the destination by
  // whitespace, or when the destination itself is empty.
  if ((q === '"' || q === "'" || q === '(') && (hadWs || destRaw === '')) {
    const close = q === '(' ? ')' : q;
    let k = j + 1;
    let closed = false;
    while (k < n) {
      const ch = s[k];
      if (ch === '\\') {
        k += 2;
      } else if (ch === close) {
        closed = true;
        break;
      } else if (q === '(' && ch === '(') {
        return null;
      } else {
        k++;
      }
    }
    if (!closed) return null;
    titleRaw = s.slice(j + 1, k);
    j = k + 1;
    skipSpaces();
  }
  if (s[j] !== ')') return null;
  return {
    dest: decodeLinkText(destRaw),
    title: titleRaw === null ? null : decodeLinkText(titleRaw),
    end: j + 1,
  };
}

// Parse a reference label starting at s[i] === '[' (the second bracket of a
// full/collapsed reference). Returns {label, end} or null.
function parseRefLabel(s, i) {
  const n = s.length;
  let j = i + 1;
  while (j < n) {
    const ch = s[j];
    if (ch === '\\') {
      j += 2;
    } else if (ch === '[') {
      return null;
    } else if (ch === ']') {
      return { label: s.slice(i + 1, j), end: j + 1 };
    } else {
      j++;
    }
  }
  return null;
}

// Character classes used by marked's emphasis rules -------------------------

const PS_RE = /[\p{P}\p{S}]/u;

// Punctuation-or-symbol in the Unicode sense (empty and undefined are not).
function isPS(c) {
  return c !== '' && c !== undefined && PS_RE.test(c);
}
function isWsC(c) {
  return c !== '' && c !== undefined && /\s/.test(c);
}
// For '*' delimiter scans (GFM rule set), '~' counts as a word character:
// it is neither punctuation nor punctuation-or-space.
function psAst(c) {
  return c !== '~' && isPS(c);
}
function psSpaceAst(c) {
  return c !== '~' && (isWsC(c) || isPS(c));
}
function notPsSpaceAst(c) {
  return c === '~' || !(isWsC(c) || isPS(c));
}
// For '_' delimiter scans the classes are the plain ones.
function psSpace(c) {
  return isWsC(c) || isPS(c);
}
function notPsSpace(c) {
  return !psSpace(c);
}
// Marked's generic "punctuation" test: whitespace, punctuation or symbol,
// but not a delimiter character itself.
function isPunctRule(c) {
  if (c === '' || c === undefined || c === '*' || c === '_') return false;
  return psSpace(c);
}

// Match an HTML construct that counts as one chunk inside a link label:
// an autolink, a comment, a processing instruction, a declaration, or a
// tag whose quoted attribute values may contain ']'. Returns the index
// just past the construct, or -1.
function matchLabelTag(text, i) {
  const n = text.length;
  if (text.startsWith('<!--', i)) {
    if (text.startsWith('<!-->', i)) return i + 5;
    if (text.startsWith('<!--->', i)) return i + 6;
    const end = text.indexOf('-->', i + 4);
    return end === -1 ? -1 : end + 3;
  }
  if (text.startsWith('<?', i)) {
    const end = text.indexOf('?>', i + 2);
    return end === -1 ? -1 : end + 2;
  }
  if (text[i + 1] === '!' && /[A-Z]/.test(text[i + 2] || '')) {
    const end = text.indexOf('>', i + 2);
    return end === -1 ? -1 : end + 1;
  }
  const rest = text.slice(i);
  const linkLike = RE_AUTOLINK.exec(rest) || RE_EMAILLINK.exec(rest);
  if (linkLike) return i + linkLike[0].length;
  let j = i + 1;
  let closing = false;
  if (text[j] === '/') {
    closing = true;
    j++;
  }
  const name = /^[A-Za-z][A-Za-z0-9-]*/.exec(text.slice(j));
  if (!name) return -1;
  j += name[0].length;
  if (closing) {
    while (j < n && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n')) j++;
    return text[j] === '>' ? j + 1 : -1;
  }
  while (j < n) {
    let ws = 0;
    while (j < n && /\s/.test(text[j])) {
      j++;
      ws++;
    }
    if (text[j] === '>') return j + 1;
    if (text[j] === '/' && text[j + 1] === '>') return j + 2;
    if (!ws) return -1;
    const attr = /^[A-Za-z_:][A-Za-z0-9_.:-]*/.exec(text.slice(j));
    if (!attr) return -1;
    j += attr[0].length;
    let k = j;
    while (k < n && (text[k] === ' ' || text[k] === '\t')) k++;
    if (text[k] === '=') {
      k++;
      while (k < n && (text[k] === ' ' || text[k] === '\t')) k++;
      const q = text[k];
      if (q === '"' || q === "'") {
        const closeQuote = text.indexOf(q, k + 1);
        if (closeQuote === -1) return -1;
        j = closeQuote + 1;
      } else {
        const val = /^[^\s"'=<>`]+/.exec(text.slice(k));
        if (!val) return -1;
        j = k + val[0].length;
      }
    }
  }
  return -1;
}

// Find the ']' that ends a link label starting at `from`, following
// marked's label grammar (see labelOk): returns its index or -1.
function findLabelEnd(text, from, blind) {
  const n = text.length;
  let i = from;
  while (i < n) {
    const c = text[i];
    if (c === '\\') {
      // In the blind scan used by the contains-link check, an escaped
      // ']' still ends the label: marked's detection of a link inside a
      // label does not honour the backslash before a closing bracket,
      // so a nested label containing '\]' reads as ending there and
      // whatever follows is not seen as that bracket's destination.
      if (blind && text[i + 1] === ']') return i + 1;
      i += 2;
    } else if (c === '[') {
      const end = scanLabelGroup(text, i);
      if (end === -1) return -1;
      i = end;
    } else if (c === ']') {
      return i;
    } else if (c === '<') {
      const tagEnd = matchLabelTag(text, i);
      i = tagEnd === -1 ? i + 1 : tagEnd;
    } else if (c === '`') {
      let j = i;
      while (j < n && text[j] === '`') j++;
      // A run of 2+ backticks directly before the closing bracket is
      // consumed as-is (marked's label grammar has a dedicated
      // alternative for it); it does not pair with a later run.
      if (j - i >= 2 && text[j] === ']') return j;
      let k = j;
      while (k < n && text[k] !== '`') k++;
      if (k === n) return -1;
      let e = k;
      while (e < n && text[e] === '`') e++;
      i = e;
    } else {
      i++;
    }
  }
  return -1;
}

// Does this text contain a link (not an image) that would form? Used for
// the no-nested-links rule: a label containing a link cannot itself be a
// link's label. Image constructs are consumed whole, so the reference
// bracket of an image is never mistaken for a link opener.
function linkInText(s, refs) {
  const n = s.length;
  let p = 0;
  while (p < n) {
    const c = s[p];
    if (c === '\\') {
      p += 2;
      continue;
    }
    if (c !== '[') {
      p++;
      continue;
    }
    const isImage = p > 0 && s[p - 1] === '!' && (p < 2 || s[p - 2] !== '\\');
    const close = findLabelEnd(s, p + 1, true);
    if (close === -1) {
      p++;
      continue;
    }
    const labelText = s.slice(p + 1, close);
    if (isImage) {
      let end = close + 1;
      if (s[end] === '(') {
        const pl = parseInlineLink(s, end);
        if (pl) end = pl.end;
      } else if (s[end] === '[') {
        const rl = parseRefLabel(s, end);
        if (rl) end = rl.end;
      }
      p = end;
      continue;
    }
    if (s[close + 1] === '(' && parseInlineLink(s, close + 1)) return true;
    if (s[close + 1] === '[') {
      const rl = parseRefLabel(s, close + 1);
      if (rl) {
        const lab = rl.label === '' ? labelText : rl.label;
        if (refs.has(normalizeLabel(lab))) return true;
        // Not a link: keep scanning inside the construct — a nested
        // bracket may still hold a link (marked's scan finds matches at
        // every position).
        p++;
        continue;
      }
    }
    if (refs.has(normalizeLabel(labelText))) return true;
    p++;
  }
  return false;
}

// Classify the bracket links a label scan (the same traversal as
// linkInText) resolves: whether any is a collapsed reference link
// ([x][]) and whether any has another form (inline, full reference, or
// shortcut). Autolinks and image constructs do not count.
function labelLinkForms(s, refs) {
  let collapsed = false;
  let other = false;
  const n = s.length;
  let p = 0;
  while (p < n) {
    const c = s[p];
    if (c === '\\') {
      p += 2;
      continue;
    }
    if (c !== '[') {
      p++;
      continue;
    }
    const isImage = p > 0 && s[p - 1] === '!' && (p < 2 || s[p - 2] !== '\\');
    const close = findLabelEnd(s, p + 1, true);
    if (close === -1) {
      p++;
      continue;
    }
    const labelText = s.slice(p + 1, close);
    if (isImage) {
      let end = close + 1;
      if (s[end] === '(') {
        const pl = parseInlineLink(s, end);
        if (pl) end = pl.end;
      } else if (s[end] === '[') {
        const rl = parseRefLabel(s, end);
        if (rl) end = rl.end;
      }
      p = end;
      continue;
    }
    if (s[close + 1] === '(' && parseInlineLink(s, close + 1)) {
      other = true;
      p = close + 1;
      continue;
    }
    if (s[close + 1] === '[') {
      const rl = parseRefLabel(s, close + 1);
      if (rl) {
        const lab = rl.label === '' ? labelText : rl.label;
        if (refs.has(normalizeLabel(lab))) {
          if (rl.label === '') collapsed = true;
          else other = true;
          p = rl.end;
          continue;
        }
        p++;
        continue;
      }
    }
    if (refs.has(normalizeLabel(labelText))) {
      other = true;
      p = close + 1;
      continue;
    }
    p++;
  }
  return { collapsed, other };
}

// Match the loose label content of a shortcut/reference bracket (escapes
// and non-bracket characters, 1..999 of them, not just whitespace before
// the end); returns the index of the closing ']' or -1.
function matchBeLabel(text, from) {
  const n = text.length;
  let i = from;
  let count = 0;
  if (/^\s*\]/.test(text.slice(from, from + 20))) return -1;
  while (i < n && count < 999) {
    const c = text[i];
    if (c === '\\') {
      i += 2;
      count++;
    } else if (c === ']') {
      return count >= 1 ? i : -1;
    } else if (c === '[') {
      return -1;
    } else {
      i++;
      count++;
    }
  }
  return -1;
}

// The emphasis mask ----------------------------------------------------------
// Before inline tokenising, marked builds a masked copy of the text (same
// length) in which regions that must be invisible to the emphasis scan are
// blanked with 'a's: reference links whose target exists, inline-link-
// shaped constructs, code spans and HTML tags. Backticks inside a code
// span are first normalised to '+' so spans read cleanly, and escaped
// punctuation becomes '++'. Returns { masked, ranges } where ranges are
// the [start, end) spans replaced by '[aaa...]' forms.
function maskText(text, refs) {
  const n = text.length;
  const arr = text.split('');
  const ranges = [];
  const blank = (a, b) => {
    if (b - a < 2) return;
    arr[a] = '[';
    for (let x = a + 1; x < b - 1; x++) arr[x] = 'a';
    arr[b - 1] = ']';
    ranges.push([a, b]);
  };
  // Pass 1: reference links and shortcut brackets whose target exists.
  if (refs.size && text.includes('[')) {
    let p = 0;
    while (p < n) {
      let start = -1; let labelStart = -1; let image = false;
      if (text[p] === '!' && text[p + 1] === '[') { start = p; labelStart = p + 2; image = true; }
      else if (text[p] === '[') { start = p; labelStart = p + 1; }
      if (start === -1) { p++; continue; }
      let matched = null;
      const le = findLabelEnd(text, labelStart);
      if (le !== -1 && text[le + 1] === '[') {
        const rl = parseRefLabel(text, le + 1);
        if (rl) matched = { end: rl.end, refName: rl.label === '' ? text.slice(labelStart, le) : rl.label, reflink: true, labelEnd: le };
      }
      if (!matched) {
        const be = matchBeLabel(text, labelStart);
        if (be !== -1 && text[be + 1] !== '(') {
          let end = be + 1;
          let refName = text.slice(labelStart, be);
          if (text[end] === '[' && text[end + 1] === ']') { end += 2; refName = ''; }
          matched = { end, refName, reflink: false, labelEnd: be };
        }
      }
      if (!matched) { p = start + 1; continue; }
      if (refs.has(normalizeLabel(matched.refName))) {
        if (matched.reflink && !image) {
          const labelPart = text.slice(labelStart, matched.labelEnd);
          if (linkInText(labelPart, refs)) {
            // Mask only the reference part; the label keeps its own mask.
            const inner = maskText(labelPart, refs);
            for (let x = 0; x < labelPart.length; x++) arr[labelStart + x] = inner.masked[x];
            for (const [a, b] of inner.ranges) ranges.push([a + labelStart, b + labelStart]);
            blank(matched.labelEnd + 1, matched.end);
          } else {
            blank(start, matched.end);
          }
        } else {
          blank(start, matched.end);
        }
      }
      p = matched.end;
    }
  }
  // Pass 2: escaped punctuation becomes '++'; backticks inside a complete
  // code span become '+' (the span's own runs stay).
  {
    let i = 0;
    while (i < n) {
      const c = arr[i];
      if (c === '\\' && i + 1 < n && isPS(arr[i + 1])) { arr[i] = '+'; arr[i + 1] = '+'; i += 2; continue; }
      if (c === '`') {
        let j = i; while (j < n && arr[j] === '`') j++;
        const run = j - i;
        let k = j; let closeEnd = -1;
        while (k < n) {
          if (arr[k] === '`') {
            let e = k; while (e < n && arr[e] === '`') e++;
            if (e - k === run) { closeEnd = e; break; }
            k = e; continue;
          }
          k++;
        }
        if (closeEnd !== -1 && closeEnd - run > j) {
          for (let x = j; x < closeEnd - run; x++) if (arr[x] === '`') arr[x] = '+';
          i = closeEnd; continue;
        }
        i = j; continue;
      }
      i++;
    }
  }
  // Pass 3: link-shaped constructs, code spans and HTML tags.
  {
    const s = arr.join('');
    let p = 0;
    while (p < n) {
      const c = s[p];
      if (c === '[') {
        // label per the lax grammar (no brackets outside spans)
        let i = p + 1; let end = -1;
        while (i < n) {
          const ch = s[i];
          if (ch === '\\') { i += 2; continue; }
          if (ch === '[') break;
          if (ch === ']') { end = i; break; }
          if (ch === '`') {
            let j = i; while (j < n && s[j] === '`') j++;
            const run = j - i;
            let k = j; let ce = -1;
            while (k < n) {
              if (s[k] === '`') { let e = k; while (e < n && s[e] === '`') e++; if (e - k === run) { ce = e; break; } k = e; continue; }
              k++;
            }
            if (ce === -1 || ce - run === j) { i = -1; break; }
            i = ce; continue;
          }
          i++;
        }
        if (end !== -1 && s[end + 1] === '(') {
          const tailEnd = blockSkipTailEnd(s, end + 1);
          if (tailEnd !== -1) { blank(p, tailEnd); p = tailEnd; continue; }
        }
        p++; continue;
      }
      if (c === '`') {
        let j = p; while (j < n && s[j] === '`') j++;
        const run = j - p;
        let k = j; let ce = -1;
        while (k < n) {
          if (s[k] === '`') { let e = k; while (e < n && s[e] === '`') e++; if (e - k === run) { ce = e; break; } k = e; continue; }
          k++;
        }
        if (ce !== -1 && ce - run > j) {
          const o = p > 0 && s[p - 1] !== '`' ? 1 : 0;
          const from = p - o;
          if (ce - from >= 2) {
            arr[from + o] = '[';
            for (let x = from + o + 1; x < ce - 1; x++) arr[x] = 'a';
            arr[ce - 1] = ']';
            ranges.push([from, ce]);
          }
          p = ce; continue;
        }
        p = j; continue;
      }
      if (c === '<' && s[p + 1] !== ' ') {
        let j = p + 1;
        while (j < n && s[j] !== '>' && s[j] !== '<') j++;
        if (j < n && s[j] === '>' && j > p + 1) { blank(p, j + 1); p = j + 1; continue; }
        p++; continue;
      }
      p++;
    }
  }
  return { masked: arr.join(''), ranges };
}

// For each delimiter character, the start index of the last run in the
// masked text that is preceded by a non-whitespace character — the last
// position at which an emphasis closer could possibly sit.
function computeLastClosers(masked) {
  const out = { '*': -1, '_': -1, '~': -1 };
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const r = masked[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    let i = s + 1; while (i < n && masked[i] === r) i++;
    const prev = s === 0 ? ' ' : masked[s - 1];
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') out[r] = s;
    s = i - 1;
  }
  return out;
}

// Classify a delimiter run in an emphasis closer scan by the characters
// around it (in the masked text): 'closer' contexts, 'open' contexts
// (nested openers that raise the count), 'g5'/'g6' (punct/word-flanked
// runs subject to extra rules) or 'skip' (no rule matches; the scan
// steps over the run).
function classifyRun(r, ctx, fol) {
  const folEnd = fol === '';
  const folWs = isWsC(fol);
  if (r === '*' || r === '~') {
    const ctxP = psAst(ctx); const ctxPS = psSpaceAst(ctx); const ctxNPS = notPsSpaceAst(ctx);
    const folPS = !folEnd && psSpaceAst(fol); const folNPS = !folEnd && notPsSpaceAst(fol);
    if (ctxP && ctx !== '\\' && (folWs || folEnd)) return 'closer';
    if (ctxNPS && (folPS || folEnd)) return 'closer';
    if (ctxPS && ctx !== '\\' && folNPS) return 'open';
    if (isWsC(ctx) && psAst(fol)) return 'open';
    if (ctxP && ctx !== '\\' && psAst(fol)) return 'g5';
    if (ctxNPS && folNPS) return 'g6';
    return 'skip';
  }
  const ctxP = isPS(ctx); const ctxPS = psSpace(ctx); const ctxNPS = notPsSpace(ctx);
  const folPS = !folEnd && psSpace(fol); const folNPS = !folEnd && notPsSpace(fol);
  if (ctxP && ctx !== '\\' && (folWs || folEnd)) return 'closer';
  if (ctxNPS && (folPS || folEnd)) return 'closer';
  if (ctxPS && ctx !== '\\' && folNPS) return 'open';
  if (isWsC(ctx) && isPS(fol)) return 'open';
  if (ctxP && ctx !== '\\' && isPS(fol)) return 'g5';
  return 'skip';
}

// The opening chunk of a closer scan can skip a region of the opposite
// delimiter's strong span that itself contains a run of ours.
const EM_SPECIAL = {
  '*': /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)/,
  '_': /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)/,
};

// Attempt marked's emphasis match at the delimiter run starting at pos in
// text (masked/lastClosers describe the same string). Returns
// { rawLen, kind, inner } with the inner source slice, or null.
function emStrongAttempt(text, masked, lastClosers, pos, prevCharIn) {
  const r = text[pos];
  const n = text.length;
  let runEnd = pos; while (runEnd < n && text[runEnd] === r) runEnd++;
  const runLen = runEnd - pos;
  const f = runEnd < n ? text[runEnd] : '';
  // Opening classification: the character after the run must be
  // punctuation (but not '~' and not the delimiter itself) or another
  // non-space character, or the run cannot open.
  const fPunct = f !== '' && f !== '~' && f !== r && isPS(f);
  const fOther = f !== '' && f !== r && !isWsC(f);
  if (!fPunct && !fOther) return null;
  // Extend left over the same character in the masked text (an attempt
  // may start mid-run after a previous failed attempt).
  let l = pos;
  while (l > 0 && masked[l - 1] === r) l--;
  const p = l > 0 ? masked[l - 1] : '';
  const h = p === '*' || p === '_' || isPunctRule(p);
  let prevChar = prevCharIn;
  let u;
  if (l < pos) { prevChar = p; u = h; } else { u = isPunctRule(prevChar); }
  if (r === '_' && fOther && /[\p{L}\p{N}]/u.test(prevChar)) return null;
  const d = fPunct ? f : '';
  if (d && prevChar !== '' && !u) return null;
  const k = runLen;
  const y = pos - l + k;
  // Marked's same-char flag uses the character actually preceding this
  // attempt's position (an attempt starting mid-run after a failed one
  // sees the run's own character), not the character before the run.
  const sameChar = prevCharIn === r;
  const R = p !== '' && !isWsC(p) && (!!d || (r === '*' && !h));
  const Q = pos + k;
  const v = lastClosers[r];
  if (v < Q) return null;
  const ee = v - Q;
  let m = k; let fsum = 0;
  let scanPos = Q;
  let first = true;
  while (true) {
    if (first) {
      first = false;
      if (r !== '~' && masked.indexOf(r === '*' ? '__' : '**', Q) !== -1) {
        const sp = EM_SPECIAL[r].exec(masked.slice(Q));
        if (sp) { scanPos = Q + sp[0].length; }
      }
    }
    let rs = -1;
    for (let x = scanPos; x < n; x++) { if (masked[x] === r) { rs = x; break; } }
    if (rs === -1) return null;
    if (rs - 1 - Q > ee) return null;
    let re = rs; while (re < n && masked[re] === r) re++;
    const b = re - rs;
    if (r === '~' && b !== k) { scanPos = re; continue; }
    const ctx = rs > 0 ? masked[rs - 1] : '';
    const fol = re < n ? masked[re] : '';
    const cls = classifyRun(r, ctx, fol);
    if (cls === 'open') { m += b; scanPos = re; continue; }
    if (cls === 'skip') { scanPos = re; continue; }
    if (cls === 'g5' || cls === 'g6') {
      if (sameChar) return null;
      if (y % 3 !== 0 && (y + b) % 3 === 0) { fsum += b; scanPos = re; continue; }
    } else if (R && y % 3 !== 0 && (y + b) % 3 === 0) {
      fsum += b; scanPos = re; continue;
    }
    m -= b;
    if (m > 0) { scanPos = re; continue; }
    const bUsed = Math.min(b, b + m + fsum);
    const rawLen = k + (rs - 1 - Q) + 1 + bUsed;
    if (r === '~') return { rawLen, kind: 'del', inner: text.slice(pos + k, pos + rawLen - bUsed) };
    const kind = Math.min(k, bUsed) % 2 === 1 ? 'em' : 'strong';
    const cut = kind === 'em' ? 1 : 2;
    return { rawLen, kind, inner: text.slice(pos + cut, pos + rawLen - cut) };
  }
}

function parseInlineNodes(text, refs, ctx) {
  const nd = []; // node list
  let tail = -1;
  // Marked leaks its inLink state across inline runs: an unclosed inline
  // <a ...> tag suppresses extended autolinks from that point on, for the
  // rest of the document, until an inline </a> appears. ctx carries it.
  let inLink = ctx ? ctx.inLink : false;
  // Marked's inRawBlock state: an inline <pre>/<code>/<kbd>/<script> start
  // tag makes following inline text render verbatim (no entity decoding,
  // no escaping) until the matching end tag. It resets for every block's
  // inline run, but is shared with nested runs (emphasis, link labels).
  let rawBlock = ctx ? !!ctx.rawBlock : false;
  // While a link or image label is being tokenised, marked's inLink
  // state disables the link rule itself: brackets inside a label never
  // form links (images still do), whatever they would form outside.
  const inLabel = ctx ? !!ctx.inLabel : false;
  // Spans of `text` in which emphasis/delimiter matching is suppressed:
  // the label of a full reference link that was rejected for containing
  // a link, when every bracket link in the label is a collapsed
  // reference link — marked leaves those labels' delimiters literal
  // when it falls back to scanning the label as ordinary text.
  const emSuppress = [];
  const emSuppressed = (pos, rawLen) => emSuppress.some(([s, e]) => pos >= s && pos + rawLen <= e);
  function push(node) {
    node.prev = tail; node.next = -1; node.parent = -1; node.gone = false;
    nd.push(node);
    const idx = nd.length - 1;
    if (tail !== -1) nd[tail].next = idx;
    tail = idx;
    return idx;
  }
  const delims = []; // indices of '~' delimiter nodes, in order
  // The emphasis mask is only needed when a delimiter run is actually
  // attempted, so it is built lazily on first use.
  let maskCache = null;
  const getMask = () => {
    if (!maskCache) {
      // Fast path: with no backslash, backtick, bracket or angle bracket
      // anywhere, no mask pass can change a character, so the masked text
      // is the text itself.
      if (!/[\\`[<]/.test(text)) {
        maskCache = { masked: text, lastClosers: computeLastClosers(text) };
      } else {
        const m = maskText(text, refs);
        maskCache = { masked: m.masked, lastClosers: computeLastClosers(m.masked) };
      }
    }
    return maskCache;
  };
  // Adopt a recursively parsed node list as the children of a new
  // container node of the given kind (link, image, em, strong).
  function adopt(sub, kind) {
    let childFirst = -1; let childLast = -1;
    const idx = nd.length + sub.nd.length;
    if (sub.nd.length && sub.head !== -1) {
      const off = nd.length;
      for (const sn of sub.nd) {
        const cp = { ...sn };
        if (cp.prev !== -1) cp.prev += off;
        if (cp.next !== -1) cp.next += off;
        if (cp.parent !== -1) cp.parent += off;
        if (cp.childFirst !== undefined && cp.childFirst !== -1) cp.childFirst += off;
        if (cp.childLast !== undefined && cp.childLast !== -1) cp.childLast += off;
        nd.push(cp);
      }
      // The effective children are the live nodes of the sub chain; a
      // spliced-out (gone) node may sit at its head.
      childFirst = sub.head + off;
      while (childFirst !== -1 && nd[childFirst].gone) childFirst = nd[childFirst].next;
      childLast = sub.tail + off;
      while (childLast !== -1 && nd[childLast].gone) childLast = nd[childLast].prev;
      if (childFirst === -1) childLast = -1;
      for (let c = childFirst; c !== -1 && c !== -1;) { const nx = nd[c].next; nd[c].parent = idx; if (c === childLast) break; c = nx; }
    }
    const node = { k: kind, prev: tail, next: -1, parent: -1, gone: false, childFirst, childLast, sealed: true };
    nd.push(node);
    if (tail !== -1) nd[tail].next = idx;
    if (childFirst !== -1) nd[childFirst].prev = idx;
    tail = idx;
    return idx;
  }

  let buf = '';
  let bufStart = 0;
  function flush() {
    if (buf !== '') {
      push({ k: 'text', s: buf, src: bufStart, srcLen: i - bufStart, il: inLink, raw: rawBlock });
      buf = '';
    }
  }

  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === '\\') {
      const nx = text[i + 1];
      if (nx === '\n') {
        // A backslash at the end of a line is part of an extended
        // autolink when a URL is in progress in the current text run —
        // unless the autolink pass will skip this run (marked's leaked
        // inLink state suppresses the url tokeniser, and the backslash
        // then forms a hard break instead).
        if (!inLink) {
          let runText = buf;
          let runStart = bufStart;
          for (let c = tail; c !== -1 && runText.length <= 2048; c = nd[c].prev) {
            const ndn = nd[c];
            if (ndn.k === 'text' && !ndn.esc && !ndn.il && ndn.src !== undefined) { runText = ndn.s + runText; runStart = ndn.src; }
            else if (ndn.k === 'delim' && ndn.len === ndn.origLen && ndn.src !== undefined) { runText = ndn.ch.repeat(ndn.len) + runText; runStart = ndn.src; }
            else break;
          }
          const um = /(?:https?:\/\/|ftp:\/\/|www\.)[^\s]*$/.exec(runText);
          if (um) {
            const before = um.index > 0 ? runText[um.index - 1] : (runStart > 0 ? text[runStart - 1] : undefined);
            if (isAutolinkBoundary(before)) { buf += ch; i++; continue; }
          }
        }
        flush(); push({ k: 'hard' }); i += 2;
        while (text[i] === ' ' || text[i] === '\t') i++;
        continue;
      }
      if (nx !== undefined && isAsciiPunct(nx)) {
        // An escaped character becomes its own text node, so that extended
        // autolinks cannot span it (marked tokenises it separately too).
        flush();
        push({ k: 'text', s: nx, src: i, srcLen: 2, esc: true });
        i += 2; continue;
      }
      if (buf === '') bufStart = i;
      buf += ch; i++; continue;
    }
    if (ch === '`') {
      let j = i; while (j < n && text[j] === '`') j++;
      const runLen = j - i;
      // find a closing run of exactly the same length
      let close = -1;
      for (let k = j; k < n;) {
        if (text[k] === '`') {
          let e = k; while (e < n && text[e] === '`') e++;
          if (e - k === runLen) { close = k; break; }
          k = e;
        } else k++;
      }
      if (close === -1) {
        if (buf === '') bufStart = i;
        buf += text.slice(i, j); i = j; continue;
      }
      flush();
      let content = text.slice(j, close).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
        content = content.slice(1, -1);
      }
      push({ k: 'code', s: content });
      i = close + runLen;
      continue;
    }
    if (ch === '&') {
      if (rawBlock) {
        // Inside a raw block the text is verbatim: no reference decoding.
        if (buf === '') bufStart = i;
        buf += ch; i++; continue;
      }
      // numeric character reference: decoded, then escaped on render
      if (text[i + 1] === '#') {
        const e = matchEntity(text, i);
        if (e) { flush(); push({ k: 'ch', s: e.text }); i += e.len; continue; }
      } else {
        // a named reference is passed through exactly as written
        const m = /^&([A-Za-z][A-Za-z0-9]*);/.exec(text.slice(i, i + 40));
        if (m) { flush(); push({ k: 'raw', s: m[0] }); i += m[0].length; continue; }
      }
      if (buf === '') bufStart = i;
      buf += ch; i++; continue;
    }
    if (ch === '<') {
      const rest = text.slice(i);
      let m;
      if ((m = RE_AUTOLINK.exec(rest))) {
        flush();
        push({ k: 'auto', href: m[1], s: m[1] });
        i += m[0].length; continue;
      }
      if ((m = RE_EMAILLINK.exec(rest))) {
        flush();
        push({ k: 'auto', href: 'mailto:' + m[1], s: m[1] });
        i += m[0].length; continue;
      }
      const html = matchInlineHtml(text, i);
      if (html) {
        flush(); push({ k: 'raw', s: html.text });
        if (/^<a /i.test(html.text)) inLink = true;
        else if (/^<\/a>$/i.test(html.text)) inLink = false;
        if (!rawBlock && /^<(pre|code|kbd|script)[\s>]/i.test(html.text)) rawBlock = true;
        else if (rawBlock && /^<\/(pre|code|kbd|script)[\s>]/i.test(html.text)) rawBlock = false;
        i += html.len; continue;
      }
      if (buf === '') bufStart = i;
      buf += ch; i++; continue;
    }
    if (ch === '[' || (ch === '!' && text[i + 1] === '[')) {
      // Marked tries the link or image at the bracket itself, before the
      // label's contents are tokenised any other way.
      const image = ch === '!';
      const labelStart = i + (image ? 2 : 1);
      const le = findLabelEnd(text, labelStart);
      let formed = null;
      const labelText = le !== -1 ? text.slice(labelStart, le) : '';
      // When a full reference link is rejected because its label
      // contains a link, and every bracket link in the label is a
      // collapsed reference link, marked's fallback scan of the label
      // leaves its emphasis delimiters literal: record the span.
      const registerEmSuppress = () => {
        if (text[le + 1] !== '[') return;
        const rl = parseRefLabel(text, le + 1);
        if (!rl) return;
        const lab = rl.label === '' ? labelText : rl.label;
        if (!refs.has(normalizeLabel(lab))) return;
        const forms = labelLinkForms(labelText, refs);
        if (forms.collapsed && !forms.other) emSuppress.push([labelStart, le]);
      };
      if (le !== -1 && (image || !inLabel)) {
        if (image || !linkInText(labelText, refs)) {
          if (text[le + 1] === '(') {
            const p = parseInlineLink(text, le + 1);
            if (p) formed = { dest: p.dest, title: p.title, end: p.end };
          }
          if (!formed && text[le + 1] === '[') {
            const rl = parseRefLabel(text, le + 1);
            if (rl) {
              const lab = rl.label === '' ? labelText : rl.label;
              const def = refs.get(normalizeLabel(lab));
              if (def) formed = { dest: def.dest, title: def.title, end: rl.end };
              else formed = 'dead';
            }
          }
          if (!formed) {
            const def = refs.get(normalizeLabel(labelText));
            if (def) formed = { dest: def.dest, title: def.title, end: le + 1 };
          }
        } else {
          registerEmSuppress();
        }
      }
      if (formed && formed !== 'dead') {
        // While a link's or image's label is tokenised, marked's inLink
        // state is set: extended autolinks do not form inside it. The
        // state used for the label is discarded when the link is done.
        // The raw-block state, by contrast, flows into the label and an
        // accepted link keeps whatever the label's tokenising left.
        const subCtx = { inLink: true, rawBlock, inLabel: !image };
        const sub = parseInlineNodes(labelText, refs, subCtx);
        // Marked rejects a (non-image) link whose label's tokenising
        // emitted a link of its own; the bracket then stays literal and
        // scanning continues inside it. The raw-block state is also
        // restored in that case. A link emitted inside an image within
        // the label does not count: the image is a sealed unit whose
        // label is tokenised with the link rule live.
        const emitsLink = sub.nd.some((node, ni) => {
          if (node.k !== 'link') return false;
          for (let p = node.parent; p !== -1; p = sub.nd[p].parent) {
            if (sub.nd[p].k === 'image') return false;
          }
          return true;
        });
        if (image || !emitsLink) {
          flush();
          rawBlock = subCtx.rawBlock;
          const idx = adopt(sub, image ? 'image' : 'link');
          nd[idx].href = formed.dest;
          nd[idx].title = formed.title;
          i = formed.end;
          continue;
        }
        if (!image) registerEmSuppress();
      }
      if (buf === '') bufStart = i;
      buf += image ? '![' : '[';
      i += image ? 2 : 1;
      continue;
    }
    if (ch === '*' || ch === '_') {
      const att = emStrongAttempt(text, getMask().masked, getMask().lastClosers, i, i > 0 ? text[i - 1] : '');
      if (att && !emSuppressed(i, att.rawLen)) {
        flush();
        if (ctx) { ctx.inLink = inLink; ctx.rawBlock = rawBlock; }
        const sub = parseInlineNodes(att.inner, refs, ctx);
        adopt(sub, att.kind);
        if (ctx) { inLink = ctx.inLink; rawBlock = ctx.rawBlock; }
        i += att.rawLen;
        continue;
      }
      if (buf === '') bufStart = i;
      buf += ch; i++; continue;
    }
    if (ch === '~') {
      let j = i; while (j < n && text[j] === ch) j++;
      if (j - i > 2) {
        // Runs of three or more tildes are literal text in marked.
        if (buf === '') bufStart = i;
        buf += text.slice(i, j); i = j; continue;
      }
      const att = emStrongAttempt(text, getMask().masked, getMask().lastClosers, i, i > 0 ? text[i - 1] : '');
      if (att && !emSuppressed(i, att.rawLen)) {
        flush();
        if (ctx) { ctx.inLink = inLink; ctx.rawBlock = rawBlock; }
        const sub = parseInlineNodes(att.inner, refs, ctx);
        adopt(sub, 'del');
        if (ctx) { inLink = ctx.inLink; rawBlock = ctx.rawBlock; }
        i += att.rawLen;
        continue;
      }
      if (buf === '') bufStart = i;
      buf += text.slice(i, j); i = j; continue;
    }
    if (ch === '\n') {
      if (/ {2,}$/.test(buf)) {
        buf = buf.replace(/[ \t]+$/, '');
        flush();
        push({ k: 'hard' });
        // Marked drops the next line's leading spaces after a hard break.
        while (text[i + 1] === ' ' || text[i + 1] === '\t') i++;
      } else {
        flush();
        push({ k: 'soft' });
      }
      i++; continue;
    }
    // ordinary text run
    if (buf === '') bufStart = i;
    let j = i;
    while (j < n && !'\\`&<![*_~\n!]'.includes(text[j])) j++;
    if (j === i) j++;
    buf += text.slice(i, j);
    i = j;
  }
  flush();
  processEmphasis(nd, delims, 0);
  // The chain head is found by walking the prev pointers back from the
  // scanner's tail (a spliced-out node can also carry prev === -1, so a
  // plain scan for it is ambiguous). The tail is then re-walked from the
  // head, since the autolink pass may have spliced the last node.
  let head = tail;
  if (head !== -1) { while (nd[head].prev !== -1) head = nd[head].prev; }
  extendAutolinks(nd, text, head);
  if (ctx) { ctx.inLink = inLink; ctx.rawBlock = rawBlock; }
  let last = head;
  if (last !== -1) { while (nd[last].next !== -1) last = nd[last].next; }
  return { nd, head, tail: last };
}

function parseInline(text, refs, ctx) {
  // Each block's inline run starts with a fresh raw-block state (marked
  // resets it for every queued inline run); the inLink leak, by contrast,
  // is document-global and is left alone.
  if (ctx) ctx.rawBlock = false;
  const { nd, head } = parseInlineNodes(text, refs, ctx);
  return renderRange(nd, head, -1);
}

/** Wrap the nodes strictly after `openerIdx` up to `lastIdx` (inclusive) in a
 *  new container node inserted where the range began. */
function wrapRange(nd, openerIdx, lastIdx, kind) {
  const first = nd[openerIdx].next;
  const empty = first === -1 || first === nd[lastIdx].next;
  const node = { k: kind, prev: openerIdx, next: nd[lastIdx].next, parent: -1, gone: false, childFirst: empty ? -1 : first, childLast: empty ? -1 : lastIdx };
  nd.push(node);
  const idx = nd.length - 1;
  if (!empty) {
    nd[first].prev = idx;
    for (let c = first; c !== -1;) { const nx = nd[c].next; nd[c].parent = idx; if (c === lastIdx) break; c = nx; }
  }
  nd[openerIdx].next = idx;
  if (node.next !== -1) nd[node.next].prev = idx;
  return idx;
}

/** Replace a bracket opener node with a link/image node whose children are
 *  the nodes that followed the opener up to lastIdx. */
function replaceWithLink(nd, openerIdx, lastIdx, kind) {
  const opener = nd[openerIdx];
  const first = opener.next;
  const empty = lastIdx === openerIdx || first === -1 || first === nd[lastIdx].next;
  const node = {
    k: kind, prev: openerIdx, next: empty ? opener.next : nd[lastIdx].next,
    parent: -1, gone: false, childFirst: empty ? -1 : first, childLast: empty ? -1 : lastIdx,
  };
  nd.push(node);
  const idx = nd.length - 1;
  opener.gone = true;
  opener.next = idx;
  if (node.next !== -1) nd[node.next].prev = idx;
  if (!empty) {
    nd[first].prev = idx;
    for (let c = first; c !== -1;) { const nx = nd[c].next; nd[c].parent = idx; if (c === lastIdx) break; c = nx; }
  }
  return idx;
}

/** The delimiter-stack emphasis algorithm. Only delimiter entries at stack
 *  positions >= bottomPos are considered; when a link forms, emphasis inside
 *  it is resolved with bottomNode set to the link's opening bracket node. */
function processEmphasis(nd, delims, bottomPos) {
  let ci = bottomPos;
  const findNextCloser = (from) => {
    let k = from;
    while (k < delims.length && !nd[delims[k]].canClose) k++;
    return k;
  };
  ci = findNextCloser(ci);
  while (ci < delims.length) {
    const closer = nd[delims[ci]];
    let oi = -1;
    for (let k = ci - 1; k >= bottomPos; k--) {
      const o = nd[delims[k]];
      if (o.ch !== closer.ch || !o.canOpen || o.gone) continue;
      if (closer.ch !== '~' && (closer.canOpen || o.canClose) &&
          (o.len + closer.len) % 3 === 0 && !(o.len % 3 === 0 && closer.len % 3 === 0)) continue;
      oi = k; break;
    }
    if (oi === -1) {
      if (!closer.canOpen) { delims.splice(ci, 1); }
      else ci++;
      ci = findNextCloser(ci);
      continue;
    }
    const opener = nd[delims[oi]];
    const use = opener.len >= 2 && closer.len >= 2 ? 2 : 1;
    const kind = closer.ch === '~' ? 'del' : use === 2 ? 'strong' : 'em';
    wrapRange(nd, delims[oi], nd[delims[ci]].prev, kind);
    // Drop the delimiters that were inside the wrapped range.
    delims.splice(oi + 1, ci - oi - 1);
    opener.len -= use; closer.len -= use;
    ci = oi + 1;
    if (closer.len === 0) { closer.gone = true; delims.splice(ci, 1); }
    if (opener.len === 0) { opener.gone = true; delims.splice(oi, 1); ci--; }
    ci = findNextCloser(ci);
  }
}

// GFM extended autolinks, applied to plain text nodes outside links ---------

// Whether the character before a candidate counts as a word boundary for
// the extended-autolink rules: the start of the text, any whitespace, or
// one of the opening punctuation marks.
function isAutolinkBoundary(prevCh) {
  if (prevCh === undefined) return true;
  if (isWsCh(prevCh)) return true;
  return '*_~([{\'"<'.includes(prevCh);
}

// A domain is usable when it has at least two dot-separated labels, none
// of them empty, none starting or ending with a hyphen, and every label
// made only of letters, digits and hyphens (underscores allowed in
// non-final labels when the caller says so).
function validDomain(domain, allowUnderscore) {
  if (!domain) return false;
  if (domain.includes('..')) return false;
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (label === '') return false;
    const last = i === labels.length - 1;
    const allowed = allowUnderscore && !last ? /^[A-Za-z0-9_-]+$/ : /^[A-Za-z0-9-]+$/;
    if (!allowed.test(label)) return false;
    if (label[0] === '-' || label[label.length - 1] === '-') return false;
  }
  return true;
}

// Trim a candidate extended-autolink the way marked does. Walk it in
// chunks — plain runs, balanced (...) groups, a lone & that does not begin
// an entity running to the end, and punctuation runs that do not reach
// the end — and keep only the matched prefix.
function trimAutolink(s) {
  const TRAIL = '?!.,:;*_\'"~)';
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (c === '(') {
      const close = s.indexOf(')', i);
      if (close === -1) break;
      i = close + 1;
      continue;
    }
    if (c === '&') {
      if (/^[A-Za-z0-9]+;$/.test(s.slice(i + 1))) break;
      i++;
      continue;
    }
    if (TRAIL.includes(c)) {
      let j = i;
      while (j < n && TRAIL.includes(s[j])) j++;
      if (j === n) break;
      i = j;
      continue;
    }
    let j = i;
    while (j < n && s[j] !== '(' && s[j] !== '&' && !TRAIL.includes(s[j])) j++;
    i = j;
  }
  return s.slice(0, i);
}

const RE_EMAIL_EXT = /^([\w.+-]+)@((?:[\w-]+\.)+[\w-]*[A-Za-z0-9])(?![\w-])/;

// Split one text node's string into plain runs and extended-autolink
// segments. Marked's URL tokeniser fires on a scheme at any position,
// even mid-word; the www. form needs a boundary before it.
function splitAutolinks(s, srcBefore) {
  const out = [];
  let buf = '';
  let pos = 0;
  const charBefore = (at) => (at > 0 ? s[at - 1] : srcBefore);
  const flushText = () => {
    if (buf) {
      out.push({ t: 'text', s: buf });
      buf = '';
    }
  };
  while (pos < s.length) {
    const boundary = isAutolinkBoundary(charBefore(pos));
    const head = s.slice(pos, pos + 8).toLowerCase();
    let kind = '';
    let schemeLen = 0;
    if (head.startsWith('https://')) { kind = 'url'; schemeLen = 8; }
    else if (head.startsWith('http://')) { kind = 'url'; schemeLen = 7; }
    else if (head.startsWith('ftp://')) { kind = 'url'; schemeLen = 6; }
    else if (boundary && s.startsWith('www.', pos)) { kind = 'www'; }
    if (kind) {
      let end = pos;
      while (end < s.length && !isWsCh(s[end]) && s[end] !== '<') end++;
      const candidate = trimAutolink(s.slice(pos, end));
      // After the scheme or www. prefix, marked's pattern needs a domain
      // label character at the start; the rest of the candidate is free-form.
      const tail = kind === 'url' ? candidate.slice(schemeLen) : candidate.slice(4);
      if (tail && /[A-Za-z0-9_-]/.test(tail[0])) {
        flushText();
        const href = kind === 'www' ? 'http://' + candidate : candidate;
        out.push({ t: 'auto', s: candidate, href });
        pos += candidate.length;
        continue;
      }
    } else {
      // Email, attempted at any position: marked's local part is word
      // characters plus '.', '+' and '-', its domain dot-joined word or
      // hyphen segments. A mailto: or xmpp: prefix is part of the link
      // only at a boundary (xmpp allows one /resource segment after).
      let prefix = '';
      if (boundary) {
        if (s.startsWith('mailto:', pos)) prefix = 'mailto:';
        else if (s.startsWith('xmpp:', pos)) prefix = 'xmpp:';
      }
      const em = RE_EMAIL_EXT.exec(s.slice(pos + prefix.length));
      if (em) {
        let total = prefix + em[0];
        if (prefix === 'xmpp:' && s[pos + total.length] === '/') {
          const res = /^[A-Za-z0-9@.]+/.exec(s.slice(pos + total.length + 1));
          if (res && res[0].length) total += '/' + res[0];
        }
        const after = s[pos + total.length];
        const blocked = after !== undefined && /[\w-]/.test(after);
        if (!blocked) {
          flushText();
          const href = prefix ? total : 'mailto:' + total;
          out.push({ t: 'auto', s: total, href });
          pos += total.length;
          continue;
        }
      }
    }
    buf += s[pos];
    pos++;
  }
  flushText();
  return out;
}

function extendAutolinks(nd, srcText, head) {
  if (head === -1) return;
  // Collect runs of source-contiguous text nodes and untouched delimiter
  // nodes: an extended autolink may span them (e.g. an email whose local
  // part contains underscores, which the scanner made delimiter nodes).
  const runs = [];
  const srcLen = (node) => node.srcLen !== undefined ? node.srcLen : node.s.length;
  const mergeable = (node, inLink) => !inLink && !node.gone && !node.esc && !node.il &&
    (node.k === 'text' || (node.k === 'delim' && node.len === node.origLen));
  const walk = (first, last, inLink, top) => {
    let run = [];
    const flushRun = () => { if (run.length) { runs.push({ nodes: run, top }); run = []; } };
    for (let c = first; c !== -1;) {
      const node = nd[c];
      const nx = node.next;
      if (mergeable(node, inLink)) {
        if (run.length) {
          const prev = nd[run[run.length - 1]];
          if (node.src !== prev.src + srcLen(prev)) flushRun();
        }
        run.push(c);
      } else {
        flushRun();
        if ((node.k === 'em' || node.k === 'strong' || node.k === 'del' || node.k === 'link' || node.k === 'image') && node.childFirst !== -1 && !node.sealed) {
          walk(node.childFirst, node.childLast, inLink || node.k === 'link', false);
        }
      }
      if (c === last) break;
      c = nx;
    }
    flushRun();
  };
  walk(head, -2, false, true);
  // The source text of the sibling node that follows a run, when an
  // extended-autolink candidate may run on into it: marked's url
  // tokeniser scans the raw source, blind to the link, image or code
  // constructs the scanner has already made of that source, so the
  // candidate is the maximal non-space run across those constructs and
  // is trimmed only once, at its very end. Returns null when the
  // sibling's source cannot be recovered in this text frame.
  const ghostText = (node, endOff) => {
    if (node.k === 'text') {
      if (node.esc || node.raw || node.s === '' || /\s/.test(node.s[0])) return null;
      return node.s;
    }
    if (node.k === 'delim') {
      if (node.len !== node.origLen) return null;
      return node.ch.repeat(node.len);
    }
    if (node.k === 'link' || node.k === 'image') {
      const image = node.k === 'image';
      if (srcText[endOff] !== (image ? '!' : '[')) return null;
      if (image && srcText[endOff + 1] !== '[') return null;
      const le = findLabelEnd(srcText, endOff + (image ? 2 : 1));
      if (le === -1) return null;
      let end;
      if (srcText[le + 1] === '(') {
        const p = parseInlineLink(srcText, le + 1);
        if (!p) return null;
        end = p.end;
      } else if (srcText[le + 1] === '[') {
        const rl = parseRefLabel(srcText, le + 1);
        if (!rl) return null;
        end = rl.end;
      } else end = le + 1;
      return srcText.slice(endOff, end);
    }
    if (node.k === 'code') {
      if (srcText[endOff] !== '`') return null;
      let j = endOff;
      while (j < srcText.length && srcText[j] === '`') j++;
      const runLen = j - endOff;
      for (let k = j; k < srcText.length;) {
        if (srcText[k] === '`') {
          let e = k;
          while (e < srcText.length && srcText[e] === '`') e++;
          if (e - k === runLen) return srcText.slice(endOff, e);
          k = e;
        } else k++;
      }
      return null;
    }
    return null;
  };
  for (const run of runs) {
    const firstNode = nd[run.nodes[0]];
    if (firstNode.gone) continue;
    let nodes = run.nodes;
    let combined = nodes.map((ix) => {
      const ndn = nd[ix];
      return ndn.k === 'text' ? ndn.s : ndn.ch.repeat(ndn.len);
    }).join('');
    const srcBefore = firstNode.src > 0 ? srcText[firstNode.src - 1] : undefined;
    // Fast reject: without any autolink-shaped substring the run cannot
    // produce a link, so the detailed scan is skipped entirely.
    if (!/www\.|https?:|ftp:|mailto:|xmpp:|@/i.test(combined)) continue;
    let segs = splitAutolinks(combined, srcBefore);
    if (run.top) {
      // Absorb following siblings into the candidate while the run's
      // last autolink reaches the end of the text scanned so far (the
      // tail after it holding no whitespace or '<'), then re-split.
      let endOff = -1;
      for (;;) {
        let autoEnd = -1; let pos = 0;
        for (const sg of segs) {
          if (sg.t === 'auto') autoEnd = pos + sg.s.length;
          pos += sg.s.length;
        }
        if (autoEnd === -1) break;
        if (/[\s<]/.test(combined.slice(autoEnd))) break;
        const lastIdx = nodes[nodes.length - 1];
        const sib = nd[lastIdx].next;
        if (sib === -1 || nd[sib].gone) break;
        if (endOff === -1) {
          const ln = nd[lastIdx];
          if (ln.src === undefined) break;
          endOff = ln.src + srcLen(ln);
        }
        const ghost = ghostText(nd[sib], endOff);
        if (ghost === null || ghost === '') break;
        nodes = [...nodes, sib];
        combined += ghost;
        endOff += ghost.length;
        segs = splitAutolinks(combined, srcBefore);
      }
    }
    if (segs.length === 1 && segs[0].t === 'text') continue;
    const lastNode = nd[nodes[nodes.length - 1]];
    const parent = firstNode.parent;
    const isFirstChild = parent !== -1 && nd[parent].childFirst === nodes[0];
    let prevIdx = firstNode.prev;
    let firstNew = -1;
    for (const seg of segs) {
      const nn = seg.t === 'text'
        ? { k: 'text', s: seg.s, src: firstNode.src, prev: prevIdx, next: -1, parent: firstNode.parent, gone: false }
        : { k: 'auto', s: seg.s, href: seg.href, prev: prevIdx, next: -1, parent: firstNode.parent, gone: false };
      nd.push(nn);
      const ni = nd.length - 1;
      if (prevIdx !== -1 && !(isFirstChild && prevIdx === parent)) nd[prevIdx].next = ni;
      if (firstNew === -1) firstNew = ni;
      prevIdx = ni;
    }
    nd[prevIdx].next = lastNode.next;
    if (lastNode.next !== -1) nd[lastNode.next].prev = prevIdx;
    for (const ix of nodes) nd[ix].gone = true;
    firstNode.next = firstNew; // keep head-of-chain traversal working when prev was -1
    if (firstNode.parent !== -1) {
      const p = nd[firstNode.parent];
      if (p.childFirst === nodes[0]) p.childFirst = firstNew;
      if (p.childLast === nodes[nodes.length - 1]) p.childLast = prevIdx;
    }
  }
}

// Inline rendering ------------------------------------------------------------

// Escape a value for a double-quoted attribute, marked-style: an
// ampersand that already introduces a character-reference-shaped sequence
// is left alone; every other & becomes &amp;.
function escAttr(s) {
  const ampFixed = s.replace(/&(?!(?:#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);)/g, '&amp;');
  return ampFixed.replace(/[<>"']/g, (c) => ESCAPE_MAP[c]);
}

// Encode a link destination for an href/src attribute: percent-encode it,
// then undo the encoding of a literal '%' (marked keeps % as-is), and
// finally escape it for the attribute. If encoding throws, fall back to
// escaping the raw destination.
function encodeHref(h) {
  try {
    const encoded = encodeURI(h).replace(/%25/g, '%');
    return escAttr(encoded);
  } catch {
    return escAttr(h);
  }
}

// The plain-text alternative for an image: walk the node's children in
// order, taking the text of text/code/character nodes, a newline for soft
// and hard breaks, the literal delimiter characters, and the bracket or
// autolink text, recursing into containers.
function altText(nd, first, last) {
  let out = '';
  let c = first;
  while (c !== -1) {
    const node = nd[c];
    if (!node.gone) {
      if (node.k === 'text' || node.k === 'ch' || node.k === 'code') {
        out += node.s;
      } else if (node.k === 'soft' || node.k === 'hard') {
        out += '\n';
      } else if (node.k === 'delim') {
        out += node.ch.repeat(node.len);
      } else if (node.k === 'bracket' || node.k === 'auto') {
        out += node.s;
      } else if (node.childFirst !== undefined && node.childFirst !== -1) {
        out += altText(nd, node.childFirst, node.childLast);
      }
    }
    if (c === last) break;
    c = node.next;
  }
  return out;
}

// Render the inline nodes from first to last (linked by .next) into HTML.
function renderRange(nd, first, last) {
  let out = '';
  let c = first;
  while (c !== -1) {
    const node = nd[c];
    if (!node.gone) out += renderNode(nd, node);
    if (c === last) break;
    c = node.next;
  }
  return out;
}

// Render one inline node. Container nodes render their children between
// their open and close tags.
function renderNode(nd, node) {
  const kind = node.k;
  if (kind === 'text') return node.raw ? node.s : escapeHtml(node.s);
  if (kind === 'raw') return node.s;
  if (kind === 'ch') return escapeHtml(node.s);
  if (kind === 'code') return `<code>${escapeHtml(node.s)}</code>`;
  if (kind === 'soft') return '\n';
  if (kind === 'hard') return '<br>';
  if (kind === 'delim') return node.ch.repeat(node.len);
  if (kind === 'bracket') return node.s;
  if (kind === 'em') return `<em>${renderRange(nd, node.childFirst, node.childLast)}</em>`;
  if (kind === 'strong') return `<strong>${renderRange(nd, node.childFirst, node.childLast)}</strong>`;
  if (kind === 'del') return `<del>${renderRange(nd, node.childFirst, node.childLast)}</del>`;
  if (kind === 'auto') return `<a href="${encodeHref(node.href)}">${escapeHtml(node.s)}</a>`;
  if (kind === 'link') {
    const titleAttr = node.title !== null && node.title !== undefined
      ? ` title="${escAttr(node.title)}"` : '';
    const inner = renderRange(nd, node.childFirst, node.childLast);
    return `<a href="${encodeHref(node.href)}"${titleAttr}>${inner}</a>`;
  }
  if (kind === 'image') {
    const titleAttr = node.title !== null && node.title !== undefined
      ? ` title="${escAttr(node.title)}"` : '';
    const alt = escAttr(altText(nd, node.childFirst, node.childLast));
    return `<img src="${encodeHref(node.href)}" alt="${alt}"${titleAttr}>`;
  }
  return '';
}

// Render every top-level block of the document in order.
function renderBlocks(root, refs, ctx) {
  let out = '';
  for (const child of root.children) out += renderBlock(child, refs, false, ctx);
  return out;
}

// Render one block node. `tight` is true inside a tight list, where
// paragraphs lose their <p> wrapper.
function renderBlock(b, refs, tight, ctx) {
  const type = b.type;
  if (type === 'paragraph') {
    if (b.defOnly) return '';
    const content = parseInline(b.lines.join('\n'), refs, ctx);
    return tight ? content : `<p>${content}</p>\n`;
  }
  if (type === 'heading') {
    const content = parseInline(b.text, refs, ctx);
    return `<h${b.level}>${content}</h${b.level}>\n`;
  }
  if (type === 'code') {
    // The content is the raw text between the fences: drop exactly one
    // trailing newline, then make sure a non-empty result still ends with
    // one.
    let content = b.lines.length ? b.lines.join('\n') + '\n' : '';
    if (content.endsWith('\n')) content = content.slice(0, -1);
    if (content !== '' && !content.endsWith('\n')) content += '\n';
    let lang = '';
    if (b.fenced && b.info) {
      const firstWord = decodeLinkText(b.info.split(/\s+/)[0]);
      lang = ` class="language-${escAttr(firstWord)}"`;
    }
    return `<pre><code${lang}>${escapeHtml(content)}</code></pre>\n`;
  }
  if (type === 'html') {
    return geTrim(b.lines.join('\n') + (b.eofEnd ? '\n' : ''));
  }
  if (type === 'hr') return '<hr>\n';
  if (type === 'blockquote') {
    let out = '<blockquote>\n';
    for (const child of b.children) out += renderBlock(child, refs, false, ctx);
    return out + '</blockquote>\n';
  }
  if (type === 'list') {
    const data = b.listData;
    const tag = data.bullet ? 'ul' : 'ol';
    const numbered = !data.bullet && data.start !== null && data.start !== 1;
    const startAttr = numbered ? ` start="${data.start}"` : '';
    let out = `<${tag}${startAttr}>\n`;
    for (const item of b.children) out += renderItem(item, refs, data, ctx);
    return out + `</${tag}>\n`;
  }
  if (type === 'table') {
    let out = '<table>\n<thead>\n<tr>\n';
    b.header.forEach((cell, i) => {
      const alignAttr = b.align[i] ? ` align="${b.align[i]}"` : '';
      out += `<th${alignAttr}>${parseInline(cell, refs, ctx)}</th>\n`;
    });
    out += '</tr>\n</thead>\n';
    if (b.rows.length) {
      out += '<tbody>';
      for (const row of b.rows) {
        out += '<tr>\n';
        row.forEach((cell, i) => {
          const alignAttr = b.align[i] ? ` align="${b.align[i]}"` : '';
          out += `<td${alignAttr}>${parseInline(cell, refs, ctx)}</td>\n`;
        });
        out += '</tr>\n';
      }
      out += '</tbody>';
    }
    return out + '</table>\n';
  }
  return '';
}

// Render one list item. In a bullet list, a first-child paragraph that
// opens with a task marker ([ ] or [x]) becomes a checkbox followed by
// the rest of the paragraph's inline content.
function renderItem(item, refs, listData, ctx) {
  const tight = listData.tight;
  let inner = '';
  let checked = null;
  for (let ci = 0; ci < item.children.length; ci++) {
    const child = item.children[ci];
    if (ci === 0 && listData.bullet && child.type === 'paragraph' && !child.defOnly) {
      const text = child.lines.join('\n');
      const m = /^\[([ xX])\] /.exec(text);
      if (m) {
        checked = m[1] !== ' ';
        const rest = text.slice(4);
        const content = parseInline(rest, refs, ctx);
        const box = checkboxHtml(checked);
        inner += tight ? `${box} ${content}` : `<p>${box} ${content}</p>\n`;
        continue;
      }
    }
    const childTight = child.type === 'paragraph' ? tight : false;
    inner += renderBlock(child, refs, childTight, ctx);
  }
  return `<li>${inner}</li>\n`;
}

// The checkbox input marked emits for a task list item.
function checkboxHtml(checked) {
  if (checked) return '<input checked="" disabled="" type="checkbox">';
  return '<input disabled="" type="checkbox">';
}

// Entry point -----------------------------------------------------------------

// Render a Markdown string to HTML, exactly as marked 18.1.3 does with
// its default options. Line endings are normalised to \n first; then the
// block pass builds the tree, link reference definitions are lifted out
// of the paragraphs, and the tree is rendered to HTML.
export function parse(markdown) {
  const normalized = String(markdown).replace(/\r\n?/g, '\n');
  const root = parseBlocks(normalized);
  const refs = new Map();
  collectRefs(root, refs);
  return renderBlocks(root, refs, { inLink: false });
}
