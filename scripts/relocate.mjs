// Relocate TXT files across repos using GitHub Contents API.
// Supports create or update (handles required SHA automatically).

import { Octokit } from "@octokit/rest";
import fs from "node:fs/promises";

const token =
  process.env.GH_TOKEN ||
  process.env.GITHUB_TOKEN ||
  process.env.GH_PAT;

if (!token) {
  throw new Error("Missing GH_TOKEN / GITHUB_TOKEN / GH_PAT in env.");
}

const octokit = new Octokit({ auth: token });

/**
 * Plan format (array). Example item:
 * {
 *   "from": { "owner":"Info1691", "repo":"rules-ui", "path":"data/rules/uk/icaew-code.txt", "ref":"main" },
 *   "to":   { "owner":"Info1691", "repo":"Law-Texts-ui", "path":"data/rules/uk/icaew-code.txt", "ref":"main" },
 *   "message": "Relocate: ICAEW code",
 *   "deleteSource": false
 * }
 */
async function loadPlan() {
  const fromInput = process.env.PLAN && process.env.PLAN.trim();
  if (fromInput) {
    try { return JSON.parse(fromInput); }
    catch (e) { throw new Error("PLAN input is not valid JSON."); }
  }
  const planPath = (process.env.PLAN_PATH || "").trim();
  if (planPath) {
    const raw = await fs.readFile(planPath, "utf8");
    return JSON.parse(raw);
  }
  // Fallback demo — edit or provide PLAN/PLAN_PATH
  return [
    // Example (comment out or replace)
    // {
    //   from:{owner:"Info1691",repo:"rules-ui",path:"data/rules/uk/icaew-code.txt",ref:"main"},
    //   to:{owner:"Info1691",repo:"Law-Texts-ui",path:"data/rules/uk/icaew-code.txt",ref:"main"},
    //   message:"Relocate: icaew-code.txt",
    //   deleteSource:false
    // }
  ];
}

async function getFile(o, r, p, ref = "main") {
  try {
    const res = await octokit.repos.getContent({ owner: o, repo: r, path: p, ref });
    if (Array.isArray(res.data)) throw new Error(`Path ${p} is a directory, expected file.`);
    return {
      sha: res.data.sha,
      encoding: res.data.encoding,
      content: res.data.content // base64
    };
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

function normalizeBase64(b64) {
  // decode → normalize line endings → re-encode
  const text = Buffer.from(b64, "base64").toString("utf8").replace(/\r\n?/g, "\n");
  return Buffer.from(text, "utf8").toString("base64");
}

async function putFile({ owner, repo, path, branch, message, contentB64, sha }) {
  return octokit.repos.createOrUpdateFileContents({
    owner, repo, path,
    message,
    content: contentB64,
    branch: branch || "main",
    sha // include only if updating
  });
}

async function deleteFile({ owner, repo, path, branch, message, sha }) {
  return octokit.repos.deleteFile({
    owner, repo, path,
    message: message || `Delete ${path}`,
    branch: branch || "main",
    sha
  });
}

function prettyMove(mv) {
  const s = mv.from, d = mv.to;
  return `${s.owner}/${s.repo}@${s.ref || "main"}:${s.path} → ${d.owner}/${d.repo}@${d.ref || "main"}:${d.path}`;
}

(async () => {
  const plan = await loadPlan();
  if (!Array.isArray(plan) || plan.length === 0) {
    console.log("No moves in plan. Provide PLAN JSON or PLAN_PATH.");
    return;
  }

  const results = [];
  for (const mv of plan) {
    console.log(`\n=== ${prettyMove(mv)} ===`);
    const src = mv.from, dst = mv.to;
    const message = mv.message || `Relocate ${src.path} → ${dst.path}`;

    // 1) Read source
    const srcFile = await getFile(src.owner, src.repo, src.path, src.ref || "main");
    if (!srcFile) {
      results.push({ move: mv, ok: false, reason: "source-not-found" });
      console.error("Source file not found.");
      continue;
    }
    const contentB64 = normalizeBase64(srcFile.content);

    // 2) Check if destination exists (to get SHA for update)
    const dstFile = await getFile(dst.owner, dst.repo, dst.path, dst.ref || "main");
    const dstSha = dstFile ? dstFile.sha : undefined;

    // 3) Write destination
    try {
      await putFile({
        owner: dst.owner, repo: dst.repo, path: dst.path,
        branch: dst.ref || "main",
        message, contentB64, sha: dstSha
      });
      console.log("Wrote destination:", `${dst.repo}/${dst.path}`, dstSha ? "(updated)" : "(created)");
    } catch (e) {
      console.error("Write failed:", e.status, e.message);
      results.push({ move: mv, ok: false, reason: "dest-write-failed", detail: e.message });
      continue;
    }

    // 4) Optionally delete source
    if (mv.deleteSource) {
      try {
        await deleteFile({
          owner: src.owner, repo: src.repo, path: src.path,
          branch: src.ref || "main",
          message: `Relocate: remove ${src.path}`,
          sha: srcFile.sha
        });
        console.log("Deleted source:", `${src.repo}/${src.path}`);
      } catch (e) {
        console.warn("Delete source failed:", e.status, e.message);
        results.push({ move: mv, ok: true, warn: "delete-failed", detail: e.message });
        continue;
      }
    }

    results.push({ move: mv, ok: true });
  }

  // Summary
  const ok = results.filter(r => r.ok).length;
  const fail = results.length - ok;
  console.log(`\nDone. OK: ${ok}, Failed: ${fail}`);
  if (fail) {
    process.exitCode = 1;
  }
})();
