// Token Radar, a token-radar-01 entry (Node 22, standard library only).
//
// It reads the sealed snapshot at /input/snapshot.json (or --input <file|dir>), scores
// every rankable pre-token protocol with the radar-2 model in lib/model.ts, writes the
// ranked board to /output/board.json, and copies this repository's dashboard/ and
// screenshots/ to /output. Last, it writes /output/dossier.json, the summary the judge
// reads, with the vendored make.fun library.
//
// The dashboard is a static page, no framework and no network: dashboard/index.html,
// dashboard/app.css and dashboard/app.js read /output/data.js, which this program writes
// from the same board. The board covers the whole watchlist plus every other rankable
// pre-token protocol in the snapshot, each with a seven-step farm plan. Screenshots are
// stored in the repository as base64 text (binary files cannot be pushed) and decoded
// back to PNG bytes here, so the output holds real images.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRadar, boardIssue, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps (reference/gate.json): the text cap shapes the bytes. */
const TEXT_MAX_BYTES = 65536;
const SHOT_MAX = 4;
const SHOT_MAX_BYTES = 524288;
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** The value of --name <value>, or `fallback` when the flag is absent. */
function flag(name: string, fallback: string): string {
  const argv = process.argv;
  const at = argv.indexOf('--' + name);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1] as string;
  const eq = argv.find((a) => a.indexOf('--' + name + '=') === 0);
  if (eq === undefined) return fallback;
  return eq.slice(name.length + 3);
}

/** Die with a message on stderr and exit code 2. */
function fail(message: string): never {
  process.stderr.write('token radar: ' + message + '\n');
  process.exit(2);
}

const inputArg = flag('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  fail('no snapshot at ' + inputFile + ': pass --input <snapshot.json|directory> or mount the sealed /input');
}
const out = flag('output', process.env.MAKEFUN_OUTPUT_DIR === undefined ? '/output' : process.env.MAKEFUN_OUTPUT_DIR);

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const built = buildRadar(snapshot);
const board = built.board;
const radar = built.radar;
const issue = boardIssue(board, snapshot);
if (issue !== null) fail('the model wrote a board the gate refuses: ' + issue);

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), JSON.stringify({ rows: board }) + '\n');
writeFileSync(join(out, 'data.js'), dataScript(radar));

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyDir(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  const names = readdirSync(from);
  for (const name of names) {
    if (name.charAt(0) === '.') continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    const dest = join(to, name);
    const bytes = readFileSync(path);
    writeFileSync(dest, bytes);
    copied.push(name);
  }
  return copied;
}

copyDir(join(here, 'dashboard'), join(out, 'dashboard'));

/** Decode screenshots/ base64 text files into PNG bytes in `to`, dropping the .b64 suffix. */
function decodeShots(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const decoded: string[] = [];
  const names = readdirSync(from);
  for (const name of names) {
    if (name.charAt(0) === '.') continue;
    if (!name.endsWith('.b64')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    const outName = name.slice(0, name.length - 4);
    const text = readFileSync(path, 'utf8').trim();
    writeFileSync(join(to, outName), Buffer.from(text, 'base64'));
    decoded.push(outName);
  }
  return decoded;
}

const shots = decodeShots(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  fail('screenshots/ holds ' + shots.length + ' image' + (shots.length === 1 ? '' : 's') +
    ': hand in 3, the board, a detail view and a filtered view');
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    fail('screenshots/' + name + ': a name is letters, digits and . _ -, 1 to 128 characters');
  }
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(
  join(out, 'dossier.json'),
  buildDossier(out, {
    text_max_bytes: TEXT_MAX_BYTES,
    screenshots: { max: SHOT_MAX, max_bytes: SHOT_MAX_BYTES },
    dashboard: { max_files: 400, max_bytes: 4194304 },
  }),
);

process.stdout.write(
  'token radar: ' + snapshot.protocols.length + ' protocols, ' + snapshot.watchlist.length +
    ' on the watchlist, ' + board.length + ' rows scored (' + radar.early_size + ' early, ' +
    radar.live_size + ' live set aside)\n' +
  'token radar: top implied value $' + board[0]!.implied_value_usd.toLocaleString('en-US') +
    ' (' + board[0]!.name + '); wrote ' + join(out, 'board.json') + ', ' + join(out, 'data.js') +
    ', ' + join(out, 'dashboard') + ' (3 files), ' + join(out, 'screenshots') +
    ' (' + shots.length + ' images) and ' + join(out, 'dossier.json') + '\n',
);
