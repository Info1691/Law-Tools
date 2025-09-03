/**
 * Catalog Sync — rewrites url_txt entries so they point to the actual live TXT files.
 * - Scans these repos: Law-Texts-ui, laws-ui, rules-ui (branch main)
 * - Builds a map of filename -> public URL (preferring Law-Texts-ui)
 * - Loads catalogs in Law-Texts-ui (texts/catalog.json, laws.json, rules.json)
 * - Rewrites url_txt when a better (non-404) location exists
 * - Commits the updated catalog files back to Law-Texts-ui
 *
 * No external deps: uses Node 20 fetch + GitHub REST API.
 */

const {
  GH_TOKEN,
  OWNER,
  REPOS,
  CATALOGS,
  PUBLIC_BASE_LAW_TEXTS,
  PUBLIC_BASE_LAWS,
  PUBLIC_BASE_RULES,
  BRANCH_TEXTS,
  BRANCH_LAWS,
  BRANCH_RULES,
} = process.env;

if (!GH_TOKEN) {
  console.error("GH_TOKEN is missing");
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${GH_TOKEN}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "catalog-sync",
};

const repos = JSON.parse(REPOS || '["Law-Texts-ui","laws-ui","rules-ui"]');
const catalogs = JSON.parse(
  CATALOGS || '["texts/catalog.json","laws.json","rules.json"]'
);

const repoPublicBase = {
  "Law-Texts-ui": PUBLIC_BASE_LAW_TEXTS || "https://texts.wwwbcb.org",
  "laws-ui": PUBLIC_BASE_LAWS || "https://info1691.github.io/laws-ui",
  "rules-ui": PUBLIC_BASE_RULES || "https://info1691.github.io/rules-ui",
};

const branchByRepo = {
  "Law-Texts-ui": BRANCH_TEXTS || "main",
  "laws-ui": BRANCH_LAWS || "main",
  "rules-ui": BRANCH_RULES || "main",
};

const canonicalPrefixes = {
  "Law-Texts-ui": ["data/textbooks", "data/laws", "data/rules"],
  "laws-ui": ["data/laws"],
  "rules-ui": ["data/rules"],
};

const preferOrder = ["Law-Texts-ui", "laws-ui", "rules-ui"]; // choose this order if duplicates exist

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ghGet(url) {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET ${url} -> ${res.status}: ${text}`);
  }
  return res.json();
}

async function ghPut(url, body) {
  const res = await fetch(url, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PUT ${url} -> ${res.status}: ${text}`);
  }
  return res.json();
}

function base64encode(str) {
  return Buffer.from(str, "utf8").toString("base64");
}
function base64decode(str) {
  return Buffer.from(str, "base64").toString("utf8");
}

function filenameOf(path) {
  return path.split("/").pop();
}

function normalizeName(name) {
  // exact filename match works best, but normalize case to be safe
  return (name || "").trim().toLowerCase();
}

function chooseBest(list) {
  if (!list || !list.length) return null;
  // Prefer Law-Texts-ui first, then laws-ui, then rules-ui
  list.sort(
    (a, b) => preferOrder.indexOf(a.repo) - preferOrder.indexOf(b.repo)
  );
  return list[0];
}

async function scanRepo(repo) {
  const ref = `heads/${branchByRepo[repo] || "main"}`;
  const url = `https://api.github.com/repos/${OWNER}/${repo}/git/trees/${encodeURIComponent(
    ref
  )}?recursive=1`;

  const tree = await ghGet(url);
  const items = Array.isArray(tree.tree) ? tree.tree : [];
  const prefixes = canonicalPrefixes[repo] || [];

  const hits = [];
  for (const it of items) {
    if (it.type !== "blob") continue;
    const p = it.path;
    if (!p.endsWith(".txt")) continue;
    if (!prefixes.some((pref) => p.startsWith(pref + "/"))) continue;

    const publicBase = repoPublicBase[repo];
    const publicUrl = `${publicBase}/${p}`;
    hits.push({ repo, path: p, url: publicUrl, name: filenameOf(p) });
  }
  return hits;
}

async function buildInventory() {
  const all = [];
  for (const repo of repos) {
    try {
      const r = await scanRepo(repo);
      all.push(...r);
      // tiny courtesy pause to be nice to the API
      await sleep(150);
    } catch (e) {
      console.error(`Scan failed for ${repo}:`, e.message);
    }
  }

  // Map: normalized filename -> [{repo, path, url}]
  const byName = new Map();
  for (const it of all) {
    const key = normalizeName(it.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(it);
  }
  return byName;
}

async function getFile(repo, path, ref = "main") {
  const url = `https://api.github.com/repos/${OWNER}/${repo}/contents/${encodeURIComponent(
    path
  )}?ref=${encodeURIComponent(ref)}`;
  const res = await fetch(url, { headers });
  if (res.status === 404) return null;
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`GET contents ${repo}/${path} -> ${res.status}: ${t}`);
  }
  return res.json();
}

function parseCatalog(jsonText) {
  try {
    const data = JSON.parse(jsonText);
    // Could be an array or {items:[...]}
    if (Array.isArray(data)) return { root: data, items: data, wrap: (x) => x };
    if (Array.isArray(data.items))
      return { root: data, items: data.items, wrap: (x) => ({ ...data, items: x }) };
    // Fallback: unknown shape
    return { root: data, items: [], wrap: () => data };
  } catch (e) {
    console.error("Failed to parse catalog JSON:", e.message);
    return { root: null, items: [], wrap: () => null };
  }
}

function rewriteUrlTxt(items, inventory) {
  let updates = 0;
  for (const entry of items) {
    if (!entry || !entry.url_txt) continue;
    const current = entry.url_txt;

    // Get just the filename from the current url_txt (handles relative or absolute)
    let fname = current.split("?")[0].split("#")[0];
    fname = filenameOf(fname);
    const key = normalizeName(fname);
    const candidates = inventory.get(key);
    if (!candidates || !candidates.length) continue;

    const best = chooseBest(candidates);
    if (!best) continue;

    // If different, update to absolute URL for reliability across domains
    if (current !== best.url) {
      entry.url_txt = best.url;
      updates++;
    }
  }
  return updates;
}

async function updateCatalogs(inventory) {
  const repo = "Law-Texts-ui";
  const branch = branchByRepo[repo] || "main";

  let totalUpdates = 0;

  for (const path of catalogs) {
    const cur = await getFile(repo, path, branch);
    if (!cur) {
      console.warn(`Catalog not found: ${repo}/${path}`);
      continue;
    }
    const original = base64decode(cur.content || "");
    const { root, items, wrap } = parseCatalog(original);
    if (!root) {
      console.warn(`Skipping invalid JSON in ${path}`);
      continue;
    }

    const changed = rewriteUrlTxt(items, inventory);
    totalUpdates += changed;

    if (changed > 0) {
      const updatedText = JSON.stringify(wrap(items), null, 2) + "\n";
      await ghPut(
        `https://api.github.com/repos/${OWNER}/${repo}/contents/${encodeURIComponent(
          path
        )}`,
        {
          message: `catalog-sync: update url_txt (${changed} change${
            changed === 1 ? "" : "s"
          })`,
          content: base64encode(updatedText),
          sha: cur.sha,
          branch,
        }
      );
      console.log(`Updated ${path}: ${changed} change(s)`);
    } else {
      console.log(`No changes in ${path}`);
    }
  }

  return totalUpdates;
}

(async function main() {
  try {
    console.log("Building inventory from repos:", repos.join(", "));
    const inventory = await buildInventory();
    console.log(`Inventory built for ${inventory.size} unique filenames`);

    const updates = await updateCatalogs(inventory);
    console.log(`Done. Total catalog updates: ${updates}`);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
