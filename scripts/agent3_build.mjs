// Law-Tools/scripts/agent3_build.mjs
// Build a Lunr (BM25) index + chunks for all TXT in the Law-Texts catalogs.
// Outputs: out/lunr-index.json, out/chunks.jsonl, out/agent3.json, out/agent3.meta.json

import fs from "node:fs/promises";
import path from "node:path";
import lunr from "lunr";

const OUT_DIR = process.env.OUT || "out";
const BASE    = process.env.BASE || "https://texts.wwwbcb.org/";

// You can point to local files OR to URLs. If a *PATH exists*, it wins.
// Otherwise we fetch the *URL* (or the default).
const TB_PATH = process.env.CATALOG_TEXTBOOKS_PATH || "";
const LA_PATH = process.env.CATALOG_LAWS_PATH      || "";
const RU_PATH = process.env.CATALOG_RULES_PATH     || "";

const TB_URL  = process.env.CATALOG_TEXTBOOKS_URL  || new URL("texts/catalog.json", BASE).toString();
const LA_URL  = process.env.CATALOG_LAWS_URL       || new URL("laws.json", BASE).toString();
const RU_URL  = process.env.CATALOG_RULES_URL      || new URL("rules.json", BASE).toString();

function log(...a){ console.log("[agent3]", ...a); }

async function readMaybe(pathStr, urlStr) {
  if (pathStr) {
    try {
      const txt = await fs.readFile(pathStr, "utf8");
      log("Read catalog file:", pathStr);
      return JSON.parse(txt);
    } catch (e) {
      log("WARN: could not read", pathStr, e.message, "→ will try URL");
    }
  }
  const res = await fetch(urlStr, { redirect: "follow" });
  if (!res.ok) throw new Error(`Catalog fetch failed ${res.status} ${urlStr}`);
  log("Fetched catalog:", urlStr);
  return await res.json();
}

// accept several plausible shapes
function toArray(obj) {
  if (!obj) return [];
  if (Array.isArray(obj)) return obj;
  if (Array.isArray(obj.items)) return obj.items;
  return [];
}
function mapItem(it, kind) {
  const url_txt = it.url_txt || it.url || it.urlTxt || it.href;
  const title   = it.title || it.name || it.caption || "";
  const jurisdiction = it.jurisdiction || it.jurisdiction_str || it.juris || "";
  return url_txt ? { title, kind, jurisdiction, url_txt } : null;
}
function collect(obj, key, kind) {
  // if catalog has {textbooks:[…]} use that; else treat the whole obj as the array
  const arr = Array.isArray(obj?.[key]) ? obj[key] : toArray(obj);
  return arr.map(x => mapItem(x, kind)).filter(Boolean);
}

function absolutize(u) {
  if (!u) return null;
  if (/^https?:\/\//i.test(u)) return u;
  return new URL(u.replace(/^\.\//, ""), BASE).toString();
}

// lightweight chunking to keep memory steady
function toChunks(txt, max = 1200) {
  const out = [];
  for (let i=0; i<txt.length; i+=max) out.push(txt.slice(i, i+max));
  return out;
}

async function fetchTxt(u) {
  const r = await fetch(u, { redirect: "follow" });
  if (!r.ok) throw new Error(`TXT fetch failed ${r.status} ${u}`);
  return await r.text();
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const tb = await readMaybe(TB_PATH, TB_URL);
  const la = await readMaybe(LA_PATH, LA_URL);
  const ru = await readMaybe(RU_PATH, RU_URL);

  const textbooks = collect(tb, "textbooks", "textbook");
  const laws      = collect(la, "laws",      "law");
  const rules     = collect(ru, "rules",     "rule");

  const items = [...textbooks, ...laws, ...rules];
  log(`Catalog counts — textbooks: ${textbooks.length}, laws: ${laws.length}, rules: ${rules.length}, total: ${items.length}`);

  let cid = 0;
  const docs = [];
  const lines = [];

  for (const it of items) {
    const url = absolutize(it.url_txt);
    try {
      const txt = await fetchTxt(url);
      for (const chunk of toChunks(txt)) {
        const id = String(++cid);
        docs.push({ id, text: chunk, title: it.title, kind: it.kind, jurisdiction: it.jurisdiction });
        lines.push(JSON.stringify({ id, url, title: it.title, kind: it.kind, jurisdiction: it.jurisdiction, text: chunk }));
      }
    } catch (e) {
      log("WARN: skipping", url, e.message);
    }
  }

  log(`Indexing ${docs.length} chunks with Lunr ${lunr.version}…`);
  const idx = lunr(function () {
    this.ref("id");
    this.field("text");
    this.field("title");
    this.field("kind");
    this.field("jurisdiction");
    for (const d of docs) this.add(d);
  });

  await fs.writeFile(path.join(OUT_DIR, "lunr-index.json"), JSON.stringify(idx), "utf8");
  await fs.writeFile(path.join(OUT_DIR, "chunks.jsonl"),     lines.join("\n") + "\n", "utf8");

  const meta = {
    builtAt: new Date().toISOString(),
    base: BASE,
    catalogItems: items.length,
    docs: docs.length,
    chunkCount: docs.length,
    engine: `lunr-${lunr.version}`,
    source: "Law-Tools/scripts/agent3_build.mjs"
  };
  const bundle = { ...meta, index: "lunr-index.json", chunks: "chunks.jsonl" };

  await fs.writeFile(path.join(OUT_DIR, "agent3.meta.json"), JSON.stringify(meta,   null, 2), "utf8");
  await fs.writeFile(path.join(OUT_DIR, "agent3.json"),      JSON.stringify(bundle, null, 2), "utf8");

  log("DONE → out/:", ["lunr-index.json","chunks.jsonl","agent3.json","agent3.meta.json"].join(", "));
}

main().catch(e => { console.error(e); process.exit(1); });
