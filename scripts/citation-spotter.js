/* Citation Spotter + Linker
   - Finds common case patterns in result snippets and makes them clickable.
   - Links to the site-wide global search so the user can jump from a textbook mention
     to primary sources (laws/rules/other texts).
   - Safe: operates only on text nodes (doesn’t break existing <mark> highlighting).
*/

(() => {
  const DEST = "https://tools.wwwbcb.org/global-search.html?q=";

  // Patterns: keep conservative to avoid false-positives
  const PATTERNS = [
    // A v B (with optional dot after v)
    { name: "AvB", re: /\b([A-Z][A-Za-z&'().-]+)\s+v\.?\s+([A-Z][A-Za-z&'().-]+)\b/g },

    // Re X…
    { name: "ReX", re: /\bRe\s+[A-Z][A-Za-z0-9'().-]{2,}\b/g },

    // Simple neutral-citation-ish: [1999] ABC 123  (kept broad but gated by brackets)
    { name: "Neutral", re: /\[\d{4}\]\s*[A-Z]{1,5}\s*\d{1,4}(?:\s*\([A-Z]{1,3}\))?/g }
  ];

  const TARGET_SELECTORS = [
    ".result-snippet",   // Agent 3 cards
    ".snippet",          // Our quick-search cards
    ".card .snippet"
  ];

  // Inject a subtle underline for linked cites
  const style = document.createElement("style");
  style.textContent = `
    a.cite { text-decoration: none; border-bottom: 1px dotted #8fb3ff; }
    a.cite:hover { border-bottom-style: solid; }
  `;
  document.head.appendChild(style);

  function linkifyIn(el, re, toHref) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    const nodes = [];
    while (true) {
      const n = walker.nextNode();
      if (!n) break;
      // Skip if already inside a link
      if (n.parentElement && n.parentElement.closest("a")) continue;
      nodes.push(n);
    }

    for (const textNode of nodes) {
      const txt = textNode.nodeValue;
      re.lastIndex = 0;
      let m, last = 0, changed = false;
      const frag = document.createDocumentFragment();

      while ((m = re.exec(txt))) {
        changed = true;
        // Before match
        if (m.index > last) {
          frag.appendChild(document.createTextNode(txt.slice(last, m.index)));
        }
        // Link
        const a = document.createElement("a");
        a.className = "cite";
        a.target = "_blank";
        a.rel = "noopener";
        a.href = toHref(m);
        a.textContent = m[0];
        frag.appendChild(a);

        last = m.index + m[0].length;
      }

      if (changed) {
        // Tail
        if (last < txt.length) frag.appendChild(document.createTextNode(txt.slice(last)));
        textNode.parentNode.replaceChild(frag, textNode);
      }
    }
  }

  function runOnce() {
    const roots = TARGET_SELECTORS.flatMap(sel => Array.from(document.querySelectorAll(sel)));
    if (!roots.length) return;

    for (const root of roots) {
      for (const { re } of PATTERNS) {
        linkifyIn(root, re, m => DEST + encodeURIComponent(m[0]));
      }
    }
  }

  // Run when the page finishes rendering initial results, and also after future updates.
  const kick = () => runOnce();

  if (document.readyState === "complete" || document.readyState === "interactive") {
    setTimeout(kick, 0);
  } else {
    document.addEventListener("DOMContentLoaded", kick);
  }

  // Mutation observer so new result cards (e.g., a new search) get linkified too
  const obs = new MutationObserver((mut) => {
    for (const m of mut) {
      if (m.addedNodes && m.addedNodes.length) {
        runOnce();
        break;
      }
    }
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
})();
