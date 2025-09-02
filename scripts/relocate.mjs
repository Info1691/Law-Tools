// Relocate normalized .txt files into Law-Texts-ui canonical layout
// and regenerate catalogs the search UI uses.
// Requires env: GH_TOKEN (PAT), CANONICAL_OWNER, CANONICAL_REPO, CANONICAL_BRANCH, SITE_BASE, DRY_RUN

import { Octokit } from "@octokit/rest";
import path from "node:path";
import { Buffer } from "node:buffer";

const {
  GH_TOKEN,
  CANONICAL_OWNER = "Info1691",
  CANONICAL_REPO  = "Law-Texts-ui",
  CANONICAL_BRANCH = "main",
  SITE_BASE = "https://texts.wwwbcb.org",
  DRY_RUN = "false",
} = process.env;

if (!GH_TOKEN) {
  console.error("Missing GH_TOKEN (PAT with write to Law-Texts-ui).");
  process.exit(1);
}

const octokit = new Octokit({ auth: GH_TOKEN });

const SOURCES = [
  // textbooks produced by ingest or already in canonical repo
  { owner: "Info1691", repo: "lex-ingest-local", base: "law-index/texts", kind: "textbook" },
  { owner: "Info1691", repo: "Law-Texts-ui",     base: "data/textbooks",   kind: "textbook" },

  // laws + rules repos
  { owner: "Info1691", repo: "laws-ui",          base: "data/laws",        kind: "law" },
  { owner: "Info1691", repo: "rules-ui",         base: "data/rules",       kind: "rule" },
];

const KIND_FOLDER = {
  textbook: "textbooks",
  law: "laws",
  rule: "rules",
};

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function getDefaultBranchSHA(owner, repo, branch) {
  const { data } = await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });
  return data.object.sha;
}

async function createBranch(owner, repo, baseSha, branchName) {
  await octokit.git.createRef({
    owner, repo, ref: `refs/heads/${branchName}`, sha: baseSha
  });
}

async function getRecursive(owner, repo, basePath) {
  const out = [];
  async function walk(p) {
    let res;
    try {
      res = await octokit.repos.getContent({ owner, repo, path: p });
    } catch (e) {
      if (e.status === 404) return; else throw e;
    }
    const items = Array.isArray(res.data) ? res.data : [res.data];
    for (const it of items) {
      if (it.type === "dir") {
        await walk(it.path);
      } else if (it.type === "file" && it.name.toLowerCase().endsWith(".txt")) {
        out.push({ path: it.path, size: it.size });
      }
    }
  }
  await walk(basePath);
  return out;
}

function detectJurisdiction(p) {
  const m = p.match(/\/(jersey|uk)\//i);
  return m ? m[1].toLowerCase() : "unknown";
}

function computeDest(kind, srcPath) {
  const folder = KIND_FOLDER[kind];
  const jur = detectJurisdiction(srcPath);
  const filename = path.basename(srcPath).replace(/\s+/g, "-");
  return `data/${folder}/${jur}/${filename}`;
}

function toTitleFromFilename(filename) {
  const base = filename.replace(/\.txt$/i, "")
                       .replace(/[-_]+/g, " ")
                       .replace(/\s+/g, " ")
                       .trim();
  return base.length ? base[0].toUpperCase() + base.slice(1) : filename;
}

async function getRaw(owner, repo, p) {
  const res = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
    owner, repo, path: p,
    headers: { accept: "application/vnd.github.v3.raw" }
  });
  return Buffer.from(res.data);
}

async function getFileSHAIfExists(owner, repo, branch, p) {
  try {
    const r = await octokit.repos.getContent({ owner, repo, path: p, ref: branch });
    if (Array.isArray(r.data)) return null;
    return r.data.sha;
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

async function putFile(owner, repo, branch, p, content, message, sha=null) {
  await octokit.repos.createOrUpdateFileContents({
    owner, repo, path: p, branch,
    message,
    content: content.toString("base64"),
    sha: sha || undefined
  });
}

async function getCatalog(owner, repo, branch, p) {
  try {
    const res = await octokit.repos.getContent({
      owner, repo, path: p, ref: branch,
      headers: { accept: "application/vnd.github.v3.raw" }
    });
    return JSON.parse(res.data.toString());
  } catch (e) {
    if (e.status === 404) return [];
    throw e;
  }
}

function mergeCatalog(existing, entriesByUrl) {
  // Update url_txt when titles match (case-insensitive),
  // otherwise append new minimal entries.
  const byTitle = new Map(existing.map(e => [ (e.title || "").toLowerCase(), e ]));
  for (const ent of entriesByUrl) {
    const key = (ent.title || "").toLowerCase();
    if (byTitle.has(key)) {
      byTitle.get(key).url_txt = ent.url_txt;
    } else {
      existing.push(ent);
    }
  }
  return existing;
}

async function main() {
  const baseSha = await getDefaultBranchSHA(CANONICAL_OWNER, CANONICAL_REPO, CANONICAL_BRANCH);
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 13);
  const workBranch = `relocate-txt/${ts}`;

  if (DRY_RUN !== "true") {
    await createBranch(CANONICAL_OWNER, CANONICAL_REPO, baseSha, workBranch);
  }

  const plannedMoves = [];
  // 1) Collect all files from sources
  for (const s of SOURCES) {
    const files = await getRecursive(s.owner, s.repo, s.base);
    for (const f of files) {
      const dest = computeDest(s.kind, f.path);
      plannedMoves.push({
        kind: s.kind,
        srcOwner: s.owner,
        srcRepo: s.repo,
        srcPath: f.path,
        destPath: dest,
        jurisdiction: detectJurisdiction(f.path),
        filename: path.basename(f.path),
        size: f.size
      });
    }
  }

  // 2) Write/copy into Law-Texts-ui on a branch
  let nWrites = 0;
  for (const m of plannedMoves) {
    const msg = `Relocate ${m.kind}: ${m.srcRepo}/${m.srcPath} -> ${m.destPath}`;
    if (DRY_RUN === "true") {
      console.log("[DRY-RUN]", msg);
      continue;
    }
    const raw = await getRaw(m.srcOwner, m.srcRepo, m.srcPath);
    const sha = await getFileSHAIfExists(CANONICAL_OWNER, CANONICAL_REPO, workBranch, m.destPath);
    await putFile(CANONICAL_OWNER, CANONICAL_REPO, workBranch, m.destPath, raw, msg, sha);
    nWrites++;
    await sleep(200); // be gentle on API
  }

  // 3) Build catalogs from what we *expect* to exist post-move
  const textbooks = plannedMoves.filter(m => m.kind === "textbook").map(m => ({
    title: toTitleFromFilename(m.filename),
    jurisdiction: m.jurisdiction,
    url_txt: `${SITE_BASE}/${m.destPath}`
  }));
  const laws = plannedMoves.filter(m => m.kind === "law").map(m => ({
    title: toTitleFromFilename(m.filename),
    jurisdiction: m.jurisdiction,
    url_txt: `${SITE_BASE}/${m.destPath}`
  }));
  const rules = plannedMoves.filter(m => m.kind === "rule").map(m => ({
    title: toTitleFromFilename(m.filename),
    jurisdiction: m.jurisdiction,
    url_txt: `${SITE_BASE}/${m.destPath}`
  }));

  // Merge with existing (preserve nice titles if present)
  let catTextbooks = await getCatalog(CANONICAL_OWNER, CANONICAL_REPO, DRY_RUN === "true" ? CANONICAL_BRANCH : workBranch, "texts/catalog.json");
  let catLaws      = await getCatalog(CANONICAL_OWNER, CANONICAL_REPO, DRY_RUN === "true" ? CANONICAL_BRANCH : workBranch, "laws.json");
  let catRules     = await getCatalog(CANONICAL_OWNER, CANONICAL_REPO, DRY_RUN === "true" ? CANONICAL_BRANCH : workBranch, "rules.json");

  catTextbooks = mergeCatalog(catTextbooks, textbooks);
  catLaws      = mergeCatalog(catLaws, laws);
  catRules     = mergeCatalog(catRules, rules);

  if (DRY_RUN !== "true") {
    await putFile(CANONICAL_OWNER, CANONICAL_REPO, workBranch, "texts/catalog.json",
      Buffer.from(JSON.stringify(catTextbooks, null, 2)),
      "Update texts/catalog.json for relocated textbooks");
    await putFile(CANONICAL_OWNER, CANONICAL_REPO, workBranch, "laws.json",
      Buffer.from(JSON.stringify(catLaws, null, 2)),
      "Update laws.json for relocated laws");
    await putFile(CANONICAL_OWNER, CANONICAL_REPO, workBranch, "rules.json",
      Buffer.from(JSON.stringify(catRules, null, 2)),
      "Update rules.json for relocated rules");
  }

  // 4) PR
  if (DRY_RUN === "true") {
    console.log(`DRY-RUN complete. Planned copies: ${plannedMoves.length}.`);
    return;
  }

  const bodyLines = plannedMoves.map(m =>
    `- ${m.kind} • ${m.jurisdiction} • \`${m.filename}\`\n  - from: \`${m.srcRepo}/${m.srcPath}\`\n  - to:   \`${m.destPath}\``);

  await octokit.pulls.create({
    owner: CANONICAL_OWNER,
    repo: CANONICAL_REPO,
    title: `Relocate ${plannedMoves.length} .txt files & refresh catalogs`,
    head: workBranch,
    base: CANONICAL_BRANCH,
    body: `This PR relocates normalized .txt files into the canonical tree and refreshes the catalogs used by the search UI.\n\n${bodyLines.join("\n")}`
  });

  console.log(`Done. Wrote ${nWrites} files and opened PR in ${CANONICAL_OWNER}/${CANONICAL_REPO}.`);
}

main().catch(e => { console.error(e); process.exit(1); });
