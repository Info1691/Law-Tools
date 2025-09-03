// scripts/relocate.mjs
import { Octokit } from "@octokit/rest";

const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error("No GH_TOKEN provided");
  process.exit(1);
}
const octo = new Octokit({ auth: TOKEN });

const DEFAULT_REPOS = (process.env.INPUT_REPOS || "").trim()
  || "Info1691/Law-Texts-ui,Info1691/laws-ui,Info1691/rules-ui,Info1691/lex-ingest-local";

const INPUT_PLAN = (process.env.INPUT_PLAN || "").trim();

// ---- helpers ---------------------------------------------------------------

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const ownerRepo = (full) => {
  const [owner, repo] = full.split("/");
  return { owner, repo };
};

const getHeadSha = async ({ owner, repo, ref = "main" }) => {
  const { data } = await octo.rest.git.getRef({ owner, repo, ref: `heads/${ref}` });
  return data.object.sha;
};

const listTxtFiles = async ({ owner, repo, ref = "main" }) => {
  // enumerate all files via git tree (fast) and filter .txt
  const sha = await getHeadSha({ owner, repo, ref });
  const { data } = await octo.rest.git.getTree({ owner, repo, tree_sha: sha, recursive: "1" });
  return (data.tree || [])
    .filter(n => n.type === "blob" && n.path.toLowerCase().endsWith(".txt"))
    .map(n => ({ path: n.path }));
};

const readFile = async ({ owner, repo, path, ref = "main" }) => {
  try {
    const { data } = await octo.rest.repos.getContent({ owner, repo, path, ref });
    if (Array.isArray(data)) return null;
    return Buffer.from(data.content, "base64").toString("utf8");
  } catch (e) {
    if (e.status !== 404) console.error("readFile error", path, e.message);
    return null;
  }
};

const writeFile = async ({ owner, repo, path, message, content, branch = "main" }) => {
  // fetch existing to get sha if needed (upsert)
  let sha = undefined;
  try {
    const { data } = await octo.rest.repos.getContent({ owner, repo, path, ref: branch });
    if (!Array.isArray(data) && data.sha) sha = data.sha;
  } catch (e) {
    // 404 is fine
  }
  await octo.rest.repos.createOrUpdateFileContents({
    owner, repo, path, message,
    content: Buffer.from(content, "utf8").toString("base64"),
    branch, sha
  });
};

const prettyTitle = (basename) => {
  // turn "breach-of-trust-text-by-birks-and-pretto.txt" into "Breach of Trust — Birks & Pretto"
  const stem = basename.replace(/\.txt$/i, "");
  return stem
    .replace(/-/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/\b(\w)/g, (m) => m.toUpperCase());
};

const ensureCatalogEntry = async ({ kind, jurisdiction, relPath, title }) => {
  const owner = "Info1691";
  const repo = "Law-Texts-ui";
  const branch = "main";
  let catPath;
  if (kind === "textbook") catPath = "texts/catalog.json";
  else if (kind === "law") catPath = "laws.json";
  else if (kind === "rule") catPath = "rules.json";
  else return;

  let raw = await readFile({ owner, repo, path: catPath, ref: branch });
  let arr = [];
  if (raw) {
    try { arr = JSON.parse(raw); } catch { arr = []; }
  }
  // normalize url_txt form (relative from root)
  const url_txt = `./${relPath}`;
  const already = arr.find(e => (e.url_txt || "").toLowerCase() === url_txt.toLowerCase());
  if (!already) {
    arr.push({
      title: title || prettyTitle(relPath.split("/").pop()),
      jurisdiction,
      kind: (kind === "textbook" ? "textbook" : (kind === "law" ? "law" : "rule")),
      url_txt
    });
    await writeFile({
      owner, repo, path: catPath,
      message: `catalog: add ${title || relPath}`,
      content: JSON.stringify(arr, null, 2),
      branch
    });
  }
};

const canonicalFor = ({ repo, path }) => {
  const p = path.replace(/\\/g, "/");
  const lower = p.toLowerCase();

  let kind = "textbook";
  if (repo.toLowerCase().includes("laws-ui") || /\/laws\//.test(lower)) kind = "law";
  if (repo.toLowerCase().includes("rules-ui") || /\/rules\//.test(lower)) kind = "rule";

  // jurisdiction guess from path
  let jurisdiction = "uk";
  if (/(^|\/)(jersey)(\/|$)/.test(lower)) jurisdiction = "jersey";

  const base = p.split("/").pop(); // keep original filename (already normalized in your repos)
  let relPath;
  if (kind === "textbook") relPath = `data/textbooks/${jurisdiction}/${base}`;
  else if (kind === "law")   relPath = `data/laws/${jurisdiction}/${base}`;
  else                       relPath = `data/rules/${jurisdiction}/${base}`;

  return { kind, jurisdiction, destRepo: "Law-Texts-ui", destOwner: "Info1691", destPath: relPath };
};

// ---- main: plan + execute --------------------------------------------------

const autoPlan = async () => {
  const entries = [];
  const targets = DEFAULT_REPOS.split(",").map(s => s.trim()).filter(Boolean);
  for (const full of targets) {
    const { owner, repo } = ownerRepo(full);
    const files = await listTxtFiles({ owner, repo, ref: "main" });

    for (const f of files) {
      // skip already canonical in Law-Texts-ui
      if (repo === "Law-Texts-ui" && /^data\/(textbooks|laws|rules)\/(jersey|uk)\/.+\.txt$/i.test(f.path)) {
        continue;
      }
      const { kind, jurisdiction, destOwner, destRepo, destPath } = canonicalFor({ repo, path: f.path });
      entries.push({
        fromOwner: owner, fromRepo: repo, fromBranch: "main", fromPath: f.path,
        toOwner: destOwner, toRepo: destRepo, toBranch: "main", toPath: destPath,
        kind, jurisdiction
      });
    }
  }
  return entries;
};

const fetchContentBase64 = async ({ owner, repo, path, ref = "main" }) => {
  const { data } = await octo.rest.repos.getContent({ owner, repo, path, ref });
  if (Array.isArray(data)) throw new Error("Expected file, got directory");
  return data.content; // base64
};

const putFileBase64 = async ({ owner, repo, path, branch = "main", message, b64 }) => {
  let sha = undefined;
  try {
    const { data } = await octo.rest.repos.getContent({ owner, repo, path, ref: branch });
    if (!Array.isArray(data)) sha = data.sha;
  } catch (e) {}
  await octo.rest.repos.createOrUpdateFileContents({
    owner, repo, path, message, branch, content: b64, sha
  });
};

const run = async () => {
  let plan = [];
  if (INPUT_PLAN) {
    try { plan = JSON.parse(INPUT_PLAN); }
    catch (e) {
      console.error("Invalid plan JSON:", e.message);
      process.exit(1);
    }
  } else {
    console.log("No plan provided; running auto-discovery…");
    plan = await autoPlan();
  }

  if (!plan.length) {
    console.log("Nothing to move. Done.");
    return;
  }

  // Execute moves (create/update in Law-Texts-ui; leave source in place)
  for (const item of plan) {
    const label = `${item.fromRepo}:${item.fromPath}  ->  ${item.toRepo}:${item.toPath}`;
    try {
      const b64 = await fetchContentBase64({
        owner: item.fromOwner, repo: item.fromRepo, path: item.fromPath, ref: item.fromBranch
      });

      await putFileBase64({
        owner: item.toOwner, repo: item.toRepo, path: item.toPath, branch: item.toBranch,
        message: `relocate: ${item.fromRepo}/${item.fromPath} -> ${item.toPath}`,
        b64
      });

      // catalog
      await ensureCatalogEntry({
        kind: item.kind,
        jurisdiction: item.jurisdiction,
        relPath: item.toPath,
        title: prettyTitle(item.toPath.split("/").pop())
      });

      console.log("OK:", label);
      await sleep(200); // be polite to API
    } catch (e) {
      console.error("FAIL:", label, e.status || "", e.message);
    }
  }
};

run().catch(err => {
  console.error(err);
  process.exit(1);
});
