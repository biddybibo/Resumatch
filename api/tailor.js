import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { resume, jobDescription } = req.body;

  if (!resume || !jobDescription) {
    return res.status(400).json({ error: 'Missing resume or job description' });
  }

  // Truncate inputs to keep token count low and avoid timeouts
  const resumeTruncated = resume.slice(0, 6000);
  const jobTruncated = jobDescription.slice(0, 3000);

  try {
    // NOTE: Vercel Hobby plan hard-caps serverless functions at 10 seconds.
    // Use claude-haiku (fastest model) + low max_tokens to stay under the limit.
    // To use Sonnet: upgrade to Vercel Pro and set maxDuration: 60 in vercel.json.
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: [
        {
          role: 'user',
          content: `You are an expert resume optimizer for ATS systems. Be concise.

RULES:
1. No AI jargon (no "spearheaded", "leveraged", "synergized", "championed", "pioneered")
2. Add quantifiable metrics where possible. Use [X] placeholders if unknown.
3. Only work with what's in the resume — no fabrication.
4. Naturally weave in job description keywords where they genuinely fit.
5. Sound like a real human wrote it.

RESUME:
${resumeTruncated}

JOB DESCRIPTION:
${jobTruncated}

Respond ONLY with a valid JSON object — no markdown, no code fences, no commentary:
{
  "matchScore": <0-100>,
  "strengths": [<3-5 strings: strengths in resume matching the job>],
  "missingKeywords": [<3-5 strings: important JD keywords absent from resume>],
  "tailoredResume": "<full optimized resume as a single string>",
  "changes": [
    { "original": "<old phrase>", "replacement": "<new phrase>", "reason": "<why>" }
  ]
}`,
        },
      ],
    });

    const content = message.content[0].text;

    // Strip markdown code fences if the model adds them anyway
    const stripped = content.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
    const jsonMatch = stripped.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Could not extract JSON from AI response');
    }

    const result = JSON.parse(jsonMatch[0]);
    return res.status(200).json(result);
  } catch (error) {
    console.error('Error:', error);

    const msg = error.message || 'Unknown error';
    const isTimeout = msg.toLowerCase().includes('timeout') || msg.includes('504');
    return res.status(500).json({
      error: isTimeout
        ? 'Request timed out. Try shortening your resume or job description.'
        : msg,
    });
  }
}
