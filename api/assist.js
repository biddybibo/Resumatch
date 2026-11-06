// AI helpers that run after tailoring:
//   action=verify     Truthfulness guard: flag tailored-resume claims the original doesn't back up
//   action=followup   Draft a follow-up / thank-you email for a pipeline card
//   action=interview  Likely interview questions with STAR answer drafts from the user's resume
import { askJSON, authorize, clip } from './_lib/ai.js';

const NO_DASHES = 'Never use em dashes or en dashes; use commas or periods instead.';

// ── Truthfulness guard ─────────────────────────────────────────────────────

// Deterministic check: numbers (metrics, counts, money, percentages) that appear in the
// tailored resume but nowhere in the original. Years and [X] placeholders are ignored.
export function findNewNumbers(original, tailored) {
  const numsIn = (s) => (s.replace(/(\d),(\d{3})/g, '$1$2').match(/\$?\d+(?:\.\d+)?\s*(?:%|\+|k\b|m\b|x\b)?/gi) || []);
  const digits = (t) => t.replace(/[^\d.]/g, '').replace(/\.$/, '');
  const known = new Set(numsIn(original).map(digits));
  const flags = [];
  for (const raw of tailored.split('\n')) {
    const line = raw.trim();
    if (!line || /@|\(\d{3}\)|\d{3}[-.\s]\d{3}[-.\s]\d{4}/.test(line)) continue; // contact lines
    const fresh = [...new Set(numsIn(line).map(t => t.trim()))].filter(t => {
      const d = digits(t);
      return d && !/^(19|20)\d\d$/.test(d) && !known.has(d);
    });
    if (fresh.length) flags.push({ claim: line.replace(/^[•\-*]\s*/, ''), numbers: fresh });
  }
  return flags;
}

async function verify(body) {
  const original = clip(body.original, 12000), tailored = clip(body.tailored, 12000);
  if (!original || !tailored) throw Object.assign(new Error('Missing original or tailored resume'), { status: 400 });

  const ai = await askJSON(`You are a strict resume fact-checker. Compare the TAILORED resume against the ORIGINAL resume, which is the only source of truth about the candidate.

Review every factual claim in the TAILORED resume: employers, titles, dates, degrees, tools and skills, team or user counts, scope, responsibilities, outcomes and metrics.
- Rewording, stronger verbs, reordering and keyword synonyms are fine when the underlying fact is in the original.
- Bracketed placeholders such as [X] or [X]% are fine; the candidate fills those in.
- Flag "unsupported" when the fact is absent from the original (a new tool, employer, responsibility, number or outcome).
- Flag "embellished" when the fact exists but scope, seniority, ownership or impact was inflated (e.g. "helped with" became "led").
Do not flag legitimate rewording. Be precise.

ORIGINAL RESUME:
${original}

TAILORED RESUME:
${tailored}

Return JSON only:
{
  "checked": <integer: how many factual claims you reviewed>,
  "flags": [
    {
      "claim": "<verbatim excerpt from the tailored resume, under 20 words>",
      "verdict": "unsupported" | "embellished",
      "issue": "<one sentence on what is not backed up>",
      "evidence": "<closest verbatim excerpt from the original, or empty string>",
      "fix": "<an honest rewrite of that excerpt using only the original's facts, or empty string>"
    }
  ]
}`, { maxTokens: 2000 });

  const flags = (Array.isArray(ai.flags) ? ai.flags : [])
    .filter(f => f && f.claim)
    .map(f => ({
      claim: String(f.claim), verdict: f.verdict === 'embellished' ? 'embellished' : 'unsupported',
      issue: String(f.issue || ''), evidence: String(f.evidence || ''), fix: String(f.fix || ''), source: 'ai'
    }));

  // Add number flags the AI didn't already cover.
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  for (const n of findNewNumbers(original, tailored)) {
    const covered = flags.some(f => norm(n.claim).includes(norm(f.claim)) || norm(f.claim).includes(norm(n.claim)));
    if (!covered) flags.push({
      claim: n.claim, verdict: 'unsupported', source: 'numbers', evidence: '', fix: '',
      issue: `${n.numbers.map(x => `"${x}"`).join(', ')} ${n.numbers.length > 1 ? "don't" : "doesn't"} appear anywhere in your original resume. Replace with [X] or confirm it's accurate.`
    });
  }
  return { checked: Number.isFinite(+ai.checked) ? Math.round(+ai.checked) : null, flags, checkedAt: new Date().toISOString() };
}

// ── Follow-up email ────────────────────────────────────────────────────────

const FOLLOWUP_KINDS = {
  no_reply: 'A polite follow-up after applying and hearing nothing back. Restate interest in one line, add one concrete, relevant proof point from the resume, and make a low-effort ask (a quick call or an update on timeline).',
  thank_you: 'A thank-you note sent within a day of an interview. Thank them, reference something specific from the conversation if the notes mention it (otherwise leave a [specific topic you discussed] placeholder), and reinforce fit in one sentence.',
  post_interview: 'A check-in a week or more after an interview with no decision yet. Brief, warm, asks about timeline, offers anything else they need.',
  offer: 'A reply about an offer: thank them, confirm enthusiasm, and ask any clarifying question on timeline or details. Do not accept or negotiate specific numbers.'
};

async function followup(body) {
  const kind = FOLLOWUP_KINDS[body.kind] ? body.kind : 'no_reply';
  const out = await askJSON(`Write a short follow-up email from a job candidate.

PURPOSE: ${FOLLOWUP_KINDS[kind]}

COMPANY: ${clip(body.company, 120) || '[Company]'}
ROLE: ${clip(body.role, 160) || '[Role]'}
DAYS SINCE LAST CONTACT: ${Number.isFinite(+body.daysSince) ? Math.round(+body.daysSince) : 'unknown'}
CANDIDATE NOTES (may name the recruiter or interviewer): ${clip(body.notes, 1500) || 'none'}

CANDIDATE RESUME:
${clip(body.resume, 6000) || 'not provided'}

JOB DESCRIPTION:
${clip(body.jobDescription, 4000) || 'not provided'}

Rules:
- Under 120 words in the body. Plain text, no markdown.
- Sound like a real person; no cliches like "I hope this email finds you well" or "I wanted to reach out".
- Use a recipient name from the notes if one is given, otherwise "Hi [Name],".
- Only reference experience that is in the resume. Never invent facts.
- ${NO_DASHES}
- Sign off with "Best," then "[Your Name]" on the next line.

Return JSON only: {"subject": "<under 70 characters>", "body": "<full email body with \\n line breaks>"}`, { maxTokens: 700, temperature: 0.4 });
  return { kind, subject: String(out.subject || ''), body: String(out.body || '').replace(/\s*[–—]\s*/g, ', '), generatedAt: new Date().toISOString() };
}

// ── Interview prep ─────────────────────────────────────────────────────────

async function interview(body) {
  const resume = clip(body.resume, 10000), jd = clip(body.jobDescription, 8000);
  if (!resume || !jd) throw Object.assign(new Error('Interview prep needs both a resume and a job description'), { status: 400 });
  const out = await askJSON(`You are an interview coach preparing a candidate for a specific role.

COMPANY: ${clip(body.company, 120) || 'unknown'}
ROLE: ${clip(body.role, 160) || 'unknown'}

CANDIDATE RESUME (the only source of facts about the candidate):
${resume}

JOB DESCRIPTION:
${jd}

Predict the 6 questions this candidate is most likely to be asked for THIS role: at least 2 behavioral, at least 2 technical or role-specific, and 1 about the company or motivation. Base them on the job description's actual requirements and on whatever in this resume an interviewer would probe.

For each, draft a STAR answer using ONLY experience from the resume. Write the STAR parts in first person, conversational, 1 to 3 sentences each. Where a detail is unknown (a number, a name), use a [bracketed placeholder]. If the resume has no relevant experience for a question, say so in "tip" and suggest an honest angle instead of inventing one.

Then suggest 3 sharp questions the candidate could ask the interviewer about this role.

${NO_DASHES}

Return JSON only:
{
  "questions": [
    {
      "q": "<the question>",
      "type": "behavioral" | "technical" | "role" | "company",
      "why": "<one sentence: which job requirement or resume item this probes>",
      "star": {"situation": "...", "task": "...", "action": "...", "result": "..."},
      "tip": "<one sentence of delivery advice or an honest caveat>"
    }
  ],
  "askThem": ["<question>", "<question>", "<question>"]
}`, { maxTokens: 3200, temperature: 0.2 });
  const dash = (s) => String(s || '').replace(/\s*[–—]\s*/g, ', ');
  return {
    questions: (Array.isArray(out.questions) ? out.questions : []).filter(q => q && q.q).map(q => ({
      q: dash(q.q), type: ['behavioral', 'technical', 'role', 'company'].includes(q.type) ? q.type : 'role', why: dash(q.why),
      star: { situation: dash(q.star?.situation), task: dash(q.star?.task), action: dash(q.star?.action), result: dash(q.star?.result) },
      tip: dash(q.tip)
    })),
    askThem: (Array.isArray(out.askThem) ? out.askThem : []).map(dash).filter(Boolean).slice(0, 5),
    generatedAt: new Date().toISOString()
  };
}

const ACTIONS = { verify, followup, interview };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const fn = ACTIONS[req.body?.action];
  if (!fn) return res.status(400).json({ error: 'Unknown action' });
  try {
    const auth = await authorize(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    return res.status(200).json(await fn(req.body));
  } catch (err) {
    console.error(`assist/${req.body.action} failed:`, err);
    if (/is not set/.test(err?.message || '')) return res.status(500).json({ error: `Server misconfigured: ${err.message}` });
    const status = err?.status === 400 ? 400 : err?.status === 429 ? 429 : 500;
    return res.status(status).json({ error: status === 429 ? 'High demand right now. Please try again in a moment.' : (status === 400 ? err.message : 'Something went wrong. Please try again.') });
  }
}
