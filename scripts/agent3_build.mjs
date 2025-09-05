// Minimal, explicit builder: fetch 3 catalogs, fetch TXT, chunk, build lunr, emit 4 files.
// Inputs:  --out <dir>   (required)
//          --catalogs "<url1>\n<url2>\n<url3>"  (required)
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import lunr from 'lunr';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith('--')) a.push([v.replace(/^--/,''),
    (arr[i+1] && !arr[i+1].startsWith('--')) ? arr[i+1] : '']);
  return a;
}, []));

const OUT = args.out?.trim();
if (!OUT) {
  console.error('ERROR: --out is required');
  process.exit(2);
}

const catalogsRaw = (args.catalogs || '').trim();
if (!catalogsRaw) {
  console.error('ERROR: --catalogs "<url1>\\n<url2>\\n<url3>" is required');
  process.exit(2);
}

await fs.mkdir(OUT, { recursive: true });

const catalogUrls = catalogsRaw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

async function getJson(url) {
  const r = await fetch(url, { headers: { 'Accept': 'application/json' }});
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.json();
}
async function getTxt(url) {
  const r = await fetch(url, { headers: { 'Accept': 'text/plain' }});
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.text();
}

// 1) Load catalogs
const items = [];
for (const url of catalogUrls) {
  const arr = await getJson(url);
  for (const it of arr) {
    if (it?.url_txt) items.push({
      title: it.title || '',
      kind: it.kind || '',
      jurisdiction: it.jurisdiction || '',
      url: it.url_txt
    });
  }
}

// 2) Fetch & chunk (simple paragraph splitter)
const docs = [];
const chunks = [];
const MAX_DOCS = 50000; // safety
let docId = 0;
for (const it of items) {
  if (docId >= MAX_DOCS) break;
  try {
    const text = await getTxt(it.url);
    const paras = text.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
    const baseId = `d${docId++}`;
    docs.push({ id: baseId, title: it.title, kind: it.kind, jurisdiction: it.jurisdiction, url: it.url, paraCount: paras.length });

    paras.forEach((p, i) => {
      chunks.push({
        id: `${baseId}#${i}`,
        text: p,
        title: it.title,
        kind: it.kind,
        jurisdiction: it.jurisdiction,
        url: it.url
      });
    });
  } catch (e) {
    console.warn('WARN: skipping', it.url, String(e));
  }
}

// 3) Build lunr index
const idx = lunr(function () {
  this.ref('id');
  this.field('text');
  this.field('title');
  this.field('kind');
  this.field('jurisdiction');
  for (const c of chunks) this.add(c);
});

// 4) Emit files
await fs.writeFile(path.join(OUT, 'lunr-index.json'), JSON.stringify(idx));
await fs.writeFile(path.join(OUT, 'chunks.jsonl'), chunks.map(c => JSON.stringify(c)).join('\n')+'\n');

const meta = {
  builtAt: new Date().toISOString(),
  base: 'https://texts.wwwbcb.org/',
  catalogItems: items.length,
  docs: docs.length,
  chunkCount: chunks.length,
  engine: 'lunr-2.3.9',
  source: 'Law-Tools/scripts/agent3_build.mjs',
  index: 'lunr-index.json',
  chunks: 'chunks.jsonl'
};
await fs.writeFile(path.join(OUT, 'agent3.meta.json'), JSON.stringify(meta, null, 2));
await fs.writeFile(path.join(OUT, 'agent3.json'), JSON.stringify({ ok: true }));

console.log(`Built index. items=${items.length} docs=${docs.length} chunks=${chunks.length}`);
