#!/usr/bin/env node
/**
 * Agent3 Builder
 * - Scans a source directory for .txt files
 * - Emits:
 *    agent3.meta.json  -> { docs, chunkCount, builtAt }
 *    chunks.jsonl      -> one JSON per line with {id,url,title,text,lineStart,lineEnd,source}
 *    lunr-index.json   -> serialized lunr index (id,title,text)
 *    agent3.json       -> { base, index, chunks, meta } manifest
 *
 * USAGE:
 *   node scripts/agent3-build.mjs --src ./data --out ./agent3-bm25 --base https://texts.wwwbcb.org/raw
 *
 * NOTES:
 *   - Adjust --base to the public host that serves your raw TXT files.
 *   - Chunks are line-windowed for stable segment links (default 12 lines, step 6).
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';
import readline from 'node:readline';
import lunr from 'lunr';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i=0;i<args.length;i++){
    const a = args[i];
    if (a === '--src')  out.src  = args[++i];
    else if (a === '--out')  out.out  = args[++i];
    else if (a === '--base') out.base = args[++i];
    else if (a === '--lines') out.lines = parseInt(args[++i],10);
    else if (a === '--step')  out.step  = parseInt(args[++i],10);
  }
  return out;
}

function walkTxtFiles(root) {
  /** @type {string[]} */
  const files = [];
  (function rec(dir){
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) rec(p);
      else if (entry.isFile() && p.toLowerCase().endsWith('.txt')) files.push(p);
    }
  })(root);
  return files.sort();
}

async function readLines(file) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity
  });
  const lines = [];
  for await (const line of rl) lines.push(line);
  return lines;
}

function toPublicUrl(base, srcRoot, filePath) {
  // Convert local file path under srcRoot → public URL under base
  // e.g., srcRoot=/repo/data, filePath=/repo/data/laws/jersey/JTL-1984.txt
  // base=https://texts.wwwbcb.org/data → https://texts.wwwbcb.org/data/laws/jersey/JTL-1984.txt
  const rel = path.relative(srcRoot, filePath).split(path.sep).join('/');
  return `${base.replace(/\/+$/,'')}/${rel}`;
}

async function main() {
  const { src, out, base, lines: LINES = 12, step: STEP = 6 } = parseArgs();

  if (!src || !out || !base) {
    console.error('Usage: node scripts/agent3-build.mjs --src ./data --out ./agent3-bm25 --base https://texts.wwwbcb.org/data');
    process.exit(1);
  }
  await fsp.mkdir(out, { recursive: true });

  const files = walkTxtFiles(src);
  const chunksPath = path.join(out, 'chunks.jsonl');
  const chunksStream = fs.createWriteStream(chunksPath, { encoding: 'utf8' });

  /** Indexables for lunr */
  /** @type {{id:string,title:string,text:string}[]} */
  const docs = [];

  let idCounter = 0;
  let chunkCount = 0;

  for (const file of files) {
    const title = path.basename(file);
    const urlPub = toPublicUrl(base, src, file);
    const lines = await readLines(file);

    // create sliding windows
    for (let start = 0; start < lines.length; start += STEP) {
      const end = Math.min(lines.length, start + LINES);
      const text = lines.slice(start, end).join('\n').trim();
      if (!text) continue;

      const id = String(idCounter++);
      const rec = {
        id,
        url: urlPub,
        title,
        text,
        lineStart: start, // zero-based inclusive
        lineEnd: end,     // zero-based exclusive
        source: file
      };

      chunksStream.write(JSON.stringify(rec) + '\n');

      // For lunr indexing: keep id/title/text
      docs.push({ id, title, text });
      chunkCount++;

      if (end === lines.length) break; // finished
    }
  }
  chunksStream.end();

  // Build lunr index
  const idx = lunr(function () {
    this.ref('id');
    this.field('title');
    this.field('text');
    for (const d of docs) this.add(d);
  });

  const lunrPath = path.join(out, 'lunr-index.json');
  await fsp.writeFile(lunrPath, JSON.stringify(idx), 'utf8');

  // Meta
  const meta = {
    docs: files.length,
    chunkCount,
    builtAt: new Date().toISOString(),
    windowLines: LINES,
    windowStep: STEP
  };
  await fsp.writeFile(path.join(out, 'agent3.meta.json'), JSON.stringify(meta, null, 2), 'utf8');

  // Manifest
  const baseUrl = toPublicUrl(base, src, out).replace(/\/[^\/]+$/, '/'); // best-effort; not strictly needed
  const manifest = {
    base: `https://texts.wwwbcb.org/agent3-bm25/`, // CHANGE if you publish elsewhere
    index: "lunr-index.json",
    chunks: "chunks.jsonl",
    meta: "agent3.meta.json"
  };
  await fsp.writeFile(path.join(out, 'agent3.json'), JSON.stringify(manifest, null, 2), 'utf8');

  console.log(`Built agent3: files=${files.length}, chunks=${chunkCount}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
