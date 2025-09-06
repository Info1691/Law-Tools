#!/usr/bin/env node
/**
 * Agent3 Builder (BM25/Lunr, windowed TXT → chunks)
 *
 * Produces:
 *   /<out>/agent3.meta.json   -> { docs, chunkCount, builtAt, windowLines, windowStep, engine, source, base, index, chunks }
 *   /<out>/chunks.jsonl       -> one JSON per line: { id, url, title, text, lineStart, lineEnd, source, kind }
 *   /<out>/lunr-index.json    -> serialized Lunr index over { id, title, text }
 *   /<out>/agent3.json        -> manifest: { base, index, chunks, meta }
 *
 * CLI:
 *   node agent3-build.mjs \
 *     --src ./data \
 *     --out ./agent3-bm25 \
 *     --base https://texts.wwwbcb.org/data \
 *     --lines 12 \
 *     --step 6
 *
 * Notes:
 *   - All .txt files under --src are processed (laws, rules, cases, commentary, textbooks, etc).
 *   - Chunks are sliding windows (LINES lines, stepping STEP lines) to create stable, linkable segments.
 *   - Each chunk records zero-based [lineStart, lineEnd) suitable for segment viewers.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';
import readline from 'node:readline';
import lunr from 'lunr';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ---------- CLI args ----------
function parseArgs() {
  const a = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    if (k === '--src')   out.src   = a[++i];
    else if (k === '--out')  out.out  = a[++i];
    else if (k === '--base') out.base = a[++i];
    else if (k === '--lines') out.lines = parseInt(a[++i], 10);
    else if (k === '--step')  out.step  = parseInt(a[++i], 10);
  }
  return out;
}

// ---------- FS helpers ----------
function walkTxtFiles(root) {
  /** @type {string[]} */
  const files = [];
  (function rec(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) rec(p);
      else if (entry.isFile() && p.toLowerCase().endsWith('.txt')) files.push(p);
    }
  })(root);
  return files.sort();
}

async function readAllLines(file) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity
  });
  const lines = [];
  for await (const line of rl) lines.push(line);
  return lines;
}

function toPublicUrl(base, srcRoot, filePath) {
  // Convert filePath under srcRoot → URL under base
  // e.g. srcRoot=/repo/data, filePath=/repo/data/laws/jersey/JTL-1984.txt
  // base=https://texts.wwwbcb.org/data
  const rel = path.relative(srcRoot, filePath).split(path.sep).join('/');
  return `${base.replace(/\/+$/,'')}/${rel}`;
}

function kindFromPath(srcRoot, filePath) {
  // /data/<kind>/.../file.txt  -> returns <kind>, else ""
  const rel = path.relative(srcRoot, filePath).split(path.sep);
  return rel.length > 0 ? rel[0].toLowerCase() : '';
}

// ---------- Main ----------
async function main() {
  const args = parseArgs();
  const SRC   = args.src ?? './data';
  const OUT   = args.out ?? './agent3-bm25';
  const BASE  = args.base ?? '/data'; // may be absolute URL or same-origin path
  const LINES = Number.isFinite(args.lines) ? args.lines : 12; // lines per window
  const STEP  = Number.isFinite(args.step)  ? args.step  : 6;  // stride

  // Validate
  if (!fs.existsSync(SRC)) {
    console.error(`ERROR: --src not found: ${SRC}`);
    process.exit(1);
  }
  await fsp.mkdir(OUT, { recursive: true });

  const files = walkTxtFiles(SRC);
  if (!files.length) {
    console.error(`ERROR: No .txt files under ${SRC}`);
    process.exit(1);
  }

  const chunksPath = path.join(OUT, 'chunks.jsonl');
  const chunksStream = fs.createWriteStream(chunksPath, { encoding: 'utf8' });

  /** @type {{id:string,title:string,text:string}[]} */
  const docs = [];
  let idCounter = 0;
  let chunkCount = 0;

  for (const file of files) {
    const title = path.basename(file);
    const urlPub = toPublicUrl(BASE, SRC, file);
    const kind = kindFromPath(SRC, file); // e.g., laws, rules, cases, commentary, textbooks, etc.
    const lines = await readAllLines(file);

    for (let start = 0; start < lines.length; start += STEP) {
      const end = Math.min(lines.length, start + LINES);
      const text = lines.slice(start, end).join('\n').trim();
      if (!text) {
        if (end === lines.length) break;
        continue;
      }

      const id = String(idCounter++);
      const rec = {
        id,
        url: urlPub,
        title,
        text,
        lineStart: start, // inclusive, 0-based
        lineEnd: end,     // exclusive, 0-based
        source: file,
        kind
      };

      chunksStream.write(JSON.stringify(rec) + '\n');
      docs.push({ id, title, text });
      chunkCount++;
      if (end === lines.length) break;
    }
  }
  chunksStream.end();

  // Build Lunr index
  const idx = lunr(function () {
    this.ref('id');
    this.field('title');
    this.field('text');
    for (const d of docs) this.add(d);
  });

  const lunrPath = path.join(OUT, 'lunr-index.json');
  await fsp.writeFile(lunrPath, JSON.stringify(idx), 'utf8');

  // Meta + manifest
  const meta = {
    builtAt: new Date().toISOString(),
    base: BASE.endsWith('/') ? BASE : `${BASE}/`,
    catalogItems: files.length,     // legacy/compat label
    docs: files.length,             // number of .txt files
    chunkCount,
    engine: `lunr-${lunr.version || 'unknown'}`,
    source: path.relative(process.cwd(), path.join(__dirname, path.basename(__filename))),
    index: 'lunr-index.json',
    chunks: 'chunks.jsonl',
    windowLines: LINES,
    windowStep: STEP
  };
  await fsp.writeFile(path.join(OUT, 'agent3.meta.json'), JSON.stringify(meta, null, 2), 'utf8');

  const manifest = {
    base: BASE.endsWith('/') ? BASE : `${BASE}/`,
    index: 'lunr-index.json',
    chunks: 'chunks.jsonl',
    meta: 'agent3.meta.json'
  };
  await fsp.writeFile(path.join(OUT, 'agent3.json'), JSON.stringify(manifest, null, 2), 'utf8');

  console.log(`Built agent3: files=${files.length}, chunks=${chunkCount}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
