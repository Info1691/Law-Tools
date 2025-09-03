/* fulltext-mode.js
   Adds a "Full-text mode" to the Search (beta) page.
   When ON, it scans ENTIRE .txt files from the catalogs on texts.wwwbcb.org,
   builds snippets, and shows bytes scanned + SHA-256 for each hit.
   Works on both Law-Texts-ui (texts.wwwbcb.org) and Law-Tools mirrors.
*/

(() => {
  const STATE = {
    enabled: false,
    catalogs: {
      textbooks: 'https://texts.wwwbcb.org/texts/catalog.json',
      laws:      'https://texts.wwwbcb.org/laws.json',
      rules:     'https://texts.wwwbcb.org/rules.json'
    },
    windowChars: 240,
    maxSnippetsPerDoc: 6
  };

  // --- helpers --------------------------------------------------------------

  const $ = (sel, root=document) => root.querySelector(sel);
  const el = (tag, attrs={}, ...children) => {
    const n = document.createElement(tag);
    Object.entries(attrs).forEach(([k,v]) => {
      if (k === 'class') n.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
      else if (v !== undefined && v !== null) n.setAttribute(k, v);
    });
    children.forEach(c => n.append(c));
    return n;
  };

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function sha256(text) {
    const buf = new TextEncoder().encode(text);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function parseWindowChars() {
    // Try to read the little "Window: 240 chars" input if present
    const winInput = $('input[type="number"][name="window"], input[aria-label*="Window"], input[title*="Window"]');
    const v = winInput ? parseInt(winInput.value || winInput.placeholder || '240', 10) : 240;
    return Number.isFinite(v) && v > 0 ? v : 240;
  }

  function getQuery() {
    const box = $('input[type="search"], input[name="q"], input#q') || $('input');
    return (box && box.value ? box.value : '').trim();
  }

  function buildMatcher(q, orMode=false) {
    // phrase "..." or tokens; default AND; OR if orMode checkbox on
    const quoted = q.match(/"([^"]+)"/);
    if (quoted) {
      const needle = quoted[1].toLowerCase();
      return (txt) => {
        const i = txt.toLowerCase().indexOf(needle);
        if (i < 0) return [];
        return [[i, i + needle.length]];
      };
    }
    // tokens
    const toks = q.split(/\s+/).filter(Boolean).map(t => t.toLowerCase());
    if (!toks.length) return () => [];
    return (txt) => {
      const hay = txt.toLowerCase();
      const spans = [];
      let matchedAny = false;
      for (const t of toks) {
        let idx = hay.indexOf(t), hit = false;
        while (idx >= 0) {
          spans.push([idx, idx + t.length]);
          hit = true;
          matchedAny = true;
          idx = hay.indexOf(t, idx + t.length);
        }
        if (!orMode && !hit) return []; // AND: if one token missing, no match
      }
      return orMode ? (matchedAny ? spans : []) : spans;
    };
  }

  function makeSnippet(text, start, end, windowChars) {
    const half = Math.floor(windowChars/2);
    const s = Math.max(0, Math.floor((start+end)/2) - half);
    const e = Math.min(text.length, s + windowChars);
    return text.slice(s, e);
  }

  function highlight(html, terms) {
    // very simple highlight, case-insensitive
    let out = html;
    for (const t of terms.sort((a,b)=>b.length-a.length)) {
      if (!t) continue;
      const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      out = out.replace(re, m => `<mark>${m}</mark>`);
    }
    return out;
  }

  async function fetchJSON(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`Catalog fetch failed: ${url} — ${r.status}`);
    return r.json();
  }

  function normalizeCatalogRecords(raw, kindLabel) {
    // Accept either array of items or {items:[...]} or arbitrary object
    let arr = Array.isArray(raw) ? raw
            : Array.isArray(raw?.items) ? raw.items
            : Array.isArray(raw?.records) ? raw.records
            : Object.values(raw || {});
    return arr
      .filter(x => x && (x.url_txt || x.url || x.href))
      .map(x => ({
        title: x.title || x.name || x.label || '(untitled)',
        url:   x.url_txt || x.url || x.href,
        kind:  kindLabel,
        meta:  x
      }));
  }

  function resolveURL(u) {
    // allow ./data/... or absolute
    try {
      return new URL(u, location.origin).href;
    } catch { return u; }
  }

  function termsFromQuery(q) {
    const quoted = q.match(/"([^"]+)"/);
    return quoted ? [quoted[1]] : q.split(/\s+/).filter(Boolean);
  }

  // --- UI wiring -----------------------------------------------------------

  function insertToggle() {
    const host = $('form') || $('.search-bar') || document.body;
    if (!host || $('#bb-fulltext-toggle')) return;

    const wrap = el('div', { id: 'bb-fulltext-toggle', style:{
      display:'flex', gap:'12px', alignItems:'center', margin:'8px 0 6px 0'
    }});

    const lab = el('label', { style:{display:'inline-flex',gap:'8px',alignItems:'center',cursor:'pointer'}},
      el('input', { type:'checkbox', id:'bb-fulltext-enabled' }),
      el('span', {}, 'Full-text mode (scan entire TXT)'),
    );

    const by = el('span', { id:'bb-fulltext-status', style:{fontSize:'12px',opacity:'0.8'}});
    wrap.append(lab, by);

    // Try to place right under the search bar
    const box = $('input[type="search"], input[name="q"], input#q');
    if (box && box.parentElement) {
      box.parentElement.insertAdjacentElement('afterend', wrap);
    } else {
      host.prepend(wrap);
    }

    $('#bb-fulltext-enabled').addEventListener('change', (e) => {
      STATE.enabled = e.target.checked;
      $('#bb-fulltext-status').textContent = STATE.enabled ? 'Ready.' : '';
    });
  }

  function ensureResultsContainer() {
    if ($('#bb-fulltext-results')) return $('#bb-fulltext-results');
    const c = el('div', { id:'bb-fulltext-results', style:{marginTop:'16px'}});
    const h = el('div', { style:{
      display:'flex',justifyContent:'space-between',alignItems:'baseline',margin:'6px 0 10px'
    }},
      el('h3', {style:{margin:'0'}}, 'Full-text results'),
      el('div', { id:'bb-ft-stats', style:{fontSize:'12px',opacity:'0.75'}}, '')
    );
    c.append(h);
    // Try to place before the existing results list, else at end of main
    const main = $('main') || $('#app') || document.body;
    main.insertBefore(c, main.firstChild);
    return c;
  }

  function renderResults({query, groups, scannedBytes, scannedDocs, elapsedMs}) {
    const root = ensureResultsContainer();
    root.querySelectorAll('.bb-ft-group, .bb-ft-empty').forEach(n => n.remove());

    $('#bb-ft-stats').textContent =
      `query="${query}" • scanned ${scannedDocs} file(s), ${scannedBytes.toLocaleString()} bytes in ${elapsedMs} ms`;

    if (groups.every(g => g.items.length === 0)) {
      root.append(el('div', {class:'bb-ft-empty', style:{opacity:'0.8',padding:'8px 0'}},
        'No full-text matches.'));
      return;
    }

    for (const g of groups) {
      const sec = el('section', {class:'bb-ft-group', style:{margin:'12px 0'}},
        el('h4', {style:{margin:'0 0 6px'}}, g.title)
      );
      for (const it of g.items) {
        const card = el('div', {class:'bb-ft-card', style:{
          border:'1px solid #2a2a2a', borderRadius:'8px', padding:'10px 12px', margin:'8px 0',
          background: 'rgba(255,255,255,0.03)'
        }});
        const head = el('div', {style:{display:'flex',justifyContent:'space-between',gap:'8px',flexWrap:'wrap'}},
          el('div', {style:{fontWeight:'600'}}, it.title),
          el('div', {style:{fontSize:'12px',opacity:'0.8'}},
            `${it.matches} hit(s) • ${it.bytes.toLocaleString()} B • SHA-256 ${it.sha.slice(0,7)}…`)
        );
        const open = el('div', {style:{margin:'6px 0 2px'}},
          el('a', {href:it.url, target:'_blank', rel:'noopener'}, 'open TXT')
        );
        card.append(head, open);

        for (const snip of it.snippets) {
          const p = el('div', {style:{
            fontSize:'14px', lineHeight:'1.4', padding:'8px 10px', margin:'6px 0',
            borderLeft:'3px solid #555', background:'rgba(255,255,255,0.02)'
          }});
          p.innerHTML = highlight(escapeHTML(snip), it.terms);
          card.append(p);
        }
        sec.append(card);
      }
      root.append(sec);
    }
  }

  function escapeHTML(s) {
    return s.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }

  // --- engine --------------------------------------------------------------

  async function runFulltextSearch(ev) {
    if (!STATE.enabled) return; // let the page’s native search run
    if (ev) ev.preventDefault();

    const q = getQuery();
    if (!q) return;

    // detect OR mode if the page has a checkbox
    const orCheckbox = $('input[type="checkbox"][name="or"], input[type="checkbox"][id*="or"]');
    const orMode = !!(orCheckbox && orCheckbox.checked);
    STATE.windowChars = parseWindowChars();

    const matcher = buildMatcher(q, orMode);
    const terms = termsFromQuery(q);

    const groups = [
      { key:'textbooks', title:'Textbooks', items:[] },
      { key:'laws',      title:'Laws',      items:[] },
      { key:'rules',     title:'Rules',     items:[] }
    ];

    ensureResultsContainer();
    $('#bb-ft-stats').textContent = 'Fetching catalogs…';

    const t0 = performance.now();
    // Fetch catalogs in parallel
    let [tbRaw, lawsRaw, rulesRaw] = await Promise.all([
      fetchJSON(STATE.catalogs.textbooks).catch(()=>[]),
      fetchJSON(STATE.catalogs.laws).catch(()=>[]),
      fetchJSON(STATE.catalogs.rules).catch(()=>[])
    ]);

    const tb  = normalizeCatalogRecords(tbRaw,   'Textbook');
    const lw  = normalizeCatalogRecords(lawsRaw, 'Law');
    const rl  = normalizeCatalogRecords(rulesRaw,'Rule');

    const plan = [
      {arr: tb, group: groups[0]},
      {arr: lw, group: groups[1]},
      {arr: rl, group: groups[2]},
    ];

    let scannedBytes = 0, scannedDocs = 0;

    for (const {arr, group} of plan) {
      for (const rec of arr) {
        const url = resolveURL(rec.url);
        let txt;
        try {
          const r = await fetch(url, { cache:'no-store' });
          if (!r.ok) continue;
          txt = await r.text();
        } catch { continue; }

        scannedBytes += (txt.length || 0);
        scannedDocs += 1;

        const spans = matcher(txt);
        if (!spans.length) continue;

        const snippets = [];
        // Deduplicate & sort spans, then take a few snippets
        spans.sort((a,b)=>a[0]-b[0]);
        const chosen = [];
        let lastEnd = -1;
        for (const [s,e] of spans) {
          if (s <= lastEnd) continue;
          chosen.push([s,e]);
          lastEnd = e;
          if (chosen.length >= STATE.maxSnippetsPerDoc) break;
        }
        for (const [s,e] of chosen) {
          snippets.push(makeSnippet(txt, s, e, STATE.windowChars));
        }

        const item = {
          title: rec.title,
          url,
          snippets,
          matches: spans.length,
          bytes: txt.length || 0,
          sha: await sha256(txt),
          terms
        };
        group.items.push(item);
      }
    }

    const elapsed = Math.round(performance.now() - t0);
    renderResults({query:q, groups, scannedBytes, scannedDocs, elapsedMs: elapsed});
  }

  function hookSubmit() {
    // Try to hook the page’s Search button / form submit
    const form = $('form');
    if (form && !form.__bbFulltextHooked) {
      form.addEventListener('submit', runFulltextSearch, true);
      form.__bbFulltextHooked = true;
    }
    const btn = $('button[type="submit"], input[type="submit"]');
    if (btn && !btn.__bbFulltextHooked) {
      btn.addEventListener('click', runFulltextSearch, true);
      btn.__bbFulltextHooked = true;
    }
  }

  // --- boot ----------------------------------------------------------------

  function boot() {
    insertToggle();
    hookSubmit();
    // also expose a tiny API for debugging
    window.__fulltext = {
      run: runFulltextSearch,
      setCatalogs: (o) => Object.assign(STATE.catalogs, o || {}),
      state: STATE
    };
  }

  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', boot)
    : boot();

})();
