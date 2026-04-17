import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth check — same pattern as tailor.js
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Invalid session' });

  // Check usage — cover letter shares the same Pro gate as tailoring
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

  // Set up SSE — same headers as tailor.js
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    let fullText = '';

    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
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
${useKeywords ? '7. KEYWORDS: Naturally weave in relevant keywords from the job description throughout.' : '7. Focus on narrative and authentic fit — do not force keyword insertion.'}

Style: ${styleGuides[style] || styleGuides.story}
Tone: ${tone}

Provide your response in TWO clearly separated parts:

PART 1 — Cover letter as plain text:
LETTER_START
<full cover letter text here>
LETTER_END

PART 2 — JSON only:
\`\`\`json
{
  "strengths": [<2-3 short strings describing what the letter does well>],
  "keywords": [<3-5 job keywords naturally incorporated>]
}
\`\`\`

RESUME:
${resume}

JOB DESCRIPTION:
${jobDescription}`
      }]
    });

    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta?.text) {
        fullText += chunk.delta.text;
        res.write(`data: ${JSON.stringify({ partial: true, chars: fullText.length })}\n\n`);
      }
    }

    // Parse letter text
    const letterMatch = fullText.match(/LETTER_START\s*([\s\S]*?)\s*LETTER_END/) ||
                        fullText.match(/LETTER_START\s*([\s\S]+)$/);
    if (!letterMatch) throw new Error('Failed to parse cover letter response');

    // Parse JSON metadata
    const jsonBlockMatch = fullText.match(/```json\s*([\s\S]*?)```/i);
    let meta = { strengths: [], keywords: [] };
    if (jsonBlockMatch) {
      try { meta = JSON.parse(jsonBlockMatch[1].trim()); } catch { /* use defaults */ }
    }

    const result = {
      coverLetter: letterMatch[1].trim(),
      strengths: meta.strengths || [],
      keywords: meta.keywords || []
    };

    res.write(`data: ${JSON.stringify({ done: true, result })}\n\n`);
    res.end();
  } catch (error) {
    const msg = error?.status ? `API error ${error.status}: ${error.message}` : (error.message || 'Unknown error');
    res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
    res.end();
  }
}
