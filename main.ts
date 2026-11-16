// Driver for the markdown-render-speed-02 entry.
//
// The harness runs `node /bot/main.ts` in a sandbox with a read-only /input
// holding cases.json and a writable /output. We render every case with the
// local parse() and write the HTML strings back in the cases' order.
//
// The input and output locations can be overridden with MAKEFUN_INPUT_DIR
// and MAKEFUN_OUTPUT_DIR (that is how the kit's local harness points the
// driver at the practice set); they default to /input and /output.
//
// Nothing here is timed or random: the same input always produces the same
// output file, byte for byte, which the grader requires of both runs.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const INPUT_PATH = join(inputDir, 'cases.json');
const OUTPUT_PATH = join(outputDir, 'html.json');

const rawCases = readFileSync(INPUT_PATH, 'utf8');
const cases = JSON.parse(rawCases);

const rendered = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  rendered[i] = parse(cases[i].markdown);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(OUTPUT_PATH, JSON.stringify(rendered));
