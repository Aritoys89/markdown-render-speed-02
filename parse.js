// A dependency-free Markdown-to-HTML renderer: parse(markdown) returns the HTML
// that marked 18.1.3 renders with its default options (GFM on, breaks off).
// Written from the CommonMark 0.31.2 and GFM 0.29 specifications and tuned
// against marked's observable output. Two passes: a block pass that matches
// container blocks line by line and accumulates leaf blocks, then an inline
// pass (delimiter-stack emphasis, links, code spans, autolinks) per text block.

// ------------------------------------------------------------- text helpers

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape the five HTML-significant characters, as marked does for text/code. */
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ESCAPE_MAP[c]);
}

const C1_MAP = [0x20AC, 0x81, 0x201A, 0x192, 0x201E, 0x2026, 0x2020, 0x2021, 0x2C6, 0x2030, 0x160, 0x2039, 0x152, 0x8D, 0x17D, 0x8F, 0x90, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x2DC, 0x2122, 0x161, 0x203A, 0x153, 0x9D, 0x17E, 0x178];

/** Decode a numeric character reference value the way HTML requires. */
function decodeNumericEntity(cp) {
  if (!Number.isFinite(cp) || cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '\uFFFD';
  return String.fromCodePoint(cp);
}

// The HTML5 named character references: keys are the name with a trailing ';'
// for the full form, or bare for the legacy forms HTML allows without one.

/** Decode entities and backslash escapes in a link destination or title.
 *  One pass: a backslash-escaped '&' never starts a reference. */
function decodeLinkText(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\\' && i + 1 < raw.length && isAsciiPunct(raw[i + 1])) { out += raw[i + 1]; i++; continue; }
    out += ch;
  }
  return out;
}

/** Try to read a character reference at s[i] === '&' for attribute-like
 *  contexts (destinations, titles). Returns {text, len} or null. */
function matchEntity(s, i) {
  const n = s.length;
  let j = i + 1;
  if (j >= n) return null;
  if (s[j] === '#') {
    j++;
    let hex = false;
    if (j < n && (s[j] === 'x' || s[j] === 'X')) { hex = true; j++; }
    const start = j;
    if (hex) { while (j < n && /[0-9a-fA-F]/.test(s[j])) j++; }
    else { while (j < n && s[j] >= '0' && s[j] <= '9') j++; }
    if (j === start || j - start > (hex ? 6 : 7) || j >= n || s[j] !== ';') return null;
    return { text: decodeNumericEntity(parseInt(s.slice(start, j), hex ? 16 : 10)), len: j - i + 1 };
  }
  return null;
}

const ASCII_PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));
function isAsciiPunct(ch) { return ch !== undefined && ASCII_PUNCT.has(ch); }

const UNICODE_PUNCT_RE = /[\u2000-\u2FFF\u00A1-\u00BF\u00D7\u00F7\u0387\u055A-\u055F\u0589\u05C0\u05C3\u05C6\u05F3\u05F4\u0610-\u061A\u0640\u065F\u06DD\u06DE\u06E9\u070F\u074A\u07B1\u07EA\u07FD\u07FE\u0830-\u083E\u0859\u085B\u08E2\u0964\u0965\u0970\u09F4-\u09FE\u0A76\u0AF0\u0B70\u0C77\u0C84\u0D4E\u0D79\u0DF4\u0E4F\u0E5A\u0E5B\u0F04-\u0F12\u0F85\u0FD0-\u0FD4\u0FD9\u0FDA\u104A-\u104F\u109F\u10FB\u1360-\u1368\u166D\u166E\u169B\u169C\u16EB-\u16ED\u1735\u1736\u17D4-\u17D6\u17D8-\u17DA\u1800-\u180A\u1944\u1945\u1A1E\u1A1F\u1AA0-\u1AA5\u1AA8-\u1AAD\u1B5A-\u1B60\u1BFC-\u1BFF\u1C24-\u1C2F\u1C7E\u1C7F\u1CC0-\u1CC7\u1CD3\u2010-\u2027\u2030-\u204E\u2053-\u205E\u207A-\u207F\u20A0-\u20BF\u2100-\u214F\u2190-\u2BFF\u2C60-\u2C7F\u2E00-\u2E7F\u3001-\u302E\u3030\u303D\u3040-\u309F\u30A0-\u30FF\uFF01-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65\uFFE0-\uFFEF]/;
function isPunctCh(ch) {
  if (ch === undefined) return false;
  if (ch.length === 1 && ch.charCodeAt(0) < 128) return ASCII_PUNCT.has(ch);
  return UNICODE_PUNCT_RE.test(ch);
}
function isWsCh(ch) {
  return ch === undefined || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v' || ch === '\u00A0' || ch === '\u1680' || (ch >= '\u2000' && ch <= '\u200A') || ch === '\u2028' || ch === '\u2029' || ch === '\u202F' || ch === '\u205F' || ch === '\u3000' || ch === '\uFEFF';
}

// ------------------------------------------------------------- block parsing

function newBlock(type) {
  return { type, children: [], parent: null, lastLineBlank: false, open: true };
}
function addChild(parent, child) {
  child.parent = parent;
  parent.children.push(child);
  parent.lastLineBlank = false;
  return child;
}

/** Line-scan state: pos indexes the raw line, col is its column, and when
 *  partialTab > 0 the tab at pos has that many columns still unconsumed. */
function makeState(line) { return { line, pos: 0, col: 0, partialTab: 0 }; }

// Expand a run of spaces/tabs into spaces, a tab advancing the column to
// the next multiple of four from startCol.
function expandWsRun(run, startCol) {
  let t = startCol; let out = '';
  for (let ix = 0; ix < run.length; ix++) {
    if (run[ix] === '\t') { const pad = 4 - (t % 4); out += ' '.repeat(pad); t += pad; }
    else { out += run[ix]; t++; }
  }
  return out;
}

// Marked expands the whitespace run following a blockquote marker (tabs
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
  st.pos++; st.col++;
}

function advanceIndent(st, maxCols) {
  let consumed = 0;
  if (st.partialTab > 0) {
    if (st.partialTab <= maxCols) {
      st.col += st.partialTab; st.pos++; consumed += st.partialTab; st.partialTab = 0;
    } else {
      st.col += maxCols; st.partialTab -= maxCols; return maxCols;
    }
  }
  while (consumed < maxCols && st.pos < st.line.length) {
    const ch = st.line[st.pos];
    if (ch === ' ') { st.pos++; st.col++; consumed++; }
    else if (ch === '\t') {
      const tabCols = 4 - (st.col % 4);
      if (tabCols <= maxCols - consumed) { st.pos++; st.col += tabCols; consumed += tabCols; }
      else { st.partialTab = tabCols - (maxCols - consumed); st.col += maxCols; consumed = maxCols; }
    } else break;
  }
  return consumed;
}

/** Measure the whitespace run at st: {cols, pos} without moving st. */
function measureIndent(st) {
  let cols = 0; let p = st.pos; let c = st.col;
  if (st.partialTab > 0) { cols += st.partialTab; p++; c += st.partialTab; }
  while (p < st.line.length) {
    const ch = st.line[p];
    if (ch === ' ') { cols++; p++; c++; }
    else if (ch === '\t') { const t = 4 - (c % 4); cols += t; p++; c += t; }
    else break;
  }
  return { cols, pos: p };
}

/** The rest of the line from st, expanding a partially consumed tab to spaces. */
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
    if (ch === ' ') { out += ' '; col++; i++; }
    else if (ch === '\t') { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; i++; }
    else break;
  }
  if (i === 0) return text;
  return out + text.slice(i);
}

function isBlankText(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/** Marked post-processes every block-HTML match by dropping trailing blank
 *  lines: if more than one line follows the last non-blank line, the match
 *  is cut back to that line (and loses any trailing newline with them). */
function geTrim(a) {
  const e = a.split('\n');
  let t = e.length - 1;
  while (t >= 0 && isBlankText(e[t])) t--;
  return e.length - t <= 2 ? a : e.slice(0, t + 1).join('\n');
}

const RE_ATX = /^(#{1,6})(?:[ \t]+(.*)|[ \t]*$)/;
const RE_ATX_CLOSE = /[ \t]+#+[ \t]*$/;
const RE_SETEXT = /^(=+|-+)[ \t]*$/;
const RE_HR = /^(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})[ \t]*$/;
const RE_FENCE = /^(`{3,}|~{3,})(.*)$/;
const HTML_BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

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
            // same list (checked from the state before the item's indent).
            Object.assign(st, snap);
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
        else { allMatched = false; Object.assign(st, snap); break; }
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

    // Leaf blocks that continue by content: fenced/indented code, HTML, table.
    if (cur.type === 'code' || cur.type === 'html' || cur.type === 'table') {
      // A fenced code block keeps consuming lines when the first unmatched
      // container is a list item, but not across a block quote boundary.
      // Inside a list item it only runs on once a non-blank content line
      // has been consumed with the item fully matched ("established"):
      // marked's item gathering otherwise ends the item at that line,
      // leaving the fence unclosed inside the item.
      const fenceRunsOn = cur.type === 'code' && cur.fenced && cur.established &&
        stack[lastMatched + 1] && stack[lastMatched + 1].type === 'item' &&
        !stack.slice(lastMatched + 1, -1).some((b) => b.type === 'blockquote');
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
        cur.lines.push(restNow);
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
        if (stripped[0] === '>' || RE_ATX.test(stripped) || RE_HR.test(stripped) || htmlBlockStart(stripped, false)) {
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
          hb.cond = cond; hb.lines = [remainderText(st)];
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
        inItemPara = b.type === 'item';
        break;
      }
      if (inItemPara) {
        let txt = remainderText(st);
        if (stack.length > 2) txt = leadExpand(txt, st);
        if (txt.startsWith('    ')) txt = txt.slice(4);
        if (!allMatched && cur.lines.length >= 2 && /^ {0,3}(=+|-+)[ \t]*$/.test(txt)) {
          let hasQuote = false;
          for (let si = lastMatched + 1; si < stack.length; si++) if (stack[si].type === 'blockquote') { hasQuote = true; break; }
          if (hasQuote) txt = '    ' + txt.replace(/^ +/, '');
        }
        cur.lines.push(txt);
        continue;
      }
      let lazyText = remainderText(stL);
      let lazySt = stL;
      if (!allMatched) {
        // Marked strips 4 columns from a deeply indented lazy line when a
        // block quote among the unmatched containers is being continued.
        let hasQuote = false;
        for (let si = lastMatched + 1; si < stack.length; si++) if (stack[si].type === 'blockquote') { hasQuote = true; break; }
        if (hasQuote && measureIndent(stL).cols >= 4) {
          const stQ = { line: stL.line, pos: stL.pos, col: stL.col, partialTab: stL.partialTab };
          advanceIndent(stQ, 4);
          lazyText = remainderText(stQ);
          lazySt = stQ;
        }
      }
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
function matchInlineHtml(s, i) {
  const rest = s.slice(i);
  let m;
  if ((m = RE_OPEN_TAG.exec(rest))) return { text: m[0], len: m[0].length };
  if ((m = RE_CLOSE_TAG.exec(rest))) return { text: m[0], len: m[0].length };
  if (rest.startsWith('<!--')) {
    // Marked accepts the abruptly closed comments <!--> and <!--->, and
    // otherwise any content up to the first --> (even containing --).
    if (rest[4] === '>') return { text: '<!-->', len: 5 };
    if (rest[4] === '-' && rest[5] === '>') return { text: '<!--->', len: 6 };
    const end = rest.indexOf('-->', 4);
    if (end !== -1) return { text: rest.slice(0, end + 3), len: end + 3 };
    return null;
  }
  if (rest.startsWith('<?')) {
    const end = rest.indexOf('?>', 2);
    if (end !== -1) return { text: rest.slice(0, end + 2), len: end + 2 };
    return null;
  }
  if (rest.startsWith('<![CDATA[')) {
    const end = rest.indexOf(']]>', 9);
    if (end !== -1) return { text: rest.slice(0, end + 3), len: end + 3 };
    return null;
  }
  if (/^<![A-Za-z]/.test(rest)) {
    const end = rest.indexOf('>', 2);
    if (end !== -1) return { text: rest.slice(0, end + 1), len: end + 1 };
  }
  return null;
}

/** Parse the (destination "title") part of an inline link; s[i] === '('.
 *  Returns {dest, title, end} or null. */
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
  let j = i + 1;
  while (j < n) {
    const c = src[j];
    if (c === ']') return j + 1;
    if (c === '\\') { j += 2; continue; }
    if (c === '[') {
      let k = j + 1; let ok = false;
      while (k < n) {
        if (src[k] === ']') { ok = true; break; }
        if (src[k] === '\\') { k += 2; continue; }
        if (src[k] === '[') return -1;
        k++;
      }
      if (!ok) return -1;
      j = k + 1; continue;
    }
    j++;
  }
  return -1;
}

function labelOk(src) {
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '[') {
      const end = scanLabelGroup(src, i);
      if (end === -1) return false;
      i = end; continue;
    }
    if (c === ']') return false;
    if (c === '<') {
      const tagEnd = matchLabelTag(src, i);
      if (tagEnd !== -1) { i = tagEnd; continue; }
      i++; continue;
    }
    if (c === '`') {
      let j = i; while (j < n && src[j] === '`') j++;
      if (j === n) return j - i >= 2;
      let k = j; while (k < n && src[k] !== '`') k++;
      if (k === n) return false;
      let e = k; while (e < n && src[e] === '`') e++;
      i = e; continue;
    }
    i++;
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
  let j = i + 1;
  while (j < n) {
    const c = s[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '(') {
      let k = j + 1; let closed = false;
      while (k < n) {
        if (s[k] === '\\') { k += 2; continue; }
        if (s[k] === ')') { closed = true; break; }
        if (s[k] === '(') return -1;
        k++;
      }
      if (!closed) return -1;
      j = k + 1; continue;
    }
    if (c === ')') return j + 1;
    j++;
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
      let j = i; while (j < n && src[j] === '`') j++;
      const run = j - i;
      let k = j; let closeEnd = -1;
      while (k < n) {
        if (src[k] === '`') {
          let e = k; while (e < n && src[e] === '`') e++;
          if (e - k === run) { closeEnd = e; break; }
          k = e; continue;
        }
        k++;
      }
      if (closeEnd === -1) return false;
      i = closeEnd; continue;
    }
    i++;
  }
  return true;
}

function parseInlineLink(s, i) {
  const n = s.length;
  let j = i + 1;
  const skipWs = () => { while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++; };
  skipWs();
  let destRaw;
  if (s[j] === '<') {
    let k = j + 1; let ok = false;
    while (k < n) {
      const ch = s[k];
      if (ch === '\\' && isAsciiPunct(s[k + 1])) { k += 2; continue; }
      if (ch === '>') { ok = true; break; }
      if (ch === '<' || ch === '\n') return null;
      k++;
    }
    if (!ok) return null;
    destRaw = s.slice(j + 1, k);
    j = k + 1;
  } else {
    const start = j;
    let depth = 0;
    while (j < n) {
      const ch = s[j];
      if (ch === '\\' && isAsciiPunct(s[j + 1])) { j += 2; continue; }
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch < ' ') break;
      if (ch === '(') depth++;
      else if (ch === ')') { if (depth === 0) break; depth--; }
      j++;
    }
    destRaw = s.slice(start, j);
  }
  const hadWs = j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n');
  skipWs();
  let titleRaw = null;
  const q = s[j];
  if ((q === '"' || q === "'" || q === '(') && (hadWs || destRaw === '')) {
    const close = q === '(' ? ')' : q;
    let k = j + 1; let ok = false;
    while (k < n) {
      const ch = s[k];
      if (ch === '\\') { k += 2; continue; }
      if (ch === close) { ok = true; break; }
      if (q === '(' && ch === '(') return null;
      k++;
    }
    if (!ok) return null;
    titleRaw = s.slice(j + 1, k);
    j = k + 1;
    skipWs();
  }
  if (s[j] !== ')') return null;
  return {
    dest: decodeLinkText(destRaw),
    title: titleRaw === null ? null : decodeLinkText(titleRaw),
    end: j + 1,
  };
}

/** Parse a reference label starting at s[i] === '[' (the second bracket of a
 *  full/collapsed reference). Returns {label, end} or null. */
function parseRefLabel(s, i) {
  const n = s.length;
  let j = i + 1;
  while (j < n) {
    const ch = s[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch === '[') return null;
    if (ch === ']') return { label: s.slice(i + 1, j), end: j + 1 };
    j++;
  }
  return null;
}

// Character classes used by marked's emphasis rules -------------------------

const PS_RE = /[\p{P}\p{S}]/u;
function isPS(c) { return c !== '' && c !== undefined && PS_RE.test(c); }
function isWsC(c) { return c !== '' && c !== undefined && /\s/.test(c); }
// For '*' delimiter scans (GFM rule set), '~' counts as a word character:
// it is neither punctuation nor punctuation-or-space.
function psAst(c) { return c !== '~' && isPS(c); }
function psSpaceAst(c) { return c !== '~' && (isWsC(c) || isPS(c)); }
function notPsSpaceAst(c) { return c === '~' || !(isWsC(c) || isPS(c)); }
// For '_' delimiter scans the classes are the plain ones.
function psSpace(c) { return isWsC(c) || isPS(c); }
function notPsSpace(c) { return !psSpace(c); }
// Marked's generic "punctuation" test: whitespace, punctuation or symbol,
// but not a delimiter character itself.
function isPunctRule(c) { return c !== '' && c !== undefined && c !== '*' && c !== '_' && psSpace(c); }

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
  const am = RE_AUTOLINK.exec(rest) || RE_EMAILLINK.exec(rest);
  if (am) return i + am[0].length;
  let j = i + 1;
  let closing = false;
  if (text[j] === '/') { closing = true; j++; }
  const nm = /^[A-Za-z][A-Za-z0-9-]*/.exec(text.slice(j));
  if (!nm) return -1;
  j += nm[0].length;
  if (closing) {
    while (j < n && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n')) j++;
    return text[j] === '>' ? j + 1 : -1;
  }
  while (j < n) {
    let ws = 0;
    while (j < n && /\s/.test(text[j])) { j++; ws++; }
    if (text[j] === '>') return j + 1;
    if (text[j] === '/' && text[j + 1] === '>') return j + 2;
    if (!ws) return -1;
    const an = /^[A-Za-z_:][A-Za-z0-9_.:-]*/.exec(text.slice(j));
    if (!an) return -1;
    j += an[0].length;
    let k = j;
    while (k < n && (text[k] === ' ' || text[k] === '\t')) k++;
    if (text[k] === '=') {
      k++;
      while (k < n && (text[k] === ' ' || text[k] === '\t')) k++;
      const q = text[k];
      if (q === '"' || q === "'") {
        const e = text.indexOf(q, k + 1);
        if (e === -1) return -1;
        j = e + 1;
      } else {
        const vm = /^[^\s"'=<>`]+/.exec(text.slice(k));
        if (!vm) return -1;
        j = k + vm[0].length;
      }
    }
  }
  return -1;
}

// Find the ']' that ends a link label starting at `from`, following
// marked's label grammar (see labelOk): returns its index or -1.
function findLabelEnd(text, from) {
  const n = text.length;
  let i = from;
  while (i < n) {
    const c = text[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '[') {
      const end = scanLabelGroup(text, i);
      if (end === -1) return -1;
      i = end; continue;
    }
    if (c === ']') return i;
    if (c === '<') {
      const tagEnd = matchLabelTag(text, i);
      if (tagEnd !== -1) { i = tagEnd; continue; }
      i++; continue;
    }
    if (c === '`') {
      let j = i; while (j < n && text[j] === '`') j++;
      // A run of 2+ backticks directly before the closing bracket is
      // consumed as-is (marked's label grammar has a dedicated
      // alternative for it); it does not pair with a later run.
      if (j - i >= 2 && text[j] === ']') return j;
      let k = j; while (k < n && text[k] !== '`') k++;
      if (k === n) return -1;
      let e = k; while (e < n && text[e] === '`') e++;
      i = e; continue;
    }
    i++;
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
    if (c === '\\') { p += 2; continue; }
    if (c !== '[') { p++; continue; }
    const image = p > 0 && s[p - 1] === '!' && (p < 2 || s[p - 2] !== '\\');
    const le = findLabelEnd(s, p + 1);
    if (le === -1) { p++; continue; }
    const labelText = s.slice(p + 1, le);
    if (image) {
      let end = le + 1;
      if (s[end] === '(') { const pl = parseInlineLink(s, end); if (pl) end = pl.end; }
      else if (s[end] === '[') { const rl = parseRefLabel(s, end); if (rl) end = rl.end; }
      p = end; continue;
    }
    if (s[le + 1] === '(' && parseInlineLink(s, le + 1)) return true;
    if (s[le + 1] === '[') {
      const rl = parseRefLabel(s, le + 1);
      if (rl) {
        const lab = rl.label === '' ? labelText : rl.label;
        if (refs.has(normalizeLabel(lab))) return true;
        p = rl.end; continue;
      }
    }
    if (refs.has(normalizeLabel(labelText))) return true;
    p = le + 1;
  }
  return false;
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
    if (c === '\\') { i += 2; count++; continue; }
    if (c === ']') return count >= 1 ? i : -1;
    if (c === '[') return -1;
    i++; count++;
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
  const sameChar = prevChar === r;
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
      push({ k: 'text', s: buf, src: bufStart, srcLen: i - bufStart, il: inLink });
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
        // autolink when a URL is in progress in the current text run.
        const um = /(?:https?:\/\/|ftp:\/\/|www\.)[^\s]*$/.exec(buf);
        if (um && (um.index === 0 || isAutolinkBoundary(buf[um.index - 1]))) {
          buf += ch; i++; continue;
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
      if (le !== -1) {
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
        }
      }
      if (formed && formed !== 'dead') {
        flush();
        // While a link's or image's label is tokenised, marked's inLink
        // state is set: extended autolinks do not form inside it. The
        // state used for the label is discarded when the link is done.
        const sub = parseInlineNodes(labelText, refs, { inLink: true });
        const idx = adopt(sub, image ? 'image' : 'link');
        nd[idx].href = formed.dest;
        nd[idx].title = formed.title;
        i = formed.end;
        continue;
      }
      if (buf === '') bufStart = i;
      buf += image ? '![' : '[';
      i += image ? 2 : 1;
      continue;
    }
    if (ch === '*' || ch === '_') {
      const att = emStrongAttempt(text, getMask().masked, getMask().lastClosers, i, i > 0 ? text[i - 1] : '');
      if (att) {
        flush();
        if (ctx) ctx.inLink = inLink;
        const sub = parseInlineNodes(att.inner, refs, ctx);
        adopt(sub, att.kind);
        if (ctx) inLink = ctx.inLink;
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
      if (att) {
        flush();
        if (ctx) ctx.inLink = inLink;
        const sub = parseInlineNodes(att.inner, refs, ctx);
        adopt(sub, 'del');
        if (ctx) inLink = ctx.inLink;
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
  if (ctx) ctx.inLink = inLink;
  let last = head;
  if (last !== -1) { while (nd[last].next !== -1) last = nd[last].next; }
  return { nd, head, tail: last };
}

function parseInline(text, refs, ctx) {
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

function isAutolinkBoundary(prevCh) {
  return prevCh === undefined || isWsCh(prevCh) || '*_~([{\'"<'.includes(prevCh);
}

function validDomain(domain, allowUnderscore) {
  if (!domain || domain.includes('..')) return false;
  const segs = domain.split('.');
  if (segs.length < 2) return false;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '') return false;
    const isLast = i === segs.length - 1;
    const re = allowUnderscore && !isLast ? /^[A-Za-z0-9_-]+$/ : /^[A-Za-z0-9-]+$/;
    if (!re.test(seg)) return false;
    if (seg.startsWith('-') || seg.endsWith('-')) return false;
  }
  return true;
}

/** Trim a candidate extended-autolink the way marked does: scan the
 *  candidate in chunks — plain runs, balanced (...) groups, a lone &
 *  that does not begin an entity running to the end, and punctuation
 *  runs that do not reach the end — and keep only the matched prefix. */
function trimAutolink(s) {
  const PUNCT = '?!.,:;*_\'"~)';
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (c === '(') {
      const close = s.indexOf(')', i);
      if (close === -1) break;
      i = close + 1; continue;
    }
    if (c === '&') {
      if (/^[A-Za-z0-9]+;$/.test(s.slice(i + 1))) break;
      i++; continue;
    }
    if (PUNCT.includes(c)) {
      let j = i;
      while (j < n && PUNCT.includes(s[j])) j++;
      if (j === n) break;
      i = j; continue;
    }
    let j = i;
    while (j < n && s[j] !== '(' && s[j] !== '&' && !PUNCT.includes(s[j])) j++;
    i = j;
  }
  return s.slice(0, i);
}

const RE_EMAIL_EXT = /^([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/;

/** Split a text node's string into plain and autolink segments. */
function splitAutolinks(s, srcBefore) {
  const segs = [];
  let plain = '';
  let i = 0;
  const prevAt = (pos) => (pos > 0 ? s[pos - 1] : srcBefore);
  while (i < s.length) {
    if (isAutolinkBoundary(prevAt(i))) {
      let kind = null; let schemeLen = 0;
      if (s.startsWith('www.', i)) kind = 'www';
      else {
        const head = s.slice(i, i + 8).toLowerCase();
        if (head.startsWith('https://')) { kind = 'url'; schemeLen = 8; }
        else if (head.startsWith('http://')) { kind = 'url'; schemeLen = 7; }
        else if (head.startsWith('ftp://')) { kind = 'url'; schemeLen = 6; }
      }
      if (kind) {
        let j = i;
        while (j < s.length && !isWsCh(s[j]) && s[j] !== '<') j++;
        const raw = s.slice(i, j);
        const trimmed = trimAutolink(raw);
        // After the scheme or www. prefix, marked's pattern needs a
        // domain label character; the rest of the candidate is free-form.
        const rest = kind === 'url' ? trimmed.slice(schemeLen) : trimmed.slice(4);
        if (rest && /[A-Za-z0-9_-]/.test(rest[0])) {
          if (plain) { segs.push({ t: 'text', s: plain }); plain = ''; }
          segs.push({ t: 'auto', s: trimmed, href: kind === 'www' ? 'http://' + trimmed : trimmed });
          i += trimmed.length;
          continue;
        }
      } else {
        // Email, optionally prefixed by mailto: or xmpp: (the prefix is
        // part of the link; xmpp allows one /resource segment after it).
        let prefix = '';
        if (s.startsWith('mailto:', i)) prefix = 'mailto:';
        else if (s.startsWith('xmpp:', i)) prefix = 'xmpp:';
        const em = RE_EMAIL_EXT.exec(s.slice(i + prefix.length));
        if (em && validDomain(em[2], false)) {
          let total = prefix + em[0];
          if (prefix === 'xmpp:' && s[i + total.length] === '/') {
            const res = /^[A-Za-z0-9@.]+/.exec(s.slice(i + total.length + 1));
            if (res && res[0].length) total += '/' + res[0];
          }
          const after = s[i + total.length];
          if (!(after !== undefined && /[A-Za-z0-9_]/.test(after))) {
            if (plain) { segs.push({ t: 'text', s: plain }); plain = ''; }
            segs.push({ t: 'auto', s: total, href: prefix ? total : 'mailto:' + total });
            i += total.length;
            continue;
          }
        }
      }
    }
    plain += s[i];
    i++;
  }
  if (plain) segs.push({ t: 'text', s: plain });
  return segs;
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
  const walk = (first, last, inLink) => {
    let run = [];
    const flushRun = () => { if (run.length) { runs.push(run); run = []; } };
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
          walk(node.childFirst, node.childLast, inLink || node.k === 'link');
        }
      }
      if (c === last) break;
      c = nx;
    }
    flushRun();
  };
  walk(head, -2, false);
  for (const run of runs) {
    const firstNode = nd[run[0]];
    if (firstNode.gone) continue;
    const combined = run.map((ix) => {
      const ndn = nd[ix];
      return ndn.k === 'text' ? ndn.s : ndn.ch.repeat(ndn.len);
    }).join('');
    const srcBefore = firstNode.src > 0 ? srcText[firstNode.src - 1] : undefined;
    // Fast reject: without any autolink-shaped substring the run cannot
    // produce a link, so the detailed scan is skipped entirely.
    if (!/www\.|https?:|ftp:|mailto:|xmpp:|@/i.test(combined)) continue;
    const segs = splitAutolinks(combined, srcBefore);
    if (segs.length === 1 && segs[0].t === 'text') continue;
    const lastNode = nd[run[run.length - 1]];
    const parent = firstNode.parent;
    const isFirstChild = parent !== -1 && nd[parent].childFirst === run[0];
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
    for (const ix of run) nd[ix].gone = true;
    firstNode.next = firstNew; // keep head-of-chain traversal working when prev was -1
    if (firstNode.parent !== -1) {
      const p = nd[firstNode.parent];
      if (p.childFirst === run[0]) p.childFirst = firstNew;
      if (p.childLast === run[run.length - 1]) p.childLast = prevIdx;
    }
  }
}

// Inline rendering ------------------------------------------------------------

/** Escape for a double-quoted attribute value, marked-style: an ampersand
 *  that already introduces a character-reference-shaped sequence is left
 *  alone; every other & becomes &amp;. */
function escAttr(s) {
  return s
    .replace(/&(?!(?:#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);)/g, '&amp;')
    .replace(/[<>"']/g, (c) => ESCAPE_MAP[c]);
}

function encodeHref(h) {
  try { return escAttr(encodeURI(h).replace(/%25/g, '%')); } catch { return escAttr(h); }
}

function altText(nd, first, last) {
  let out = '';
  for (let c = first; c !== -1;) {
    const node = nd[c];
    if (!node.gone) {
      if (node.k === 'text' || node.k === 'ch' || node.k === 'code') out += node.s;
      else if (node.k === 'soft' || node.k === 'hard') out += '\n';
      else if (node.k === 'delim') out += node.ch.repeat(node.len);
      else if (node.k === 'bracket') out += node.s;
      else if (node.k === 'auto') out += node.s;
      else if (node.childFirst !== undefined && node.childFirst !== -1) out += altText(nd, node.childFirst, node.childLast);
    }
    if (c === last) break;
    c = node.next;
  }
  return out;
}

function renderRange(nd, first, last) {
  let out = '';
  for (let c = first; c !== -1;) {
    const node = nd[c];
    if (!node.gone) out += renderNode(nd, node);
    if (c === last) break;
    c = node.next;
  }
  return out;
}

function renderNode(nd, node) {
  switch (node.k) {
    case 'text': return escapeHtml(node.s);
    case 'raw': return node.s;
    case 'ch': return escapeHtml(node.s);
    case 'code': return '<code>' + escapeHtml(node.s) + '</code>';
    case 'soft': return '\n';
    case 'hard': return '<br>';
    case 'delim': return node.ch.repeat(node.len);
    case 'bracket': return node.s;
    case 'em': return '<em>' + renderRange(nd, node.childFirst, node.childLast) + '</em>';
    case 'strong': return '<strong>' + renderRange(nd, node.childFirst, node.childLast) + '</strong>';
    case 'del': return '<del>' + renderRange(nd, node.childFirst, node.childLast) + '</del>';
    case 'auto': return '<a href="' + encodeHref(node.href) + '">' + escapeHtml(node.s) + '</a>';
    case 'link': {
      const title = node.title !== null && node.title !== undefined ? ' title="' + escAttr(node.title) + '"' : '';
      return '<a href="' + encodeHref(node.href) + '"' + title + '>' + renderRange(nd, node.childFirst, node.childLast) + '</a>';
    }
    case 'image': {
      const title = node.title !== null && node.title !== undefined ? ' title="' + escAttr(node.title) + '"' : '';
      return '<img src="' + encodeHref(node.href) + '" alt="' + escAttr(altText(nd, node.childFirst, node.childLast)) + '"' + title + '>';
    }
    default: return '';
  }
}

// Block rendering -------------------------------------------------------------

function renderBlocks(root, refs, ctx) {
  let out = '';
  for (const c of root.children) out += renderBlock(c, refs, false, ctx);
  return out;
}

function renderBlock(b, refs, tight, ctx) {
  switch (b.type) {
    case 'paragraph': {
      if (b.defOnly) return '';
      const content = parseInline(b.lines.join('\n'), refs, ctx);
      return tight ? content : '<p>' + content + '</p>\n';
    }
    case 'heading':
      return '<h' + b.level + '>' + parseInline(b.text, refs, ctx) + '</h' + b.level + '>\n';
    case 'code': {
      // Content is the raw text between the fences: drop exactly one
      // trailing newline, then ensure a final newline if non-empty.
      let content = b.lines.length ? b.lines.join('\n') + '\n' : '';
      if (content.endsWith('\n')) content = content.slice(0, -1);
      if (content !== '' && !content.endsWith('\n')) content += '\n';
      let cls = '';
      if (b.fenced && b.info) cls = ' class="language-' + escAttr(decodeLinkText(b.info.split(/\s+/)[0])) + '"';
      return '<pre><code' + cls + '>' + escapeHtml(content) + '</code></pre>\n';
    }
    case 'html':
      return geTrim(b.lines.join('\n') + (b.eofEnd ? '\n' : ''));
    case 'hr':
      return '<hr>\n';
    case 'blockquote': {
      let out = '<blockquote>\n';
      for (const c of b.children) out += renderBlock(c, refs, false, ctx);
      return out + '</blockquote>\n';
    }
    case 'list': {
      const tag = b.listData.bullet ? 'ul' : 'ol';
      const start = !b.listData.bullet && b.listData.start !== null && b.listData.start !== 1 ? ' start="' + b.listData.start + '"' : '';
      let out = '<' + tag + start + '>\n';
      for (const item of b.children) out += renderItem(item, refs, b.listData, ctx);
      return out + '</' + tag + '>\n';
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      b.header.forEach((cell, i) => {
        out += '<th' + (b.align[i] ? ' align="' + b.align[i] + '"' : '') + '>' + parseInline(cell, refs, ctx) + '</th>\n';
      });
      out += '</tr>\n</thead>\n';
      if (b.rows.length) {
        out += '<tbody>';
        for (const row of b.rows) {
          out += '<tr>\n';
          row.forEach((cell, i) => {
            out += '<td' + (b.align[i] ? ' align="' + b.align[i] + '"' : '') + '>' + parseInline(cell, refs, ctx) + '</td>\n';
          });
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      return out + '</table>\n';
    }
    default:
      return '';
  }
}

function renderItem(item, refs, listData, ctx) {
  const tight = listData.tight;
  let inner = '';
  let checkbox = null;
  item.children.forEach((child, ci) => {
    if (ci === 0 && listData.bullet && child.type === 'paragraph' && !child.defOnly) {
      const text = child.lines.join('\n');
      const m = /^\[([ xX])\] /.exec(text);
      if (m) {
        checkbox = m[1] !== ' ';
        const rest = text.slice(4);
        const content = parseInline(rest, refs, ctx);
        inner += tight
          ? checkboxHtml(checkbox) + ' ' + content
          : '<p>' + checkboxHtml(checkbox) + ' ' + content + '</p>\n';
        return;
      }
    }
    inner += child.type === 'paragraph' ? renderBlock(child, refs, tight, ctx) : renderBlock(child, refs, false, ctx);
  });
  return '<li>' + inner + '</li>\n';
}

function checkboxHtml(checked) {
  return checked ? '<input checked="" disabled="" type="checkbox">' : '<input disabled="" type="checkbox">';
}

// Entry point -----------------------------------------------------------------

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const root = parseBlocks(src);
  const refs = new Map();
  collectRefs(root, refs);
  return renderBlocks(root, refs, { inLink: false });
}
