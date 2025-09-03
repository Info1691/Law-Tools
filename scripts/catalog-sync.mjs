/**
 * Catalog Sync — rewrites url_txt entries so they point to live TXT files.
 * Scans: Law-Texts-ui, laws-ui, rules-ui (branch main)
 * Updates catalogs in Law-Texts-ui: texts/catalog.json, laws.json, rules.json
 * Prefers Law-Texts-ui, then laws-ui, then rules-ui.
 * Handles URL-encoded names (spaces, parentheses) when matching.
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

const preferOrder = ["Law-Texts-ui", "laws-ui", "rules-ui"];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function ghGet(url){ const r=await fetch(url,{headers}); if(!r.ok){throw new Error(`GET ${url} -> ${r.status} ${await r.text()}`);} return r.json(); }
async function ghPut(url,body){ const r=await fetch(url,{method:"PUT",headers:{...headers,"Content-Type":"application/json"},body:JSON.stringify(body)}); if(!r.ok){throw new Error(`PUT ${url} -> ${r.status} ${await r.text()}`);} return r.json(); }
const b64e = s => Buffer.from(s,"utf8").toString("base64");
const b64d = s => Buffer.from(s,"base64").toString("utf8");

function lastSeg(p){ return (p||"").split("?")[0].split("#")[0].split("/").pop(); }
function safeDecode(s){
  try { return decodeURIComponent(s); } catch { return s; }
}
function normalizeName(name){
  // decode %XX, collapse whitespace, lowercase
  const dec = safeDecode(name || "");
  return dec.replace(/\s+/g," ").trim().toLowerCase();
}
function chooseBest(list){
  if(!list?.length) return null;
  return list.sort((a,b)=>preferOrder.indexOf(a.repo)-preferOrder.indexOf(b.repo))[0];
}

async function scanRepo(repo){
  const ref = `heads/${branchByRepo[repo] || "main"}`;
  const url = `https://api.github.com/repos/${OWNER}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
  const tree = await ghGet(url);
  const items = Array.isArray(tree.tree) ? tree.tree : [];
  const prefixes = canonicalPrefixes[repo] || [];
  const out = [];
  for(const it of items){
    if(it.type!=="blob") continue;
    const p = it.path;
    if(!p.endsWith(".txt")) continue;
    if(!prefixes.some(pref => p.startsWith(pref + "/"))) continue;
    out.push({ repo, path: p, url: `${repoPublicBase[repo]}/${p}`, name: lastSeg(p) });
  }
  return out;
}

async function buildInventory(){
  const all = [];
  for(const repo of repos){
    try{
      const got = await scanRepo(repo);
      all.push(...got);
      await sleep(120);
    }catch(e){ console.error(`Scan failed for ${repo}:`, e.message); }
  }
  // Map normalized filename -> variants
  const map = new Map();
  for(const it of all){
    const key = normalizeName(it.name);
    if(!map.has(key)) map.set(key, []);
    map.get(key).push(it);
  }
  return map;
}

async function getFile(repo, path, ref="main"){
  const url = `https://api.github.com/repos/${OWNER}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`;
  const res = await fetch(url,{headers});
  if(res.status===404) return null;
  if(!res.ok){ throw new Error(`GET contents ${repo}/${path} -> ${res.status} ${await res.text()}`); }
  return res.json();
}

function parseCatalog(txt){
  try{
    const data = JSON.parse(txt);
    if(Array.isArray(data)) return { root:data, items:data, wrap:(x)=>x };
    if(Array.isArray(data.items)) return { root:data, items:data.items, wrap:(x)=>({ ...data, items:x }) };
  }catch(e){ /* fall-through */ }
  return { root:null, items:[], wrap:()=>null };
}

function rewriteUrlTxt(items, inventory){
  let changed = 0;
  for(const entry of items){
    if(!entry?.url_txt) continue;

    const cur = entry.url_txt;
    const seg = lastSeg(cur);
    const key = normalizeName(seg);
    const variants = inventory.get(key);

    if(!variants || variants.length===0){
      // Extra robustness: try dropping extension to match rare mis-entries
      const keyNoExt = normalizeName(seg.replace(/\.txt$/i,""));
      const fallback = [...inventory.keys()].find(k => k === keyNoExt || k.replace(/\.txt$/,"") === keyNoExt);
      if(fallback) {
        const cand = chooseBest(inventory.get(fallback));
        if(cand && cand.url !== cur){ entry.url_txt = cand.url; changed++; }
      }
      continue;
    }

    const best = chooseBest(variants);
    if(best && best.url !== cur){
      entry.url_txt = best.url;
      changed++;
    }
  }
  return changed;
}

async function updateCatalogs(inventory){
  const repo = "Law-Texts-ui";
  const branch = branchByRepo[repo] || "main";
  let total = 0;

  for(const path of catalogs){
    const meta = await getFile(repo, path, branch);
    if(!meta){ console.warn(`Catalog not found: ${repo}/${path}`); continue; }

    const original = b64d(meta.content || "");
    const { root, items, wrap } = parseCatalog(original);
    if(!root){ console.warn(`Invalid JSON in ${path}`); continue; }

    const n = rewriteUrlTxt(items, inventory);
    total += n;

    if(n > 0){
      const updated = JSON.stringify(wrap(items), null, 2) + "\n";
      await ghPut(
        `https://api.github.com/repos/${OWNER}/${repo}/contents/${encodeURIComponent(path)}`,
        {
          message: `catalog-sync: update url_txt (${n} change${n===1?"":"s"})`,
          content: b64e(updated),
          sha: meta.sha,
          branch,
        }
      );
      console.log(`Updated ${path}: ${n} change(s)`);
    }else{
      console.log(`No changes in ${path}`);
    }
  }
  return total;
}

(async function main(){
  try{
    console.log("Building inventory…");
    const inventory = await buildInventory();
    console.log(`Inventory contains ${inventory.size} unique filenames`);
    const n = await updateCatalogs(inventory);
    console.log(`Done. Total updates: ${n}`);
  }catch(e){
    console.error(e);
    process.exit(1);
  }
})();
