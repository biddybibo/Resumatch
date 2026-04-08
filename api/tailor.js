import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { resume, jobDescription } = req.body;
  if (!resume || !jobDescription) return res.status(400).json({ error: 'Missing resume or job description' });

  // Set up SSE so the connection streams instead of timing out
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Connection', 'keep-alive');

  try {
    let fullText = '';

    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-5',
      max_tokens: 3500,
      messages: [{
        role: 'user',
        content: `You are an expert resume optimizer specializing in ATS (Applicant Tracking System) optimization and authentic, human-sounding professional writing.

CRITICAL RULES:
1. AVOID AI-GENERATED JARGON: Never use buzzwords like "spearheaded," "leveraged," "synergized," "orchestrated," "championed," "pioneered," or other obviously AI-generated corporate speak. Use clear, direct language instead.
2. ADD QUANTIFIABLE ACHIEVEMENTS: When possible, replace vague statements with specific numbers, percentages, timeframes, or measurable outcomes. If the original resume lacks metrics, suggest realistic placeholders in [brackets] that the user should fill in.
3. MAINTAIN HONESTY: Only work with what's already in the resume. Never fabricate experience, skills, or accomplishments.
4. KEYWORD MATCHING: Naturally incorporate keywords from the job description where they genuinely fit the candidate's experience.
5. HUMAN VOICE: Write in clear, professional language that sounds like a real person wrote it, not an AI or corporate template.

ORIGINAL RESUME:
${resume}

JOB DESCRIPTION:
${jobDescription}

Please provide your response in the following JSON format:
{
  "matchScore": <number 0-100>,
  "strengths": [<list of 3-5 strengths already present that align with the job>],
  "missingKeywords": [<list of 3-5 important keywords from job description not in resume>],
  "tailoredResume": "<the optimized resume text with anti-AI-jargon and quantifiable metrics where possible>",
  "changes": [
    {
      "original": "<original text>",
      "replacement": "<new text>",
      "reason": "<why this change was made: keyword match, removed jargon, added metrics, etc.>"
    }
  ]
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
    res.write(`data: ${JSON.stringify({ done: true, result })}\n\n`);
    res.end();
  } catch (error) {
    res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    res.end();
  }
}
