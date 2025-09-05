// scripts/citation-utils.mjs
// Minimal, fast citation utilities for Agent 3/4 (no deps).

const V = /\s+v\.?\s+/i;
const WORD = "[A-Z][A-Za-z'.&-]+";
const PARTY = `(?:${WORD})(?:\\s+(?:${WORD}|&))*(?:\\s+\$begin:math:text$.*?\\$end:math:text$)?`;

// Case name patterns: R v X, X v Y, Re X, Ex parte X
const CASE_PATTERNS = [
  new RegExp(`\\bRe\\s+${PARTY}`, "g"),                        // Re Beddoe
  new RegExp(`\\bEx\\s+parte\\s+${PARTY}`, "g"),               // Ex parte Belchier
  new RegExp(`\\bR\\s?v\\.?\\s+${PARTY}`, "g"),                // R v Smith
  new RegExp(`\\b${PARTY}\\s+v\\.?\\s+${PARTY}`, "g"),         // Saunders v Vautier
];

// Neutral / report citations (common UK/NZ/AUS/CI)
const CITE_PATTERNS = [
  /\[\d{4}\]\s?(?:JRC|JCA|UKSC|UKHL|UKPC|EWCA|EWHC|PC|HCA|NZCA|NZHC)\s?\d+\b/g,
  /\(\d{4}\)\s?\d+\s?(?:AC|Ch|QB|KB|WLR|All\s?ER|BCLC|ER|SCR|CLR|NZLR|NSWLR|JLR)\s?\d+\b/g,
  /\b\d{4}\s?\(\d\)\s?JLR\s?\d+\b/g,           // 2015 (2) JLR 112
];

export function normalizeCaseName(s) {
  return s
    .replace(/\s+/g, " ")
    .replace(/\bv\.?\b/gi, " v ")
    .replace(/\bex\s+parte\b/gi, "Ex parte")
    .replace(/\bre\b/gi, "Re")
    .trim();
}

export function extractCitations(text) {
  const found = { cases: new Set(), cites: new Set() };

  for (const rx of CASE_PATTERNS) {
    for (const m of text.matchAll(rx)) {
      found.cases.add(normalizeCaseName(m[0]));
    }
  }
  for (const rx of CITE_PATTERNS) {
    for (const m of text.matchAll(rx)) {
      found.cites.add(m[0].replace(/\s+/g, " ").trim());
    }
  }
  return {
    cases: [...found.cases],
    cites: [...found.cites],
  };
}

// Lightweight aliasing for well-known shorthand (extend as you wish)
export const CASE_ALIASES = {
  beddoe: ["Re Beddoe", "Re Beddoe [1893] 1 Ch 547"],
  saunders: ["Saunders v Vautier", "Saunders v Vautier (1841) Cr & Ph 240"],
  belchier: ["Ex parte Belchier"],
};

export const LAW_ALIASES = {
  jtl: "Trusts (Jersey) Law 1984",
  cjl: "Companies (Jersey) Law 1991",
  fsl: "Financial Services (Jersey) Law 1998",
};

// Expand “s 5(2) / art 5.2” into search-safe alternates
export function expandSections(q) {
  const outs = [];
  const secRx = /\b(?:s|sec|section|art|article)\s*([0-9]+)\s*[\.\( ]\s*([0-9]+)\)?/ig;
  let m;
  while ((m = secRx.exec(q))) {
    const a = m[1], b = m[2];
    outs.push(`"${a}(${b})"`, `"${a} ${b}"`, `"${a}.${b}"`);
  }
  return outs;
}

export function preprocessQuery(raw) {
  let q = raw.trim();

  // Alias expansion (law)
  q = q.replace(/\b(jtl|cjl|fsl)\b/ig, (m) => LAW_ALIASES[m.toLowerCase()]);

  // Case alias expansion (single tokens like "beddoe")
  const extra = [];
  for (const [k, vals] of Object.entries(CASE_ALIASES)) {
    if (new RegExp(`\\b${k}\\b`, "i").test(q)) extra.push(...vals);
  }

  const secExpansions = expandSections(q);

  // If user typed “X vs Y”, normalize to “v”
  q = q.replace(/\bvs\b/gi, "v").replace(/\bv\.\b/gi, "v");

  return {
    base: q,
    expansions: [...new Set([...extra, ...secExpansions])],
    wantsOR: secExpansions.length > 0, // section queries benefit from OR
  };
}
