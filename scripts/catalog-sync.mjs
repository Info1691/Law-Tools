// catalog-sync.mjs
// Scans canonical TXT locations in Law-Texts-ui and auto-fixes url_txt
// in texts/catalog.json, laws.json, rules.json.
//
// Expected layout (served by texts.wwwbcb.org):
//   data/textbooks/{jersey|uk}/*.txt
//   data/laws/{jersey|uk}/*.txt
//   data/rules/{jersey|uk}/*.txt

import { Octokit } from '@octokit/rest';

const GH_TOKEN = process.env.GH_TOKEN || process.env.LAW_SYNC_TOKEN;
if (!GH_TOKEN) {
  console.error('Missing GH_TOKEN/LAW_SYNC_TOKEN env.');
  process.exit(1);
}
const octo = new Octokit({ auth: GH_TOKEN });

// --- config ---
const OWNER = 'Info1691';              // org/user
const TEXTS_REPO = 'Law-Texts-ui';     // catalogs live here
const REF = 'main';

const CATALOGS = [
  { path: 'texts/catalog.json', kind: 'textbook' },
  { path: 'laws.json',          kind: 'law' },
  { path: 'rules.json',         kind: 'rule' }
];

// Where we consider authoritative TXT files (by kind)
const ROOTS = {
  textbook: ['data/textbooks/jersey', 'data/textbooks/uk'],
  law:      ['data/laws/jersey',      'data/laws/uk'],
  rule:     ['data/rules/jersey',     'data/rules/uk']
};

// --- helpers ---
const norm = s => s
  .toLowerCase()
  .replace(/\.txt$/, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/-+/g, '-')
  .replace(/^-|-$/g, '');

const base = p => p.split('/').pop();

async function getHeadSha(owner, repo, ref) {
  const { data } = await octo.git.getRef({ owner, repo, ref: `heads/${ref}` });
  return data.object.sha;
}

async function listTxtUnder(owner, repo, ref, roots) {
  const commitSha = await getHeadSha(owner, repo, ref);
  const { data: tree } = await octo.git.getTree({
    owner, repo, tree_sha: commitSha, recursive: 'true'
  });

  return tree.tree
    .filter(n => n.type === 'blob' && n.path.endsWith('.txt'))
    .filter(n => roots.some(r => n.path.startsWith(r)))
    .map(n => n.path);
}

async function readJsonFile(owner, repo, path, ref) {
  const { data } = await octo.repos.getContent({ owner, repo, path, ref });
  const sha = data.sha;
  const json = Buffer.from(data.content, 'base64').toString('utf8');
  return { sha, text: json, obj: JSON.parse(json) };
}

async function writeJsonFile(owner, repo, path, ref, prevSha, obj, message) {
  const content = Buffer.from(JSON.stringify(obj, null, 2) + '\n').toString('base64');
  await octo.repos.createOrUpdateFileContents({
    owner, repo, path, message, content, sha: prevSha, branch: ref
  });
}

function buildIndex(paths) {
  const m = new Map();
  for (const p of paths) {
    const k = norm(base(p));
    m.set(k, p); // last wins; OK
  }
  return m;
}

function keyFromItem(item) {
  // Prefer current url_txt filename; fall back to title slug
  if (item.url_txt) return norm(base(item.url_txt));
  if (item.title)   return norm(item.title);
  return '';
}

function relPath(p) {
  // We want catalogs to keep relative paths against texts.wwwbcb.org root
  return `./${p}`;
}

(async () => {
  let totalChanged = 0;
  for (const cat of CATALOGS) {
    console.log(`\n==> Syncing ${cat.path} (${cat.kind})`);

    // index real TXT files under canonical roots
    const roots = ROOTS[cat.kind];
    const files = await listTxtUnder(OWNER, TEXTS_REPO, REF, roots);
    const index = buildIndex(files);

    // read the catalog
    const { sha, text, obj } = await readJsonFile(OWNER, TEXTS_REPO, cat.path, REF);

    let changed = 0;
    for (const item of obj) {
      const k = keyFromItem(item);
      if (!k) continue;

      const foundPath = index.get(k);
      if (!foundPath) continue; // nothing to change

      const newUrl = relPath(foundPath);
      if (item.url_txt !== newUrl) {
        item.url_txt = newUrl;
        changed++;
      }
    }

    if (changed > 0) {
      await writeJsonFile(
        OWNER, TEXTS_REPO, cat.path, REF, sha, obj,
        `catalog-sync: ${changed} url_txt updated in ${cat.path}`
      );
      console.log(`Updated ${changed} entries in ${cat.path}`);
      totalChanged += changed;
    } else {
      console.log('No changes needed.');
    }
  }

  console.log(`\nDone. Total entries updated: ${totalChanged}`);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
