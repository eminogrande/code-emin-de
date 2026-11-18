#!/usr/bin/env -S node --no-warnings
import { realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unixRpc } from "./cli.mjs";
import { openPasskeyStore } from "./webauthn.mjs";

const DEFAULT_DATA_DIR = process.env.SWARM_DATA_DIR || join(homedir(), ".pi-durable");
const DEFAULT_SOCK = process.env.SWARM_SOCK || join(DEFAULT_DATA_DIR, "swarm.sock");
const DEFAULT_AUTH_DB = process.env.SWARM_AUTH_DB || join(DEFAULT_DATA_DIR, "webauthn.sqlite");
const RP_ID = process.env.WEBAUTHN_RP_ID || "code.emin.de";
const ORIGIN = process.env.WEBAUTHN_ORIGIN || `https://${RP_ID}`;
const PORT = Number(process.env.SWARM_WEB_PORT || "3001");
const COOKIE_NAME = ORIGIN.startsWith("https://") ? "__Host-s" : "swarm_s";

function parseCookies(header = "") {
  const out = {};
  for (const part of String(header).split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

async function readJsonLimited(req, maxBytes = 65_536) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > maxBytes) throw new Error("Payload too large");
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function sessionCookieHeader(token, maxAgeSec = 14 * 86_400) {
  const secure = ORIGIN.startsWith("https://") ? "; Secure" : "";
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure}`;
}

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function renderSolarizedGate({ enrollToken = "", enrollLabel = "" } = {}) {
  const mode = enrollToken ? "enroll" : "login";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#fdf6e3">
<title>code.emin.de</title>
<style>
:root{--paper:#fdf6e3;--paper-2:#eee8d5;--rule:#ddd6c1;--heading:#002b36;--ink:#073642;--muted:#4f646b;--accent:#b58900}
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;display:grid;place-items:center;background:var(--paper);color:var(--ink);font:1.125rem/1.6 ui-sans-serif,system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased;padding:1.5rem}
main{text-align:center;max-width:24rem}
button{appearance:none;background:var(--paper-2);color:var(--heading);border:1px solid var(--rule);padding:.75rem 1.4rem;font:inherit;cursor:pointer;border-radius:3px}
button:hover{border-color:var(--accent)}
p{margin:.9rem 0 0;color:var(--muted);font-size:.95rem;min-height:1.5em}
</style>
</head>
<body>
<main>
  <button id="go" autofocus>${mode === "enroll" ? `Enroll passkey (${enrollLabel.replace(/[<>&"]/g, "")})` : "Unlock with passkey"}</button>
  <p id="msg"></p>
</main>
<script>
const MODE = ${JSON.stringify(mode)};
const ENROLL = ${JSON.stringify(enrollToken)};
const b64ToBuf = (s) => Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));
const bufToB64 = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
const btn = document.getElementById('go');
const msg = document.getElementById('msg');

btn.onclick = async () => {
  btn.disabled = true;
  msg.textContent = '';
  try {
    if (MODE === 'enroll') {
      const r1 = await fetch('/auth/register/options', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ token: ENROLL })
      });
      const opt = await r1.json();
      if (!r1.ok) throw new Error(opt.error || 'Denied');
      opt.challenge = b64ToBuf(opt.challenge);
      opt.user.id = b64ToBuf(opt.user.id);
      opt.excludeCredentials = (opt.excludeCredentials || []).map(c => ({ ...c, id: b64ToBuf(c.id) }));
      const cred = await navigator.credentials.create({ publicKey: opt });
      const r2 = await fetch('/auth/register/verify', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          id: cred.id,
          type: cred.type,
          response: {
            clientDataJSON: bufToB64(cred.response.clientDataJSON),
            attestationObject: bufToB64(cred.response.attestationObject),
            transports: cred.response.getTransports ? cred.response.getTransports() : []
          }
        })
      });
      const v = await r2.json();
      if (!r2.ok) throw new Error(v.error || 'Enroll failed');
      location.replace('/');
    } else {
      const r1 = await fetch('/auth/login/options', { method: 'POST' });
      const opt = await r1.json();
      if (!r1.ok) throw new Error(opt.error || 'Locked');
      opt.challenge = b64ToBuf(opt.challenge);
      opt.allowCredentials = (opt.allowCredentials || []).map(c => ({ ...c, id: b64ToBuf(c.id) }));
      const cred = await navigator.credentials.get({ publicKey: opt });
      const r2 = await fetch('/auth/login/verify', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          id: cred.id,
          type: cred.type,
          response: {
            clientDataJSON: bufToB64(cred.response.clientDataJSON),
            authenticatorData: bufToB64(cred.response.authenticatorData),
            signature: bufToB64(cred.response.signature)
          }
        })
      });
      const v = await r2.json();
      if (!r2.ok) throw new Error(v.error || 'Denied');
      location.replace('/');
    }
  } catch (e) {
    msg.textContent = e.message || String(e);
    btn.disabled = false;
  }
};
</script>
</body>
</html>`;
}

function renderMinimalChat() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#fdf6e3">
<title>code.emin.de</title>
<style>
:root{--paper:#fdf6e3;--paper-2:#eee8d5;--rule:#ddd6c1;--heading:#002b36;--ink:#073642;--muted:#4f646b;--accent:#b58900}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--paper);color:var(--ink);font:1.125rem/1.62 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
body{display:flex;flex-direction:column;max-width:48rem;margin:0 auto;padding:0 1.25rem}
#log{flex:1;overflow-y:auto;padding:2rem 0 1.25rem;display:flex;flex-direction:column;gap:1.35rem}
.m{white-space:pre-wrap;word-break:break-word}
.u{color:var(--muted)}
.a{color:var(--heading)}
pre,code{font:0.92em/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--paper-2)}
code{padding:.1em .3em;border-radius:2px}
pre{padding:.75rem .9rem;overflow-x:auto;border-left:2px solid var(--rule);margin:.5rem 0}
form{padding:.75rem 0 1.25rem;border-top:1px solid var(--rule)}
textarea{width:100%;border:0;outline:0;background:transparent;color:var(--heading);font:inherit;resize:none;max-height:12rem;padding:0;margin:0}
textarea::placeholder{color:var(--muted);opacity:.65}
</style>
</head>
<body>
<div id="log" aria-live="polite"></div>
<form id="f">
  <textarea id="q" rows="1" placeholder="Ask…" autofocus></textarea>
</form>
<script>
const log = document.getElementById('log');
const q = document.getElementById('q');
let busy = false;

function add(cls, text) {
  if (!text) return null;
  const d = document.createElement('div');
  d.className = 'm ' + cls;
  d.textContent = text;
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
  return d;
}

async function hydrate() {
  try {
    const r = await fetch('/api/history');
    if (!r.ok) return;
    const d = await r.json();
    for (const e of (d.entries || [])) {
      if (e.role === 'user' && e.text) add('u', e.text.replace(/^\\[ROUTER_HINT:[^\\]]+\\]\\n/, ''));
      else if (e.role === 'assistant' && e.text) add('a', e.text);
    }
  } catch {}
}

function fit() {
  q.style.height = 'auto';
  q.style.height = Math.min(q.scrollHeight, 192) + 'px';
}
q.addEventListener('input', fit);

async function send(steer = false) {
  const text = q.value.trim();
  if (!text) return;
  q.value = '';
  fit();
  add('u', text);
  const pending = add('a', '…');
  busy = true;
  try {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ text, steer })
    });
    if (r.status === 401) { location.reload(); return; }
    const d = await r.json();
    pending.textContent = d.error ? ('Error: ' + d.error) : (d.text || '(done)');
  } catch (e) {
    pending.textContent = 'Error: ' + (e.message || e);
  } finally {
    busy = false;
    log.scrollTop = log.scrollHeight;
  }
}

q.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    send(busy);
  } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') {
    ev.preventDefault();
    send(true);
  }
});

hydrate();
</script>
</body>
</html>`;
}

export async function startWebServer({
  port = PORT,
  host = "127.0.0.1",
  sockPath = DEFAULT_SOCK,
  authDbPath = DEFAULT_AUTH_DB,
  rpId = RP_ID,
  origin = ORIGIN,
} = {}) {
  await mkdir(dirname(authDbPath), { recursive: true });
  const auth = openPasskeyStore(authDbPath, { rpId, rpName: rpId, expectedOrigin: origin });

  const server = createServer(async (req, res) => {
    const sendJson = (code, obj, extraHeaders = {}) => {
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS, ...extraHeaders });
      res.end(JSON.stringify(obj));
    };
    const sendHtml = (code, html, extraHeaders = {}) => {
      res.writeHead(code, { "Content-Type": "text/html; charset=utf-8", ...SECURITY_HEADERS, ...extraHeaders });
      res.end(html);
    };

    try {
      const url = new URL(req.url || "/", origin);
      const ip = req.headers["x-real-ip"] || req.socket.remoteAddress || "unknown";
      const cookies = parseCookies(req.headers.cookie);
      const authed = auth.verifySession(cookies[COOKIE_NAME]);

      if (req.method === "GET" && url.pathname === "/healthz") {
        return sendJson(200, { ok: true });
      }

      // SSH-bootstrapped one-time enrollment page (returns 404 unless token is valid & unused!)
      if (req.method === "GET" && url.pathname.startsWith("/enroll/")) {
        const rawTok = decodeURIComponent(url.pathname.slice("/enroll/".length));
        const valid = auth.checkEnrollToken(rawTok);
        if (!valid) {
          console.error(`[WEBAUTHN_FAIL] ip=${ip} reason=invalid_enroll_token`);
          return sendJson(404, { error: "not_found" });
        }
        return sendHtml(200, renderSolarizedGate({ enrollToken: rawTok, enrollLabel: valid.label }));
      }

      if (req.method === "POST" && url.pathname === "/auth/register/options") {
        const body = await readJsonLimited(req, 4096);
        try {
          return sendJson(200, auth.beginRegistration(body.token));
        } catch (err) {
          console.error(`[WEBAUTHN_FAIL] ip=${ip} reason=${err.message}`);
          return sendJson(403, { error: "Forbidden" });
        }
      }

      if (req.method === "POST" && url.pathname === "/auth/register/verify") {
        const body = await readJsonLimited(req, 16_384);
        try {
          const out = auth.finishRegistration(body);
          return sendJson(200, { ok: true, label: out.label }, { "Set-Cookie": sessionCookieHeader(out.sessionToken) });
        } catch (err) {
          console.error(`[WEBAUTHN_FAIL] ip=${ip} reason=${err.message}`);
          return sendJson(403, { error: err.message });
        }
      }

      if (req.method === "POST" && url.pathname === "/auth/login/options") {
        try {
          return sendJson(200, auth.beginAuthentication());
        } catch (err) {
          return sendJson(403, { error: err.message });
        }
      }

      if (req.method === "POST" && url.pathname === "/auth/login/verify") {
        const body = await readJsonLimited(req, 16_384);
        try {
          const out = auth.finishAuthentication(body);
          return sendJson(200, { ok: true }, { "Set-Cookie": sessionCookieHeader(out.sessionToken) });
        } catch (err) {
          console.error(`[WEBAUTHN_FAIL] ip=${ip} reason=${err.message}`);
          return sendJson(403, { error: "Authentication failed" });
        }
      }

      // Every route below requires a verified hardware passkey session
      if (!authed) {
        if (req.method === "GET" && url.pathname === "/") {
          return sendHtml(200, renderSolarizedGate());
        }
        return sendJson(401, { error: "Passkey required" });
      }

      if (req.method === "GET" && url.pathname === "/") {
        return sendHtml(200, renderMinimalChat());
      }

      if (req.method === "GET" && url.pathname === "/api/history") {
        const out = await unixRpc(sockPath, "GET", "/transcript?convId=1&max=40");
        return sendJson(out.status, out.body);
      }

      if (req.method === "POST" && url.pathname === "/api/chat") {
        const body = await readJsonLimited(req, 65_536);
        const text = String(body.text || "").trim();
        if (!text) return sendJson(400, { error: "Empty prompt" });
        const out = await unixRpc(sockPath, "POST", "/chat", {
          text,
          steer: !!body.steer,
          targetWorkerId: body.targetWorkerId || "lead",
          wait: true,
        });
        return sendJson(out.status, out.body);
      }

      if (req.method === "POST" && url.pathname === "/auth/logout") {
        auth.revokeSession(cookies[COOKIE_NAME]);
        return sendJson(200, { ok: true }, { "Set-Cookie": sessionCookieHeader("", 0) });
      }

      return sendJson(404, { error: "not_found" });
    } catch (err) {
      return sendJson(500, { error: err?.message || String(err) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  const shutdown = () => {
    server.close();
    auth.close();
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  return { server, auth, port };
}

const isMain = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  const cmd = process.argv[2] || "serve";
  if (cmd === "enroll") {
    await mkdir(dirname(DEFAULT_AUTH_DB), { recursive: true });
    const label = process.argv[3] || "passkey";
    const store = openPasskeyStore(DEFAULT_AUTH_DB, { rpId: RP_ID, rpName: RP_ID, expectedOrigin: ORIGIN });
    const { token, expiresAt } = store.createEnrollToken(label, 15 * 60_000);
    store.close();
    console.log(`${ORIGIN}/enroll/${token}  (label=${label}, expires=${new Date(expiresAt).toISOString()})`);
  } else if (cmd === "list-keys") {
    const store = openPasskeyStore(DEFAULT_AUTH_DB, { rpId: RP_ID, rpName: RP_ID, expectedOrigin: ORIGIN });
    console.log(JSON.stringify(store.listCredentials(), null, 2));
    store.close();
  } else {
    const { port } = await startWebServer();
    console.log(`swarm-web listening on 127.0.0.1:${port} (rpId=${RP_ID})`);
  }
}
