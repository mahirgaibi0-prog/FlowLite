import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';

const { Pool } = pg;
const app = express();
const required = ['DATABASE_URL', 'JWT_SECRET', 'CREDENTIALS_KEY'];
for (const key of required) if (!process.env[key]) {
  console.error(`Missing required environment variable: ${key}`);
  process.exit(1);
}
if (Buffer.from(process.env.CREDENTIALS_KEY, 'base64').length !== 32) {
  console.error('CREDENTIALS_KEY must be a base64-encoded 32-byte key');
  process.exit(1);
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: true } : undefined });
app.use(helmet());
app.use(cors({ origin: (process.env.CORS_ORIGINS || '').split(',').filter(Boolean), credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));

const key = Buffer.from(process.env.CREDENTIALS_KEY, 'base64');
const encrypt = (value) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
};
const decrypt = (packed) => {
  const [iv, tag, data] = packed.split('.').map(x => Buffer.from(x, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
};
const auth = async (req, res, next) => {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = Number(payload.sub);
    if (!Number.isSafeInteger(req.userId)) throw new Error('Invalid user');
    next();
  } catch { res.status(401).json({ error: 'Unauthorized' }); }
};
const safeJson = (value, fallback = {}) => {
  try { return typeof value === 'string' ? JSON.parse(value) : (value ?? fallback); } catch { return fallback; }
};
const isPrivateIp = (ip) => {
  if (net.isIPv4(ip)) {
    const [a,b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (net.isIPv6(ip)) return ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80:') || ip.startsWith('::ffff:127.');
  return true;
};
async function assertPublicHttpUrl(raw) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only public HTTP(S) URLs are allowed');
  if (url.hostname === 'localhost' || url.hostname.endsWith('.local')) throw new Error('Local destinations are blocked');
  const records = await dns.lookup(url.hostname, { all: true });
  if (!records.length || records.some(r => isPrivateIp(r.address))) throw new Error('Private or local network destinations are blocked');
  return url;
}
async function runDefinition(definition, input, userId) {
  const nodes = Array.isArray(definition.nodes) ? definition.nodes : [];
  const edges = Array.isArray(definition.edges) ? definition.edges : [];
  if (nodes.length > 100) throw new Error('Workflow exceeds 100 nodes');
  const byId = new Map(nodes.map(n => [String(n.id), n]));
  const trigger = nodes.find(n => ['Trigger', 'Manual Trigger'].includes(n.type)) || nodes[0];
  if (!trigger) throw new Error('Workflow has no nodes');
  let current = trigger, data = input ?? {}, steps = 0;
  const outputs = [];
  while (current && steps++ < 100) {
    const cfg = current.config || {};
    if (current.type === 'Set' || current.type === 'Set Variables') {
      data = { ...data, ...(cfg.values || {}) };
    } else if (current.type === 'IF') {
      const actual = data?.[cfg.field];
      const pass = cfg.operator === 'equals' ? String(actual) === String(cfg.value)
        : cfg.operator === 'contains' ? String(actual ?? '').includes(String(cfg.value))
        : cfg.operator === 'greater' ? Number(actual) > Number(cfg.value)
        : Boolean(actual);
      const edge = edges.find(e => String(e.source) === String(current.id) && String(e.sourceHandle || e.from) === (pass ? 'true' : 'false'));
      current = edge ? byId.get(String(edge.target)) : null;
      outputs.push({ nodeId: current?.id ?? null, branch: pass ? 'true' : 'false' });
      continue;
    } else if (current.type === 'HTTP Request' || current.type === 'HTTP') {
      const url = await assertPublicHttpUrl(cfg.url);
      const method = String(cfg.method || 'GET').toUpperCase();
      if (!['GET','POST','PUT','PATCH','DELETE'].includes(method)) throw new Error('Unsupported HTTP method');
      const response = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json', ...(cfg.headers || {}) },
        body: ['GET','HEAD'].includes(method) ? undefined : JSON.stringify(cfg.body ?? data),
        redirect: 'error',
        signal: AbortSignal.timeout(Math.min(Math.max(Number(cfg.timeoutMs) || 15000, 1000), 30000))
      });
      const raw = await response.text();
      let body; try { body = JSON.parse(raw); } catch { body = raw.slice(0, 20000); }
      data = { status: response.status, body };
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } else if (current.type === 'AI Agent' || current.type === 'AI') {
      const cred = await pool.query('SELECT secret_enc FROM credentials WHERE user_id=$1 AND name=$2', [userId, cfg.credentialName || 'default']);
      const apiKey = cred.rows[0] ? decrypt(cred.rows[0].secret_enc) : cfg.apiKey;
      if (!apiKey) throw new Error('AI API key is missing; configure a credential first');
      const endpoint = await assertPublicHttpUrl(cfg.endpoint || 'https://api.openai.com/v1/chat/completions');
      const response = await fetch(endpoint, {
        method: 'POST', redirect: 'error',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: cfg.model || 'gpt-4o-mini', messages: [
          { role: 'system', content: cfg.systemPrompt || 'You are a helpful assistant.' },
          { role: 'user', content: String(cfg.prompt || data?.prompt || JSON.stringify(data)) }
        ] }),
        signal: AbortSignal.timeout(30000)
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result?.error?.message || `AI API HTTP ${response.status}`);
      data = { ...data, ai: result?.choices?.[0]?.message?.content ?? result };
    } else if (current.type === 'Output') {
      outputs.push({ nodeId: current.id, data });
    }
    const next = edges.find(e => String(e.source) === String(current.id));
    current = next ? byId.get(String(next.target)) : null;
  }
  if (steps >= 100) throw new Error('Execution step limit reached');
  return { data, outputs };
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'FlowLite API' }));
app.post('/api/auth/signup', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 10) return res.status(400).json({ error: 'Valid email and password of at least 10 characters required' });
    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query('INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id,email', [email, hash]);
    const user = result.rows[0];
    res.status(201).json({ token: jwt.sign({ sub: String(user.id) }, process.env.JWT_SECRET, { expiresIn: '7d' }), user });
  } catch (e) { res.status(e.code === '23505' ? 409 : 500).json({ error: e.code === '23505' ? 'Email already registered' : 'Signup failed' }); }
});
app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const result = await pool.query('SELECT id,email,password_hash FROM users WHERE email=$1', [email]);
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(String(req.body?.password || ''), user.password_hash))) return res.status(401).json({ error: 'Invalid email or password' });
  res.json({ token: jwt.sign({ sub: String(user.id) }, process.env.JWT_SECRET, { expiresIn: '7d' }), user: { id: user.id, email: user.email } });
});
app.get('/api/me', auth, async (req, res) => {
  const r = await pool.query('SELECT id,email,created_at FROM users WHERE id=$1', [req.userId]);
  if (!r.rows[0]) return res.status(404).json({ error: 'User not found' });
  res.json({ user: r.rows[0] });
});
app.get('/api/workflows', auth, async (req, res) => {
  const r = await pool.query('SELECT id,name,definition,enabled,created_at,updated_at FROM workflows WHERE user_id=$1 ORDER BY updated_at DESC', [req.userId]);
  res.json({ workflows: r.rows });
});
app.post('/api/workflows', auth, async (req, res) => {
  const name = String(req.body?.name || 'Untitled workflow').slice(0,120);
  const definition = safeJson(req.body?.definition);
  const r = await pool.query('INSERT INTO workflows(user_id,name,definition) VALUES($1,$2,$3) RETURNING *', [req.userId,name,JSON.stringify(definition)]);
  res.status(201).json({ workflow: r.rows[0] });
});
app.put('/api/workflows/:id', auth, async (req, res) => {
  const r = await pool.query('UPDATE workflows SET name=$1,definition=$2,updated_at=NOW() WHERE id=$3 AND user_id=$4 RETURNING *',
    [String(req.body?.name || 'Untitled workflow').slice(0,120),JSON.stringify(safeJson(req.body?.definition)),req.params.id,req.userId]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Workflow not found' });
  res.json({ workflow: r.rows[0] });
});
app.delete('/api/workflows/:id', auth, async (req, res) => {
  const r = await pool.query('DELETE FROM workflows WHERE id=$1 AND user_id=$2', [req.params.id,req.userId]);
  res.status(r.rowCount ? 204 : 404).end();
});
app.post('/api/workflows/:id/run', auth, async (req, res) => {
  const w = await pool.query('SELECT id,definition FROM workflows WHERE id=$1 AND user_id=$2', [req.params.id,req.userId]);
  if (!w.rows[0]) return res.status(404).json({ error: 'Workflow not found' });
  const started = Date.now();
  try {
    const output = await runDefinition(w.rows[0].definition, req.body?.input || {}, req.userId);
    const saved = await pool.query('INSERT INTO executions(workflow_id,user_id,status,input,output,finished_at) VALUES($1,$2,$3,$4,$5,NOW()) RETURNING id',
      [w.rows[0].id,req.userId,'success',JSON.stringify(req.body?.input || {}),JSON.stringify(output)]);
    res.json({ executionId: saved.rows[0].id, durationMs: Date.now()-started, ...output });
  } catch (e) {
    await pool.query('INSERT INTO executions(workflow_id,user_id,status,input,error,finished_at) VALUES($1,$2,$3,$4,$5,NOW())',
      [w.rows[0].id,req.userId,'failed',JSON.stringify(req.body?.input || {}),String(e.message).slice(0,1000)]);
    res.status(400).json({ error: e.message });
  }
});
app.get('/api/executions', auth, async (req, res) => {
  const r = await pool.query('SELECT id,workflow_id,status,input,output,error,started_at,finished_at FROM executions WHERE user_id=$1 ORDER BY started_at DESC LIMIT 50',[req.userId]);
  res.json({ executions: r.rows });
});
app.put('/api/credentials/:name', auth, async (req, res) => {
  const name = String(req.params.name).replace(/[^a-zA-Z0-9_-]/g,'').slice(0,60);
  const secret = String(req.body?.secret || '');
  if (!name || secret.length < 8 || secret.length > 5000) return res.status(400).json({ error: 'Credential name and valid secret required' });
  await pool.query(`CREATE TABLE IF NOT EXISTS credentials (id BIGSERIAL PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,name TEXT NOT NULL,secret_enc TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(user_id,name))`);
  await pool.query('INSERT INTO credentials(user_id,name,secret_enc) VALUES($1,$2,$3) ON CONFLICT(user_id,name) DO UPDATE SET secret_enc=EXCLUDED.secret_enc,created_at=NOW()',[req.userId,name,encrypt(secret)]);
  res.json({ saved: true, name });
});
app.delete('/api/credentials/:name', auth, async (req, res) => {
  const r = await pool.query('DELETE FROM credentials WHERE user_id=$1 AND name=$2',[req.userId,req.params.name]);
  res.status(r.rowCount ? 204 : 404).end();
});
app.use((err,_req,res,_next) => { console.error(err); res.status(500).json({ error: 'Internal server error' }); });
const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`FlowLite API listening on ${port}`));