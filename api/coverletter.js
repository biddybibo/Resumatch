import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Extract a likely company name from the job description
function extractCompanyName(jobDescription) {
  const lines = jobDescription.split('\n').map(l => l.trim()).filter(l => l);
  // Look for "About [Company]", "Company: X", or "at [Company]" patterns
  for (const line of lines.slice(0, 20)) {
    const m = line.match(/^(?:about|company|employer|organization)[:\s]+(.+)/i) ||
              line.match(/(?:join|at|with)\s+([A-Z][A-Za-z0-9\s&.,'-]{2,40}?)(?:\s*[,.]|$)/);
    if (m) return m[1].trim().replace(/[.,]+$/, '');
  }
  // Fallback: first line that looks like a proper noun (Title Case, short)
  for (const line of lines.slice(0, 5)) {
    if (line.length < 60 && /^[A-Z]/.test(line) && !/\b(we|our|you|your|the|and)\b/i.test(line)) {
      return line.replace(/[.,]+$/, '');
    }
  }
  return '';
}

async function searchCompanyInfo(companyName) {
  if (!process.env.SERPER_API_KEY || !companyName) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const response = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: `${companyName} headquarters address contact`, num: 3 }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    const data = await response.json();

    // Pull address/location snippets from organic results and knowledge graph
    const parts = [];
    if (data.knowledgeGraph) {
      const kg = data.knowledgeGraph;
      if (kg.address) parts.push(kg.address);
      if (kg.phone) parts.push(kg.phone);
      if (kg.website) parts.push(kg.website);
    }
    (data.organic || []).slice(0, 2).forEach(r => {
      if (r.snippet) parts.push(r.snippet);
    });
    return parts.length ? parts.join(' | ') : null;
  } catch {
    return null;
  }
}

// Pull the letter out of the model's reply. The prompt asks for LETTER_START/LETTER_END
// markers, but the model sometimes bolds them, adds spaces, or skips them entirely.
export function extractLetter(text) {
  const t = String(text || '');
  const START = /\**\s*LETTER[\s_-]*START\s*\**:?/i;
  const END = /\**\s*LETTER[\s_-]*END\s*\**/i;
  let body = null;
  const s = t.search(START);
  if (s !== -1) {
    const rest = t.slice(s).replace(START, '');
    const e = rest.search(END);
    body = e !== -1 ? rest.slice(0, e) : rest.split(/```|PART\s*2/i)[0];
  } else {
    // No markers: take everything before the JSON part, from the salutation on.
    const before = t.split(/```|\**\s*PART\s*2/i)[0];
    const dear = before.search(/^\s*(Dear|Hello|Hi|To whom)\b/im);
    body = dear !== -1 ? before.slice(dear) : null;
  }
  body = (body || '').replace(/^\s*\**\s*PART\s*1[^\n]*\n/i, '').trim();
  return body.length >= 80 ? body : null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Invalid session' });

  const { data: profile } = await supabase
    .from('profiles')
    .select('subscription_status, tailor_count')
    .eq('id', user.id)
    .single();

  if (!profile) return res.status(400).json({ error: 'Profile not found' });

  if (profile.subscription_status !== 'active' && profile.tailor_count >= 3) {
    return res.status(403).json({ error: 'FREE_LIMIT_REACHED' });
  }

  const { resume, jobDescription, style, tone, useKeywords } = req.body;
  if (!resume || !jobDescription) return res.status(400).json({ error: 'Missing resume or job description' });

  const styleGuides = {
    story: 'Open with a compelling hook or personal connection to the company/role. Build a narrative that shows why this specific opportunity matters. Weave in experience as proof points.',
    achievement: 'Lead immediately with the strongest quantifiable achievement relevant to this role. Structure around concrete results and metrics. Make impact the centerpiece.',
    direct: 'Be extremely concise — 3 short paragraphs maximum. No fluff. State fit clearly and get to the point fast. Every sentence must earn its place.'
  };

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    // Search for company info in parallel before AI call
    const companyName = extractCompanyName(jobDescription);
    const [companyInfoRaw] = await Promise.all([searchCompanyInfo(companyName)]);

    const companyContext = companyInfoRaw
      ? `\n\nCOMPANY INFO (from web search — use for recipient block):\n${companyInfoRaw}`
      : '';

    let fullText = '';

    const streamParams = {
      model: 'claude-sonnet-4-6',
      max_tokens: 1800,
      messages: [{
        role: 'user',
        content: `You are an expert cover letter writer. Write targeted, authentic cover letters that sound like a real person — not a template.

CRITICAL RULES:
1. NO CLICHÉS: Never use "I am writing to express my interest", "I am a passionate team player", "I would be a great fit", or similar tired phrases.
2. NO PERSONAL PRONOUNS at the start of sentences when possible. Vary sentence structure.
3. SPECIFIC: Reference the actual company name and role. Show you know what they do.
4. HONEST: Only draw from what is in the resume. Never fabricate experience.
5. HUMAN: Write like a real person, not a bot. Vary sentence length. Use active voice.
6. NO AI JARGON: Never use "spearheaded", "leveraged", "synergized", "orchestrated", or similar buzzwords.
7. NO DASHES: Never use any dashes — no em-dashes (—), en-dashes (–), hyphens as separators, or dash lines (---). Use commas or semicolons instead.
8. ONE PAGE: Keep the letter concise — 3-4 paragraphs maximum. Every sentence must earn its place.
9. CLOSING FORMAT: Write the closing on its own line as just "Sincerely," or "Best regards," — never append the name to the closing line.
${useKeywords ? '9. KEYWORDS: Naturally weave in relevant keywords from the job description throughout.' : '9. Focus on narrative and authentic fit — do not force keyword insertion.'}

Style: ${styleGuides[style] || styleGuides.story}
Tone: ${tone}

Provide your response in TWO clearly separated parts:

PART 1 — Cover letter as plain text (salutation through closing only — no header block):
LETTER_START
<letter starting with "Dear [Name]:" through closing and name>
LETTER_END

PART 2 — JSON only:
\`\`\`json
{
  "strengths": [<2-3 short strings describing what the letter does well>],
  "keywords": [<3-5 job keywords naturally incorporated>],
  "recipient": {
    "name": "<hiring manager full name if found, else empty string>",
    "title": "<their title if found, else empty string>",
    "company": "<company name>",
    "address": "<street address if found from job description or company info, else empty string>",
    "cityStateZip": "<city, state zip if found, else empty string>"
  }
}
\`\`\`

RESUME:
${resume}

JOB DESCRIPTION:
${jobDescription}${companyContext}`
      }]
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
        break;
      } catch (err) {
        if (err?.status === 429 && attempt < MAX_RETRIES) {
          const waitMs = Math.pow(2, attempt) * 1500;
          res.write(`data: ${JSON.stringify({ retrying: true, attempt: attempt + 1, maxRetries: MAX_RETRIES, waitMs })}\n\n`);
          await new Promise(r => setTimeout(r, waitMs));
        } else {
          throw err;
        }
      }
    }

    const letterText = extractLetter(fullText);
    if (!letterText) {
      console.error('coverletter: unparseable response:', JSON.stringify(fullText.slice(0, 400)));
      throw new Error('The letter came back in an unexpected format. Please try again.');
    }

    const jsonBlockMatch = fullText.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
    let meta = { strengths: [], keywords: [], recipient: {} };
    if (jsonBlockMatch) {
      try { meta = JSON.parse(jsonBlockMatch[1].trim()); } catch { /* use defaults */ }
    }

    // Strip any dash lines from letter text
    const cleanLetter = letterText
      .split('\n')
      .filter(l => !/^[\-–—=*#~\s]{2,}$/.test(l))
      .join('\n');

    const result = {
      coverLetter: cleanLetter,
      strengths: meta.strengths || [],
      keywords: meta.keywords || [],
      recipient: meta.recipient || {}
    };

    res.write(`data: ${JSON.stringify({ done: true, result })}\n\n`);
    res.end();
  } catch (error) {
    const msg = error?.status ? `API error ${error.status}: ${error.message}` : (error.message || 'Unknown error');
    res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
    res.end();
  }
}
