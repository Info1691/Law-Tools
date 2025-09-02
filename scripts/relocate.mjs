// scripts/relocate.mjs
// Move TXT files across repos -> canonical folders in Law-Texts-ui
// Fixes 422 by supplying 'sha' on updates + deletes.

import { Octokit } from "@octokit/rest";
import fs from "node:fs/promises";
import path from "node:path";

const TOKEN = process.env.GITHUB_TOKEN || process.env.RELOCATE_TOKEN;
if (!TOKEN) {
  console.error("Missing GITHUB_TOKEN / RELOCATE_TOKEN env var.");
  process.exit(1);
}

const TARGET_OWNER = process.env.TARGET_OWNER || "Info1691";
const TARGET_REPO  = process.env.TARGET_REPO  || "Law-Texts-ui";
const TARGET_BRANCH = process.env.TARGET_BRANCH || "main";

// PLAN comes either from env PLAN (JSON string) or scripts/plan.json
async function loadPlan() {
  const fromEnv = process.env.PLAN && process.env.PLAN.trim();
  if (fromEnv) {
    try { return JSON.parse(fromEnv); } 
    catch (e) {
      console.error("PLAN env is not valid JSON.");
      throw e;
    }
  }
  const planPath = path.join(process.cwd(), "scripts", "plan.json");
  try {
    const txt = await fs.readFile(planPath, "utf8");
    return JSON.parse(txt);
  } catch {
    console.log("No PLAN provided and no scripts/plan.json found. Nothing to do.");
    return [];
  }
}

/**
 * Move spec:
 * {
 *   "src_owner": "Info1691",
 *   "src_repo":  "rules-ui",
 *   "src_path":  "data/rules/uk/icaew-code.txt",
 *   "dst_path":  "data/rules/uk/icaew-code.txt",   // path inside Law-Texts-ui
 *   "message":   "Relocate ICAEW code to canonical rules folder"
 * }
 */
const octokit = new Octokit({ auth: TOKEN });

async function getFile(oct, owner, repo, ref, filePath) {
  try {
    const res = await oct.repos.getContent({ owner, repo, path: filePath, ref });
    if (Array.isArray(res.data)) throw new Error("Expected a file, got directory");
    return {
      exists: true,
      sha: res.data.sha,
      encoding: res.data.encoding,
      content: res.data.content, // base64
    };
  } catch (err) {
    if (err.status === 404) return { exists: false };
    throw err;
  }
}

async function putFile(oct, owner, repo, branch, filePath, contentBase64, message) {
  // If destination exists, include sha on update to avoid 422
  const current = await getFile(oct, owner, repo, branch, filePath);
  const params = {
    owner, repo, path: filePath,
    message,
    content: contentBase64,
    branch,
    committer: { name: "Relocator", email: "actions@github.com" },
    author:    { name: "Relocator", email: "actions@github.com" },
  };
  if (current.exists) params.sha = current.sha;
  return oct.repos.createOrUpdateFileContents(params);
}

async function deleteFile(oct, owner, repo, branch, filePath, sha, message) {
  return oct.repos.deleteFile({
    owner, repo, path: filePath, sha,
    branch, message,
    committer: { name: "Relocator", email: "actions@github.com" },
    author:    { name: "Relocator", email: "actions@github.com" },
  });
}

function asBase64(buf) {
  return Buffer.isBuffer(buf) ? buf.toString("base64") : Buffer.from(buf, "utf8").toString("base64");
}

async function run() {
  const plan = await loadPlan();
  if (!plan.length) {
    console.log("No relocations to perform.");
    return;
  }

  console.log(`Relocating ${plan.length} file(s) -> ${TARGET_OWNER}/${TARGET_REPO}@${TARGET_BRANCH}`);

  for (const item of plan) {
    const srcOwner = item.src_owner;
    const srcRepo  = item.src_repo;
    const srcPath  = item.src_path;
    const dstPath  = item.dst_path;
    const msg      = item.message || `Relocate ${srcRepo}/${srcPath} -> ${TARGET_REPO}/${dstPath}`;

    console.log(`\n→ ${msg}`);

    // 1) Read source file (base64)
    const src = await getFile(octokit, srcOwner, srcRepo, "main", srcPath);
    if (!src.exists) {
      console.warn(`  ✖ Source not found: ${srcOwner}/${srcRepo}/${srcPath}`);
      continue;
    }

    // 2) Write to destination (create or update) WITH sha when needed
    await putFile(octokit, TARGET_OWNER, TARGET_REPO, TARGET_BRANCH, dstPath, src.content, msg);
    console.log(`  ✓ Wrote ${TARGET_REPO}/${dstPath}`);

    // 3) Delete the source (requires its sha)
    await deleteFile(octokit, srcOwner, srcRepo, "main", srcPath, src.sha, `Remove moved file: ${srcPath}`);
    console.log(`  ✓ Deleted source ${srcOwner}/${srcRepo}/${srcPath}`);
  }

  console.log("\nAll moves completed.");
}

run().catch(err => {
  console.error("\nRelocator failed:");
  console.error(err);
  process.exit(1);
});
