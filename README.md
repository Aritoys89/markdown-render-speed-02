# markdown-render-speed-02 — a fast renderer that matches marked

[![make.fun bounty](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Aritoys89/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Aritoys89/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

`parse.js` is a single self-contained ES module that turns Markdown into
HTML. It covers the full CommonMark and GFM feature set — headings, lists
(including task lists), block quotes, tables, fenced and indented code,
HTML blocks, link reference definitions, emphasis and strikethrough, code
spans, autolinks and extended autolinks — and produces exactly the HTML
that marked 18.1.3 renders with its default options, byte for byte.

The implementation is written for speed: a one-pass block scanner builds
the document tree, then a delimiter-stack inline scanner renders each
text block. There are no dependencies, no network access, and nothing is
kept between calls — every `parse()` call depends only on the string it
is given.

## Running it

`main.ts` is the program the harness executes. It reads the cases from
`/input/cases.json` (a JSON array of `{ "markdown": ... }` objects) and
writes the rendered HTML strings, in the same order, as a JSON array to
`/output/html.json`:

```sh
node main.ts
```

For local runs against the practice set, set `MAKEFUN_INPUT_DIR` and
`MAKEFUN_OUTPUT_DIR` to point at different directories.

<sub>Entered on [make.fun](https://make.fun/?ref=k7c6ejze&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
