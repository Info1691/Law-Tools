// scripts/agent3_build.mjs
// Build a Lunr index from the TXT catalog(s) in a checked-out Law-Texts-ui repo.
// Outputs: ./out/lunr-index.json and ./out/chunks.jsonl

import fs from "fs/promises";
import path from "node:path";
import lunr from "lunr";

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.split("=");
  return [k.replace(/^--/, ""), v ?? "true"];
}));

const TARGET = path.resolve(argv.target || "./target");
const OUTDIR = path.resolve(argv.out || "./out");

// Helpers
async function readJson(p) {
  try { return JSON.parse(await fs.readFile(p, "utf8")); }
  catch { return null; }
}
async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

// Load catalogs (textbooks at texts/catalog.json; try laws.json & rules.json if present)
async function loadCatalogItems() {
  const items = [];

  const textbooks = await readJson(path.join(TARGET, "texts", "catalog.json"));
  if (Array.isArray(textbooks)) items.push(...textbooks);

  const laws = await readJson(path.join(TARGET, "laws.json"));
  if (Array.isArray(laws)) items.push(...laws);

  const rules = await readJson(path.join(TARGET, "rules.json"));
  if (Array.isArray(rules)) items.push(...rules);

  // Normalise a couple of fields we rely on
  for (const it of items) {
    it.title = it.title || it.name || "";
    it.kind = it.kind || it.category || "";
    it.jurisdiction = it.jurisdiction || it.juris || "";
    it.url_txt = it.url_txt || it.url || it.href || "";
  }
  return items.filter(it => typeof it.url_txt === "string" && it.url_txt.length);
}

// Resolve a catalog url_txt to a local repo path
function resolveLocalTxtPath(urlTxt) {
  // Most entries are relative like "./data/…". Accept several forms.
  const cleaned = urlTxt.replace(/^\.?\//, "");
  if (cleaned.startsWith("data/")) return path.join(TARGET, cleaned);
  // If absolute to texts.wwwbcb.org, strip origin
  const m = urlTxt.match(/https?:\/\/[^/]+\/(.+)/i);
  if (m) return path.join(TARGET, m[1]);
  // Fallback: assume it's already relative to repo root
  return path.join(TARGET, cleaned);
}

// Chunk a big string into overlapping windows (good for search)
function* chunkText(text, size = 900, stride = 700) {
  const n = text.length;
  if (n <= size) { yield { start: 0, end: n, text }; return; }
  for (let i = 0; i < n; i += stride) {
    const end = Math.min(i + size, n);
    yield { start: i, end, text: text.slice(i, end) };
    if (end === n) break;
  }
}

async function main() {
  await fs.mkdir(OUTDIR, { recursive: true });

  const items = await loadCatalogItems();
  if (!items.length) {
    console.error("No catalog items found. Is TARGET correct? TARGET=", TARGET);
    process.exit(2);
  }

  const chunks = []; // {id,title,kind,jurisdiction,url_txt,offset,text}
  let nextId = 0;

  // Build Lunr
  const builder = new lunr.Builder();
  builder.ref("id");
  builder.field("text");
  builder.field("title");
  builder.field("kind");
  builder.field("jurisdiction");

  for (const it of items) {
    const local = resolveLocalTxtPath(it.url_txt);
    if (!(await exists(local))) continue;

    const raw = await fs.readFile(local, "utf8");
    for (const c of chunkText(raw)) {
      const id = String(nextId++);
      const record = {
        id,
        title: it.title,
        kind: it.kind,
        jurisdiction: it.jurisdiction,
        url_txt: it.url_txt,
        offset: c.start,
        text: c.text
      };
      chunks.push(record);
      builder.add(record);
    }
  }

  const idx = builder.build().toJSON();

  // Write outputs
  await fs.writeFile(path.join(OUTDIR, "lunr-index.json"), JSON.stringify(idx), "utf8");

  // JSONL for chunks (stream-friendly)
  const lines = chunks.map(o => JSON.stringify(o)).join("\n");
  await fs.writeFile(path.join(OUTDIR, "chunks.jsonl"), lines, "utf8");

  // Small debug message so the action log shows counts
  console.log(`Built index. docs(chunks)=${chunks.length}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
