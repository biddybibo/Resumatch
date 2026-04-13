import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

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

  // Verify authentication
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Invalid session' });

  // Check usage
  const { data: profile } = await supabase
    .from('profiles')
    .select('subscription_status, tailor_count')
    .eq('id', user.id)
    .single();

  if (!profile) return res.status(400).json({ error: 'Profile not found' });

  if (profile.subscription_status !== 'active' && profile.tailor_count >= 3) {
    return res.status(403).json({ error: 'FREE_LIMIT_REACHED' });
  }

  const { resume, jobDescription } = req.body;
  if (!resume || !jobDescription) return res.status(400).json({ error: 'Missing resume or job description' });

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable Nginx/Vercel proxy buffering
  res.flushHeaders(); // Send headers immediately so the stream is established

  try {
    // Search for reference resumes
    const referenceResumes = await searchReferenceResumes(jobDescription);

    const referenceContext = referenceResumes
      ? `\n\nREFERENCE RESUMES FROM SUCCESSFUL CANDIDATES IN SIMILAR ROLES:\n${referenceResumes}\n\nUse these as inspiration for tone, structure, and keyword usage — but do NOT copy them directly. Adapt ideas to the candidate's actual experience.`
      : '';

    let fullText = '';

    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
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
11. MINIMUM BULLETS: Each position must have at least 2-3 bullet points. If the original has fewer, expand from context.
12. RESUME FORMAT — follow this exact structure for every experience entry:
    Job Title (mixed case)                    Month Year – Month Year
    Company Name, City, State
    • Bullet starting with action verb
    • Bullet starting with action verb
    Do NOT use ALL CAPS for company names. Use • for bullets only (not dashes).
13. SECTION HEADERS must be ALL CAPS (e.g. EDUCATION, EXPERIENCE, ACADEMIC PROJECTS).
14. Each bullet must be 1-2 lines maximum.

ORIGINAL RESUME:
${resume}

JOB DESCRIPTION:
${jobDescription}${referenceContext}

Provide your response in TWO clearly separated parts:

PART 1 — JSON only (no resume text here):
\`\`\`json
{
  "matchScore": <0-100. Keyword overlap 40% + experience match 35% + skills 25%. Strong tailored resume = 70-85. Below 60 only for major gaps.>,
  "strengths": [<3-5 short strings>],
  "missingKeywords": [<3-5 short strings>],
  "changes": [<6-8 changes, each: {"original":"<brief excerpt>","replacement":"<brief excerpt>","reason":"<one sentence>"}>]
}
\`\`\`

PART 2 — Tailored resume as plain text (no JSON, no code block, no separator lines):
RESUME_START
<full optimized resume text here>
RESUME_END`
      }],
    });

    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta?.text) {
        fullText += chunk.delta.text;
        res.write(`data: ${JSON.stringify({ partial: true, chars: fullText.length })}\n\n`);
      }
    }

    // Parse and send final result
    // Extract JSON block (between ```json and ```)
    const jsonBlockMatch = fullText.match(/```json\s*([\s\S]*?)```/i);
    // Extract resume plain text (between RESUME_START and RESUME_END)
    const resumeMatch = fullText.match(/RESUME_START\s*([\s\S]*?)\s*RESUME_END/);

    if (!jsonBlockMatch && !resumeMatch) throw new Error('Failed to parse AI response');

    let result;
    if (jsonBlockMatch) {
      result = JSON.parse(repairJSON(jsonBlockMatch[1].trim()));
    } else {
      // Fallback: try to find any JSON object
      const fallback = fullText.replace(/```json\s*/gi, '').replace(/```/g, '');
      const jsonMatch = fallback.match(/\{[\s\S]*/);
      if (!jsonMatch) throw new Error('Failed to parse AI response');
      result = JSON.parse(repairJSON(jsonMatch[0]));
    }

    // Extract resume text
    if (resumeMatch) {
      result.tailoredResume = resumeMatch[1].trim();
    } else if (!result.tailoredResume) {
      throw new Error('Failed to extract resume text');
    }

    // Strip any separator lines the AI generated
    result.tailoredResume = result.tailoredResume
      .split('\n')
      .filter(line => line.trim() === '' || /[a-zA-Z0-9]/.test(line))
      .join('\n');

    // Increment usage count
    await supabase
      .from('profiles')
      .update({ tailor_count: profile.tailor_count + 1 })
      .eq('id', user.id);

    res.write(`data: ${JSON.stringify({ done: true, result })}\n\n`);
    res.end();
  } catch (error) {
    const msg = error?.status ? `API error ${error.status}: ${error.message}` : (error.message || 'Unknown error');
    res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
    res.end();
  }
}
