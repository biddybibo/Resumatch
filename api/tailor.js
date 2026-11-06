import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

function repairJSON(str) {
  // Pass 1: escape literal control characters inside strings
  // (AI often writes literal \n instead of \\n inside JSON string values)
  let fixed = '';
  let inString = false, escape = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (escape) { escape = false; fixed += ch; continue; }
    if (ch === '\\' && inString) { escape = true; fixed += ch; continue; }
    if (ch === '"') { inString = !inString; fixed += ch; continue; }
    if (inString && ch === '\n') { fixed += '\\n'; continue; }
    if (inString && ch === '\r') { fixed += '\\r'; continue; }
    if (inString && ch === '\t') { fixed += '\\t'; continue; }
    fixed += ch;
  }

  // Pass 2: close any unclosed strings and brackets
  let result = fixed.trimEnd().replace(/,\s*$/, '');
  const opens = [];
  inString = false; escape = false;
  for (const ch of result) {
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') opens.push(ch === '{' ? '}' : ']');
    if ((ch === '}' || ch === ']') && opens.length) opens.pop();
  }
  if (inString) result += '"';
  while (opens.length) result += opens.pop();
  return result;
}

async function withRetry(fn, retries = 3) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); } catch (err) {
      if (err?.status !== 429 || attempt >= retries) throw err;
      await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1500));
    }
  }
}

async function askJSON(prompt, maxTokens) {
  const msg = await withRetry(() => anthropic.messages.create({
    model: 'claude-sonnet-4-6', max_tokens: maxTokens, temperature: 0,
    messages: [{ role: 'user', content: prompt }]
  }));
  const text = msg.content.map(b => b.text || '').join('');
  return JSON.parse(repairJSON(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)));
}

// ── Scores ──────────────────────────────────────────────────────────────────
// Two numbers, both computed in code from cached inputs so they are reproducible:
//
//   FIT SCORE (headline): does the candidate's actual experience match the job?
//     The model rates each requirement strong / partial / none for the ORIGINAL resume and must
//     quote the resume as evidence. Quotes are checked against the resume text; a quote that
//     isn't there downgrades the rating. Score = weighted credit (strong 1, partial 0.5).
//     Judgments are cached per resume+job, so the same inputs always give the same score.
//     Tailoring can't change fit (it can't add experience), so there is one fit score.
//
//   ATS KEYWORDS (before -> after): share of the job's requirements the resume names literally
//     (skill or alias). This is what tailoring improves.
//
// Requirements are extracted once per job description and cached (client, then Supabase).
// Weights: required = 2, preferred = 1.

// Must match the client's hashing in app.html (normalize -> SHA-256 hex).
export const normalizeJD = (jd) => String(jd || '').replace(/\s+/g, ' ').trim().toLowerCase();
export const hashJD = (jd) => createHash('sha256').update(normalizeJD(jd)).digest('hex');
// Key for cached fit judgments. Must match fitKey() in app.html.
export const fitKeyFor = (resume, jd) => createHash('sha256').update(normalizeJD(resume) + '\n--\n' + normalizeJD(jd)).digest('hex');

function cleanRequirements(list) {
  if (!Array.isArray(list)) return null;
  const out = list.slice(0, 12).map(r => ({
    skill: String(r?.skill || '').trim().slice(0, 80),
    aliases: (Array.isArray(r?.aliases) ? r.aliases : []).map(a => String(a || '').trim().slice(0, 60)).filter(Boolean).slice(0, 6),
    importance: r?.importance === 'preferred' ? 'preferred' : 'required'
  })).filter(r => r.skill);
  return out.length >= 3 ? out : null;
}

async function getRequirements(jobDescription, provided) {
  const hash = hashJD(jobDescription);
  const fromClient = cleanRequirements(provided);
  if (fromClient) return { hash, requirements: fromClient, source: 'client' };

  const key = `req-${hash}`.slice(0, 80);
  try {
    const { data } = await supabase.from('resume_cache').select('search_results').eq('job_title_hash', key).maybeSingle();
    const raw = data?.search_results;  // jsonb column; older rows may hold a JSON string
    const cached = raw && cleanRequirements(typeof raw === 'string' ? JSON.parse(raw) : raw);
    if (cached) return { hash, requirements: cached, source: 'cache' };
  } catch { /* cache unavailable: extract below */ }

  const out = await askJSON(`From this job description, list the 8-12 most important requirements a recruiter or ATS would screen for: concrete skills, tools, domains and responsibilities. Phrase each the way the posting does. Most important first.

JOB DESCRIPTION:
${jobDescription}

Return JSON only:
{"requirements": [{"skill": "<short, e.g. \\"React\\", \\"REST APIs\\", \\"stakeholder communication\\">", "aliases": [<2-4 alternate spellings or close synonyms an ATS would also accept>], "importance": "required" | "preferred"}]}`, 900);
  const requirements = cleanRequirements(out.requirements);
  if (!requirements) throw new Error('No requirements extracted');
  supabase.from('resume_cache')
    .upsert({ job_title_hash: key, search_results: requirements, created_at: new Date().toISOString() }, { onConflict: 'job_title_hash' })
    .then(() => {}, () => {});
  return { hash, requirements, source: 'extracted' };
}

const LEVELS = ['strong', 'partial', 'none'];

// Validate/trim judgments (from the model or from a client cache).
export function cleanNotes(raw, count) {
  if (!raw || !Array.isArray(raw.items)) return null;
  const items = raw.items.slice(0, 15).map(it => ({
    i: Number(it?.i),
    level: LEVELS.includes(it?.level) ? it.level : 'none',
    evidence: String(it?.evidence || '').slice(0, 300),
    suggestion: String(it?.suggestion || '').slice(0, 300)
  })).filter(it => Number.isInteger(it.i) && it.i >= 0 && it.i < count);
  if (!items.length) return null;
  return {
    company: String(raw.company || '').slice(0, 120),
    role: String(raw.role || '').slice(0, 160),
    summary: String(raw.summary || '').slice(0, 400),
    items
  };
}

// Per-requirement fit judgments for the ORIGINAL resume, with quoted evidence.
async function judgeFit(resume, jobDescription, requirements) {
  const out = await askJSON(`You are a strict, fair recruiter screening a resume for one job. For each requirement, judge whether the candidate's ACTUAL experience covers it, regardless of the exact words used.

Levels:
- "strong": the resume clearly shows doing this, by name or through clearly equivalent work.
- "partial": related or transferable experience, or lighter exposure (coursework, a small project, adjacent tool).
- "none": nothing in the resume supports it.

Rules:
- Judge experience, not keywords. "Worked with sales and ops leads to scope features" is evidence for "stakeholder management".
- For strong or partial you MUST give "evidence": a short excerpt copied word for word from the resume. If you can't quote it, the level is "none".
- Do not give credit for things the resume doesn't show. Do not penalize different wording.

ORIGINAL RESUME:
${resume}

JOB DESCRIPTION:
${jobDescription}

REQUIREMENTS (by index):
${requirements.map((r, i) => `${i}. ${r.skill} (${r.importance})`).join('\n')}

Return JSON only:
{
  "company": "<hiring company name, or empty string>",
  "role": "<job title, short>",
  "summary": "<one sentence: the single biggest real gap between this candidate and the role>",
  "items": [
    {
      "i": <requirement index>,
      "level": "strong" | "partial" | "none",
      "evidence": "<verbatim resume excerpt, or empty string>",
      "suggestion": "<for strong or partial: one resume bullet (action verb, no pronouns, under 25 words) that states this experience in the posting's terms, using ONLY what the resume shows. For none: empty string; never invent experience>"
    }
  ]
}
Include exactly one item per requirement.`, 2200);
  return cleanNotes(out, requirements.length);
}

// Resume words, for checking that quoted evidence really comes from the resume.
const wordsOf = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9+#%$.]+/g, ' ').split(' ').filter(w => w.length > 2);
// Share of the quote's words that appear in the resume (1 = fully grounded).
function evidenceMatch(evidence, resumeWords) {
  const ws = wordsOf(evidence);
  if (!ws.length) return 0;
  return ws.filter(w => resumeWords.has(w)).length / ws.length;
}

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Deterministic keyword check: does the text literally contain the skill or one of its aliases?
function mentions(text, terms) {
  const hay = text.toLowerCase();
  return terms.some(t => {
    const term = String(t || '').trim().toLowerCase();
    if (term.length < 2) return false;
    return new RegExp(`(?<![a-z0-9])${escapeRegExp(term)}(?![a-z0-9])`).test(hay);
  });
}

const WEIGHT = { required: 2, preferred: 1 };
export function scoreResume(text, requirements) {
  const total = requirements.reduce((n, r) => n + WEIGHT[r.importance], 0);
  if (!total) return null;
  const got = requirements.reduce((n, r) => n + (mentions(text, [r.skill, ...r.aliases]) ? WEIGHT[r.importance] : 0), 0);
  return Math.round(100 * got / total);
}

const CREDIT = { strong: 1, partial: 0.5, none: 0 };
const DOWNGRADE = { strong: 'partial', partial: 'none', none: 'none' };

export function buildGapAnalysis(requirements, notes, originalResume, tailoredResume) {
  if (!requirements) return null;
  const byIndex = new Map((notes?.items || []).map(it => [it.i, it]));
  const resumeWords = new Set(wordsOf(originalResume));
  const rows = requirements.map((r, i) => {
    const n = byIndex.get(i) || { level: 'none', evidence: '', suggestion: '' };
    let level = n.level;
    // Grounding check: a strong/partial rating needs a quote that is actually in the resume.
    // Mostly there (light paraphrase) -> one level down; mostly invented -> no credit.
    const match = level === 'none' ? 1 : evidenceMatch(n.evidence, resumeWords);
    const grounded = match >= 0.8;
    if (!grounded) level = match >= 0.5 ? DOWNGRADE[level] : 'none';
    const terms = [r.skill, ...r.aliases];
    return {
      skill: r.skill,
      importance: r.importance,
      level,
      ungrounded: !grounded,
      supported: level !== 'none',
      evidence: level === 'none' ? '' : n.evidence,
      suggestion: level === 'none' ? '' : n.suggestion,
      inOriginal: mentions(originalResume, terms),
      inTailored: mentions(tailoredResume, terms)
    };
  });
  const total = rows.reduce((t, r) => t + WEIGHT[r.importance], 0);
  const fitScore = notes && total ? Math.round(100 * rows.reduce((t, r) => t + WEIGHT[r.importance] * CREDIT[r.level], 0) / total) : null;
  return {
    company: notes?.company || '',
    role: notes?.role || '',
    summary: notes?.summary || '',
    fitScore,
    keywordBefore: scoreResume(originalResume, requirements),
    keywordAfter: scoreResume(tailoredResume, requirements),
    requirements: rows,
    coverageBefore: rows.filter(r => r.inOriginal).length,
    coverageAfter: rows.filter(r => r.inTailored).length,
    total: rows.length
  };
}

async function searchReferenceResumes(jobDescription) {
  if (!process.env.SERPER_API_KEY) return '';

  // Extract first line as likely job title
  const jobTitle = jobDescription.split('\n').find(l => l.trim())?.trim().slice(0, 100) || '';
  const query = `${jobTitle} resume example successfully hired`;

  // Check cache first
  const cacheKey = jobTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 80);
  const { data: cached } = await supabase
    .from('resume_cache')
    .select('search_results, created_at')
    .eq('job_title_hash', cacheKey)
    .single();

  // Use cache if less than 24 hours old
  if (cached && (Date.now() - new Date(cached.created_at).getTime()) < 86400000) {
    return cached.search_results;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const response = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: 3 }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    const data = await response.json();

    const snippets = (data.organic || [])
      .slice(0, 3)
      .map(r => `[${r.title}]: ${r.snippet}`)
      .join('\n\n');

    // Cache the results
    await supabase
      .from('resume_cache')
      .upsert({ job_title_hash: cacheKey, search_results: snippets, created_at: new Date().toISOString() }, { onConflict: 'job_title_hash' });

    return snippets;
  } catch {
    return '';
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Determine auth mode: Bearer token (logged in) or X-Anon-Id (anonymous)
  const token = req.headers.authorization?.replace('Bearer ', '');
  const anonId = req.headers['x-anon-id'];

  let user = null;
  let profile = null;
  let anonUseCount = 0;

  if (token) {
    const { data: { user: authUser }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !authUser) return res.status(401).json({ error: 'Invalid session' });
    user = authUser;

    const { data: p } = await supabase
      .from('profiles')
      .select('subscription_status, tailor_count')
      .eq('id', user.id)
      .single();

    if (!p) return res.status(400).json({ error: 'Profile not found' });
    profile = p;

    if (profile.subscription_status !== 'active' && profile.tailor_count >= 3) {
      return res.status(403).json({ error: 'FREE_LIMIT_REACHED' });
    }
  } else if (anonId && typeof anonId === 'string' && anonId.length <= 100) {
    const { data: anonRecord } = await supabase
      .from('anonymous_usage')
      .select('use_count')
      .eq('anon_id', anonId)
      .single();

    anonUseCount = anonRecord?.use_count || 0;
    if (anonUseCount >= 3) return res.status(403).json({ error: 'FREE_LIMIT_REACHED' });
  } else {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { resume, jobDescription, requirements: cachedRequirements, fitCache } = req.body;
  if (!resume || !jobDescription) return res.status(400).json({ error: 'Missing resume or job description' });

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable Nginx/Vercel proxy buffering
  res.flushHeaders(); // Send headers immediately so the stream is established

  try {
    // In parallel with tailoring: get the job's requirements (cached per job post),
    // then the resume-specific gap notes. Neither failure blocks the tailored resume.
    const reqPromise = getRequirements(jobDescription, cachedRequirements)
      .catch(err => { console.error('getRequirements failed:', err?.message); return null; });
    const fitKey = fitKeyFor(resume, jobDescription);
    const notesPromise = reqPromise.then(r => {
      if (!r) return null;
      // Reuse cached judgments for this exact resume + job (keeps the fit score stable).
      const cached = fitCache?.key === fitKey && fitCache?.jdHash === r.hash ? cleanNotes(fitCache.notes, r.requirements.length) : null;
      return cached || judgeFit(resume, jobDescription, r.requirements);
    })
      .catch(err => { console.error('judgeFit failed:', err?.message); return null; });

    // Search for reference resumes
    const referenceResumes = await searchReferenceResumes(jobDescription);

    const referenceContext = referenceResumes
      ? `\n\nEXAMPLE RESUME SNIPPETS FOUND ONLINE FOR SIMILAR ROLES (unverified, not known to have led to a hire):\n${referenceResumes}\n\nUse these only as loose inspiration for tone, structure and keyword usage. Do NOT copy them, and never add experience the candidate doesn't have.`
      : '';

    let fullText = '';

    const streamParams = {
      model: 'claude-sonnet-4-6',
      max_tokens: 2800,
      temperature: 0,
      messages: [{
        role: 'user',
        content: `You are an expert resume optimizer specializing in ATS optimization and professional resume writing standards.

CRITICAL RULES:
1. NO PERSONAL PRONOUNS: Never use "I", "me", "my", "we", "you" anywhere in the resume.
2. ACTION VERBS: Begin every bullet point with a strong action verb. Never repeat the same action verb across bullets in the same position. Use past tense for previous roles, present tense for current roles.
3. QUANTIFY ACHIEVEMENTS: Replace vague statements with specific numbers, percentages, timeframes, or measurable outcomes. If metrics are missing, add realistic placeholders in [brackets] for the candidate to fill in.
4. NO GENERIC DUTIES: Never write "responsible for", "duties included", or list tasks without showing impact or result. Every bullet must demonstrate a skill, achievement, or outcome.
5. NO AI JARGON: Never use "spearheaded", "leveraged", "synergized", "orchestrated", "championed", "pioneered", "utilized", or similar corporate buzzwords. Write like a real person.
6. KEYWORD MATCHING: Naturally incorporate keywords from the job description where they genuinely fit the candidate's experience.
7. MAINTAIN HONESTY: Only work with what is already in the resume. Never fabricate experience, skills, or accomplishments.
8. PROPER GRAMMAR: Correct all spelling, punctuation, and grammar errors. Ensure consistent formatting throughout.
9. NO SEPARATOR LINES: Do NOT include any lines made of repeated symbols like %%%%%, -----, =====, ****. Only section header text, no decorative separators.
10. DEGREE TITLE: Write out the full official degree title (e.g. "Bachelor of Arts in Economics" not "BA Economics").
11. FILL THE PAGE: The resume must fill a full page with minimal bottom whitespace. Achieve this by:
    a) Writing 3-4 bullet points per experience/leadership position (not 2). Expand from context where needed.
    b) Writing 2-3 bullet points per academic project.
    c) If space still remains, add a third sentence to the Professional Summary.
    Never leave large blank space at the bottom of the resume.
12. PROFESSIONAL SUMMARY: Always include a PROFESSIONAL SUMMARY section immediately after the header (before EDUCATION). Write 2-3 concise sentences (no pronouns) that highlight the candidate's top skills, years of experience, and alignment with the job. Tailor it to the job description keywords.
13. RESUME FORMAT — follow this exact structure for every experience entry:
    Job Title (mixed case)                    Month Year – Month Year
    Company Name, City, State
    • Bullet starting with action verb
    • Bullet starting with action verb
    Do NOT use ALL CAPS for company names. Use • for bullets only (not dashes).
14. SECTION HEADERS must be ALL CAPS (e.g. PROFESSIONAL SUMMARY, EDUCATION, EXPERIENCE, ACADEMIC PROJECTS).
15. Each bullet must be 1-2 lines maximum.

ORIGINAL RESUME:
${resume}

JOB DESCRIPTION:
${jobDescription}${referenceContext}

Provide your response in TWO clearly separated parts:

PART 1 — Tailored resume as plain text (no JSON, no code block, no separator lines):
RESUME_START
<full optimized resume text here>
RESUME_END

PART 2 — JSON only (no resume text here):
\`\`\`json
{
  "strengths": [<3-5 short strings>],
  "missingKeywords": [<3-5 short strings>],
  "changes": [<6-8 changes, each: {"original":"<short excerpt copied verbatim from the original resume, or empty if newly added>","replacement":"<short excerpt copied verbatim from the tailored resume>","reason":"<one sentence>"}>]
}
\`\`\``
      }],
    };

    const MAX_RETRIES = 3;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        fullText = '';
        const stream = anthropic.messages.stream(streamParams);
        for await (const chunk of stream) {
          if (chunk.type === 'content_block_delta' && chunk.delta?.text) {
            fullText += chunk.delta.text;
            res.write(`data: ${JSON.stringify({ partial: true, chars: fullText.length })}\n\n`);
          }
        }
        break; // success — exit retry loop
      } catch (err) {
        if (err?.status === 429 && attempt < MAX_RETRIES) {
          const waitMs = Math.pow(2, attempt) * 1500; // 1.5s, 3s, 6s
          res.write(`data: ${JSON.stringify({ retrying: true, attempt: attempt + 1, maxRetries: MAX_RETRIES, waitMs })}\n\n`);
          await new Promise(r => setTimeout(r, waitMs));
        } else {
          throw err;
        }
      }
    }

    // Parse and send final result
    // Extract resume text first (PART 1 — always present even if truncated)
    const resumeMatch = fullText.match(/RESUME_START\s*([\s\S]*?)\s*RESUME_END/) ||
                        fullText.match(/RESUME_START\s*([\s\S]+)$/);

    if (!resumeMatch) throw new Error('Failed to parse AI response');

    // Extract JSON block (PART 2 — gracefully degrade if truncated)
    const jsonBlockMatch = fullText.match(/```json\s*([\s\S]*?)```/i);
    let result;
    if (jsonBlockMatch) {
      try {
        result = JSON.parse(repairJSON(jsonBlockMatch[1].trim()));
      } catch {
        result = {};
      }
    } else {
      // Try to find any partial JSON object after RESUME_END
      const afterResume = fullText.split('RESUME_END')[1] || '';
      const jsonMatch = afterResume.match(/\{[\s\S]+/);
      if (jsonMatch) {
        try { result = JSON.parse(repairJSON(jsonMatch[0])); } catch { result = {}; }
      } else {
        result = {};
      }
    }

    // Apply defaults if JSON was missing or incomplete
    if (!result.strengths) result.strengths = [];
    if (!result.missingKeywords) result.missingKeywords = [];
    if (!result.changes) result.changes = [];

    result.tailoredResume = resumeMatch[1].trim();

    // Strip any separator lines the AI generated
    result.tailoredResume = result.tailoredResume
      .split('\n')
      .filter(line => line.trim() === '' || /[a-zA-Z0-9]/.test(line))
      .join('\n');

    // Before/after scores: same formula, same cached requirements -> reproducible.
    const reqs = await reqPromise;
    const notes = await notesPromise;
    result.analysis = buildGapAnalysis(reqs?.requirements || null, notes, resume, result.tailoredResume);
    result.fitScore = result.analysis?.fitScore ?? null;
    result.keywordBefore = result.analysis?.keywordBefore ?? null;
    result.keywordAfter = result.analysis?.keywordAfter ?? null;
    result.matchScore = result.fitScore; // headline number used by history and pipeline
    result.jdHash = reqs?.hash || null;
    result.requirementsSpec = reqs?.requirements || null; // client caches per job post
    result.fitKey = fitKey;
    result.notesSpec = notes;                              // client caches per resume + job

    // Increment usage count
    if (user) {
      await supabase
        .from('profiles')
        .update({ tailor_count: profile.tailor_count + 1 })
        .eq('id', user.id);
    } else {
      await supabase
        .from('anonymous_usage')
        .upsert({ anon_id: anonId, use_count: anonUseCount + 1, last_used: new Date().toISOString() });
    }

    res.write(`data: ${JSON.stringify({ done: true, result })}\n\n`);
    res.end();
  } catch (error) {
    const msg = error?.status ? `API error ${error.status}: ${error.message}` : (error.message || 'Unknown error');
    res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
    res.end();
  }
}
