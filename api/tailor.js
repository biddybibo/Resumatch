import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

function repairJSON(str) {
  let result = str;
  const opens = [];
  let inString = false, escape = false;
  for (const ch of result) {
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') opens.push(ch === '{' ? '}' : ']');
    if (ch === '}' || ch === ']') opens.pop();
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
      max_tokens: 3000,
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

ORIGINAL RESUME:
${resume}

JOB DESCRIPTION:
${jobDescription}${referenceContext}

Please provide your response in the following JSON format:
{
  "matchScore": <number 0-100>,
  "strengths": [<list of 3-5 strengths already present that align with the job>],
  "missingKeywords": [<list of 3-5 important keywords from job description not in resume>],
  "tailoredResume": "<the full optimized resume text>",
  "changes": [<list of 8-12 most impactful changes made, each with "original", "replacement", and "reason" fields>]
}

EXAMPLES OF GOOD VS BAD CHANGES:
❌ BAD: "Spearheaded cross-functional initiatives to drive synergistic outcomes"
✅ GOOD: "Led team of 5 to launch new feature, increasing user engagement by 30%"

❌ BAD: "Leveraged cutting-edge technologies to optimize performance"
✅ GOOD: "Improved page load time from 3s to 0.8s using React optimization techniques"

❌ BAD: "Championed strategic vision across multiple stakeholders"
✅ GOOD: "Coordinated with product, design, and engineering teams to deliver Q3 roadmap"

Focus on making every change meaningful, measurable where possible, and sounding authentically human.`
      }],
    });

    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta?.text) {
        fullText += chunk.delta.text;
        res.write(`data: ${JSON.stringify({ partial: true, chars: fullText.length })}\n\n`);
      }
    }

    // Parse and send final result
    const stripped = fullText.replace(/```json\s*/gi, '').replace(/```/g, '');
    const jsonMatch = stripped.match(/\{[\s\S]*/);
    if (!jsonMatch) throw new Error('Failed to parse AI response');

    const result = JSON.parse(repairJSON(jsonMatch[0]));

    // Strip any separator lines (%%%%%, ----, ====, etc.) the AI generated
    if (result.tailoredResume) {
      result.tailoredResume = result.tailoredResume
        .split('\n')
        .filter(line => line.trim() === '' || /[a-zA-Z0-9]/.test(line))
        .join('\n');
    }

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
