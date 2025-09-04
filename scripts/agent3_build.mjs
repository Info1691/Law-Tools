#!/usr/bin/env node
/**
 * Build Agent 3 BM25 index from catalogs on texts.wwwbcb.org
 * Writes:
 *   <out>/chunks.jsonl    (JSONL of chunk metadata + text)
 *   <out>/lunr-index.json (Lunr v2 index over chunk text, ref=id)
 *
 * Usage:
 *   node scripts/agent3_build.mjs --out target/data/agent3
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import lunr from 'lunr';

// ---------- config ----------
const CATALOGS = [
  'https://texts.wwwbcb.org/texts/catalog.json',
  'https://texts.wwwbcb.org/laws.json',
  'https://texts.wwwbcb.org/rules.json'
];

const ABS_BASE = 'https://texts.wwwbcb.org/'; // for resolving ./data/… paths

// Chunking tuned for good recall without ballooning memory
const CHUNK_SIZE = 850;
const CHUNK_OVERLAP = 120;

// Optionally limit docs for debugging via env, e.g. MAX_DOCS=5
const MAX_DOCS = process.env.MAX_DOCS ? parseInt(process.env.MAX_DOCS, 10) : Infinity;
// ---------------------------

function resolveOutDir(argv) {
  const i = argv.indexOf('--out');
  if (i === -1 || !argv[i + 1]) {
    console.error('Missing --out <dir>');
    process.exit(1);
  }
  return argv[i + 1];
}

function cleanText(s) {
  return s
    .replace(/^\uFEFF/, '')   // BOM
    .replace(/\u00A0/g, ' ')  // NBSP
    .replace(/\u200B/g, '')   // ZWSP
    .replace(/\r\n/g, '\n');
}

function kindFromPath(p) {
  if (p.includes('/textbooks/')) return 'textbook';
  if (p.includes('/laws/')) return 'law';
  if (p.includes('/rules/')) return 'rule';
  return 'unknown';
}

function jurisFromPath(p) {
  if (p.includes('/jersey/')) return 'jersey';
  if (p.includes('/uk/')) return 'uk';
  return '';
}

function toAbs(urlTxt) {
  // catalogs usually carry ./data/… or /data/…
  if (/^https?:\/\//i.test(urlTxt)) return urlTxt;
  if (urlTxt.startsWith('./')) return new URL(urlTxt.slice(2), ABS_BASE).toString();
  if (urlTxt.startsWith('/'))  return new URL(urlTxt.slice(1), ABS_BASE).toString();
  return new URL(urlTxt, ABS_BASE).toString();
}

async function fetchJSON(u) {
  const r = await fetch(u, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${u}`);
  return r.json();
}

async function fetchText(u) {
  const r = await fetch(u, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${u}`);
  return r.text();
}

function* chunker(text) {
  const n = text.length;
  let i = 0;
  while (i < n) {
    const end = Math.min(n, i + CHUNK_SIZE);
    yield text.slice(i, end);
    if (end === n) break;
    i = Math.max(end - CHUNK_OVERLAP, i + 1);
  }
}

async function gatherDocs() {
  const all = [];
  for (const c of CATALOGS) {
    try {
      const arr = await fetchJSON(c);
      // expect array of { title, url_txt, ... }
      for (const row of arr) {
        if (!row || !row.url_txt) continue;
        const abs = toAbs(row.url_txt);
        const p = new URL(abs).pathname; // /data/…
        all.push({
          title: row.title || path.basename(p),
          url: abs,
          relpath: p,
          kind: row.kind || kindFromPath(p),
          juris: row.jurisdiction || jurisFromPath(p),
        });
      }
    } catch (e) {
      console.warn(`Catalog load warning for ${c}: ${e.message}`);
    }
  }
  // de-dupe by URL (some catalogs may overlap)
  const seen = new Set();
  const deduped = [];
  for (const d of all) {
    if (seen.has(d.url)) continue;
    seen.add(d.url);
    deduped.push(d);
  }
  return deduped.slice(0, MAX_DOCS);
}

async function main() {
  const outDir = resolveOutDir(process.argv);
  await fsp.mkdir(outDir, { recursive: true });

  const chunksPath = path.join(outDir, 'chunks.jsonl');
  const idxPath    = path.join(outDir, 'lunr-index.json');

  const docs = await gatherDocs();
  console.log(`Building from ${docs.length} documents…`);
  const ws = fs.createWriteStream(chunksPath, { encoding: 'utf8' });

  let idCounter = 1;

  // Build Lunr index (lean): ref=id, field=text only
  const builder = new lunr.Builder();
  builder.ref('id');
  builder.field('text');

  for (const d of docs) {
    let txt = '';
    try {
      txt = cleanText(await fetchText(d.url));
    } catch (e) {
      console.warn(`Fetch failed for ${d.url}: ${e.message}`);
      continue;
    }

    let local = 0;
    for (const piece of chunker(txt)) {
      const obj = {
        id: String(idCounter++),
        url: d.url,
        title: d.title,
        kind: d.kind,
        juris: d.juris,
        text: piece
      };
      ws.write(JSON.stringify(obj) + '\n');
      // add only the minimum to the index to keep memory modest
      builder.add({ id: obj.id, text: obj.text });
      local++;
    }
    console.log(`✓ ${d.title} — ${local} chunks`);
  }

  ws.end();

  const index = builder.build();
  await fsp.writeFile(idxPath, JSON.stringify(index), 'utf8');
  console.log(`Wrote:\n  ${chunksPath}\n  ${idxPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
