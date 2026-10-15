// Ahmise server: serves the app and runs Claude with tools through the Claude API.
const express = require('express');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const crypto = require('crypto');
const AnthropicPkg = require('@anthropic-ai/sdk');
const Anthropic = AnthropicPkg.default || AnthropicPkg;

const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.APP_PASSWORD || '';
if (!process.env.ANTHROPIC_API_KEY) console.warn('Missing ANTHROPIC_API_KEY: replies will fail.');
if (!PASSWORD) console.warn('Missing APP_PASSWORD: anyone with the link could spend your API credit. Set it before going public.');
const client = new Anthropic();

const MODELS = {
  quick: process.env.MODEL_QUICK || 'claude-haiku-5-5',
  default: process.env.MODEL_DEFAULT || 'claude-sonnet-5-5',
  complex: process.env.MODEL_COMPLEX || 'claude-opus-5-5',
};

const app = express();
app.use(express.json({ limit: '2mb' }));
const fs = require('fs');
const INDEX = ['index.html', 'index-2.html', 'index-3.html', 'public/index.html'].map(f => path.join(__dirname, f)).find(p => fs.existsSync(p));
app.get('/', (req, res) => INDEX ? res.sendFile(INDEX) : res.status(500).send('index.html is missing'));

function authed(req) {
  if (!PASSWORD) return false;
  const got = Buffer.from(String(req.get('x-ahmise-key') || ''));
  const want = Buffer.from(PASSWORD);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/* ---------- tools ---------- */
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const l = ip.toLowerCase();
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:');
}
async function safeFetch(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { return 'That is not a valid URL.'; }
  if (!/^https?:$/.test(u.protocol)) return 'Only http and https links work.';
  const addrs = await dns.lookup(u.hostname, { all: true }).catch(() => []);
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) return 'That address is not allowed.';
  const res = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { 'user-agent': 'AhmiseBot/1.0' } });
  if (res.status >= 300 && res.status < 400) return 'The page redirected to ' + res.headers.get('location') + '. Fetch that address instead if it is safe.';
  const ct = res.headers.get('content-type') || '';
  if (!/text|json|xml/.test(ct)) return 'Not a text page (' + ct + ').';
  let t = (await res.text()).slice(0, 400000);
  t = t.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  return t.slice(0, 20000) || 'The page had no readable text.';
}
function calc(expr) {
  const s = String(expr).replace(/\^/g, '**');
  if (!/^[0-9+\-*/%().,\s*eE]*$/.test(s) || s.length > 200) return 'Only numbers and + - * / % ^ ( ) are allowed.';
  try { const v = Function('"use strict";return (' + s + ')')(); return Number.isFinite(v) ? String(v) : 'Not a finite number.'; } catch { return 'Could not calculate that.'; }
}
const CUSTOM_TOOLS = [
  { name: 'get_datetime', description: 'Get the current date and time, optionally in an IANA time zone such as Asia/Dubai.', input_schema: { type: 'object', properties: { timezone: { type: 'string' } } } },
  { name: 'calculator', description: 'Evaluate an arithmetic expression exactly. Use for any maths.', input_schema: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] } },
  { name: 'fetch_url', description: 'Download a public web page and return its readable text. Use it to read a link the person gives you or a page found by search.', input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
];
async function runTool(name, input) {
  try {
    if (name === 'get_datetime') {
      const tz = input && input.timezone;
      try { return new Date().toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'long', timeZone: tz || 'UTC' }); } catch { return new Date().toISOString(); }
    }
    if (name === 'calculator') return calc(input.expression);
    if (name === 'fetch_url') return await safeFetch(input.url);
  } catch (e) { return 'Tool error: ' + (e.message || 'failed'); }
  return 'Unknown tool.';
}

/* ---------- chat ---------- */
function normalize(input) {
  const arr = typeof input === 'string' ? [{ role: 'user', content: input }] : Array.isArray(input) ? input : [];
  const out = [];
  for (const m of arr) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string' || !m.content) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += '\n\n' + m.content; else out.push({ role: m.role, content: m.content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}
function errCode(e) {
  const s = e && (e.status || (e.error && e.error.status));
  if (s === 429) return 'rate_limited';
  if (s === 401 || s === 403) return 'sampling_disabled';
  if (s === 413) return 'prompt_too_large';
  return 'upstream_error';
}

app.post('/api/chat', async (req, res) => {
  if (!authed(req)) return res.status(401).json({ code: 'session_expired' });
  const messages = normalize(req.body && req.body.input);
  if (!messages.length) return res.status(400).json({ code: 'upstream_error' });
  const model = MODELS[req.body.modelTier] || MODELS.default;
  const useTools = req.body.tools !== false;

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  const send = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
  const ac = new AbortController();
  res.on('close', () => ac.abort());

  const tools = useTools ? [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }, ...CUSTOM_TOOLS] : undefined;
  let full = '';
  try {
    for (let turn = 0; turn < 8; turn++) {
      const stream = client.messages.stream({ model, max_tokens: 8000, messages, ...(tools ? { tools } : {}) }, { signal: ac.signal });
      stream.on('text', d => { full += d; send({ delta: d }); });
      const msg = await stream.finalMessage();
      if (msg.stop_reason === 'tool_use') {
        messages.push({ role: 'assistant', content: msg.content });
        const results = [];
        for (const b of msg.content) {
          if (b.type === 'tool_use') results.push({ type: 'tool_result', tool_use_id: b.id, content: await runTool(b.name, b.input) });
        }
        messages.push({ role: 'user', content: results });
        full += '';
        continue;
      }
      if (msg.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: msg.content }); continue; }
      if (msg.stop_reason === 'refusal') send({ error: 'refused' });
      break;
    }
    if (!full.trim()) send({ error: 'empty_completion' });
    send({ done: true });
  } catch (e) {
    if (!ac.signal.aborted) { console.error(e && e.message); send({ error: errCode(e) }); }
  }
  res.end();
});


/* ---------- real images (OpenAI) and videos (Google Veo) ---------- */
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const IMAGE_MODEL = process.env.IMAGE_MODEL || 'gpt-image-2.5-flare';
const VIDEO_MODEL = process.env.VIDEO_MODEL || 'veo-3.1-generate-preview';
const GBASE = 'https://generativelanguage.googleapis.com/v1beta';

function gate(req, res) {
  if (!authed(req)) { res.status(401).json({ code: 'session_expired' }); return false; }
  return true;
}
function cleanPrompt(p) { return typeof p === 'string' ? p.trim().slice(0, 2000) : ''; }

app.post('/api/image', async (req, res) => {
  if (!gate(req, res)) return;
  if (!OPENAI_KEY) return res.status(501).json({ code: 'nokey' });
  const prompt = cleanPrompt(req.body && req.body.prompt);
  if (!prompt) return res.status(400).json({ code: 'upstream_error' });
  try {
    const r = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + OPENAI_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ model: IMAGE_MODEL, prompt, n: 1 }),
      signal: AbortSignal.timeout(170000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = JSON.stringify(j.error || {}).toLowerCase();
      console.error('image error', r.status, msg.slice(0, 300));
      if (/safety|policy|moderation/.test(msg)) return res.status(400).json({ code: 'blocked' });
      return res.status(502).json({ code: r.status === 429 ? 'rate_limited' : 'upstream_error' });
    }
    const b64 = j.data && j.data[0] && j.data[0].b64_json;
    if (!b64) return res.status(502).json({ code: 'upstream_error' });
    res.json({ b64 });
  } catch (e) { console.error('image', e.message); res.status(502).json({ code: 'upstream_error' }); }
});

const OP_RE = /^models\/[\w.\-]+\/operations\/[\w\-]+$/;
app.post('/api/video/start', async (req, res) => {
  if (!gate(req, res)) return;
  if (!GEMINI_KEY) return res.status(501).json({ code: 'nokey' });
  const prompt = cleanPrompt(req.body && req.body.prompt);
  if (!prompt) return res.status(400).json({ code: 'upstream_error' });
  try {
    const r = await fetch(GBASE + '/models/' + VIDEO_MODEL + ':predictLongRunning', {
      method: 'POST',
      headers: { 'x-goog-api-key': GEMINI_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ instances: [{ prompt }], parameters: { aspectRatio: '16:9' } }),
      signal: AbortSignal.timeout(30000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.name || !OP_RE.test(j.name)) {
      console.error('video start', r.status, JSON.stringify(j).slice(0, 300));
      return res.status(502).json({ code: r.status === 429 ? 'rate_limited' : 'upstream_error' });
    }
    res.json({ id: j.name });
  } catch (e) { console.error('video start', e.message); res.status(502).json({ code: 'upstream_error' }); }
});
async function opStatus(id) {
  const r = await fetch(GBASE + '/' + id, { headers: { 'x-goog-api-key': GEMINI_KEY }, signal: AbortSignal.timeout(30000) });
  return r.json();
}
app.get('/api/video/status', async (req, res) => {
  if (!gate(req, res)) return;
  const id = String(req.query.id || '');
  if (!OP_RE.test(id)) return res.status(400).json({ code: 'upstream_error' });
  try {
    const j = await opStatus(id);
    if (j.error) { console.error('video op error', JSON.stringify(j.error).slice(0, 300)); return res.json({ done: true, failed: true }); }
    const uri = j.response && j.response.generateVideoResponse && j.response.generateVideoResponse.generatedSamples && j.response.generateVideoResponse.generatedSamples[0] && j.response.generateVideoResponse.generatedSamples[0].video && j.response.generateVideoResponse.generatedSamples[0].video.uri;
    const filtered = j.done && !uri;
    res.json({ done: !!j.done, failed: filtered });
  } catch (e) { res.status(502).json({ code: 'upstream_error' }); }
});
app.get('/api/video/file', async (req, res) => {
  if (!gate(req, res)) return;
  const id = String(req.query.id || '');
  if (!OP_RE.test(id)) return res.status(400).json({ code: 'upstream_error' });
  try {
    const j = await opStatus(id);
    const uri = j.response && j.response.generateVideoResponse && j.response.generateVideoResponse.generatedSamples[0].video.uri;
    if (!uri || !uri.startsWith('https://generativelanguage.googleapis.com/')) return res.status(404).json({ code: 'upstream_error' });
    let r = await fetch(uri, { headers: { 'x-goog-api-key': GEMINI_KEY }, redirect: 'manual', signal: AbortSignal.timeout(120000) });
    if (r.status >= 300 && r.status < 400) {
      const loc = new URL(r.headers.get('location'), uri);
      if (loc.protocol !== 'https:' || !/(\.|^)(googleapis|googleusercontent)\.com$/.test(loc.hostname)) return res.status(502).json({ code: 'upstream_error' });
      r = await fetch(loc, { signal: AbortSignal.timeout(120000) });
    }
    if (!r.ok) return res.status(502).json({ code: 'upstream_error' });
    res.setHeader('content-type', 'video/mp4');
    require('stream').Readable.fromWeb(r.body).pipe(res);
  } catch (e) { console.error('video file', e.message); if (!res.headersSent) res.status(502).json({ code: 'upstream_error' }); }
});

app.get('/api/ping', (req, res) => res.json({ ok: authed(req) }));
app.listen(PORT, () => console.log('Ahmise running on port ' + PORT));
