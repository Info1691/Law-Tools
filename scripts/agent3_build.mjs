/* Build a BM25 (Lunr) index over ALL TXT in catalogs.
 * Output:
 *   out/lunr-index.json  — serialized lunr index
 *   out/chunks.jsonl     — newline-delimited JSON {id,src,title,kind,juris,url,offset,text}
 * These are committed by CI into Law-Texts-ui/data/agent3/.
 */
import fs from 'node:fs';
import path from 'node:path';
import lunr from 'lunr';

// --- config
const CATALOGS = [
  { url: process.env.CATALOG_TEXTBOOKS, kind: 'textbook' },
  { url: process.env.CATALOG_LAWS,      kind: 'law' },
  { url: process.env.CATALOG_RULES,     kind: 'rule' },
];
const OUTDIR = 'out';
const CHUNK_SIZE = 1400;      // characters
const CHUNK_OVERLAP = 200;    // characters

if (!fs.existsSync(OUTDIR)) fs.mkdirSync(OUTDIR, { recursive: true });

// --- helpers
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clean = (s) =>
  (s || '')
    .replace(/^\uFEFF/, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\u200B/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');

function chunkText(full) {
  const chunks = [];
  let i = 0, id = 0;
  while (i < full.length) {
    const end = Math.min(full.length, i + CHUNK_SIZE);
    const slice = full.slice(i, end);
    chunks.push({ id: id++, text: slice, offset: i });
    i = end - CHUNK_OVERLAP;
    if (i < 0) i = 0;
    if (i >= full.length) break;
  }
  return chunks;
}

// Resolve url_txt possibly relative to the catalog JSON URL
function resolveUrl(catalogUrl, urlTxt) {
  try { return new URL(urlTxt, catalogUrl).href; } catch { return urlTxt; }
}

// --- load catalogs
async function loadCatalog(c) {
  const res = await fetch(c.url);
  if (!res.ok) throw new Error(`Catalog fetch failed: ${c.url} -> ${res.status}`);
  const data = await res.json();
  // both schemas supported: array of objects with url_txt + title, or url fields directly
  return (data.items || data).map((it, idx) => ({
    kind: c.kind,
    title: it.title || it.name || `untitled-${idx}`,
    juris: it.jurisdiction || it.juris || '',
    url: resolveUrl(c.url, it.url_txt || it.url || it.href),
    src: c.url,
  }));
}

async function fetchText(u) {
  // be nice to GH Pages
  await sleep(80);
  const res = await fetch(u, { redirect: 'follow' });
  if (!res.ok) throw new Error(`TXT fetch failed: ${u} -> ${res.status}`);
  return await res.text();
}

const catalogs = [];
for (const c of CATALOGS) {
  if (!c.url) continue;
  catalogs.push(...await loadCatalog(c));
}

// --- build chunks + docs
const chunks = [];
let globalId = 0;
for (const doc of catalogs) {
  try {
    const txt = clean(await fetchText(doc.url));
    const parts = chunkText(txt);
    for (const p of parts) {
      const id = `d${globalId++}`;
      chunks.push({
        id,
        src: doc.src,
        title: doc.title,
        kind: doc.kind,
        juris: doc.juris,
        url: doc.url,
        offset: p.offset,
        text: p.text
      });
    }
  } catch (e) {
    console.error('SKIP (fetch error):', doc.url, String(e));
  }
}

// --- lunr index (BM25)
const idx = lunr(function () {
  this.ref('id');
  this.field('text');
  this.field('title');
  this.field('kind');
  this.field('juris');

  // smaller pipeline to keep original tokens useful for legal cites
  this.pipeline.reset();
  this.searchPipeline.reset();

  for (const c of chunks) this.add(c);
});

fs.writeFileSync(path.join(OUTDIR, 'lunr-index.json'), JSON.stringify(idx), 'utf8');
const w = fs.createWriteStream(path.join(OUTDIR, 'chunks.jsonl'));
for (const c of chunks) w.write(JSON.stringify(c) + '\n');
w.end();
console.log(`Indexed ${chunks.length} chunks across ${catalogs.length} documents.`);
