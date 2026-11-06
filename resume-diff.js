// Tracked-changes diff between an original and a tailored resume.
// Line-level LCS diff -> pair similar removed/added lines into "modified" rows ->
// word-level diff inside each modified row -> attach the AI's "why" notes to rows.
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Split into logical lines; re-join lines that PDF extraction wrapped mid-sentence.
  function units(text) {
    const out = [];
    for (const raw of String(text || '').replace(/\r/g, '').split('\n')) {
      const t = raw.trim();
      if (!t || !/[a-zA-Z0-9]/.test(t)) continue;
      const prev = out[out.length - 1];
      const isWrap = prev && /^[a-z(]/.test(t) && !/[@|]/.test(t) && !/[.:]$/.test(prev)
        && (/^[•●○‣⁃*\-–—]/.test(prev) || prev.length > 45);
      if (isWrap) { out[out.length - 1] += ' ' + t; continue; }
      out.push(t);
    }
    return out;
  }

  const stripBullet = (s) => s.replace(/^[•●○‣⁃*\-–—]\s*/, '');
  const norm = (s) => stripBullet(s).replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();
  const words = (s) => norm(s).replace(/[^a-z0-9+#%$ ]/g, ' ').split(/\s+/).filter(Boolean);

  const STOP = new Set('a an the and or of in on to for with by at from as is are was were be this that it its into over x'.split(' '));
  // Similarity of two lines by shared content words (overlap coefficient).
  // A rewritten bullet usually keeps a few key nouns but grows a lot, so Jaccard undercounts it.
  function similarity(a, b) {
    const A = new Set(words(a).filter(w => !STOP.has(w))), B = new Set(words(b).filter(w => !STOP.has(w)));
    if (!A.size || !B.size) return 0;
    let inter = 0; for (const w of A) if (B.has(w)) inter++;
    if (inter < Math.min(2, A.size, B.size)) return 0;
    return inter / Math.min(A.size, B.size);
  }

  // Classic LCS diff. Returns [{op:'eq'|'del'|'add', a?, b?}] in order.
  function lcsDiff(a, b, eq) {
    const n = a.length, m = b.length;
    if (n * m > 250000) return [...a.map(x => ({ op: 'del', a: x })), ...b.map(y => ({ op: 'add', b: y }))];
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i][j] = eq(a[i], b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const ops = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (eq(a[i], b[j])) { ops.push({ op: 'eq', a: a[i++], b: b[j++] }); }
      else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ op: 'del', a: a[i++] });
      else ops.push({ op: 'add', b: b[j++] });
    }
    while (i < n) ops.push({ op: 'del', a: a[i++] });
    while (j < m) ops.push({ op: 'add', b: b[j++] });
    return ops;
  }

  function wordDiff(oldText, newText) {
    const A = stripBullet(oldText).split(/(\s+)/).filter(s => s && !/^\s+$/.test(s));
    const B = stripBullet(newText).split(/(\s+)/).filter(s => s && !/^\s+$/.test(s));
    const key = (w) => w.toLowerCase().replace(/[^a-z0-9+#%$]/g, '');
    return lcsDiff(A, B, (x, y) => key(x) === key(y) && key(x) !== '' || x === y);
  }

  // Turn a run of dels/adds into paired "mod" rows where lines are similar enough.
  function pairRun(dels, adds) {
    const used = new Set();
    const pairs = adds.map(add => {
      let best = -1, bestSim = 0.45;
      dels.forEach((d, k) => { if (!used.has(k)) { const s = similarity(d, add); if (s > bestSim) { bestSim = s; best = k; } } });
      if (best >= 0) used.add(best);
      return { add, del: best >= 0 ? dels[best] : null };
    });
    const rows = dels.filter((_, k) => !used.has(k)).map(d => ({ type: 'del', oldText: d }));
    for (const p of pairs) {
      rows.push(p.del
        ? { type: 'mod', oldText: p.del, newText: p.add, words: wordDiff(p.del, p.add) }
        : { type: 'add', newText: p.add });
    }
    return rows;
  }

  function diffResumes(original, tailored, changes, flags) {
    const a = units(original), b = units(tailored);
    const ops = lcsDiff(a, b, (x, y) => norm(x) === norm(y));
    const rows = [];
    let dels = [], adds = [];
    const flush = () => { if (dels.length || adds.length) rows.push(...pairRun(dels, adds)); dels = []; adds = []; };
    for (const o of ops) {
      if (o.op === 'eq') { flush(); rows.push({ type: 'same', newText: o.b }); }
      else if (o.op === 'del') dels.push(o.a);
      else adds.push(o.b);
    }
    flush();
    rows.forEach(r => { r.notes = []; r.flags = []; });

    // Attach each "why" note to the changed row that best contains its replacement excerpt.
    const unmatched = [];
    for (const c of Array.isArray(changes) ? changes : []) {
      const target = words(c.replacement || '');
      let best = null, bestScore = 0.55;
      if (target.length) {
        for (const r of rows) {
          if (r.type !== 'add' && r.type !== 'mod') continue;
          const have = new Set(words(r.newText));
          const score = target.filter(w => have.has(w)).length / target.length;
          if (score > bestScore) { bestScore = score; best = r; }
        }
      }
      if (best) best.notes.push(c.reason || ''); else unmatched.push(c);
    }

    // Attach truth-check flags to the line that contains the flagged claim.
    for (const f of Array.isArray(flags) ? flags : []) {
      const target = words(f.claim || '');
      let best = null, bestScore = 0.6;
      if (target.length) for (const r of rows) {
        if (!r.newText) continue;
        const have = new Set(words(r.newText));
        const score = target.filter(w => have.has(w)).length / target.length;
        if (score > bestScore) { bestScore = score; best = r; }
      }
      if (best) best.flags.push(f);
    }

    const count = (t) => rows.filter(r => r.type === t).length;
    return { rows, unmatched, stats: { modified: count('mod'), added: count('add'), removed: count('del'), unchanged: count('same'), flagged: rows.filter(r => r.flags.length).length } };
  }

  function renderWords(ops) {
    return ops.map(o => o.op === 'eq' ? esc(o.b) : o.op === 'del' ? `<del>${esc(o.a)}</del>` : `<ins>${esc(o.b)}</ins>`).join(' ');
  }

  function renderDiffHTML(diff, { context = 1 } = {}) {
    const { rows, unmatched, stats } = diff;
    const changed = rows.map(r => r.type !== 'same');
    const show = rows.map((_, i) => {
      for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) if (changed[k]) return true;
      return false;
    });
    const noteHTML = (r) => r.notes.filter(Boolean).map(n => `<div class="rd-why"><span>WHY</span>${esc(n)}</div>`).join('')
      + (r.flags || []).map(f => `<div class="rd-why rd-flag"><span>CHECK</span>${esc(f.issue)}</div>`).join('');
    let html = `<div class="rd-stats">
      <span class="rd-stat mod">${stats.modified} rewritten</span>
      <span class="rd-stat add">${stats.added} added</span>
      <span class="rd-stat del">${stats.removed} removed</span>
      <span class="rd-stat same">${stats.unchanged} unchanged</span>
      ${stats.flagged ? `<span class="rd-stat flag">⚠ ${stats.flagged} to verify</span>` : ''}
    </div><div class="rd-body">`;
    let hidden = 0;
    const flushHidden = () => { if (hidden) { html += `<div class="rd-skip">··· ${hidden} unchanged line${hidden > 1 ? 's' : ''}</div>`; hidden = 0; } };
    rows.forEach((r, i) => {
      if (!show[i]) { hidden++; return; }
      flushHidden();
      if (r.type === 'same') html += `<div class="rd-row same${r.flags.length ? ' flagged' : ''}"><span class="rd-gut"> </span><div>${esc(r.newText)}${noteHTML(r)}</div></div>`;
      else if (r.type === 'del') html += `<div class="rd-row del"><span class="rd-gut">−</span><div><del>${esc(r.oldText)}</del></div></div>`;
      else if (r.type === 'add') html += `<div class="rd-row add${r.flags.length ? ' flagged' : ''}"><span class="rd-gut">+</span><div><ins>${esc(r.newText)}</ins>${noteHTML(r)}</div></div>`;
      else html += `<div class="rd-row mod${r.flags.length ? ' flagged' : ''}"><span class="rd-gut">~</span><div>${renderWords(r.words)}${noteHTML(r)}</div></div>`;
    });
    flushHidden();
    html += '</div>';
    if (unmatched.length) {
      html += `<div class="rd-other"><div class="rd-other-title">OTHER CHANGES</div>${unmatched.map(c =>
        `<div class="rd-other-item"><div><del>${esc(c.original)}</del> → <ins>${esc(c.replacement)}</ins></div><div class="rd-why"><span>WHY</span>${esc(c.reason)}</div></div>`).join('')}</div>`;
    }
    return html;
  }

  // Styles shared by every page that shows a diff.
  const css = `
  .rd-stats{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px;}
  .rd-stat{font-size:12px;letter-spacing:1px;padding:4px 10px;border-radius:20px;border:1px solid var(--border-light);color:var(--muted);}
  .rd-stat.mod{color:var(--blue);border-color:rgba(var(--blue-rgb),0.3);} .rd-stat.add{color:var(--accent);border-color:rgba(var(--accent-rgb),0.3);} .rd-stat.del{color:var(--danger);border-color:rgba(var(--danger-rgb),0.3);}
  .rd-body{font-size:14px;line-height:1.7;}
  .rd-row{display:grid;grid-template-columns:18px 1fr;gap:8px;padding:5px 8px;border-radius:6px;margin-bottom:2px;word-break:break-word;}
  .rd-row.same{color:var(--c-777);} .rd-row.add{background:rgba(var(--accent-rgb),0.05);} .rd-row.del{background:rgba(var(--danger-rgb),0.05);} .rd-row.mod{background:rgba(var(--blue-rgb),0.05);color:var(--c-ccc);}
  .rd-gut{color:var(--muted);text-align:center;user-select:none;} .rd-row.add .rd-gut{color:var(--accent);} .rd-row.del .rd-gut{color:var(--danger);} .rd-row.mod .rd-gut{color:var(--blue);}
  .rd-body ins,.rd-other ins{text-decoration:none;color:var(--accent);background:rgba(var(--accent-rgb),0.12);border-radius:3px;padding:0 2px;}
  .rd-body del,.rd-other del{color:var(--c-ff9090);background:rgba(var(--danger-rgb),0.1);border-radius:3px;padding:0 2px;}
  .rd-why{margin-top:6px;font-size:13px;color:var(--c-9a9ab0);line-height:1.5;display:flex;gap:8px;align-items:baseline;}
  .rd-why span{font-size:11px;letter-spacing:1.5px;color:var(--warn);border:1px solid rgba(var(--warn-rgb),0.3);border-radius:4px;padding:1px 5px;flex-shrink:0;}
  .rd-stat.flag{color:var(--danger);border-color:rgba(var(--danger-rgb),0.4);background:rgba(var(--danger-rgb),0.06);}
  .rd-row.flagged{box-shadow:inset 3px 0 0 var(--danger);}
  .rd-flag{color:var(--c-ffb0b0);} .rd-flag span{color:var(--danger);border-color:rgba(var(--danger-rgb),0.4);}
  .rd-skip{font-size:12px;color:var(--c-555);padding:4px 34px;letter-spacing:1px;}
  .rd-other{margin-top:20px;padding-top:16px;border-top:1px solid var(--border);}
  .rd-other-title{font-size:11px;letter-spacing:2px;color:var(--muted);margin-bottom:10px;}
  .rd-other-item{font-size:13px;padding:8px 0;border-bottom:1px solid var(--border);color:var(--c-bbb);word-break:break-word;}`;
  if (typeof document !== 'undefined') {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  const api = { diffResumes, renderDiffHTML, units, esc };
  if (typeof window !== 'undefined') window.ResumeDiff = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
