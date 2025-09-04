// Usage: node scripts/normalize.mjs path/to/file.txt
// Safe, idempotent, and UTF-8 only. Repairs common PDF/Word artifacts,
// removes U+FFFD, fixes ligatures/smart quotes, de-hyphenates linebreaks,
// collapses whitespace, and ensures LF line endings.

import fs from 'node:fs';
import path from 'node:path';

const input = process.argv[2];
if (!input) {
  console.error('ERROR: Provide a TXT path. Example: node scripts/normalize.mjs target/data/…/file.txt');
  process.exit(1);
}
if (!fs.existsSync(input)) {
  console.error(`ERROR: File not found: ${input}`);
  process.exit(1);
}

let buf = fs.readFileSync(input);
let text = buf.toString('utf8');

// Strip BOM
text = text.replace(/^\uFEFF/, '');

// Replace Windows/Word punctuation & ligatures (common cases)
const repl = [
  [/[\u2018\u2019\u201B]/g, "'"],        // ‘ ’ ‛  -> '
  [/[\u201C\u201D\u201E]/g, '"'],       // “ ” „  -> "
  [/\u2013/g, '-'],                     // – -> -
  [/\u2014/g, ' — '],                   // — -> spaced em dash
  [/\u2026/g, '...'],                   // … -> ...
  [/\u00A0/g, ' '],                     // NBSP -> space
  [/\u200B/g, ''],                      // zero-width space
  [/\uFB00/g, 'ff'],                    // ﬀ
  [/\uFB01/g, 'fi'],                    // ﬁ
  [/\uFB02/g, 'fl'],                    // ﬂ
  [/\uFB03/g, 'ffi'],                   // ﬃ
  [/\uFB04/g, 'ffl'],                   // ﬄ
];

// Remove all U+FFFD (replacement char)
repl.push([/\uFFFD/g, '']);

// Apply replacements
for (const [re, to] of repl) text = text.replace(re, to);

// Remove control chars except \t \n \r
text = text.replace(/[^\S\r\n\t]?[\u0000-\u0008\u000B-\u001F\u007F]+/g, '');

// Join hyphenated linebreaks: foo-\nbar -> foobar
text = text.replace(/([A-Za-z])-\r?\n([A-Za-z])/g, '$1$2');

// Normalize line endings to LF
text = text.replace(/\r\n/g, '\n');

// Collapse weird spacing
text = text
  .replace(/[ \t]+\n/g, '\n')        // trim line-end spaces
  .replace(/\n{3,}/g, '\n\n')        // max one blank line
  .replace(/[ \t]{2,}/g, ' ');       // multi spaces -> single

// Trim file ends
text = text.trim() + '\n';

// Simple sanity stats
const bytesBefore = buf.length;
const bytesAfter  = Buffer.byteLength(text, 'utf8');
const ffCount     = (text.match(/\uFFFD/g) || []).length;

fs.writeFileSync(input, text, { encoding: 'utf8' });

console.log(`Normalized: ${path.relative(process.cwd(), input)}`);
console.log(`  bytes: ${bytesBefore} -> ${bytesAfter}`);
console.log(`  U+FFFD removed: ${ffCount}`);
