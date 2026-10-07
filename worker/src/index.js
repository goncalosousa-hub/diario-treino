// Servidor de avisos do Diário de Treino: agenda o fim do descanso e envia a notificação para o iPhone.
// Só aceita pedidos com um token do GitHub que consiga abrir o repositório de dados (DATA_REPO).
import { DurableObject } from 'cloudflare:workers';
import { generateVapidKeys, sendPush } from './webpush.js';

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

function corsHeaders(req, env) {
  const origin = req.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
  if (allowed.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let res;
    try {
      res = await env.HUB.get(env.HUB.idFromName('dono')).fetch(req);
    } catch {
      res = json({ error: 'erro interno' }, 500);
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  },
};

const clip = (v, n) => String(v == null ? '' : v).slice(0, n);

export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
  }

  async vapid() {
    let keys = await this.ctx.storage.get('vapid');
    if (!keys) {
      keys = await generateVapidKeys();
      await this.ctx.storage.put('vapid', keys);
    }
    return keys;
  }

  async authorized(req) {
    const m = (req.headers.get('Authorization') || '').match(/^Bearer\s+(\S{10,})$/);
    if (!m) return false;
    const token = m[1];
    if (this.env.TEST_TOKEN && token === this.env.TEST_TOKEN) return true; // só em testes locais
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
    const key = 'auth:' + Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
    const until = await this.ctx.storage.get(key);
    if (until && until > Date.now()) return true;
    let r;
    try {
      r = await fetch(`https://api.github.com/repos/${this.env.DATA_REPO}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'diario-treino-avisos',
        },
      });
    } catch {
      return false;
    }
    if (r.status !== 200) return false;
    await this.ctx.storage.put(key, Date.now() + 24 * 3600e3);
    return true;
  }

  async fetch(req) {
    const path = new URL(req.url).pathname.replace(/\/+$/, '') || '/';
    if (req.method === 'GET' && path === '/') return json({ ok: true, app: 'diario-treino' });
    if (req.method === 'GET' && path === '/vapid') return json({ publicKey: (await this.vapid()).publicKey });
    if (req.method !== 'POST') return json({ error: 'não encontrado' }, 404);
    if (!(await this.authorized(req))) return json({ error: 'sem autorização' }, 401);
    let body = {};
    try { body = await req.json(); } catch {}
    const now = Date.now();

    if (path === '/subscribe') {
      const s = body.subscription;
      const endpointOk = s && typeof s.endpoint === 'string' && s.endpoint.length < 1000 &&
        (/^https:\/\//.test(s.endpoint) || (this.env.TEST_TOKEN && /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(s.endpoint)));
      const ok = endpointOk && s.keys && typeof s.keys.p256dh === 'string' && typeof s.keys.auth === 'string';
      if (!ok) return json({ error: 'subscrição inválida' }, 400);
      const subs = ((await this.ctx.storage.get('subs')) || []).filter((x) => x.endpoint !== s.endpoint);
      subs.unshift({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth }, at: now });
      await this.ctx.storage.put('subs', subs.slice(0, 5));
      return json({ ok: true, devices: Math.min(subs.length, 5) });
    }
    if (path === '/unsubscribe') {
      const subs = ((await this.ctx.storage.get('subs')) || []).filter((x) => x.endpoint !== body.endpoint);
      await this.ctx.storage.put('subs', subs);
      return json({ ok: true, devices: subs.length });
    }
    if (path === '/rest') {
      const at = Number(body.at);
      if (!Number.isFinite(at) || at < now - 5000 || at > now + 30 * 60e3) return json({ error: 'hora inválida' }, 400);
      const pending = { at, title: clip(body.title || 'Descanso feito', 80), body: clip(body.body, 160), tag: 'descanso' };
      await this.ctx.storage.put('pending', pending);
      await this.ctx.storage.setAlarm(Math.max(at, now + 250));
      return json({ ok: true, at });
    }
    if (path === '/rest/cancel') {
      await this.ctx.storage.delete('pending');
      await this.ctx.storage.deleteAlarm();
      return json({ ok: true });
    }
    if (path === '/test') {
      const at = now + 8000;
      await this.ctx.storage.put('pending', { at, title: 'Aviso de teste', body: 'Os avisos de fim de descanso estão a funcionar.', tag: 'teste' });
      await this.ctx.storage.setAlarm(at);
      return json({ ok: true, at });
    }
    if (path === '/status') {
      const subs = (await this.ctx.storage.get('subs')) || [];
      return json({ ok: true, devices: subs.length, lastPush: (await this.ctx.storage.get('lastPush')) || null, pending: (await this.ctx.storage.get('pending')) || null });
    }
    return json({ error: 'não encontrado' }, 404);
  }

  async alarm() {
    const p = await this.ctx.storage.get('pending');
    if (!p) return;
    if (p.at > Date.now() + 1000) {
      await this.ctx.storage.setAlarm(p.at);
      return;
    }
    await this.ctx.storage.delete('pending');
    await this.broadcast({ title: p.title, body: p.body, tag: p.tag });
  }

  async broadcast(msg) {
    const subs = (await this.ctx.storage.get('subs')) || [];
    if (!subs.length) return;
    const keys = await this.vapid();
    const keep = [];
    const statuses = [];
    for (const s of subs) {
      try {
        const r = await sendPush(s, JSON.stringify(msg), keys, this.env.VAPID_SUBJECT);
        statuses.push(r.status);
        if (r.status === 404 || r.status === 410) continue; // subscrição que já não existe
      } catch {
        statuses.push(0);
      }
      keep.push(s);
    }
    if (keep.length !== subs.length) await this.ctx.storage.put('subs', keep);
    await this.ctx.storage.put('lastPush', { at: Date.now(), statuses });
  }
}
