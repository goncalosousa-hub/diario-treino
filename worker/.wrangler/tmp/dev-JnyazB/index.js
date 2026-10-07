var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
import { DurableObject } from "cloudflare:workers";

// src/webpush.js
var enc = new TextEncoder();
function b64url(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
__name(b64url, "b64url");
function unb64url(str) {
  const s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - s.length % 4) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
__name(unb64url, "unb64url");
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
__name(concat, "concat");
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}
__name(hkdf, "hkdf");
async function generateVapidKeys() {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { publicKey: b64url(publicRaw), privateJwk: await crypto.subtle.exportKey("jwk", kp.privateKey) };
}
__name(generateVapidKeys, "generateVapidKeys");
async function vapidHeader(endpoint, keys, subject) {
  const head = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1e3) + 12 * 3600,
    sub: subject
  })));
  const unsigned = `${head}.${claims}`;
  const key = await crypto.subtle.importKey("jwk", keys.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(unsigned)));
  return `vapid t=${unsigned}.${b64url(sig)}, k=${keys.publicKey}`;
}
__name(vapidHeader, "vapidHeader");
async function encryptPayload(payload, p256dh, authSecret) {
  const uaPublic = unb64url(p256dh);
  const auth = unb64url(authSecret);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));
  const ikm = await hkdf(auth, shared, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const plain = concat(typeof payload === "string" ? enc.encode(payload) : payload, new Uint8Array([2]));
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, plain));
  const header = new Uint8Array(21 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, cipher);
}
__name(encryptPayload, "encryptPayload");
async function sendPush(subscription, payload, keys, subject, { ttl = 120, urgency = "high" } = {}) {
  const body = await encryptPayload(payload, subscription.keys.p256dh, subscription.keys.auth);
  return fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      "TTL": String(ttl),
      "Urgency": urgency,
      "Authorization": await vapidHeader(subscription.endpoint, keys, subject)
    },
    body
  });
}
__name(sendPush, "sendPush");

// src/index.js
var json = /* @__PURE__ */ __name((data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
}), "json");
function corsHeaders(req, env) {
  const origin = req.headers.get("Origin") || "";
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const h = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
  if (allowed.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}
__name(corsHeaders, "corsHeaders");
var src_default = {
  async fetch(req, env) {
    const cors = corsHeaders(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    let res;
    try {
      res = await env.HUB.get(env.HUB.idFromName("dono")).fetch(req);
    } catch {
      res = json({ error: "erro interno" }, 500);
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  }
};
var clip = /* @__PURE__ */ __name((v, n) => String(v == null ? "" : v).slice(0, n), "clip");
var Hub = class extends DurableObject {
  static {
    __name(this, "Hub");
  }
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
  }
  async vapid() {
    let keys = await this.ctx.storage.get("vapid");
    if (!keys) {
      keys = await generateVapidKeys();
      await this.ctx.storage.put("vapid", keys);
    }
    return keys;
  }
  async authorized(req) {
    const m = (req.headers.get("Authorization") || "").match(/^Bearer\s+(\S{10,})$/);
    if (!m) return false;
    const token = m[1];
    if (this.env.TEST_TOKEN && token === this.env.TEST_TOKEN) return true;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
    const key = "auth:" + Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
    const until = await this.ctx.storage.get(key);
    if (until && until > Date.now()) return true;
    let r;
    try {
      r = await fetch(`https://api.github.com/repos/${this.env.DATA_REPO}`, {
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "diario-treino-avisos"
        }
      });
    } catch {
      return false;
    }
    if (r.status !== 200) return false;
    await this.ctx.storage.put(key, Date.now() + 24 * 36e5);
    return true;
  }
  async fetch(req) {
    const path = new URL(req.url).pathname.replace(/\/+$/, "") || "/";
    if (req.method === "GET" && path === "/") return json({ ok: true, app: "diario-treino" });
    if (req.method === "GET" && path === "/vapid") return json({ publicKey: (await this.vapid()).publicKey });
    if (req.method !== "POST") return json({ error: "n\xE3o encontrado" }, 404);
    if (!await this.authorized(req)) return json({ error: "sem autoriza\xE7\xE3o" }, 401);
    let body = {};
    try {
      body = await req.json();
    } catch {
    }
    const now = Date.now();
    if (path === "/subscribe") {
      const s = body.subscription;
      const endpointOk = s && typeof s.endpoint === "string" && s.endpoint.length < 1e3 && (/^https:\/\//.test(s.endpoint) || this.env.TEST_TOKEN && /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(s.endpoint));
      const ok = endpointOk && s.keys && typeof s.keys.p256dh === "string" && typeof s.keys.auth === "string";
      if (!ok) return json({ error: "subscri\xE7\xE3o inv\xE1lida" }, 400);
      const subs = (await this.ctx.storage.get("subs") || []).filter((x) => x.endpoint !== s.endpoint);
      subs.unshift({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth }, at: now });
      await this.ctx.storage.put("subs", subs.slice(0, 5));
      return json({ ok: true, devices: Math.min(subs.length, 5) });
    }
    if (path === "/unsubscribe") {
      const subs = (await this.ctx.storage.get("subs") || []).filter((x) => x.endpoint !== body.endpoint);
      await this.ctx.storage.put("subs", subs);
      return json({ ok: true, devices: subs.length });
    }
    if (path === "/rest") {
      const at = Number(body.at);
      if (!Number.isFinite(at) || at < now - 5e3 || at > now + 30 * 6e4) return json({ error: "hora inv\xE1lida" }, 400);
      const pending = { at, title: clip(body.title || "Descanso feito", 80), body: clip(body.body, 160), tag: "descanso" };
      await this.ctx.storage.put("pending", pending);
      await this.ctx.storage.setAlarm(Math.max(at, now + 250));
      return json({ ok: true, at });
    }
    if (path === "/rest/cancel") {
      await this.ctx.storage.delete("pending");
      await this.ctx.storage.deleteAlarm();
      return json({ ok: true });
    }
    if (path === "/test") {
      const at = now + 8e3;
      await this.ctx.storage.put("pending", { at, title: "Aviso de teste", body: "Os avisos de fim de descanso est\xE3o a funcionar.", tag: "teste" });
      await this.ctx.storage.setAlarm(at);
      return json({ ok: true, at });
    }
    if (path === "/status") {
      const subs = await this.ctx.storage.get("subs") || [];
      return json({ ok: true, devices: subs.length, lastPush: await this.ctx.storage.get("lastPush") || null, pending: await this.ctx.storage.get("pending") || null });
    }
    return json({ error: "n\xE3o encontrado" }, 404);
  }
  async alarm() {
    const p = await this.ctx.storage.get("pending");
    if (!p) return;
    if (p.at > Date.now() + 1e3) {
      await this.ctx.storage.setAlarm(p.at);
      return;
    }
    await this.ctx.storage.delete("pending");
    await this.broadcast({ title: p.title, body: p.body, tag: p.tag });
  }
  async broadcast(msg) {
    const subs = await this.ctx.storage.get("subs") || [];
    if (!subs.length) return;
    const keys = await this.vapid();
    const keep = [];
    const statuses = [];
    for (const s of subs) {
      try {
        const r = await sendPush(s, JSON.stringify(msg), keys, this.env.VAPID_SUBJECT);
        statuses.push(r.status);
        if (r.status === 404 || r.status === 410) continue;
      } catch {
        statuses.push(0);
      }
      keep.push(s);
    }
    if (keep.length !== subs.length) await this.ctx.storage.put("subs", keep);
    await this.ctx.storage.put("lastPush", { at: Date.now(), statuses });
  }
};

// ../../.npm/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../.npm/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-efsSO9/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// ../../.npm/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-efsSO9/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  Hub,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
