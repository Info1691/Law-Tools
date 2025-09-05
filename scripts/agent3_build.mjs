// Law-Tools/scripts/agent3_build.mjs
// Build a Lunr (BM25) index + chunks for all TXT in the Law-Texts catalogs.
// Node 20 (global fetch). Outputs: out/lunr-index.json, out/chunks.jsonl,
// out/agent3.json, out/agent3.meta.json

import fs from "node:fs/promises";
import path from "node:path";
import lunr from "lunr";

const OUT_DIR   = process.env.OUT || "out";
const BASE      = process.env.BASE || "https://texts.wwwbcb.org/";
const CATALOG_PATH = process.env.CATALOG_PATH || "";        // e.g. target/texts/catalog.json
const CATALOG_URL  = process.env.CATALOG_URL  || "";        // e.g. https://texts.wwwbcb.org/texts/catalog.json

function log(...a){ console.log("[agent3]", ...a); }

async function readCatalog() {
  if (CATALOG_PATH) {
    log("Reading catalog from file:", CATALOG_PATH);
    const txt = await fs.readFile(CATALOG_PATH, "utf8");
    return JSON.parse(txt);
  }
  const url = CATALOG_URL || (new URL("texts/catalog.json", BASE)).toString();
  log("Reading catalog from URL:", url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Catalog fetch failed ${res.status}`);
  return await res.json();
}

function flattenCatalog(cat) {
  const rows = [];
  const pushAll = (arr, kind) => (arr||[]).forEach(x => {
    rows.push({
      title: x.title || x.name || "",
      kind,
      jurisdiction: x.jurisdiction || x.jurisdiction_str || "",
      url_txt: x.url_txt,               // absolute or relative to BASE
    });
  });
  pushAll(cat.textbooks, "textbook");
  pushAll(cat.laws,      "law");
  pushAll(cat.rules,     "rule");
  return rows;
}

function absolutize(url_txt) {
  if (!url_txt) return null;
  if (/^https?:\/\//i.test(url_txt)) return url_txt;
  return new URL(url_txt.replace(/^\.\//, ""), BASE).toString();
}

async function fetchTxt(url) {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`TXT fetch failed ${r.status} ${url}`);
  return await r.text();
}

// very simple rule-based chunking to keep memory modest
function toChunks(fullText, maxLen = 1200) {
  const chunks = [];
  let i = 0;
  while (i < fullText.length) {
    const slice = fullText.slice(i, i + maxLen);
    chunks.push(slice);
    i += maxLen;
  }
  return chunks;
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const catalog = await readCatalog();
  const items = flattenCatalog(catalog);
  log(`Catalog items: ${items.length}`);

  // collect chunk docs for Lunr
  let cid = 0;
  const docs = [];          // for Lunr
  const lines = [];         // JSONL lines for chunks.jsonl

  for (const it of items) {
    const url = absolutize(it.url_txt);
    if (!url) continue;
    try {
      const txt = await fetchTxt(url);
      const chunks = toChunks(txt);
      for (const c of chunks) {
        const id = String(++cid);
        docs.push({
          id,
          text: c,
          title: it.title,
          kind: it.kind,
          jurisdiction: it.jurisdiction
        });
        // keep JSONL compact; UI shows URL + title + snippet
        lines.push(JSON.stringify({
          id,
          url,
          title: it.title,
          kind: it.kind,
          jurisdiction: it.jurisdiction,
          text: c
        }));
      }
    } catch (e) {
      log("WARN: skipping", it.url_txt, e.message);
    }
  }

  log(`Building Lunr index over ${docs.length} chunks…`);
  const idx = lunr(function () {
    this.ref("id");
    this.field("text");
    this.field("title");
    this.field("kind");
    this.field("jurisdiction");
    for (const d of docs) this.add(d);
  });

  const indexPath  = path.join(OUT_DIR, "lunr-index.json");
  const chunksPath = path.join(OUT_DIR, "chunks.jsonl");
  await fs.writeFile(indexPath, JSON.stringify(idx), "utf8");
  await fs.writeFile(chunksPath, lines.join("\n") + "\n", "utf8");

  const meta = {
    builtAt: new Date().toISOString(),
    base: BASE,
    catalogItems: items.length,
    docs: docs.length,
    chunkCount: docs.length,
    engine: `lunr-${lunr.version}`,
    source: "Law-Tools/scripts/agent3_build.mjs"
  };
  const bundle = {
    ...meta,
    index: "lunr-index.json",
    chunks: "chunks.jsonl"
  };

  await fs.writeFile(path.join(OUT_DIR, "agent3.meta.json"), JSON.stringify(meta, null, 2), "utf8");
  await fs.writeFile(path.join(OUT_DIR, "agent3.json"),      JSON.stringify(bundle, null, 2), "utf8");

  log("Wrote:", indexPath, chunksPath, "agent3.json", "agent3.meta.json");
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
