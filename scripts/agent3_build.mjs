// Build a chunked text collection and a Lunr index from the live catalogs.
// Outputs:
//   lunr-index.json   (Lunr serialized index)
//   chunks.jsonl      (one JSON object per line with metadata + chunk text)
//
// Usage: node scripts/agent3_build.mjs --out <dir>

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import lunr from 'lunr';

const OUT_ARG = (() => {
  const i = process.argv.indexOf('--out');
  return i > -1 ? process.argv[i + 1] : 'data/agent3';
})();

const ROOT = 'https://texts.wwwbcb.org';
const CATALOGS = [
  `${ROOT}/texts/catalog.json`, // textbooks
  `${ROOT}/laws.json`,          // laws
  `${ROOT}/rules.json`,         // rules
];

const CHUNK = 800;     // characters
const OVERLAP = 120;   // characters

function resolveUrl(base, maybeRelative) {
  try { return new URL(maybeRelative, base).href; } catch { return null; }
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

function normalizeUtf8(s) {
  return s
    .replace(/\r\n?/g, '\n')       // newlines
    .replace(/\uFEFF/g, '')        // BOM
    .replace(/[^\S\n]+/g, ' ')     // collapse spaces (except newlines)
    .replace(/[ \t]+\n/g, '\n');   // trim line ends
}

function chunkText(txt, size = CHUNK, overlap = OVERLAP) {
  const chunks = [];
  let i = 0;
  while (i < txt.length) {
    const end = Math.min(txt.length, i + size);
    chunks.push(txt.slice(i, end));
    if (end === txt.length) break;
    i = end - overlap;
    if (i < 0) i = 0;
  }
  return chunks;
}

async function fetchJson(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`Fetch ${url} -> ${r.status}`);
  return await r.json();
}

async function fetchTxt(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`Fetch ${url} -> ${r.status}`);
  return await r.text();
}

function pick(v, k, d='') { return (v && v[k]) ? v[k] : d; }

async function readCatalog(catalogUrl) {
  const base = new URL(catalogUrl).href;
  const arr = await fetchJson(catalogUrl);
  // Expect array of items with url_txt; keep flexible on other keys.
  return arr
    .map((it, idx) => {
      const urlRel = pick(it, 'url_txt', pick(it, 'url', null));
      const urlTxt = urlRel ? resolveUrl(base, urlRel) : null;
      return {
        id: `${path.basename(catalogUrl)}#${idx}`,
        title: pick(it, 'title', path.basename(urlRel || `item-${idx}`)),
        kind: pick(it, 'source', pick(it, 'kind', 'text')),
        jurisdiction: pick(it, 'jurisdiction', ''),
        urlTxt,
      };
    })
    .filter(x => !!x.urlTxt);
}

function buildLunr(docs) {
  return lunr(function () {
    this.ref('id');
    this.field('text');
    this.field('title');
    this.field('kind');
    this.field('jurisdiction');

    for (const d of docs) {
      this.add({
        id: d.id,
        text: d.text,
        title: d.title,
        kind: d.kind,
        jurisdiction: d.jurisdiction,
      });
    }
  });
}

async function main() {
  const outDir = OUT_ARG;
  await ensureDir(outDir);

  // 1) read all catalogs
  let items = [];
  for (const c of CATALOGS) {
    try {
      const part = await readCatalog(c);
      items = items.concat(part);
    } catch (e) {
      console.error(`Catalog read failed: ${c} -> ${e.message}`);
    }
  }
  if (!items.length) throw new Error('No catalog entries found.');

  // 2) fetch & chunk
  const chunks = [];
  let chunkId = 0;

  for (const it of items) {
    try {
      const raw = await fetchTxt(it.urlTxt);
      const norm = normalizeUtf8(raw);
      const parts = chunkText(norm);
      for (const p of parts) {
        chunks.push({
          id: `c${++chunkId}`,
          title: it.title,
          kind: it.kind,
          jurisdiction: it.jurisdiction,
          url: it.urlTxt,
          text: p,
        });
      }
    } catch (e) {
      console.warn(`Skip ${it.urlTxt} (${it.title}) -> ${e.message}`);
    }
  }

  if (!chunks.length) throw new Error('No text chunks created.');

  // 3) build Lunr over chunks
  const idx = buildLunr(chunks);

  // 4) write outputs
  const idxPath = path.join(outDir, 'lunr-index.json');
  const chunksPath = path.join(outDir, 'chunks.jsonl');

  await fs.writeFile(idxPath, JSON.stringify(idx), 'utf8');
  const lines = chunks.map(o => JSON.stringify(o)).join('\n') + '\n';
  await fs.writeFile(chunksPath, lines, 'utf8');

  console.log(`Wrote ${idxPath} and ${chunksPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
