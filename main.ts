// Entry driver for the markdown-render-speed-02 competition.
//
// Reads every case from cases.json in the input directory, renders each
// case's markdown with the parser in parse.js, and writes the resulting
// HTML strings, in case order, as a JSON array to html.json in the output
// directory. The directories default to /input and /output and can be
// overridden with the MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR environment
// variables (the kit harness uses those for local runs).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
// @ts-ignore -- parse.js is a plain ES module next to this file.
import { parse } from "./parse.js";

interface Case {
  id: string;
  markdown: string;
}

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

const cases = JSON.parse(
  readFileSync(join(inputDir, "cases.json"), "utf8"),
) as Case[];

const html: string[] = new Array(cases.length);
for (let k = 0; k < cases.length; k++) {
  html[k] = parse(cases[k].markdown);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, "html.json"), JSON.stringify(html));
