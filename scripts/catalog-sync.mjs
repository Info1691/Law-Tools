// catalog-sync.mjs
// Normalizes url_txt in Law-Texts-ui catalogs to absolute URLs on https://texts.wwwbcb.org
// No external deps; uses Node 20 fetch + GitHub Contents API.

import { Buffer } from "node:buffer";

const GH_TOKEN = process.env.GH_TOKEN;
if (!GH_TOKEN) {
  console.error("GH_TOKEN is missing"); // mapped from TEXTS_RW_TOKEN in the workflow
  process.exit(1);
}

const OWNER = process.env.TEXTS_OWNER || "Info1691";
const REPO = process.env.TEXTS_REPO || "Law-Texts-ui";
const BRANCH = process.env.TEXTS_BRANCH || "main";
const BASE = (process.env.TEXTS_BASE || "https://texts.wwwbcb.org").replace(/\/+$/, "");

const GH = "https://api.github.com";
const HEADERS = {
  Authorization: `Bearer ${GH_TOKEN}`,
  Accept: "application/vnd.github+json",
};

// --- GitHub Contents API helpers ---
async function getFile(path) {
  const url = `${GH}/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(BRANCH)}`;
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`);
  const j = await r.json();
  const content = Buffer.from(j.content, j.encoding || "base64").toString("utf8");
  return { sha: j.sha, content };
}

async function putFile(path, sha, newContent, message) {
  const url = `${GH}/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(path)}`;
  const body = {
    message,
    content: Buffer.from(newContent, "utf8").toString("base64"),
    sha,
    branch: BRANCH,
  };
  const r = await fetch(url, {
    method: "PUT",
    headers: { ...HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`PUT ${path} -> ${r.status} ${await r.text()}`);
}

// --- url_txt normalization ---
function fixUrl(u) {
  if (!u || typeof u !== "string") return u;

  // Convert relative (“./…”) to absolute on texts.wwwbcb.org
  if (u.startsWith("./")) return `${BASE}${u.slice(1)}`;

  // Old domain → new domain
  if (u.startsWith("https://info1691.github.io/law-index/")) {
    return u.replace("https://info1691.github.io/law-index", BASE);
  }

  return u;
}

function transform(jsonText) {
  let data = JSON.parse(jsonText);

  // Support either a plain array or { items: [...] }
  if (Array.isArray(data)) {
    data = data.map((it) => {
      if (it.url_txt) it.url_txt = fixUrl(it.url_txt);
      return it;
    });
  } else if (data && Array.isArray(data.items)) {
    data.items = data.items.map((it) => {
      if (it.url_txt) it.url_txt = fixUrl(it.url_txt);
      return it;
    });
  }

  return JSON.stringify(data, null, 2) + "\n";
}

// --- main ---
(async () => {
  const paths = ["texts/catalog.json", "laws.json", "rules.json"];
  for (const p of paths) {
    const { sha, content } = await getFile(p);
    const updated = transform(content);
    if (updated !== content) {
      await putFile(p, sha, updated, `catalog-sync: normalize url_txt to ${BASE}`);
      console.log(`Updated ${p}`);
    } else {
      console.log(`No changes for ${p}`);
    }
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
