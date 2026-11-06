// Import a job description from a URL.
// Greenhouse, Lever and Ashby via their public job-board APIs; LinkedIn via its public guest page;
// anything else via schema.org JobPosting markup, falling back to the page's main text.
import dns from 'node:dns/promises';
import net from 'node:net';
import { authorize } from './_lib/ai.js';

const MAX_BYTES = 3 * 1024 * 1024;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Resumatch-JobImport';

// ── SSRF protection: only public http(s) hosts, re-checked on every redirect ──
function isPrivateIP(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIP(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb');
}

async function assertPublicUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw userError('That doesn\'t look like a valid link.'); }
  if (!/^https?:$/.test(url.protocol)) throw userError('Only http and https links are supported.');
  if (url.username || url.password) throw userError('Links with credentials are not supported.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw userError('That link isn\'t publicly reachable.');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw userError('Couldn\'t reach that website.');
  if (addrs.some(a => isPrivateIP(a.address))) throw userError('That link isn\'t publicly reachable.');
  return url;
}

async function safeFetch(raw, { accept = 'text/html,application/json', hops = 4 } = {}) {
  let url = await assertPublicUrl(raw);
  for (let i = 0; i <= hops; i++) {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(8000), headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'en-US,en;q=0.9' } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = await assertPublicUrl(new URL(res.headers.get('location'), url).href);
      continue;
    }
    if (!res.ok) throw Object.assign(new Error(`Upstream ${res.status}`), { upstreamStatus: res.status });
    const reader = res.body.getReader();
    const chunks = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) { reader.cancel(); throw userError('That page is too large to import.'); }
      chunks.push(value);
    }
    return { text: Buffer.concat(chunks).toString('utf8'), finalUrl: url.href };
  }
  throw userError('Too many redirects.');
}

const userError = (msg) => Object.assign(new Error(msg), { userFacing: true });

// ── HTML → readable text ──
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', hellip: '...', bull: '•', middot: '·', copy: '©', reg: '®', trade: '™' };
export function decodeEntities(s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(cp) && cp < 0x110000 ? String.fromCodePoint(cp) : m; }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
export function htmlToText(html) {
  return decodeEntities(String(html || '')
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, '')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(p|div|h[1-6]|ul|ol|section|article|header|tr)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .split('\n').filter(l => !/^[•·|\s]*$/.test(l) || l === '').join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Source-specific importers ──
async function fromGreenhouse(url, boardHint) {
  const m = url.pathname.match(/^\/([^/]+)\/jobs\/(\d+)/);
  const board = boardHint || m?.[1] || url.searchParams.get('for'), id = url.searchParams.get('gh_jid') || m?.[2] || url.searchParams.get('token');
  if (!board || !id) return null;
  const { text } = await safeFetch(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs/${encodeURIComponent(id)}`, { accept: 'application/json' });
  const j = JSON.parse(text);
  return { title: j.title, company: j.company_name || titleCase(board), location: j.location?.name || '', description: htmlToText(decodeEntities(j.content)), source: 'Greenhouse' };
}

async function fromLever(url) {
  const [, company, id] = url.pathname.match(/^\/([^/]+)\/([0-9a-f-]{36})/i) || [];
  if (!company) return null;
  const { text } = await safeFetch(`https://api.lever.co/v0/postings/${encodeURIComponent(company)}/${id}`, { accept: 'application/json' });
  const j = JSON.parse(text);
  const lists = (j.lists || []).map(l => `${l.text}\n${htmlToText(l.content)}`).join('\n\n');
  return { title: j.text, company: titleCase(company), location: j.categories?.location || '', description: [j.descriptionPlain, lists, j.additionalPlain].filter(Boolean).join('\n\n').trim(), source: 'Lever' };
}

async function fromAshby(url) {
  const [, org, id] = url.pathname.match(/^\/([^/]+)\/([0-9a-f-]{36})/i) || [];
  if (!org) return null;
  const { text } = await safeFetch(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(org)}`, { accept: 'application/json' });
  const job = (JSON.parse(text).jobs || []).find(j => j.id === id);
  if (!job) return null;
  return { title: job.title, company: titleCase(decodeURIComponent(org)), location: job.location || '', description: job.descriptionPlain || htmlToText(job.descriptionHtml), source: 'Ashby' };
}

async function fromAshbyEmbed(url, id, html) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const sld = url.hostname.replace(/^www\./, '').split('.').slice(-2, -1)[0] || '';
  const candidates = [...new Set([
    html.match(/jobs\.ashbyhq\.com\/([\w.-]+)/)?.[1],
    sld, sld.replace(/(hq|inc|app|labs|careers|jobs)$/, ''), sld.split('-')[0]
  ].filter(c => c && c.length > 1 && !['embed', 'api'].includes(c)))].slice(0, 4);
  for (const org of candidates) {
    const job = await fromAshby(new URL(`https://jobs.ashbyhq.com/${org}/${id}`)).catch(() => null);
    if (job) return job;
  }
  return null;
}

async function fromLinkedIn(url) {
  const id = url.pathname.match(/\/jobs\/view\/(?:[^/]*?-)?(\d{6,})/)?.[1] || url.searchParams.get('currentJobId');
  if (!id) return null;
  let html;
  try { ({ text: html } = await safeFetch(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`)); }
  catch { throw userError('LinkedIn blocked the import. Open the posting and paste the description instead.'); }
  const pick = (re) => htmlToText(html.match(re)?.[1] || '');
  const description = pick(/class="show-more-less-html__markup[^"]*"[^>]*>([\s\S]*?)<\/div>/);
  if (!description) throw userError('LinkedIn blocked the import. Open the posting and paste the description instead.');
  return {
    title: pick(/<h2[^>]*top-card-layout__title[^>]*>([\s\S]*?)<\/h2>/),
    company: pick(/class="topcard__org-name-link[^"]*"[^>]*>([\s\S]*?)<\/a>/),
    location: pick(/class="topcard__flavor topcard__flavor--bullet"[^>]*>([\s\S]*?)<\/span>/),
    description, source: 'LinkedIn'
  };
}

// schema.org JobPosting (most career sites and ATSs emit it for Google Jobs), else main page text.
export function fromHtml(html) {
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data; try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const nodes = [data].flat().flatMap(n => n?.['@graph'] ? [n, ...n['@graph']] : [n]);
    const jp = nodes.find(n => [n?.['@type']].flat().includes('JobPosting'));
    if (jp?.description) {
      const loc = [jp.jobLocation].flat()[0]?.address;
      return {
        title: decodeEntities(jp.title || ''), company: decodeEntities(jp.hiringOrganization?.name || ''),
        location: loc ? [loc.addressLocality, loc.addressRegion].filter(Boolean).join(', ') : (jp.jobLocationType === 'TELECOMMUTE' ? 'Remote' : ''),
        description: htmlToText(decodeEntities(jp.description)), source: 'JobPosting'
      };
    }
  }
  const meta = (p) => decodeEntities(html.match(new RegExp(`<meta[^>]+property=["']${p}["'][^>]+content=["']([^"']*)`, 'i'))?.[1] || '');
  const main = html.match(/<main[\s\S]*?<\/main>/i)?.[0] || html.match(/<article[\s\S]*?<\/article>/i)?.[0]
    || html.replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, '');
  return { title: meta('og:title') || htmlToText(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || ''), company: meta('og:site_name'), location: '', description: htmlToText(main), source: 'page' };
}

const titleCase = (s) => String(s || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const raw = String(req.body?.url || '').trim();
  if (!raw || raw.length > 2000) return res.status(400).json({ error: 'Paste a job link first.' });

  try {
    const auth = await authorize(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    const url = await assertPublicUrl(raw);
    const host = url.hostname.replace(/^www\./, '');
    let job = null;
    if (/(^|\.)greenhouse\.io$/.test(host)) job = await fromGreenhouse(url);
    else if (host === 'jobs.lever.co') job = await fromLever(url);
    else if (host === 'jobs.ashbyhq.com') job = await fromAshby(url);
    else if (/(^|\.)linkedin\.com$/.test(host)) job = await fromLinkedIn(url);
    if (!job) {
      const { text } = await safeFetch(url.href);
      // Company career sites that embed Ashby (…/careers?ashby_jid=<uuid>): the board loads client-side,
      // so find the org slug (from the page, else guessed from the domain) and use Ashby's API.
      const ashbyId = url.searchParams.get('ashby_jid');
      if (ashbyId) job = await fromAshbyEmbed(url, ashbyId, text);
      // Company career sites that embed Greenhouse (…/careers?gh_jid=123): find the board token and use the API.
      if (!job && url.searchParams.get('gh_jid')) {
        const board = text.match(/greenhouse\.io\/(?:embed\/job_board(?:\/js)?\?for=|v1\/boards\/)([\w-]+)/)?.[1]
          || text.match(/job-boards\.greenhouse\.io\/([\w-]+)/)?.[1]
          || host.split('.').slice(-2, -1)[0];
        job = await fromGreenhouse(url, board).catch(() => null);
      }
      job ||= fromHtml(text);
    }
    job.description = (job.description || '').slice(0, 15000);
    if (job.description.length < 200) {
      return res.status(422).json({ error: 'Couldn\'t find a job description on that page. Paste it in instead.' });
    }
    for (const k of ['title', 'company', 'location']) job[k] = String(job[k] || '').trim().slice(0, 200);
    return res.status(200).json({ ...job, url: url.href });
  } catch (err) {
    if (err.userFacing) return res.status(422).json({ error: err.message });
    console.error('fetch-job failed:', err);
    if (!err?.upstreamStatus && !(err?.name === 'TimeoutError' || err?.name === 'AbortError')) {
      return res.status(500).json({ error: `Import failed on the server: ${err?.message || 'unknown error'}. Paste the description instead.` });
    }
    const blocked = err?.upstreamStatus && [401, 403, 429, 999].includes(err.upstreamStatus);
    return res.status(502).json({ error: blocked ? 'That site blocked the import. Paste the description instead.' : 'Couldn\'t load that page. Check the link or paste the description instead.' });
  }
}
