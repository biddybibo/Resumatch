// Shared application-pipeline storage.
// Logged-in users -> Supabase `applications` table (RLS scoped to auth.uid()).
// Anonymous users, or if the table is unreachable -> localStorage.
(function () {
  const LOCAL_KEY = 'rm_pipeline';
  const STATUSES = ['saved', 'applied', 'interviewing', 'offer', 'closed'];
  const STATUS_LABELS = { saved: 'Saved', applied: 'Applied', interviewing: 'Interviewing', offer: 'Offer', closed: 'Closed' };

  // camelCase (app) <-> snake_case (db)
  const FIELDS = {
    id: 'id', company: 'company', role: 'role', status: 'status', position: 'position',
    jobUrl: 'job_url', jobDescription: 'job_description', originalResume: 'original_resume',
    tailoredResume: 'tailored_resume', coverLetter: 'cover_letter',
    matchScoreBefore: 'match_score_before', matchScoreAfter: 'match_score_after',
    analysis: 'analysis', changes: 'changes', notes: 'notes', nextStep: 'next_step',
    nextStepDate: 'next_step_date', activity: 'activity', truthCheck: 'truth_check',
    fitScore: 'fit_score', closeReason: 'close_reason',
    followup: 'followup', interviewPrep: 'interview_prep', createdAt: 'created_at', updatedAt: 'updated_at'
  };
  const toRow = (obj) => {
    const row = {};
    for (const [k, v] of Object.entries(obj)) if (FIELDS[k] && k !== 'createdAt' && k !== 'updatedAt') row[FIELDS[k]] = v;
    if ('nextStepDate' in obj && !obj.nextStepDate) row.next_step_date = null;
    return row;
  };
  const fromRow = (row) => {
    const obj = {};
    for (const [k, col] of Object.entries(FIELDS)) obj[k] = row[col];
    return normalize(obj);
  };

  function normalize(a) {
    return {
      company: '', role: '', status: 'saved', position: 0, jobUrl: '', jobDescription: '',
      originalResume: '', tailoredResume: '', coverLetter: '', matchScoreBefore: null, matchScoreAfter: null,
      analysis: {}, changes: [], notes: '', nextStep: '', nextStepDate: null, activity: [],
      truthCheck: null, followup: null, interviewPrep: null, fitScore: null, closeReason: null,
      ...a,
      analysis: a.analysis || {}, changes: a.changes || [], activity: a.activity || []
    };
  }

  const readLocal = () => { try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]').map(normalize); } catch { return []; } };
  const writeLocal = (list) => { try { localStorage.setItem(LOCAL_KEY, JSON.stringify(list)); } catch { /* storage unavailable */ } };
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

  // The open card for the same job, so a tailored resume and its cover letter
  // land on one card instead of two. Matches on job link, then job description,
  // then company + role.
  function findMatch(apps, { jobUrl = '', jobDescription = '', company = '', role = '' } = {}) {
    const open = (apps || []).filter(a => a.status !== 'closed');
    const url = (u) => String(u || '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
    const text = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 2000);
    const name = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (url(jobUrl)) { const m = open.find(a => url(a.jobUrl) === url(jobUrl)); if (m) return m; }
    if (text(jobDescription).length > 40) { const m = open.find(a => text(a.jobDescription) === text(jobDescription)); if (m) return m; }
    if (name(company) && name(role)) { const m = open.find(a => name(a.company) === name(company) && name(a.role) === name(role)); if (m) return m; }
    return null;
  }

  function createStore(sb, session) {
    let mode = session ? 'cloud' : 'local';
    let fallbackReason = '';

    const goLocal = (err) => {
      if (mode === 'cloud') { mode = 'local'; fallbackReason = err?.message || 'Cloud sync unavailable'; console.warn('[pipeline] falling back to local storage:', err); }
    };

    async function list() {
      if (mode === 'cloud') {
        const { data, error } = await sb.from('applications').select('*').order('position', { ascending: true });
        if (!error) return data.map(fromRow);
        goLocal(error);
      }
      return readLocal().sort((a, b) => a.position - b.position);
    }

    async function get(id) {
      if (mode === 'cloud') {
        const { data, error } = await sb.from('applications').select('*').eq('id', id).maybeSingle();
        if (!error) return data ? fromRow(data) : null;
        goLocal(error);
      }
      return readLocal().find(a => a.id === id) || null;
    }

    async function create(input) {
      const now = new Date().toISOString();
      const app = normalize({
        ...input,
        position: input.position ?? Date.now(),
        activity: [{ at: now, type: 'created', status: input.status || 'saved' }, ...(input.activity || [])]
      });
      if (mode === 'cloud') {
        const { data, error } = await sb.from('applications')
          .insert({ ...toRow(app), user_id: session.user.id }).select('*').single();
        if (!error) return fromRow(data);
        goLocal(error);
      }
      const local = { ...app, id: uuid(), createdAt: now, updatedAt: now };
      writeLocal([...readLocal(), local]);
      return local;
    }

    async function update(id, patch) {
      if (mode === 'cloud') {
        const { data, error } = await sb.from('applications').update(toRow(patch)).eq('id', id).select('*').single();
        if (!error) return fromRow(data);
        goLocal(error);
      }
      const all = readLocal();
      const i = all.findIndex(a => a.id === id);
      if (i === -1) return null;
      all[i] = normalize({ ...all[i], ...patch, updatedAt: new Date().toISOString() });
      writeLocal(all);
      return all[i];
    }

    async function remove(id) {
      if (mode === 'cloud') {
        const { error } = await sb.from('applications').delete().eq('id', id);
        if (!error) return;
        goLocal(error);
      }
      writeLocal(readLocal().filter(a => a.id !== id));
    }

    // Move an application to a new stage and log it in its activity timeline.
    async function moveTo(app, status, position) {
      if (app.status === status && position === undefined) return app;
      const activity = app.status === status ? app.activity
        : [...(app.activity || []), { at: new Date().toISOString(), type: 'stage', from: app.status, to: status }];
      return update(app.id, { status, position: position ?? Date.now(), activity });
    }

    // Applications saved anonymously on this device, offered for import after login.
    const localCount = () => (session ? readLocal().length : 0);
    async function importLocal() {
      if (mode !== 'cloud') return 0;
      const items = readLocal();
      let n = 0;
      for (const { id, createdAt, updatedAt, ...rest } of items) {
        const { error } = await sb.from('applications').insert({ ...toRow(rest), user_id: session.user.id });
        if (error) { goLocal(error); break; }
        n++;
      }
      writeLocal(items.slice(n)); // keep only what failed to import
      return n;
    }

    return {
      list, get, create, update, remove, moveTo, localCount, importLocal,
      get mode() { return mode; },
      get fallbackReason() { return fallbackReason; }
    };
  }

  // Auth headers for /api/* helpers: Supabase session if logged in, else the anonymous device id.
  function apiHeaders(session) {
    const h = { 'Content-Type': 'application/json' };
    if (session) { h.Authorization = `Bearer ${session.access_token}`; return h; }
    let id = null;
    try { id = localStorage.getItem('rm_anon_id'); if (!id) { id = crypto.randomUUID(); localStorage.setItem('rm_anon_id', id); } } catch { id = 'no-storage'; }
    h['X-Anon-Id'] = id;
    return h;
  }

  // POST JSON to an API route and return the parsed body, throwing a readable error.
  async function callApi(path, body, session) {
    const res = await fetch(path, { method: 'POST', headers: apiHeaders(session), body: JSON.stringify(body) });
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON error page */ }
    if (!res.ok) throw new Error(data.error || (res.status >= 500 ? `The server crashed (${res.status}). If you're running locally, check the vercel dev terminal for the error.` : `Request failed (${res.status})`));
    return data;
  }

  window.Pipeline = {
    findMatch, createStore, STATUSES, STATUS_LABELS, apiHeaders, callApi };
})();
