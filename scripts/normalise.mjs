import fs from 'node:fs';
import path from 'node:path';

const input = process.argv[2];
if (!input) { console.error('ERROR: provide a TXT path'); process.exit(1); }
if (!fs.existsSync(input)) { console.error(`ERROR: not found: ${input}`); process.exit(1); }

let buf = fs.readFileSync(input);
let text = buf.toString('utf8');

// strip BOM
text = text.replace(/^\uFEFF/, '');

// common replacements
const repl = [
  [/[\u2018\u2019\u201B]/g, "'"], [/[\u201C\u201D\u201E]/g, '"'],
  [/\u2013/g, '-'], [/\u2014/g, ' — '], [/\u2026/g, '...'],
  [/\u00A0/g, ' '], [/\u200B/g, ''],
  [/\uFB00/g, 'ff'], [/\uFB01/g, 'fi'], [/\uFB02/g, 'fl'],
  [/\uFB03/g, 'ffi'], [/\uFB04/g, 'ffl'],
  [/\uFFFD/g, ''] // remove replacement chars
];
for (const [re, to] of repl) text = text.replace(re, to);

// remove control chars (keep \t \n \r)
text = text.replace(/[^\S\r\n\t]?[\u0000-\u0008\u000B-\u001F\u007F]+/g, '');

// de-hyphenate line breaks: word-\nword -> wordword
text = text.replace(/([A-Za-z])-\r?\n([A-Za-z])/g, '$1$2');

// normalize spacing & newlines
text = text.replace(/\r\n/g, '\n')
           .replace(/[ \t]+\n/g, '\n')
           .replace(/\n{3,}/g, '\n\n')
           .replace(/[ \t]{2,}/g, ' ')
           .trim() + '\n';

fs.writeFileSync(input, text, { encoding: 'utf8' });

console.log(`Normalized: ${path.relative(process.cwd(), input)}`);
