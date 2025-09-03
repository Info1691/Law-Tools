// Rewrite every url_txt in the three catalogs to absolute URLs on texts.wwwbcb.org.
// - Reads:  Law-Texts-ui/texts/catalog.json, laws.json, rules.json
// - Writes: same paths, committing changes via GitHub API.
//
// Required env:
//   GH_TOKEN     -> PAT with repo scope (stored as GH_PAT secret in workflow)
//   TEXTS_OWNER  -> "Info1691"
//   TEXTS_REPO   -> "Law-Texts-ui"
//   TEXTS_BRANCH -> "main"
//   TEXTS_BASE   -> "https://texts.wwwbcb.org"

import { Octokit } from "@octokit/rest";

const {
  GH_TOKEN,
  TEXTS_OWNER = "Info1691",
  TEXTS_REPO = "Law-Texts-ui",
  TEXTS_BRANCH = "main",
  TEXTS_BASE = "https://texts.wwwbcb.org",
} = process.env;

if (!GH_TOKEN) {
  console.error("GH_TOKEN is missing");
  process.exit(1);
}

const octokit = new Octokit({ auth: GH_TOKEN });

const CATALOG_PATHS = [
  "texts/catalog.json",
  "texts/laws.json",
  "texts/rules.json",
];

function absolutizeUrlTxt(u) {
  if (!u || typeof u !== "string") return u;

  // Already absolute? leave it
  if (/^https?:\/\//i.test(u)) return u;

  // Common cases: "./data/...", "data/...", "/data/..."
  let path = u.replace(/^\.\//, "");    // drop leading "./"
  if (!path.startsWith("data/") && !path.startsWith("/data/")) {
    // If someone put it elsewhere, just return as-is to avoid breaking unknowns
    return u;
  }
  if (!path.startsWith("/")) path = `/${path}`; // ensure leading slash

  return `${TEXTS_BASE}${path}`;
}

function transformCatalog(jsonText, path) {
  let arr;
  try {
    arr = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`Invalid JSON in ${path}: ${e.message}`);
  }

  // Catalogs are arrays with at least url_txt fields
  let changed = false;
  const out = arr.map((item) => {
    if (item && typeof item === "object" && "url_txt" in item) {
      const before = item.url_txt;
      const after = absolutizeUrlTxt(before);
      if (before !== after) {
        changed = true;
        return { ...item, url_txt: after };
      }
    }
    return item;
  });

  return { changed, text: JSON.stringify(out, null, 2) + "\n" };
}

async function getFileSha(path) {
  const { data } = await octokit.repos.getContent({
    owner: TEXTS_OWNER,
    repo: TEXTS_REPO,
    path,
    ref: TEXTS_BRANCH,
  });
  // If this is a file, 'data' is the file object with 'sha'
  if (Array.isArray(data)) throw new Error(`${path} is a directory`);
  return data.sha;
}

async function readFile(path) {
  const { data } = await octokit.repos.getContent({
    owner: TEXTS_OWNER,
    repo: TEXTS_REPO,
    path,
    ref: TEXTS_BRANCH,
  });
  if (Array.isArray(data)) throw new Error(`${path} is a directory`);
  const buff = Buffer.from(data.content, data.encoding || "base64");
  return { sha: data.sha, text: buff.toString("utf8") };
}

async function writeFile(path, content, sha) {
  await octokit.repos.createOrUpdateFileContents({
    owner: TEXTS_OWNER,
    repo: TEXTS_REPO,
    path,
    message: `sync(catalogs): absolutize url_txt in ${path}`,
    content: Buffer.from(content, "utf8").toString("base64"),
    sha,
    branch: TEXTS_BRANCH,
  });
}

async function run() {
  for (const path of CATALOG_PATHS) {
    console.log(`Processing ${path} ...`);
    const { sha, text } = await readFile(path);
    const { changed, text: next } = transformCatalog(text, path);
    if (changed) {
      await writeFile(path, next, sha);
      console.log(`✔ Updated ${path}`);
    } else {
      console.log(`= No changes in ${path}`);
    }
  }
  console.log("All done.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
