# markdown-render-speed-02 — a fast marked-compatible renderer

[![make.fun bounty](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Aritoys89/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Aritoys89/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

An original, dependency-free Markdown-to-HTML renderer in a single ES
module (`parse.js`). It implements the CommonMark and GFM feature set —
headings, lists, block quotes, tables, fenced and indented code, HTML
blocks, link references, emphasis, strikethrough, autolinks and extended
autolinks — and reproduces the output of marked 18.1.3 with default
options (gfm on, breaks off, pedantic off) byte-for-byte, while being
built for speed: single-pass block and inline scanners, no dependencies,
no caching between calls.

## Run it

With a `cases.json` (an array of `{ "markdown": ... }` objects) present
in `/input`:

```sh
node main.ts
```

This writes the rendered HTML strings, in case order, as a JSON array to
`/output/html.json`. Set `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` to
use different directories (that is how the competition kit harness runs
it locally against the practice set).

<sub>Entered on [make.fun](https://make.fun/?ref=k7c6ejze&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
