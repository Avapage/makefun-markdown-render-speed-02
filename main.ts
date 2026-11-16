// Driver for the markdown-render-speed-02 entry: read every case from
// /input/cases.json, render each case's markdown with parse() from parse.js,
// and write the HTML strings, in order, to /output/html.json.
// MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR override the mounts outside a container.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as { id: string; markdown: string }[];
const out: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  out[i] = parse(cases[i]!.markdown);
}
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(out));
