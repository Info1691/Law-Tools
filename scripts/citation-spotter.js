// scripts/citation-spotter.js
// Scans result snippets, highlights case citations, and links to BAILII search.
// No dependencies. Safe to run multiple times.

(() => {
  "use strict";

  // ---- config --------------------------------------------------------------

  const BAILII_SEARCH = "https://www.bailii.org/cgi-bin/sino_search_1.pl?method=all&query=";

  // Common UK reporters & neutral identifiers (short list; extend as needed)
  const REPORTERS = [
    "UKSC","UKPC","UKUT","UKFTT","EWCA","EWHC","QB","Ch","Fam","AC","WLR","All\\s?ER","BCLC","IRLR","ICR","Cr\\s?App\\s?R","HL","PC","CA"
  ];

  // 1) Neutral/Report citations with year, e.g. [1999] 1 WLR 1 / [2019] EWCA Civ 123
  const reNeutral = new RegExp(
    String.raw`\[(\d{4})]\s+(?:${REPORTERS.join("|")})(?:\s+(?:Civ|Crim|Admin|Ch|Pat|Comm|Fam))?(?:\s+\d+)?(?:\s+[A-Z]{1,4})?(?:\s*\d+)?`,
    "g"
  );

  // 2) Party v Party cases, e.g. "Saunders v Vautier", "Belcher, Ex parte"
  //    Keep it conservative to avoid false hits in normal prose.
  const reVersus = /\b([A-Z][A-Za-z&.'’\-]{2,40})\s+v\.?\s+([A-Z][A-Za-z&.'’\-]{2,40})\b/g;

  // 3) Re / In re matters, e.g. "Re Smith", "In re XYZ Trust"
  const reRe = /\b(?:Re|In\s+re)\s+([A-Z][A-Za-z0-9&.'’\-]{2,60})\b/g;

  // Node filter: scan only within these containers (tweak as your pages require)
  const RESULT_CONTAINERS = [
    ".result",           // generic card/class
    ".snippet",          // generic snippet
    ".card",             // card container
    ".result-snippet",   // agent3 cards
    ".search-results"    // whole column
  ];

  // ---- utils ---------------------------------------------------------------

  function mkLink(href, text) {
    const a = document.createElement("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener";
    a.className = "citation-link";
    a.textContent = text;
    return a;
  }

  function toSearchURL(text) {
    // Use the raw citation text as a search query (keeps neutrality & reporter tokens)
    return BAILII_SEARCH + encodeURIComponent(text);
  }

  // Wrap a range in a text node with a link element
  function wrapTextNodeWithLink(textNode, start, end, href, cls = "citation") {
    const txt = textNode.nodeValue;
    const pre = txt.slice(0, start);
    const mid = txt.slice(start, end);
    const suf = txt.slice(end);

    const span = document.createElement("span");
    const link = mkLink(href, mid);
    link.classList.add(cls);

    // Replace the node with [pre][link][suf]
    const frag = document.createDocumentFragment();
    if (pre) frag.appendChild(document.createTextNode(pre));
    frag.appendChild(link);
    if (suf) frag.appendChild(document.createTextNode(suf));

    textNode.parentNode.replaceChild(frag, textNode);
  }

  function scanTextNode(node) {
    const text = node.nodeValue;
    if (!text || !text.trim()) return;

    // Collect matches in a single pass so offsets don't shift while we wrap
    const matches = [];

    function collect(re, kind) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        const hit = m[0];
        const start = m.index;
        const end = start + hit.length;
        matches.push({ start, end, text: hit, kind });
        // fail-safe: avoid infinite loops on zero-width regexes
        if (re.lastIndex === m.index) re.lastIndex++;
      }
    }

    collect(reNeutral, "neutral");
    collect(reVersus, "versus");
    collect(reRe, "re");

    if (!matches.length) return;

    // Deduplicate & sort by start DESC to keep indices valid while wrapping
    matches.sort((a, b) => b.start - a.start);

    for (const m of matches) {
      const href = toSearchURL(m.text);
      wrapTextNodeWithLink(node, m.start, m.end, href, `citation-${m.kind}`);
    }
  }

  function walkAndAnnotate(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        // Skip within anchors to avoid nesting links
        if (node.parentElement && node.parentElement.closest("a")) {
          return NodeFilter.FILTER_REJECT;
        }
        // Skip code/pre blocks
        const bad = node.parentElement && node.parentElement.closest("code,pre,textarea");
        return bad ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(scanTextNode);
  }

  function annotateAll() {
    const roots = [];
    // If your pages render each result in its own card/snippet, scan them specifically
    RESULT_CONTAINERS.forEach(sel => document.querySelectorAll(sel).forEach(el => roots.push(el)));
    // Fallback: scan the main content region
    if (!roots.length) roots.push(document.body);
    roots.forEach(walkAndAnnotate);
  }

  // Run after load + whenever DOM updates (results appearing async)
  window.addEventListener("DOMContentLoaded", annotateAll);
  const mo = new MutationObserver(() => annotateAll());
  mo.observe(document.documentElement, { childList: true, subtree: true });

  // Minimal styling (optional)
  const style = document.createElement("style");
  style.textContent = `
    a.citation, a.citation-link { text-decoration: underline dotted; }
    a.citation-neutral { background: rgba(80,160,255,.15); border-radius: 2px; padding: 0 .15em; }
    a.citation-versus  { background: rgba(255,160,80,.15);  border-radius: 2px; padding: 0 .15em; }
    a.citation-re      { background: rgba(160,255,120,.15); border-radius: 2px; padding: 0 .15em; }
  `;
  document.head.appendChild(style);
})();
