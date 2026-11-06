// Outcome dataset API (see supabase/migrations/20261105000000_outcome_samples.sql).
//   action=consent      {share: bool}            logged-in: opt in/out of contributing
//   action=status                                  logged-in: consent flag + how many samples you contributed
//   action=contribute   {application}             logged-in + opted in: upsert one anonymized outcome
//   action=delete_mine                             logged-in: delete everything you contributed
//   action=insights                                anyone: interview rate by Fit score range
import { createHmac, createHash } from 'node:crypto';
import { authorize, getSupabase } from './_lib/ai.js';

const MIN_TOTAL = 30;     // samples needed before any community insight is shown
const MIN_BUCKET = 10;    // samples needed before a bucket's rate is shown
const BUCKETS = [[0, 39], [40, 59], [60, 79], [80, 100]];

const secret = () => process.env.OUTCOME_SALT || process.env.SUPABASE_SERVICE_KEY || '';
const hmac = (kind, id) => createHmac('sha256', secret()).update(`${kind}:${id}`).digest('hex');
const normalizeJD = (jd) => String(jd || '').replace(/\s+/g, ' ').trim().toLowerCase();
const clampScore = (n) => (Number.isFinite(+n) ? Math.max(0, Math.min(100, Math.round(+n))) : null);

// What the resume achieved. An interview counts even if the application later closed:
// the resume did its job. Withdrawn or still-pending applications aren't outcomes.
export function outcomeOf(app) {
  const stages = new Set([app.status, ...(app.activity || []).map(e => e?.to)]);
  if (stages.has('interviewing') || stages.has('offer')) return 'interview';
  if (app.status === 'closed' && app.closeReason === 'rejected') return 'rejected';
  if (app.status === 'closed' && app.closeReason === 'no_response') return 'no_response';
  return null;
}

// Remove contact details before anything leaves the user's own account.
export function redact(text) {
  let t = String(text || '');
  t = t.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[EMAIL]');
  t = t.replace(/\b(?:https?:\/\/)?(?:www\.)?(?:linkedin\.com|github\.com|gitlab\.com)\/[^\s|,)]+/gi, '[PROFILE]');
  t = t.replace(/\bhttps?:\/\/[^\s|,)]+/gi, '[URL]');
  // Phone numbers: (213) 555-0199, 213-555-0199, +1 213.555.0199, +44 20 7946 0958. Not date ranges.
  t = t.replace(/(?<![\d-])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)\s?|\d{2,4}[\s.-])\d{3,4}[\s.-]\d{4}(?![\d-])/g, m => {
    const digits = m.replace(/\D/g, '');
    return digits.length >= 10 && !/^(19|20)\d\d\s*[-–]\s*(19|20)\d\d$/.test(m.trim()) ? '[PHONE]' : m;
  });
  t = t.replace(/\b\d{1,5}\s+(?:[A-Z][a-z]+\s){1,3}(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Ct|Court|Pl|Place)\b\.?(?:,?\s*(?:Apt|Unit|#)\s*\w+)?/g, '[ADDRESS]');
  // The first line of a resume is almost always the candidate's name.
  const lines = t.split('\n');
  const i = lines.findIndex(l => l.trim());
  if (i !== -1) {
    const first = lines[i].trim();
    if (first.split(/\s+/).length <= 5 && !/\d/.test(first)) lines[i] = '[NAME]';
  }
  return lines.join('\n');
}

function sampleFrom(app, outcome) {
  const reqs = Array.isArray(app.analysis?.requirements) ? app.analysis.requirements : [];
  const stamps = (app.activity || []);
  const appliedAt = stamps.find(e => e?.to === 'applied')?.at || app.createdAt;
  const outcomeAt = [...stamps].reverse().find(e => ['interviewing', 'offer', 'closed'].includes(e?.to))?.at;
  const days = appliedAt && outcomeAt ? Math.max(0, Math.round((new Date(outcomeAt) - new Date(appliedAt)) / 86400000)) : null;
  const tailored = !!app.tailoredResume;
  return {
    outcome,
    reached_offer: app.status === 'offer' || stamps.some(e => e?.to === 'offer'),
    fit_score: clampScore(app.fitScore),
    keyword_score: clampScore(tailored ? app.matchScoreAfter : app.matchScoreBefore),
    role: String(app.role || '').slice(0, 160),
    company: String(app.company || '').slice(0, 120),
    jd_hash: app.jobDescription ? createHash('sha256').update(normalizeJD(app.jobDescription)).digest('hex') : null,
    job_description: String(app.jobDescription || '').slice(0, 15000),
    requirements: reqs.slice(0, 15).map(r => ({
      skill: String(r.skill || '').slice(0, 80),
      importance: r.importance === 'preferred' ? 'preferred' : 'required',
      level: ['strong', 'partial', 'none'].includes(r.level) ? r.level : null
    })),
    resume_version: tailored ? 'tailored' : (app.originalResume ? 'original' : null),
    resume_redacted: redact(tailored ? app.tailoredResume : app.originalResume).slice(0, 20000),
    days_to_outcome: Number.isFinite(days) ? days : null,
    source: 'self_report',
    updated_at: new Date().toISOString()
  };
}

let insightsCache = { at: 0, data: null };
async function insights(db) {
  if (Date.now() - insightsCache.at < 10 * 60 * 1000 && insightsCache.data) return insightsCache.data;
  const { data, error } = await db.from('outcome_samples').select('fit_score, outcome').limit(20000);
  if (error) throw error;
  const rows = data || [];
  const withFit = rows.filter(r => Number.isFinite(r.fit_score));
  const buckets = BUCKETS.map(([lo, hi]) => {
    const inB = withFit.filter(r => r.fit_score >= lo && r.fit_score <= hi);
    const interviews = inB.filter(r => r.outcome === 'interview').length;
    return { range: [lo, hi], n: inB.length, interviewRate: inB.length >= MIN_BUCKET ? Math.round(100 * interviews / inB.length) : null };
  });
  const result = {
    total: rows.length,
    unlocked: rows.length >= MIN_TOTAL,
    minTotal: MIN_TOTAL,
    minBucket: MIN_BUCKET,
    overallInterviewRate: rows.length >= MIN_TOTAL ? Math.round(100 * rows.filter(r => r.outcome === 'interview').length / rows.length) : null,
    buckets
  };
  insightsCache = { at: Date.now(), data: result };
  return result;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const action = req.body?.action;
  try {
    const db = getSupabase();
    if (action === 'insights') return res.status(200).json(await insights(db));

    const auth = await authorize(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    if (!auth.userId) return res.status(401).json({ error: 'Log in to share outcomes.' });
    if (!secret()) return res.status(500).json({ error: 'Server misconfigured: OUTCOME_SALT is not set' });
    const contributor = hmac('user', auth.userId);

    if (action === 'status') {
      const { data: p } = await db.from('profiles').select('share_outcomes').eq('id', auth.userId).maybeSingle();
      const { count } = await db.from('outcome_samples').select('id', { count: 'exact', head: true }).eq('contributor', contributor);
      return res.status(200).json({ share: !!p?.share_outcomes, contributed: count || 0 });
    }

    if (action === 'consent') {
      const share = !!req.body.share;
      const { error } = await db.from('profiles').update({ share_outcomes: share }).eq('id', auth.userId);
      if (error) throw error;
      return res.status(200).json({ share });
    }

    if (action === 'delete_mine') {
      const { error, count } = await db.from('outcome_samples').delete({ count: 'exact' }).eq('contributor', contributor);
      if (error) throw error;
      return res.status(200).json({ deleted: count || 0 });
    }

    if (action === 'contribute') {
      const app = req.body.application;
      if (!app || typeof app.id !== 'string') return res.status(400).json({ error: 'Missing application' });
      const { data: p } = await db.from('profiles').select('share_outcomes').eq('id', auth.userId).maybeSingle();
      if (!p?.share_outcomes) return res.status(403).json({ error: 'Outcome sharing is off.' });
      const sample_key = hmac('app', `${auth.userId}:${app.id}`);
      const outcome = outcomeOf(app);
      if (!outcome) {
        // Withdrawn, reopened or still pending: make sure no stale sample remains.
        await db.from('outcome_samples').delete().eq('sample_key', sample_key);
        return res.status(200).json({ stored: false });
      }
      const { error } = await db.from('outcome_samples')
        .upsert({ sample_key, contributor, ...sampleFrom(app, outcome) }, { onConflict: 'sample_key' });
      if (error) throw error;
      insightsCache.at = 0;
      return res.status(200).json({ stored: true, outcome });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error(`outcomes/${action} failed:`, err);
    if (/is not set/.test(err?.message || '')) return res.status(500).json({ error: `Server misconfigured: ${err.message}` });
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
