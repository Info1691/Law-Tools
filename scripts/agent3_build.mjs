// scripts/agent3_build.mjs
// Build BM25/Lunr index for all TXT listed in Law-Texts-ui/texts/catalog.json
// Outputs: out/agent3.json (Lunr index), out/agent3.meta.json, out/chunks.jsonl

import fs from 'node:fs';
import path from 'node:path';
import lunr from 'lunr';

const TARGET = process.env.TARGET || path.resolve('./target');
const OUT    = process.env.OUT    || path.resolve('./out');
const BASE   = 'https://texts.wwwbcb.org/';

await main().catch(err => {
  console.error(err);
  process.exit(1);
});

async function main () {
  ensureDir(OUT);

  const catalogPath = path.join(TARGET, 'texts', 'catalog.json');
  assertFile(catalogPath, 'catalog.json not found; did you checkout Law-Texts-ui to ./target ?');

  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const items = flattenCatalog(catalog);

  const {docs, byDoc} = await fetchAndChunk(items);
  console.log(`Built index. docs(chunks)=${docs.length}`);

  // Build Lunr index
  const idx = lunr(function () {
    this.ref('id');
    this.field('text');
    this.field('title');
    this.field('kind');
    this.field('jurisdiction');

    // Slightly boost title/kind/jurisdiction
    this.field('title', { boost: 3 });
    this.field('kind', { boost: 1.5 });
    this.field('jurisdiction', { boost: 1.5 });

    docs.forEach(d => this.add(d));
  });

  // Write expected filenames
  const outIndex = path.join(OUT, 'agent3.json');
  fs.writeFileSync(outIndex, JSON.stringify(idx), 'utf8');

  const outChunks = path.join(OUT, 'chunks.jsonl');
  const chunkStream = fs.createWriteStream(outChunks, 'utf8');
  for (const d of docs) {
    // Keep only what the UI needs at display time
    const line = JSON.stringify({
      id: d.id,
      url: d.url,
      title: d.title,
      kind: d.kind,
      jurisdiction: d.jurisdiction,
      text: d.text
    }) + '\n';
    chunkStream.write(line);
  }
  await finished(chunkStream);

  const meta = {
    builtAt: new Date().toISOString(),
    base: BASE,
    catalogItems: items.length,
    chunkCount: docs.length,
    docs: Object.keys(byDoc).length,
    engine: 'lunr-2.3.9',
    source: 'Law-Tools/scripts/agent3_build.mjs'
  };
  fs.writeFileSync(path.join(OUT, 'agent3.meta.json'), JSON.stringify(meta, null, 2), 'utf8');
}

// ---------- helpers ----------

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function assertFile(p, msg) {
  if (!fs.existsSync(p)) {
    throw new Error(`${msg} (${p})`);
  }
}

function flattenCatalog(catalog) {
  const take = (arr, kind) =>
    (Array.isArray(arr) ? arr : []).map(x => ({ ...x, kind }));

  const all = [
    ...take(catalog.textbooks, 'textbook'),
    ...take(catalog.laws,      'law'),
    ...take(catalog.rules,     'rule')
  ];

  // Keep only items that have a url_txt
  return all.filter(x => !!x.url_txt);
}

function resolveTxtUrl(url_txt) {
  if (/^https?:\/\//i.test(url_txt)) return url_txt;
  // Resolve relative catalog entries against texts.wwwbcb.org root
  return new URL(url_txt.replace(/^\.?\//, ''), BASE).toString();
}

async function fetchAndChunk(items) {
  const docs = [];
  const byDoc = Object.create(null);

  // Simple concurrency
  const queue = items.map((item, i) => async () => {
    const url = resolveTxtUrl(item.url_txt);
    const title = item.title || '(untitled)';
    const jurisdiction = item.jurisdiction || '';

    let txt = '';
    try {
      const r = await fetch(url, { redirect: 'follow' });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      txt = await r.text();
    } catch (e) {
      console.warn(`Fetch failed for ${url} — ${String(e)}`);
      txt = ''; // still include a tiny stub so catalog positions line up
    }

    const chunks = makeChunks(txt, 600, 180); // size ~600 chars, overlap ~180
    const docId = `d${i}`;

    byDoc[docId] = { url, title, jurisdiction, kind: item.kind };

    chunks.forEach((text, j) => {
      const id = `${docId}_c${j}`;
      docs.push({
        id,
        text,
        title,
        kind: item.kind,
        jurisdiction,
        url
      });
    });
  });

  // Run with limited parallelism
  await pAll(queue, 8);
  return { docs, byDoc };
}

function makeChunks(txt, size, overlap) {
  const out = [];
  const clean = txt.replace(/\r/g, '').replace(/\t/g, ' ').replace(/[ ]{2,}/g, ' ');
  // Prefer paragraph splits; then window if long
  const paras = clean.split(/\n{2,}/g).map(s => s.trim()).filter(Boolean);

  for (const p of paras) {
    if (p.length <= size) {
      out.push(p);
      continue;
    }
    // sliding window with overlap
    let start = 0;
    while (start < p.length) {
      const end = Math.min(start + size, p.length);
      out.push(p.slice(start, end));
      if (end === p.length) break;
      start = end - overlap;
      if (start < 0) start = 0;
    }
  }
  return out;
}

async function pAll(tasks, concurrency = 8) {
  const q = tasks.slice();
  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  async function worker() {
    while (q.length) {
      const fn = q.shift();
      try { await fn(); } catch (e) { console.warn(e); }
    }
  }
}

function finished(stream) {
  return new Promise((res, rej) => {
    stream.on('finish', res);
    stream.on('error', rej);
    stream.end();
  });
}
