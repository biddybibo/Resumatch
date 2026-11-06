// Shared helpers for API routes. Files under api/_lib are bundled, not exposed as routes.
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

export const MODEL = 'claude-sonnet-4-6';

// Clients are created on first use, so a route that doesn't need one (e.g. job import for an
// anonymous user) can't crash at load time because an env var is missing.
let _anthropic, _supabase;
export function getAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
  return (_anthropic ||= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));
}
export function getSupabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY are not set');
  return (_supabase ||= createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY));
}

export const clip = (s, n) => String(s ?? '').slice(0, n);

export async function withRetry(fn, retries = 3) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); } catch (err) {
      if (err?.status !== 429 || attempt >= retries) throw err;
      await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1500));
    }
  }
}

// Escape raw control characters inside JSON strings and close truncated brackets.
export function repairJSON(str) {
  let fixed = '';
  let inString = false, escape = false;
  for (const ch of str) {
    if (escape) { escape = false; fixed += ch; continue; }
    if (ch === '\\' && inString) { escape = true; fixed += ch; continue; }
    if (ch === '"') { inString = !inString; fixed += ch; continue; }
    if (inString && ch === '\n') { fixed += '\\n'; continue; }
    if (inString && ch === '\r') { fixed += '\\r'; continue; }
    if (inString && ch === '\t') { fixed += '\\t'; continue; }
    fixed += ch;
  }
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

// One-shot Claude call that must return a JSON object.
export async function askJSON(prompt, { maxTokens = 2000, temperature = 0 } = {}) {
  const anthropic = getAnthropic();
  const msg = await withRetry(() => anthropic.messages.create({
    model: MODEL, max_tokens: maxTokens, temperature,
    messages: [{ role: 'user', content: prompt }]
  }));
  const text = msg.content.map(b => b.text || '').join('');
  const start = text.indexOf('{');
  if (start === -1) throw new Error('AI response contained no JSON');
  const end = text.lastIndexOf('}');
  return JSON.parse(repairJSON(end > start ? text.slice(start, end + 1) : text.slice(start)));
}

// Same identity rules as /api/tailor: a valid Supabase session, or an anonymous device id.
// These helper endpoints don't consume tailor credits.
export async function authorize(req) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) {
    const { data, error } = await getSupabase().auth.getUser(token);
    if (error || !data?.user) return { ok: false, status: 401, error: 'Invalid session' };
    return { ok: true, userId: data.user.id };
  }
  const anonId = req.headers['x-anon-id'];
  if (typeof anonId === 'string' && anonId.length > 0 && anonId.length <= 100) return { ok: true, anonId };
  return { ok: false, status: 401, error: 'Not authenticated' };
}
