export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { resume, jobDescription } = req.body;

  if (!resume || !jobDescription) {
    return res.status(400).json({ error: "Missing resume or job description" });
  }

  const systemPrompt = `You are an expert resume optimization specialist. Analyze the resume and job description, then return ONLY a raw JSON object with no markdown, no backticks, no preamble. The JSON must have this exact structure:
{
  "tailoredResume": "The full rewritten resume with keywords optimized",
  "changes": [
    { "original": "original phrase", "replacement": "new phrase", "reason": "brief reason" }
  ],
  "matchScore": 72,
  "missingKeywords": ["keyword1", "keyword2"],
  "strengths": ["strength1", "strength2"]
}
Rules: keep it honest — only rephrase/reframe existing experience, never fabricate. Naturally weave in job keywords where accurate. matchScore is 0-100. List 3-6 changes, 3-5 missing keywords, 2-4 strengths.`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,  // ← stored safely in Vercel
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: "user", content: `RESUME:\n${resume}\n\nJOB DESCRIPTION:\n${jobDescription}` }]
      })
    });

    const data = await response.json();
    const raw = data.content?.[0]?.text || "";
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);

    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
}
