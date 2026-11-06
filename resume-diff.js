// Tracked-changes diff between an original and a tailored resume, shown as a review.
// 1. Split both resumes into sections by their headings (renamed headings like
//    "Profile summary" -> "Professional summary" count as the same section).
// 2. Diff lines within each section, so a reordered header or a moved section
//    can't turn the whole resume into one block of removals and additions.
// 3. Pair similar removed/added lines into rewrites (word-level diff inside),
//    compare "Label: a, b, c" skill lines as sets, and mark lines that differ only
//    in spacing, case or punctuation as formatting-only.
// 4. Attach the AI's "why" notes and truth-check flags to the rows they describe.
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
  // Looser key: ignores spacing around punctuation, quotes, separators and phone formatting.
  const loose = (s) => norm(s).replace(/(\d)[\s.()-]+(?=\d)/g, '$1').replace(/[‘’“”"'`]/g, '').replace(/[•|·]/g, ' ').replace(/\s*([:;,./()+-])\s*/g, '$1').replace(/\s+/g, ' ').replace(/[.;,]$/, '').trim();
  const words = (s) => norm(s).replace(/[^a-z0-9+#%$ ]/g, ' ').split(/\s+/).filter(Boolean);
  const STOP = new Set('a an the and or of in on to for with by at from as is are was were be this that it its into over x'.split(' '));

  // ---- Section headings -------------------------------------------------------
  const SYN = [
    ['summary', /^(professional |profile |career |executive )?(summary|profile|objective|overview)$|^about( me)?$/],
    ['skills', /^(technical |core |key |relevant )?(skills|competencies|expertise|proficiencies)( (&|and) (tools|technologies))?$|^tools( (&|and) technologies)?$|^technologies$/],
    ['experience', /^(professional |work |relevant |employment )?(experience|history)$|^employment( history)?$|^work history$/],
    ['education', /^education( (&|and) (training|certifications))?$|^academic background$/],
    ['projects', /^(selected |key |personal |technical )?projects$/],
    ['certifications', /^(certifications?|licenses?( (&|and) certifications?)?|certifications? (&|and) licenses?)$/],
    ['awards', /^(awards?|honors?)( (&|and) (awards?|honors?))?$/],
    ['publications', /^publications?$/],
    ['leadership', /^leadership( (&|and) activities| experience)?$|^activities$/],
    ['volunteer', /^volunteer(ing| experience| work)?$/],
  ];
  function headingKey(line) {
    const t = stripBullet(line).replace(/[:\s]+$/, '').trim();
    if (!t || t.length > 42 || /[.,;@|]/.test(t) || /\d{3}/.test(t)) return null;
    const lower = t.toLowerCase().replace(/\s+/g, ' ');
    for (const [key, re] of SYN) if (re.test(lower)) return key;
    const letters = t.replace(/[^A-Za-z]/g, '');
    if (letters.length >= 4 && letters === letters.toUpperCase() && t.split(/\s+/).length <= 5) return lower;
    return null;
  }
  const titleCase = (s) => s.toLowerCase().replace(/(^|\s)\S/g, c => c.toUpperCase());

  function sections(lines) {
    const out = [{ key: '_header', title: 'Contact & header', heading: null, lines: [] }];
    for (const l of lines) {
      const key = headingKey(l);
      if (key && !out.some(s => s.key === key)) out.push({ key, title: titleCase(stripBullet(l).replace(/[:\s]+$/, '')), heading: l, lines: [] });
      else out[out.length - 1].lines.push(l);
    }
    return out.filter(s => s.lines.length || s.heading);
  }

  // ---- Line similarity and list lines ---------------------------------------
  // Overlap coefficient on content words: a rewritten bullet usually keeps a few key nouns.
  function similarity(a, b, minShared = 2) {
    const A = new Set(words(a).filter(w => !STOP.has(w))), B = new Set(words(b).filter(w => !STOP.has(w)));
    if (!A.size || !B.size) return 0;
    let inter = 0; for (const w of A) if (B.has(w)) inter++;
    if (inter < Math.min(minShared, A.size, B.size)) return 0;
    return inter / Math.min(A.size, B.size);
  }
  // "Label: a, b, c" -> { label, items }
  function listLine(s) {
    const m = /^([^:]{2,48}):\s*(.+)$/.exec(stripBullet(s));
    if (!m) return null;
    const items = m[2].split(/\s*[,;|•·]\s*/).map(x => x.trim()).filter(Boolean);
    return items.length >= 2 ? { label: m[1].trim(), items } : null;
  }
  const itemKey = (x) => x.toLowerCase().replace(/[^a-z0-9+#]/g, '');
  function listDiff(oldText, newText) {
    const a = listLine(oldText), b = listLine(newText);
    const has = (list, x) => list.some(y => itemKey(y) === itemKey(x));
    return {
      label: b.label,
      added: b.items.filter(x => !has(a.items, x)),
      removed: a.items.filter(x => !has(b.items, x)),
      kept: b.items.filter(x => has(a.items, x)).length,
    };
  }

  // ---- Diff -----------------------------------------------------------------
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
    const A = stripBullet(oldText).split(/\s+/).filter(Boolean);
    const B = stripBullet(newText).split(/\s+/).filter(Boolean);
    const key = (w) => w.toLowerCase().replace(/[^a-z0-9+#%$]/g, '');
    return lcsDiff(A, B, (x, y) => key(x) === key(y) && key(x) !== '' || x === y);
  }

  function rowFor(del, add) {
    if (loose(del) === loose(add)) return { type: 'fmt', oldText: del, newText: add };
    const la = listLine(del), lb = listLine(add);
    if (la && lb) return { type: 'list', oldText: del, newText: add, list: listDiff(del, add) };
    return { type: 'mod', oldText: del, newText: add, words: wordDiff(del, add) };
  }

  // Turn a run of removed/added lines into rows, in reading order. Each added line takes
  // its best-matching removed line; leftover removals stay where they were in the original.
  function pairRun(dels, adds) {
    const used = new Map(); // del index -> add index
    const match = adds.map(() => -1);
    const tryPair = (score) => adds.forEach((add, j) => {
      if (match[j] >= 0) return;
      let best = -1, bestSim = 0;
      dels.forEach((d, k) => { if (!used.has(k)) { const s = score(d, add); if (s > bestSim) { bestSim = s; best = k; } } });
      if (best >= 0) { used.set(best, j); match[j] = best; }
    });
    // 1) same text up to formatting, 2) same list label, 3) clearly similar, 4) loosely similar
    tryPair((d, a) => loose(d) === loose(a) ? 1 : 0);
    tryPair((d, a) => { const x = listLine(d), y = listLine(a); return x && y && norm(x.label) === norm(y.label) ? 1 : 0; });
    tryPair((d, a) => { const s = similarity(d, a); return s >= 0.45 ? s : 0; });
    tryPair((d, a) => { const s = similarity(d, a, 2); return s >= 0.25 ? s : 0; });

    const rows = [];
    let k = 0; // next original-order removal to place
    const flushDelsBefore = (limit) => {
      for (; k < limit; k++) if (!used.has(k)) rows.push({ type: 'del', oldText: dels[k] });
    };
    adds.forEach((add, j) => {
      if (match[j] >= 0) { flushDelsBefore(match[j]); rows.push(rowFor(dels[match[j]], add)); }
      else rows.push({ type: 'add', newText: add });
    });
    flushDelsBefore(dels.length);
    return rows;
  }

  function diffLines(a, b) {
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
    return rows;
  }

  function diffResumes(original, tailored, changes, flags) {
    const A = sections(units(original)), B = sections(units(tailored));
    const out = [];
    for (const sb of B) {
      const sa = A.find(s => s.key === sb.key);
      const sec = { key: sb.key, title: sb.title, rows: diffLines(sa ? sa.lines : [], sb.lines), isNew: !sa && sb.key !== '_header', renamedFrom: null };
      if (sa && sa.heading && sb.heading && norm(sa.heading) !== norm(sb.heading)) sec.renamedFrom = titleCase(stripBullet(sa.heading).replace(/[:\s]+$/, ''));
      out.push(sec);
    }
    for (const sa of A) {
      if (B.some(s => s.key === sa.key)) continue;
      const sec = { key: sa.key, title: sa.title, rows: diffLines(sa.lines, []), isRemoved: true, renamedFrom: null };
      const at = A.indexOf(sa);
      // Put a dropped section after the last kept section that preceded it in the original.
      let pos = 0;
      for (let i = at - 1; i >= 0; i--) { const p = out.findIndex(s => s.key === A[i].key); if (p >= 0) { pos = p + 1; break; } }
      out.splice(pos, 0, sec);
    }
    const rows = out.flatMap(s => s.rows);
    rows.forEach(r => { r.notes = []; r.flags = []; });

    // Attach each "why" note to the changed row that best contains its replacement excerpt.
    const unmatched = [];
    for (const c of Array.isArray(changes) ? changes : []) {
      const target = words(c.replacement || '');
      let best = null, bestScore = 0.55;
      if (target.length) {
        for (const r of rows) {
          if (!['add', 'mod', 'list'].includes(r.type)) continue;
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
    const stats = {
      modified: count('mod') + count('list'), added: count('add'), removed: count('del'),
      formatting: count('fmt'), unchanged: count('same'), flagged: rows.filter(r => r.flags.length).length,
    };
    return { sections: out, rows, unmatched, stats };
  }

  // ---- Render ---------------------------------------------------------------
  // Light edits read best inline (struck + inserted words). Heavy rewrites read best as the
  // new sentence with additions marked; the old one stays under "Show original".
  function renderWords(ops) {
    const oldCount = ops.filter(o => o.op !== 'add').length || 1;
    const heavy = ops.filter(o => o.op === 'del').length / oldCount > 0.3;
    return ops.filter(o => !(heavy && o.op === 'del'))
      .map(o => o.op === 'eq' ? esc(o.b) : o.op === 'del' ? `<del>${esc(o.a)}</del>` : `<ins>${esc(o.b)}</ins>`).join(' ');
  }
  const KIND = { mod: 'Rewritten', list: 'Updated list', add: 'Added', del: 'Removed' };

  function renderRow(r) {
    const flagged = r.flags.length > 0;
    const filt = [flagged ? 'verify' : '', r.type === 'list' ? 'mod' : r.type].join(' ');
    const kind = flagged ? `⚠ ${KIND[r.type] || 'Unchanged'} · check this claim` : (r.type === 'list' ? esc(r.list.label) : KIND[r.type]);
    let body = '';
    if (r.type === 'mod') body = `<div class="rd-text">${renderWords(r.words)}</div>`;
    else if (r.type === 'add') body = `<div class="rd-text"><ins>${esc(stripBullet(r.newText))}</ins></div>`;
    else if (r.type === 'del') body = `<div class="rd-text rd-removed">${esc(stripBullet(r.oldText))}</div>`;
    else if (r.type === 'list') {
      const { added, removed, kept } = r.list;
      body = `<div class="rd-tokens">${added.map(x => `<span class="rd-tok add">+ ${esc(x)}</span>`).join('')}${removed.map(x => `<span class="rd-tok del">− ${esc(x)}</span>`).join('')}${kept ? `<span class="rd-tok">${kept} kept</span>` : ''}${!added.length && !removed.length ? '<span class="rd-tok">Reordered</span>' : ''}</div>`;
    } else body = `<div class="rd-text">${esc(stripBullet(r.newText))}</div>`;
    const why = r.notes.filter(Boolean).map(n => `<div class="rd-why">${esc(n)}</div>`).join('')
      + r.flags.map(f => `<div class="rd-why rd-flag">${esc(f.issue || 'Not supported by your original resume.')}</div>`).join('');
    const orig = r.type === 'mod' || r.type === 'list'
      ? `<details class="rd-orig"><summary>Show original</summary><p>${esc(stripBullet(r.oldText))}</p></details>` : '';
    return `<div class="rd-row${flagged ? ' flagged' : ''}" data-f="${filt.trim()}"><div class="rd-kind ${r.type}${flagged ? ' verify' : ''}">${kind}</div>${body}${why}${orig}</div>`;
  }

  function renderDiffHTML(diff) {
    const { sections: secs, unmatched, stats } = diff;
    const total = stats.modified + stats.added + stats.removed;
    const chip = (f, label, n, cls = '') => n || f === 'all'
      ? `<button type="button" class="rd-filter ${cls}" data-filter="${f}" aria-pressed="${f === 'all'}" onclick="ResumeDiff.filter(this)">${label} <b>${n}</b></button>` : '';
    let html = `<div class="rd" data-active="all"><div class="rd-filters" role="group" aria-label="Show changes">
      ${chip('all', 'All', total)}
      ${chip('verify', '⚠ To verify', stats.flagged, 'warn')}
      ${chip('mod', 'Rewritten', stats.modified)}
      ${chip('add', 'Added', stats.added)}
      ${chip('del', 'Removed', stats.removed)}
    </div>`;
    if (!total && !stats.formatting) html += `<div class="rd-empty">No changes. The tailored resume matches your original.</div>`;
    for (const s of secs) {
      const changed = s.rows.filter(r => !['same', 'fmt'].includes(r.type));
      const fmt = s.rows.filter(r => r.type === 'fmt');
      if (!changed.length && !fmt.length && !s.renamedFrom) continue;
      const n = (t) => s.rows.filter(r => r.type === t || (t === 'mod' && r.type === 'list')).length;
      const bits = [
        s.isNew ? 'New section' : s.isRemoved ? 'Section removed' : '',
        s.renamedFrom ? `Renamed from “${esc(s.renamedFrom)}”` : '',
        n('mod') ? `${n('mod')} rewritten` : '', n('add') ? `${n('add')} added` : '', n('del') && !s.isRemoved ? `${n('del')} removed` : '',
        s.rows.some(r => r.flags.length) ? `${s.rows.filter(r => r.flags.length).length} to verify` : '',
        n('same') ? `${n('same')} unchanged` : '',
      ].filter(Boolean).join(' · ');
      html += `<section class="rd-sec"><div class="rd-sec-head"><span class="rd-sec-name">${esc(s.title)}</span><span class="rd-sec-sum">${bits}</span></div>`;
      html += changed.map(renderRow).join('');
      if (fmt.length) html += `<details class="rd-fmt" data-f="fmt"><summary>${fmt.length} formatting-only change${fmt.length > 1 ? 's' : ''} (spacing, case, punctuation)</summary>${fmt.map(r => `<div class="rd-fmt-line">${esc(stripBullet(r.newText))}</div>`).join('')}</details>`;
      html += `</section>`;
    }
    if (unmatched.length) {
      html += `<section class="rd-sec" data-f="mod"><div class="rd-sec-head"><span class="rd-sec-name">Other changes</span><span class="rd-sec-sum">Edits the AI described that we couldn't place on a line</span></div>${unmatched.map(c =>
        `<div class="rd-row" data-f="mod"><div class="rd-text"><del>${esc(c.original)}</del> → <ins>${esc(c.replacement)}</ins></div>${c.reason ? `<div class="rd-why">${esc(c.reason)}</div>` : ''}</div>`).join('')}</section>`;
    }
    return html + '</div>';
  }

  // Filter chips: show only rows of one kind, hide sections left empty.
  function filter(btn) {
    const root = btn.closest('.rd');
    const f = btn.dataset.filter;
    root.querySelectorAll('.rd-filter').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
    root.querySelectorAll('.rd-sec').forEach(sec => {
      let any = false;
      sec.querySelectorAll('.rd-row').forEach(r => {
        const on = f === 'all' || r.dataset.f.split(' ').includes(f);
        r.hidden = !on; any = any || on;
      });
      sec.querySelectorAll('.rd-fmt').forEach(d => { d.hidden = f !== 'all'; });
      sec.hidden = !any && !(f === 'all' && sec.querySelector('.rd-fmt, .rd-sec-sum'));
    });
  }

  // Styles shared by every page that shows a diff.
  const css = `
  .rd{display:flex;flex-direction:column;gap:14px;}
  .rd-filters{display:flex;flex-wrap:wrap;gap:8px;}
  .rd-filter{height:28px;padding:0 12px;border-radius:999px;border:1px solid var(--border-light);background:none;color:var(--muted);font-family:var(--font-ui);font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;}
  .rd-filter b{color:var(--text);font-weight:500;}
  .rd-filter:hover{color:var(--text);}
  .rd-filter[aria-pressed="true"]{background:var(--surface-2);border-color:var(--muted);color:var(--text);}
  .rd-filter.warn,.rd-filter.warn b{color:var(--warn);}
  .rd-filter:focus-visible,.rd summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px;}
  .rd-empty{color:var(--muted);font-size:14px;padding:20px 0;text-align:center;}
  .rd-sec{border:1px solid var(--border);border-radius:12px;background:var(--surface);overflow:hidden;}
  .rd-sec[hidden],.rd-row[hidden],.rd-fmt[hidden]{display:none;}
  .rd-sec-head{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid var(--border);}
  .rd-sec-name{font-family:var(--font-display);font-weight:700;font-size:15px;color:var(--c-fff);}
  .rd-sec-sum{font-size:12px;color:var(--muted);}
  .rd-row{padding:14px 16px;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:6px;word-break:break-word;}
  .rd-row:last-child{border-bottom:0;}
  .rd-kind{font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);}
  .rd-kind.add{color:var(--accent);} .rd-kind.del{color:var(--danger);} .rd-kind.verify{color:var(--warn);}
  .rd-text{font-family:var(--font-doc);font-size:14px;line-height:1.65;color:var(--text);max-width:80ch;}
  .rd ins{text-decoration:none;color:var(--accent);background:rgba(var(--accent-rgb),0.1);box-shadow:inset 0 -1px 0 rgba(var(--accent-rgb),0.45);border-radius:2px;padding:0 1px;}
  .rd del{color:var(--c-ff9090);text-decoration-color:rgba(var(--danger-rgb),0.6);}
  .rd-text.rd-removed{color:var(--muted);text-decoration:line-through;text-decoration-color:rgba(var(--danger-rgb),0.6);}
  .rd-tokens{display:flex;flex-wrap:wrap;gap:6px;}
  .rd-tok{font-size:12px;padding:2px 9px;border-radius:999px;border:1px solid var(--border-light);color:var(--muted);}
  .rd-tok.add{color:var(--accent);border-color:rgba(var(--accent-rgb),0.35);background:rgba(var(--accent-rgb),0.06);}
  .rd-tok.del{color:var(--danger);border-color:rgba(var(--danger-rgb),0.35);background:rgba(var(--danger-rgb),0.06);}
  .rd-why{font-size:12px;line-height:1.5;color:var(--muted);}
  .rd-why.rd-flag{color:var(--warn);}
  .rd-row.flagged{background:rgba(var(--warn-rgb),0.04);}
  .rd-orig summary,.rd-fmt summary{cursor:pointer;font-size:12px;color:var(--muted);list-style:none;width:fit-content;}
  .rd-orig summary::-webkit-details-marker,.rd-fmt summary::-webkit-details-marker{display:none;}
  .rd-orig summary::after,.rd-fmt summary::after{content:' ▸';} .rd-orig[open] summary::after,.rd-fmt[open] summary::after{content:' ▾';}
  .rd-orig summary:hover,.rd-fmt summary:hover{color:var(--text);}
  .rd-orig p{margin:6px 0 0;padding-left:12px;border-left:2px solid var(--border-light);font-family:var(--font-doc);font-size:13px;line-height:1.6;color:var(--muted);}
  .rd-fmt{padding:12px 16px;}
  .rd-fmt-line{font-family:var(--font-doc);font-size:13px;line-height:1.6;color:var(--muted);padding:4px 0 0 12px;}`;
  if (typeof document !== 'undefined') {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  const api = { diffResumes, renderDiffHTML, filter, units, sections, esc };
  if (typeof window !== 'undefined') window.ResumeDiff = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
