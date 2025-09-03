// scripts/normalize.mjs
import fs from "node:fs";
import path from "node:path";
import iconv from "iconv-lite";
import he from "he";

if (process.argv.length < 4) {
  console.error("Usage: node scripts/normalize.mjs <in> <out>");
  process.exit(1);
}

const [ , , inPath, outPath ] = process.argv;

// 1) Read as raw bytes then try UTF-8; if lots of U+FFFD, fall back to win1252.
const raw = fs.readFileSync(inPath);
let text = raw.toString("utf8");
const bad = (text.match(/\uFFFD/g) || []).length;
if (bad > 10) {
  text = iconv.decode(raw, "win1252");
}

// 2) Strip NULLs and other control junk (keep \n\t).
text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

// 3) HTML entities (sometimes slip in via OCR pipelines).
text = he.decode(text);

// 4) Normalize whitespace & dashes/hyphens.
text = text
  .replace(/\u00A0/g, " ")           // NBSP -> space
  .replace(/\u00AD/g, "")            // soft hyphen
  .replace(/ *\u2010|\u2011|\u2012|\u2013|\u2014/g, "-") // dashes -> -
  .replace(/[ \t]+\n/g, "\n")        // trim EOL space
  .replace(/\n{3,}/g, "\n\n");       // squeeze blank lines

// 5) Smart punctuation -> ASCII equivalents.
text = text
  .replace(/[“”]/g, '"')
  .replace(/[‘’]/g, "'")
  .replace(/\u2026/g, "...");

// 6) Remove common header/footer noise (basic heuristic; safe to keep if not present)
text = text.replace(/\n?Page\s+\d+\s+of\s+\d+\s*\n/g, "\n");

// 7) Ensure UTF-8 out
fs.writeFileSync(outPath, text, { encoding: "utf8" });
console.log(`Normalized -> ${path.resolve(outPath)}`);
