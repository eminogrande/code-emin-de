#!/usr/bin/env -S node --no-warnings
import { randomBytes, timingSafeEqual } from "node:crypto";
import { realpathSync, writeFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unixRpc } from "./cli.mjs";
import { ID_RE, MAX_BODY_BYTES, storeImages } from "./image-util.mjs";
import { renderMarkdown } from "./markdown.mjs";
import { openPasskeyStore } from "./webauthn.mjs";

const DEFAULT_DATA_DIR = process.env.SWARM_DATA_DIR || join(homedir(), ".pi-durable");
const DEFAULT_SOCK = process.env.SWARM_SOCK || join(DEFAULT_DATA_DIR, "swarm.sock");
const DEFAULT_AUTH_DB = process.env.SWARM_AUTH_DB || join(DEFAULT_DATA_DIR, "webauthn.sqlite");
const DEFAULT_BRIDGE_SECRET_FILE = process.env.SWARM_BRIDGE_SECRET_FILE || join(DEFAULT_DATA_DIR, "ssh-bridge.secret");
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

function extOf(mimeType) {
  return mimeType === "image/jpeg" ? "jpg" : String(mimeType).replace("image/", "");
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
    "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' http://127.0.0.1:4199; img-src 'self' data: blob: https: http:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Cross-Origin-Opener-Policy": "same-origin",
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
main{text-align:center;max-width:26rem;display:flex;flex-direction:column;gap:.65rem;align-items:center}
.row{display:flex;gap:.6rem;flex-wrap:wrap;justify-content:center}
button{appearance:none;background:var(--paper-2);color:var(--heading);border:1px solid var(--rule);padding:.72rem 1.25rem;font:inherit;cursor:pointer;border-radius:3px}
button:hover{border-color:var(--accent)}
p{margin:.4rem 0 0;color:var(--muted);font-size:.95rem;min-height:1.5em}
</style>
</head>
<body>
<main>
  <div class="row">
    <button id="go" autofocus>${mode === "enroll" ? `Enroll passkey (${enrollLabel.replace(/[<>&"]/g, "")})` : "Unlock with passkey"}</button>
    <button id="cardBtn" style="display:none">${mode === "enroll" ? "Enroll Nuri Smartcard (ACR39U)" : "Unlock with Nuri Smartcard"}</button>
  </div>
  <p id="msg"></p>
</main>
<script>
const MODE = ${JSON.stringify(mode)};
const ENROLL = ${JSON.stringify(enrollToken)};
const BRIDGE = 'http://127.0.0.1:4199';
const b64ToBuf = (s) => Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));
const bufToB64 = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
const btn = document.getElementById('go');
const cardBtn = document.getElementById('cardBtn');
const msg = document.getElementById('msg');

// Detect local Nuri PC/SC bridge on Mac (127.0.0.1:4199) so ACR39U contact card works in Safari!
fetch(BRIDGE + '/healthz').then(r => r.ok ? r.json() : null).then(d => {
  if (d && d.ok && d.readers && d.readers.length) cardBtn.style.display = '';
}).catch(() => {});

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

cardBtn.onclick = async () => {
  cardBtn.disabled = true;
  msg.textContent = 'Reading Nuri Smartcard…';
  try {
    if (MODE === 'enroll') {
      const r1 = await fetch('/auth/register/options', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ token: ENROLL })
      });
      const opt = await r1.json();
      if (!r1.ok) throw new Error(opt.error || 'Denied');
      const signed = await (await fetch(BRIDGE + '/webauthn-create', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ options: opt, reader: 'ACR39' })
      })).json();
      if (signed.error) throw new Error(signed.error);
      const r2 = await fetch('/auth/register/verify', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(signed)
      });
      const v = await r2.json();
      if (!r2.ok) throw new Error(v.error || 'Enroll failed');
      location.replace('/');
    } else {
      const r1 = await fetch('/auth/login/options', { method: 'POST' });
      const opt = await r1.json();
      if (!r1.ok) throw new Error(opt.error || 'Locked');
      const signed = await (await fetch(BRIDGE + '/webauthn-get', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ options: opt, reader: 'ACR39' })
      })).json();
      if (signed.error) throw new Error(signed.error);
      const r2 = await fetch('/auth/login/verify', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(signed)
      });
      const v = await r2.json();
      if (!r2.ok) throw new Error(v.error || 'Denied');
      location.replace('/');
    }
  } catch (e) {
    msg.textContent = e.message || String(e);
    cardBtn.disabled = false;
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
.m{word-break:break-word}
.m.u{white-space:pre-wrap}
.a{color:var(--heading)}
.a>:first-child{margin-top:0}
.a p,.a ul,.a ol,.a blockquote,.a table,.a .cb,.a .mmd{margin:.55rem 0}
.a h1,.a h2,.a h3,.a h4{line-height:1.3;margin:1rem 0 .4rem;color:var(--heading)}
.a h1{font-size:1.4em}.a h2{font-size:1.22em}.a h3{font-size:1.08em}
.a ul,.a ol{padding-left:1.4rem}
.a li{margin:.2rem 0}
.a blockquote{margin-left:0;padding:.15rem .9rem;border-left:3px solid var(--accent);color:var(--muted)}
.a table{border-collapse:collapse;font-size:.95em;display:block;overflow-x:auto}
.a th,.a td{border:1px solid var(--rule);padding:.35rem .6rem;text-align:left}
.a th{background:var(--paper-2)}
.a hr{border:0;border-top:1px solid var(--rule);margin:1rem 0}
.a a{color:var(--accent)}
.cb{position:relative}
.mmd-toggle{appearance:none;background:var(--paper);color:var(--muted);border:1px solid var(--rule);font:0.72em/1 ui-sans-serif,system-ui,sans-serif;padding:.28rem .5rem;border-radius:3px;cursor:pointer;opacity:.75}
.mmd-toggle:hover{opacity:1;border-color:var(--accent)}
.mmd{position:relative;border:1px solid var(--rule);border-radius:3px;padding:.5rem}
.mmd .mmd-toggle{margin:0 0 .35rem;display:inline-block}
.mmd-out{overflow-x:auto}
.mmd-out svg{max-width:100%;height:auto}
.mmd-err{border-color:#cb4b16}
.mmd-msg{color:#cb4b16;font-size:.9em;margin:.35rem 0 0}
/* --- sidebars --- */
body{display:grid;grid-template-columns:13.5rem minmax(0,1fr) 15.5rem;max-width:none;height:100dvh;padding:0}
main{display:flex;flex-direction:column;min-width:0;max-width:48rem;margin:0 auto;padding:0 1.25rem;width:100%;height:100dvh}
aside{overflow-y:auto;overscroll-behavior:contain;font-size:.86rem;padding:.85rem .7rem 1.5rem;background:#f7f0dc}
#leftCol{border-right:1px solid var(--rule)}
#rightCol{border-left:1px solid var(--rule)}
aside h2{margin:0 0 .5rem;font-size:.7rem;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);font-weight:600}
.sect{margin-bottom:1.1rem}
.tgt{display:block;width:100%;text-align:left;appearance:none;background:transparent;color:var(--ink);border:1px solid transparent;border-radius:3px;padding:.35rem .45rem;font:inherit;cursor:pointer;margin-bottom:.15rem}
.tgt:hover{border-color:var(--rule)}
.tgt[aria-current="true"]{background:var(--paper);border-color:var(--accent);color:var(--heading)}
.tgt .tname{display:block;font-weight:600}
.tgt .tmeta{display:block;color:var(--muted);font-size:.78rem;word-break:break-all}
#agents{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.4rem}
.wk{border:1px solid var(--rule);border-radius:3px;padding:.4rem .5rem;background:var(--paper)}
.wk .wtop{display:flex;align-items:center;gap:.35rem}
.wk .wrole{font-weight:600;word-break:break-all}
.wk .wsub{color:var(--muted);font-size:.76rem;display:block;word-break:break-all}
.wk .werr{color:#cb4b16}
.dot{width:.5rem;height:.5rem;border-radius:50%;flex:none;background:var(--muted)}
.s-running .dot{background:#859900;animation:pulse 1.4s ease-in-out infinite}
.s-failed .dot,.s-failed_turn_limit .dot{background:#cb4b16}
.s-idle_done .dot{background:#93a1a1}
.s-idle .dot{background:#93a1a1}
@keyframes pulse{50%{opacity:.25}}
.empty{color:var(--muted);font-size:.8rem;margin:.2rem 0}
aside a{color:var(--accent)}
#topbar{display:none;grid-column:1/-1;align-items:center;justify-content:space-between;gap:.5rem;padding:.45rem .7rem;border-bottom:1px solid var(--rule);background:var(--paper-2)}
#topbar button{appearance:none;background:var(--paper);color:var(--heading);border:1px solid var(--rule);border-radius:3px;padding:.3rem .6rem;font:inherit;font-size:.85rem;cursor:pointer}
#topbar .brand{font-size:.8rem;color:var(--muted)}
#backdrop{background:#002b3655;z-index:8}
@media (max-width:959px){
  body{grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr)}
  main{grid-row:2;padding:0 1rem}
  #topbar{display:flex}
  aside{position:fixed;top:0;bottom:0;width:15rem;z-index:9;background:var(--paper);box-shadow:0 0 12px #002b3633;transition:transform .18s ease;padding-top:3rem}
  #leftCol{left:0;transform:translateX(-102%);border-right:1px solid var(--rule)}
  #rightCol{right:0;transform:translateX(102%);border-left:1px solid var(--rule)}
  aside.open{transform:none}
  #backdrop[hidden]{display:none}
}
.hljs-comment,.hljs-quote{color:#93a1a1;font-style:italic}
.hljs-keyword,.hljs-selector-tag,.hljs-literal{color:#859900}
.hljs-string,.hljs-attr{color:#2aa198}
.hljs-number,.hljs-built_in{color:#d33682}
.hljs-title,.hljs-name{color:#268bd2}
pre,code{font:0.92em/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--paper-2)}
code{padding:.1em .3em;border-radius:2px}
pre{padding:.75rem .9rem;overflow-x:auto;border-left:2px solid var(--rule);margin:.5rem 0}
#sshBar{display:none;padding:.65rem .85rem;background:var(--paper-2);border-top:1px solid var(--accent);font-size:.96rem;align-items:center;justify-content:space-between;gap:.75rem;flex-wrap:wrap}
#sshBar button{appearance:none;background:var(--paper);color:var(--heading);border:1px solid var(--rule);padding:.32rem .75rem;font:inherit;cursor:pointer;border-radius:3px}
#sshBar button:hover{border-color:var(--accent)}
.m.err{color:#dc322f;font-size:.9rem}
#statusBar{display:flex;flex-wrap:wrap;gap:.35rem .7rem;align-items:center;padding:.3rem 0;border-top:1px solid var(--rule);font-size:.75rem;color:var(--muted)}
#statusBar[hidden]{display:none}
#statusBar .sb-model{max-width:24rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--heading);font-weight:600}
#statusBar select.sb-model{appearance:none;background:var(--paper);border:1px solid var(--rule);border-radius:2px;font:inherit;color:var(--heading);font-weight:600;padding:0 .2rem;max-width:24rem}
#archived{margin-top:.6rem}
.cb .copy{position:absolute;top:.35rem;right:.4rem;appearance:none;border:1px solid var(--rule);border-radius:3px;background:var(--paper);color:var(--muted);font:inherit;font-size:.72rem;padding:.2rem .45rem;cursor:pointer}
.cb .copy:hover,.cb .copy:focus-visible{color:var(--heading);border-color:var(--accent)}
.mini-form{display:flex;flex-direction:column;gap:.4rem;margin:.6rem 0}
.mini-form input,.mini-form select,.mini-form textarea{box-sizing:border-box;width:100%;border:1px solid var(--rule);border-radius:3px;background:var(--paper);color:var(--ink);font:inherit;font-size:.8rem;padding:.35rem;resize:vertical}
.mini-form button,.wk button,#toggle-worker-form{appearance:none;border:1px solid var(--rule);border-radius:3px;background:var(--paper);color:var(--heading);font:inherit;font-size:.78rem;padding:.3rem .45rem;cursor:pointer}
.mini-form button:hover,.wk button:hover,#toggle-worker-form:hover{border-color:var(--accent)}
.mini-form label{font-size:.75rem;color:var(--muted)}
.mini-form label input{width:4.5rem;margin:0 .25rem}
.wk .wactions{display:flex;gap:.35rem;margin-top:.35rem}
.wk .wgoal{font-size:.72rem;color:var(--muted);margin-top:.25rem;white-space:pre-wrap}
#archived summary{cursor:pointer;color:var(--muted);font-size:.75rem;letter-spacing:.06em;text-transform:uppercase}
#archive{list-style:none;margin:.4rem 0 0;padding:0;display:flex;flex-direction:column;gap:.3rem}
#archive .wsub{color:var(--muted);font-size:.75rem;display:block}
#archive .werr{color:#cb4b16;font-size:.75rem;display:block}
#statusBar select.sb-model:disabled{opacity:.55}
#statusBar .sb-err{color:#dc322f;max-width:20rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#statusBar .sb-num{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-variant-numeric:tabular-nums}
#statusBar .warn{color:var(--accent)}
#statusBar .bad{color:#dc322f}
#statusBar .sb-workers{border:1px solid var(--rule);border-radius:2px;padding:0 .35rem}
#statusBar .sb-workers.live{border-color:#2aa198;color:#2aa198}
#statusBar .sb-workers.bad{border-color:#dc322f}
form{padding:.75rem 0 1.25rem;border-top:1px solid var(--rule)}
textarea{width:100%;border:0;outline:0;background:transparent;color:var(--heading);font:inherit;resize:none;max-height:12rem;padding:0;margin:0}
textarea::placeholder{color:var(--muted);opacity:.65}
#composer-row{display:flex;gap:.5rem;align-items:flex-start}
#composer-row textarea{flex:1}
#attach-btn{flex:none;border:1px solid var(--rule);border-radius:.4rem;background:transparent;color:var(--muted);font:inherit;font-size:.8rem;padding:.1rem .45rem;cursor:pointer}
#attach-btn:hover,#attach-btn:focus-visible{color:var(--heading);border-color:#2aa198}
#pending-images{display:flex;gap:.5rem;flex-wrap:wrap;padding-bottom:.5rem}
#pending-images[hidden]{display:none}
#pending-images figure{margin:0;position:relative;width:5rem;text-align:center}
#pending-images img{width:5rem;height:4rem;object-fit:cover;border-radius:.35rem;border:1px solid var(--rule);display:block}
#pending-images figcaption{font-size:.6rem;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#pending-images .rm{position:absolute;top:-.35rem;right:-.35rem;width:1.15rem;height:1.15rem;line-height:1;border-radius:50%;border:1px solid var(--rule);background:var(--paper);color:var(--heading);cursor:pointer;font-size:.85rem;padding:0}
#attach-status{margin:.35rem 0 0;font-size:.7rem;color:var(--muted);min-height:1em}
#attach-status.bad{color:#dc322f}
.himages{display:flex;gap:.4rem;flex-wrap:wrap;margin-top:.4rem}
.himages img{max-width:9rem;max-height:7rem;border-radius:.35rem;border:1px solid var(--rule);display:block}
</style>
</head>
<body>
<div id="topbar">
  <button type="button" id="tLeft" aria-controls="leftCol" aria-expanded="false">Chats</button>
  <span class="brand">code.emin.de</span>
  <button type="button" id="tRight" aria-controls="rightCol" aria-expanded="false">Agents</button>
</div>
<div id="backdrop" hidden></div>
<aside id="leftCol">
  <div class="sect">
    <h2>Orchestrations</h2>
    <button type="button" class="tgt" data-target="lead" data-conv="1" aria-current="true">
      <span class="tname">General</span>
      <span class="tmeta">main orchestration</span>
    </button>
    <div id="targets"></div>
    <form id="new-orch" class="mini-form">
      <input id="orch-name" maxlength="60" required placeholder="New job name" aria-label="New orchestration name">
      <button type="submit">Add orchestration</button>
    </form>
    <p id="orch-status" class="empty" aria-live="polite"></p>
  </div>
</aside>
<main>
  <div id="log" aria-live="polite"></div>
  <div id="sshBar">
    <span id="sshDesc"></span>
    <span>
      <button type="button" id="sshApprove">Sign with Smartcard</button>
      <button type="button" id="sshDeny">Deny</button>
    </span>
  </div>
  <div id="statusBar" aria-live="off"></div>
  <form id="f">
    <div id="pending-images" hidden></div>
    <div id="composer-row">
      <button type="button" id="attach-btn" aria-label="Attach images" title="Attach images (images only, max 3 × 4MB)">Attach</button>
      <input type="file" id="attach-input" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden>
      <textarea id="q" rows="1" placeholder="Ask…" autofocus></textarea>
    </div>
    <p id="attach-status" aria-live="polite"></p>
  </form>
</main>
<aside id="rightCol">
  <div class="sect">
    <h2>Agents</h2>
    <button type="button" id="toggle-worker-form">New worker</button>
    <form id="new-worker" class="mini-form" hidden>
      <input id="worker-name" maxlength="60" required placeholder="Worker name" aria-label="Worker name">
      <select id="worker-role" aria-label="Worker role"><option>coder</option><option>planner</option><option>reviewer</option><option>watcher</option><option>support</option><option>social</option></select>
      <select id="worker-mode" aria-label="Worker schedule"><option value="once">One task</option><option value="recurring">Recurring</option></select>
      <label id="worker-interval-label" hidden>Every <input id="worker-minutes" type="number" min="1" max="44640" value="5"> minutes</label>
      <textarea id="worker-goal" rows="4" maxlength="12000" required placeholder="What should this worker do?"></textarea>
      <button type="submit">Create worker</button>
    </form>
    <p id="worker-form-status" class="empty" aria-live="polite"></p>
    <ul id="agents"></ul>
    <p class="empty" id="agentsEmpty">No running agents.</p>
    <details id="archived">
      <summary>Archived workers</summary>
      <ul id="archive"></ul>
    </details>
  </div>
</aside>
<!-- No defer: these must define window.chatRender/window.chatImages before the inline boot script below runs. -->
<script src="/chat-client.js"></script>
<script src="/chat-images.js"></script>
<script>
const log = document.getElementById('log');
const q = document.getElementById('q');
const sshBar = document.getElementById('sshBar');
const sshDesc = document.getElementById('sshDesc');
const sshApprove = document.getElementById('sshApprove');
const sshDeny = document.getElementById('sshDeny');
const BRIDGE = 'http://127.0.0.1:4199';
var busy = false;
var workersTimer = null;
var sshTimer = null;
let currentSshReq = null;

async function safeJson(r) {
  if (!r) return null;
  if (typeof r.text === 'function') {
    const raw = await r.text();
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { return { _nonJson: true, status: r.status }; }
  }
  return r.json();
}

function renderMd(text) {
  return fetch('/api/render', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => (d && d.html) || '')
    .catch(() => '');
}

function add(cls, text) {
  if (!text) return null;
  const d = document.createElement('div');
  d.className = 'm ' + cls;
  d.textContent = text;
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
  return d;
}

// \`html\` is server-rendered markdown: already sanitized by src/markdown.mjs
function atBottom() {
  return log.scrollHeight - log.scrollTop - log.clientHeight < 40;
}

function addHtml(cls, html, fallback, id) {
  const d = document.createElement('div');
  d.className = 'm ' + cls;
  if (id) d.dataset.id = id; else d.classList.add('pending');
  if (html) d.innerHTML = html; else d.textContent = fallback || '';
  const stick = atBottom();
  log.appendChild(d);
  if (stick) log.scrollTop = log.scrollHeight;
  if (window.chatRender) window.chatRender(d);
  return d;
}

// id -> html last applied, so a re-fetch never rebuilds unchanged entries
const rendered = new Map();

// Reconcile rendered log against transcript order: reuse by id, insert new, drop vanished.
// An unsent-input draft, selection and scroll stay untouched unless the log was at the bottom.
async function syncHistory() {
  const r = await fetch('/api/history?convId=' + encodeURIComponent(currentConv));
  if (r.status === 401) { location.reload(); return; }
  if (!r.ok) throw new Error('history ' + r.status);
  const d = await safeJson(r);
  if (!d || d._nonJson) throw new Error('history non-json');
  const entries = (d.entries || []).filter((e) => e.role === 'user' || e.role === 'assistant');
  const keep = atBottom();
  const prevTop = log.scrollTop;
  const known = new Set(entries.map((e) => String(e.id)));
  for (const n of Array.from(log.children)) {
    if (n.dataset.id && !known.has(n.dataset.id)) { n.remove(); rendered.delete(n.dataset.id); }
  }
  // Walk transcript order, keeping each entry in its slot (never a full rebuild)
  let after = null;
  for (const e of entries) {
    const html = e.html || '';
    const cls = e.role === 'user' ? 'u' : (e.isError ? 'a err' : 'a');
    let node = known.has(String(e.id)) ? log.querySelector('[data-id="' + e.id + '"]') : null;
    if (!node) {
      node = addHtml(cls, html, e.text, e.id);
    } else if (html && rendered.get(e.id) !== html) {
      node.className = 'm ' + cls;
      node.innerHTML = html;
      if (window.chatRender) window.chatRender(node);
    }
    // Attachment history: ids only, images streamed by the authenticated /api/image endpoint.
    const imgsSig = (e.images || []).join(',');
    if (imgsSig && node.dataset.images !== imgsSig && window.chatImages) {
      window.chatImages.renderHistory(node, e.images);
      node.dataset.images = imgsSig;
    }
    rendered.set(e.id, html);
    const want = after ? after.nextElementSibling : log.firstElementChild;
    if (node !== want) log.insertBefore(node, want);
    after = node;
  }
  // Optimistic nodes (no data-id) go as soon as their real counterpart landed. The reply
  // placeholder survives until the last transcript entry is the assistant reply.
  const lastRole = entries.length ? entries[entries.length - 1].role : '';
  const userTexts = new Set(entries.filter((e) => e.role === 'user').map((e) => (e.text || '').trim()));
  for (const p of Array.from(log.querySelectorAll('.pending'))) {
    if (p.dataset.settled === '1') {
      if (p.dataset.local === '1') {
        const latestId = entries.length ? String(entries[entries.length - 1].id) : '';
        if (latestId && latestId !== (p.dataset.anchorId || '')) p.remove();
        continue;
      }
      if (entries.length) p.remove();
      continue;
    }
    if (p.classList.contains('u') ? (userTexts.has((p.dataset.raw || '').trim()) || p.querySelector('.himages')) : lastRole === 'assistant') p.remove();
  }
  if (keep) log.scrollTop = log.scrollHeight; else log.scrollTop = prevTop;
}

// Poll history only while no chat request is active; back off on errors; pause when hidden.
const POLL_MS = 3000;
var pollTimer = null;
var backoff = POLL_MS;

function schedulePoll(ms) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(tick, ms);
}

async function tick() {
  if (document.hidden || busy) return schedulePoll(POLL_MS);
  try {
    await syncHistory();
    backoff = POLL_MS;
  } catch {
    backoff = Math.min(backoff * 2, 15000);
  }
  schedulePoll(backoff);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearTimeout(pollTimer);
  else schedulePoll(0);
});

async function hydrate() {
  try { await syncHistory(); } catch {}
  try { await pollWorkers(); } catch {}
}

// ---- sidebars: send target + live agents (textContent only, read-only API) ----
let target = 'lead';
let currentConv = 1;
let currentOrchestration = 'general';
let orchestrationList = [{ id: 'general', name: 'General', conversationId: 1 }];
let allWorkers = [];
const targetsBox = document.getElementById('targets');
const agentsUl = document.getElementById('agents');
const agentsEmpty = document.getElementById('agentsEmpty');
const archiveBox = document.getElementById('archived');
const archiveUl = document.getElementById('archive');
const statusBar = document.getElementById('statusBar');

function fmtTok(n) {
  if (!n) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'k';
  return String(n);
}

function truncId(id, max) {
  const s = String(id || '');
  const lim = max || 40;
  return s.length > lim ? s.slice(0, lim - 1) + '\u2026' : s;
}

// % of the context window still free; null when unknown (hides the field).
function ctxFreePct(used, win) {
  const u = Number(used) || 0;
  const w = Number(win) || 0;
  if (!(w > 0)) return null;
  return Math.max(0, Math.min(100, Math.round((1 - u / w) * 100)));
}

// Severity of the remaining budget: '' ok, 'warn' <25%, 'bad' <10%.
function budgetLevel(free) {
  if (free === null || free === undefined) return '';
  return free < 10 ? 'bad' : free < 25 ? 'warn' : '';
}

function workerCountText(list) {
  const l = list || [];
  const running = l.filter(isRunning).length;
  return running + ' running / ' + l.length + ' total';
}

// Badge level by worst worker state: 'bad' on failures, 'live' while something runs.
function workerLevel(list) {
  const l = list || [];
  if (l.some((w) => w && /fail/i.test(String(w.state || '')))) return 'bad';
  return l.some(isRunning) ? 'live' : '';
}

function sbField(cls) {
  const s = document.createElement('span');
  s.className = 'sb ' + cls;
  s.hidden = true;
  statusBar.appendChild(s);
  return s;
}
// Allowlisted Lead model choices (provider/modelId); mirrors LEAD_MODEL_CHOICES in src/models.mjs.
const MODEL_CHOICES = [
  ['llmgateway', 'kimi-k3.1-pro'],
  ['paymentrequired', 'k3.1-pro'],
  ['paymentrequired', 'k3.1-pro-highspeed'],
  ['paymentrequired', 'kimi-for-coding'],
  ['paymentrequired', 'kimi-for-coding-highspeed'],
  ['paymentrequired', 'deepseek-v4.1-flash-abliterated'],
  ['paymentrequired', 'gemini-3.5-flash-lite'],
  ['paymentrequired', 'gemini-3.8-flash-high'],
  ['paymentrequired', 'gemini-4-argon-high'],
  ['paymentrequired', 'glm-5.3-abliterated'],
  ['paymentrequired', 'glm-5.3-flash-abliterated'],
  ['paymentrequired', 'cohere/north-mini-code:free'],
  ['paymentrequired', 'dots-studio/dots-3-note-preview:free'],
  ['paymentrequired', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free'],
  ['paymentrequired', 'nvidia/nemotron-3-ultra-550b-a55b:free'],
  ['paymentrequired', 'nvidia/nemotron-3.5-lightning:free'],
  ['allmodels', 'moonshotai/kimi-k3.1-pro-abliterated'],
  ['llmgateway', 'deepseek-v4.1-flash-uncensored'],
  ['allmodels', 'deepseek/deepseek-v4.1-flash-abliterated'],
  ['llmgateway', 'glm-5.3'],
  ['allmodels', 'z-ai/glm-5.3-abliterated'],
];
const PROVIDER_LABEL = { llmgateway: 'LLMGateway', allmodels: 'AllModels', paymentrequired: 'PaymentRequired' };
// Readable, provider-prefixed labels: a bare id column would read identically in 13rem.
const MODEL_LABELS = { 'paymentrequired k3.1-pro': 'Kimi K3.1 Pro · free router' };
function modelLabel(pv, md) {
  return MODEL_LABELS[pv + ' ' + md] || (PROVIDER_LABEL[pv] || pv) + ' · ' + md;
}
const sbModel = statusBar ? document.createElement('select') : null;
const sbErr = statusBar ? sbField('sb-err') : null;
if (sbModel) {
  sbModel.className = 'sb sb-model';
  sbModel.hidden = true;
  sbModel.setAttribute('aria-label', 'Lead model (applies to new turns globally)');
  sbModel.title = 'Lead model for new turns (global)';
  for (const [pv, md] of MODEL_CHOICES) {
    const o = document.createElement('option');
    o.value = pv + ' ' + md;
    o.textContent = modelLabel(pv, md);
    sbModel.appendChild(o);
  }
  statusBar.appendChild(sbModel);
}
let modelPending = false;

function showModelError(msg) {
  if (!sbErr) return;
  sbErr.textContent = msg || '';
  sbErr.hidden = !msg;
  sbErr.title = msg || '';
}

if (sbModel) {
  sbModel.onchange = async () => {
    if (modelPending) return;
    const chosen = sbModel.value.split(' ');
    const provider = chosen[0];
    const modelId = chosen.slice(1).join(' ');
    const prev = sbModel.dataset.active || '';
    modelPending = true;
    sbModel.disabled = true;
    showModelError('');
    try {
      const r = await fetch('/api/model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, modelId }),
      });
      const d = await safeJson(r);
      if (!r.ok || !d || d._nonJson || d.error) {
        throw new Error((d && d.error) || 'Switch failed');
      }
      if (d.active) {
        sbModel.dataset.active = d.active.provider + ' ' + d.active.modelId;
        sbModel.value = sbModel.dataset.active;
      }
      if (d.warning) showModelError(d.warning);
    } catch (e) {
      if (prev) sbModel.value = prev;
      showModelError(String(e.message || e));
    } finally {
      modelPending = false;
      sbModel.disabled = false;
    }
  };
}
const sbCtx = statusBar ? sbField('sb-ctx sb-num') : null;
const sbWorkers = statusBar ? sbField('sb-workers') : null;

function renderStatus(st, list) {
  if (!statusBar) return;
  const lead = (st && st.lead) || null;
  const workers = (list || []).filter(isWorker);
  if (sbModel) {
    const id = lead && lead.model ? String(lead.model) : '';
    sbModel.hidden = !id;
    if (id) {
      const active = (lead.provider ? String(lead.provider) : '') + ' ' + id;
      sbModel.dataset.active = active;
      if (!modelPending && sbModel.value !== active && MODEL_CHOICES.some(([p, m]) => p + ' ' + m === active)) {
        sbModel.value = active;
      }
      sbModel.disabled = Boolean(lead.busy) || modelPending;
      sbModel.title = 'Lead model for new turns (global)' + (lead.busy ? ' — busy: runs keep model, next turn changes' : '');
    }
  }
  if (sbCtx) {
    const used = lead ? Number(lead.contextTokens) || 0 : 0;
    const win = lead ? Number(lead.contextWindow) || 0 : 0;
    const free = lead ? ctxFreePct(used, win) : null;
    sbCtx.hidden = free === null;
    sbCtx.textContent = free === null ? '' : 'Kontext ' + free + '% frei \u00b7 ' + fmtTok(used) + '/' + fmtTok(win);
    sbCtx.className = 'sb sb-ctx sb-num ' + budgetLevel(free);
    sbCtx.title = free === null ? '' : free + '% context free';
  }
  if (sbWorkers) {
    const has = workers.length > 0;
    sbWorkers.hidden = !has;
    sbWorkers.textContent = has ? workerCountText(workers) : '';
    sbWorkers.className = 'sb sb-workers sb-num ' + workerLevel(workers);
  }
  statusBar.hidden = !lead && workers.length === 0;
}

function setTarget(id, convId, orchestrationId) {
  target = id;
  currentConv = Number(convId) || 1;
  currentOrchestration = orchestrationId || 'general';
  rendered.clear();
  log.replaceChildren();
  q.placeholder = 'Message ' + (orchestrationList.find((o) => o.id === currentOrchestration)?.name || 'orchestration') + '…';
  for (const b of document.querySelectorAll('[data-target]')) {
    b.setAttribute('aria-current', String(b.dataset.target === id));
  }
  renderAgents(allWorkers);
  syncHistory().catch(() => {});
}
document.addEventListener('click', (ev) => {
  const b = ev.target.closest?.('[data-target]');
  if (b) { setTarget(b.dataset.target, b.dataset.conv, b.dataset.orch); closeDrawers(); }
});
// Initial General/Lead state is declared above and rendered by the static HTML.

// Registry states: running, idle_done, failed:turn_limit, stopped:<reason>, failed.
const STATE_LABEL = { running: 'running', idle_done: 'idle', failed: 'failed', 'failed:turn_limit': 'failed (turn limit)' };
const stateKey = (s) => String(s || 'idle_done').replace(/[:\s]/g, '_');
const isRunning = (w) => Boolean(w) && String(w.state || '') === 'running';
const isWorker = (w) => Boolean(w) && w.id && w.id !== 'lead' && w.role !== 'btw' && !/^cron/i.test(String(w.role || w.id));
function elapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

// Reconcile one <ul> against a worker list (running-first order comes from the server).
function fillList(ul, list, withDot) {
  const known = new Set(list.map((w) => w.id));
  for (const n of Array.from(ul.children)) if (!known.has(n.dataset.id)) n.remove();
  const now = Date.now();
  let after = null;
  for (const w of list) {
    let li = ul.querySelector('[data-id="' + CSS.escape(w.id) + '"]');
    if (!li) {
      li = document.createElement('li');
      li.dataset.id = w.id;
      li.innerHTML = (withDot ? '<div class="wtop"><span class="dot"></span><span class="wrole"></span></div>' : '<span class="wrole"></span>') + '<span class="wsub"></span><span class="werr"></span><div class="wactions"><button type="button" data-worker-action="run">Run now</button><button type="button" data-worker-action="pause"></button></div>';
      li.querySelector('.wrole').textContent = w.role || w.id;
    }
    li.className = 'wk s-' + stateKey(w.state);
    li.querySelector('.wrole').textContent = w.name || ((w.role || 'worker') + ' · ' + w.id);
    const schedule = w.mode === 'recurring' ? ' · every ' + Math.round((w.everyMs || 0) / 60000) + 'm' : ' · once';
    li.querySelector('.wsub').textContent =
      (w.enabled === false ? 'paused' : (STATE_LABEL[w.state] || String(w.state || 'idle'))) + schedule + ' · ' + (w.runCount || 0) + ' runs';
    li.querySelector('.werr').textContent = w.lastError ? String(w.lastError).slice(0, 120) : '';
    const runBtn = li.querySelector('[data-worker-action="run"]');
    runBtn.dataset.workerId = w.id;
    runBtn.disabled = w.enabled === false || isRunning(w);
    const pauseBtn = li.querySelector('[data-worker-action="pause"]');
    pauseBtn.dataset.workerId = w.id;
    pauseBtn.hidden = w.mode !== 'recurring';
    pauseBtn.dataset.workerAction = w.enabled === false ? 'resume' : 'pause';
    pauseBtn.textContent = w.enabled === false ? 'Resume' : 'Pause';
    const want = after ? after.nextElementSibling : ul.firstElementChild;
    if (li !== want) ul.insertBefore(li, want);
    after = li;
  }
}

// Right sidebar: running agents live; everything else collapses into Archived workers.
function renderAgents(list) {
  const workers = list.filter(isWorker).filter((w) => (w.orchestrationId || 'general') === currentOrchestration);
  fillList(agentsUl, workers, true);
  agentsEmpty.hidden = agentsUl.children.length > 0;
  agentsEmpty.textContent = 'No workers in this orchestration.';
  if (archiveBox) archiveBox.hidden = true;
}

// Left sidebar lists durable named orchestrations, each backed by its own Lead conversation.
function renderTargets(list) {
  orchestrationList = list && list.length ? list : orchestrationList;
  targetsBox.replaceChildren();
  for (const o of orchestrationList.filter((x) => x.id !== 'general')) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tgt';
    b.dataset.target = 'orchestration:' + o.id;
    b.dataset.conv = String(o.conversationId);
    b.dataset.orch = o.id;
    b.setAttribute('aria-current', String(currentOrchestration === o.id));
    const name = document.createElement('span'); name.className = 'tname'; name.textContent = o.name;
    const meta = document.createElement('span'); meta.className = 'tmeta'; meta.textContent = o.state || 'idle';
    b.append(name, meta); targetsBox.appendChild(b);
  }
}

// Poll the read-only agent list on the shared backoff; paused while hidden.
async function pollWorkers() {
  if (document.hidden) return;
  try {
    const [r, or] = await Promise.all([fetch('/api/workers'), fetch('/api/orchestrations')]);
    if (r.status === 401 || or.status === 401) { location.reload(); return; }
    if (!r.ok) return;
    const d = await safeJson(r);
    const od = or.ok ? await safeJson(or) : null;
    if (!d || d._nonJson) return;
    const list = (d.workers || []).filter((w) => w && w.id && w.id !== 'lead');
    allWorkers = list;
    renderTargets(od?.orchestrations || orchestrationList);
    renderAgents(list);
    renderStatus(d.status || null, list);
    agentsEmpty.textContent = list.length ? '' : 'No running agents.';
  } catch (e) {
    // Surface the real poll failure instead of a silently stale/empty sidebar.
    if (!agentsUl.children.length && !agentsEmpty.hidden) agentsEmpty.textContent = 'Poll failed: ' + String((e && e.message) || e);
  }
}
workersTimer = setInterval(pollWorkers, POLL_MS);

// Durable orchestration and worker controls. No prompt/LLM is needed to create or control these.
const orchStatus = document.getElementById('orch-status');
document.getElementById('new-orch').onsubmit = async (ev) => {
  ev.preventDefault();
  orchStatus.textContent = 'Creating…';
  try {
    const name = document.getElementById('orch-name').value;
    const r = await fetch('/api/orchestrations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    const d = await safeJson(r);
    if (!r.ok || d.error) throw new Error(d.error || 'Create failed');
    document.getElementById('orch-name').value = '';
    orchStatus.textContent = 'Created ' + d.name;
    await pollWorkers();
    setTarget('orchestration:' + d.id, d.conversationId, d.id);
  } catch (e) { orchStatus.textContent = String(e.message || e); }
};

const workerForm = document.getElementById('new-worker');
const workerMode = document.getElementById('worker-mode');
const intervalLabel = document.getElementById('worker-interval-label');
document.getElementById('toggle-worker-form').onclick = () => { workerForm.hidden = !workerForm.hidden; };
workerMode.onchange = () => { intervalLabel.hidden = workerMode.value !== 'recurring'; };
workerForm.onsubmit = async (ev) => {
  ev.preventDefault();
  const status = document.getElementById('worker-form-status');
  status.textContent = 'Creating…';
  try {
    const mode = workerMode.value;
    const payload = {
      orchestrationId: currentOrchestration,
      name: document.getElementById('worker-name').value,
      role: document.getElementById('worker-role').value,
      goal: document.getElementById('worker-goal').value,
      mode,
      everyMs: mode === 'recurring' ? Number(document.getElementById('worker-minutes').value) * 60000 : undefined,
    };
    const r = await fetch('/api/orchestration-workers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const d = await safeJson(r);
    if (!r.ok || d.error) throw new Error(d.error || 'Create failed');
    workerForm.reset(); intervalLabel.hidden = true; workerForm.hidden = true;
    status.textContent = mode === 'recurring' ? 'Recurring worker started.' : 'One-shot worker started.';
    await pollWorkers();
  } catch (e) { status.textContent = String(e.message || e); }
};

document.addEventListener('click', async (ev) => {
  const b = ev.target.closest?.('[data-worker-action]');
  if (!b) return;
  b.disabled = true;
  try {
    const r = await fetch('/api/orchestration-worker', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workerId: b.dataset.workerId, action: b.dataset.workerAction }) });
    const d = await safeJson(r);
    if (!r.ok || d.error) throw new Error(d.error || 'Action failed');
    await pollWorkers();
  } catch (e) {
    document.getElementById('worker-form-status').textContent = String(e.message || e);
    b.disabled = false;
  }
});

// ---- responsive drawers ----
const leftCol = document.getElementById('leftCol');
const rightCol = document.getElementById('rightCol');
const backdrop = document.getElementById('backdrop');
const tLeft = document.getElementById('tLeft');
const tRight = document.getElementById('tRight');
function closeDrawers() {
  for (const el of [leftCol, rightCol]) el.classList.remove('open');
  tLeft.setAttribute('aria-expanded', 'false');
  tRight.setAttribute('aria-expanded', 'false');
  backdrop.hidden = true;
}
function toggleDrawer(el, btn) {
  const open = !el.classList.contains('open');
  closeDrawers();
  if (!open) return;
  el.classList.add('open');
  btn.setAttribute('aria-expanded', 'true');
  backdrop.hidden = false;
}
tLeft.onclick = () => toggleDrawer(leftCol, tLeft);
tRight.onclick = () => toggleDrawer(rightCol, tRight);
backdrop.onclick = closeDrawers;
addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeDrawers(); });


// Poll pending Click-to-Sign SSH challenges when swarm is working or every 1.5s
async function pollSsh() {
  try {
    const r = await fetch('/api/ssh-sign/pending');
    if (r.ok) {
      const d = await safeJson(r);
      if (!d || d._nonJson) return;
      const p = (d.pending || [])[0] || null;
      currentSshReq = p;
      if (p) {
        sshDesc.textContent = 'SSH request: ' + p.sshCommand;
        sshBar.style.display = 'flex';
      } else {
        sshBar.style.display = 'none';
      }
    }
  } catch {}
}
sshTimer = setInterval(pollSsh, 1500);
addEventListener('unload', () => { clearTimeout(pollTimer); clearInterval(workersTimer); clearInterval(sshTimer); });

sshApprove.onclick = async () => {
  if (!currentSshReq) return;
  const req = currentSshReq;
  sshApprove.disabled = true;
  sshDesc.textContent = 'Signing on local Nuri Smartcard…';
  try {
    const sr = await fetch(BRIDGE + '/ssh-sign', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(req)
    });
    const sig = await sr.json();
    if (!sr.ok || !sig.ok) throw new Error(sig.error || 'Local smartcard bridge failed');
    await fetch('/api/ssh-sign/resolve', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ id: req.id, approve: true, ...sig })
    });
    sshBar.style.display = 'none';
    currentSshReq = null;
  } catch (e) {
    sshDesc.textContent = 'Smartcard error: ' + (e.message || e);
  } finally {
    sshApprove.disabled = false;
  }
};

sshDeny.onclick = async () => {
  if (!currentSshReq) return;
  const id = currentSshReq.id;
  sshBar.style.display = 'none';
  currentSshReq = null;
  await fetch('/api/ssh-sign/resolve', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ id, approve: false, error: 'Denied by Emin in browser' })
  });
};

function fit() {
  q.style.height = 'auto';
  q.style.height = Math.min(q.scrollHeight, 192) + 'px';
}
q.addEventListener('input', fit);

async function send(steer = false) {
  const text = q.value.trim();
  const imgs = window.chatImages ? window.chatImages.take() : [];
  if (!text && !imgs.length) return;
  let payloadImages = [];
  if (imgs.length) {
    try {
      payloadImages = await window.chatImages.toDataUrls(imgs);
    } catch (e) {
      window.chatImages.note(e.message || 'Image read failed', true);
      return;
    }
  }
  q.value = '';
  fit();
  const userNode = addHtml('u', '', text);
  if (userNode) {
    userNode.dataset.raw = text;
    if (payloadImages.length) {
      const box = document.createElement('div');
      box.className = 'himages';
      payloadImages.forEach((p) => {
        const img = document.createElement('img');
        img.src = p.dataUrl;
        img.alt = p.name;
        box.appendChild(img);
      });
      userNode.appendChild(box);
    }
  }
  if (text) {
    renderMd(text).then((h) => {
      if (h && userNode && userNode.isConnected) {
        const keepImgs = userNode.querySelector('.himages');
        userNode.innerHTML = h;
        if (keepImgs) userNode.appendChild(keepImgs);
      }
    });
  }
  for (const old of Array.from(log.querySelectorAll('.pending'))) {
    if (old !== userNode && old.dataset.settled === '1') old.remove();
  }
  const pending = addHtml('a', '', '…');
  busy = true;
  clearTimeout(pollTimer);
  try {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, steer, targetWorkerId: target, images: payloadImages })
    });
    if (r.status === 401) { location.reload(); return; }
    const d = await safeJson(r);
    const anchorNodes = log.querySelectorAll('[data-id]');
    const anchorId = anchorNodes.length ? (anchorNodes[anchorNodes.length - 1].dataset.id || '') : '';
    const markSettled = (local) => {
      for (const n of [userNode, pending]) {
        if (!n) continue;
        n.dataset.settled = '1';
        if (local) { n.dataset.local = '1'; n.dataset.anchorId = anchorId; }
      }
    };
    let waitForBackend = false;
    if (!d || d._nonJson || r.status === 502 || r.status === 503 || r.status === 504) {
      waitForBackend = true;
      pending.textContent = 'Swarm reloading — syncing reply…';
      setTimeout(() => { syncHistory().catch(() => {}); }, 2000);
    } else if (d.error) {
      markSettled(true);
      pending.classList.add('err');
      pending.textContent = 'Error: ' + d.error +
        (payloadImages.length ? ' — the current model may not accept images; switch to a vision model.' : '');
    } else if (d.html) {
      pending.innerHTML = d.html;
      if (window.chatRender) window.chatRender(pending);
    } else {
      pending.textContent = d.text || '(done)';
    }
    // Attachments only leave the deck once the message actually landed.
    if (d && !d.error && imgs.length) window.chatImages.clear();
    if (!waitForBackend && d && !d.error) {
      const localOnly = d.route === 'command' || d.route === 'btw' || d.route === 'reinforce' || d.route === 'invalid' ||
        (d.conversationId && Number(d.conversationId) !== Number(currentConv));
      markSettled(localOnly);
      if (!localOnly) {
        await syncHistory().catch(() => {});
      }
    }
  } catch (e) {
    pending.textContent = 'Swarm reconnecting — syncing reply…';
    setTimeout(() => { syncHistory().catch(() => {}); }, 2000);
  } finally {
    busy = false;
    log.scrollTop = log.scrollHeight;
    schedulePoll(POLL_MS);
  }
}

const attachBtn = document.getElementById('attach-btn');
const attachInput = document.getElementById('attach-input');
if (attachBtn && attachInput) attachBtn.onclick = () => attachInput.click();

q.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    send(busy);
    return;
  }
  // Ctrl/Cmd+V is handled by chat-images.js so pasted text stays untouched.
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') {
    ev.preventDefault();
    send(true);
  }
});

hydrate();
pollSsh();
pollWorkers();
schedulePoll(POLL_MS);
</script>
</body>
</html>`;
}

export async function startWebServer({
  port = PORT,
  host = "127.0.0.1",
  sockPath = DEFAULT_SOCK,
  authDbPath = DEFAULT_AUTH_DB,
  bridgeSecretFile = join(dirname(authDbPath), "ssh-bridge.secret"),
  rpId = RP_ID,
  origin = ORIGIN,
} = {}) {
  const dataDirResolved = dirname(authDbPath);
  await mkdir(dirname(authDbPath), { recursive: true });
  await mkdir(dirname(bridgeSecretFile), { recursive: true });
  const auth = openPasskeyStore(authDbPath, { rpId, rpName: rpId, expectedOrigin: origin });

  // Local 0600 shared secret so ONLY local `swarm` user SSH helper can post `/internal/ssh-sign/request`
  let bridgeSecret = "";
  try {
    bridgeSecret = (await readFile(bridgeSecretFile, "utf8")).trim();
  } catch {}
  if (!bridgeSecret) {
    bridgeSecret = randomBytes(32).toString("base64url");
    writeFileSync(bridgeSecretFile, bridgeSecret + "\n", { mode: 0o600 });
  }
  const bridgeSecretBuf = Buffer.from(bridgeSecret, "utf8");

  // Pending Click-to-Sign SSH challenges (id -> { req, resolve, timer })
  const pendingSsh = new Map();
  // Tiny TTL cache for the sidebar worker list (avoids a socket round-trip per poll)
  let workersCache = null;
  const WORKERS_TTL_MS = 2000;

  const server = createServer(async (req, res) => {
    const sendJson = (code, obj, extraHeaders = {}) => {
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS, ...extraHeaders });
      res.end(JSON.stringify(obj));
    };
    const sendHtml = (code, html, extraHeaders = {}) => {
      res.writeHead(code, { "Content-Type": "text/html; charset=utf-8", ...SECURITY_HEADERS, ...extraHeaders });
      res.end(html);
    };
    const sendAsset = (code, body, type) => {
      res.writeHead(code, { "Content-Type": type, ...SECURITY_HEADERS, "Cache-Control": "public, max-age=3600" });
      res.end(body);
    };
    const assetFile = async (relPath, type) => {
      try {
        return sendAsset(200, await readFile(new URL(relPath, import.meta.url)), type);
      } catch {
        return sendJson(404, { error: "not_found" });
      }
    };

    try {
      const url = new URL(req.url || "/", origin);
      const ip = req.headers["x-real-ip"] || req.socket.remoteAddress || "unknown";

      // Internal loopback-only endpoint called by vps-ssh-sk-helper.mjs when `ssh` runs on VPS
      if (req.method === "POST" && url.pathname === "/internal/ssh-sign/request") {
        const remote = req.socket.remoteAddress || "";
        if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") {
          return sendJson(403, { error: "Loopback only" });
        }
        const hdr = Buffer.from(String(req.headers["x-bridge-secret"] || ""), "utf8");
        if (hdr.length !== bridgeSecretBuf.length || !timingSafeEqual(hdr, bridgeSecretBuf)) {
          return sendJson(403, { error: "Forbidden" });
        }
        const body = await readJsonLimited(req, 16_384);
        const id = randomBytes(12).toString("base64url");
        const item = {
          id,
          application: String(body.application || "ssh:"),
          dataHex: String(body.dataHex || ""),
          keyHandleHex: String(body.keyHandleHex || ""),
          flags: Number(body.flags || 1),
          sshCommand: String(body.sshCommand || "ssh"),
          createdAt: Date.now(),
        };
        const result = await new Promise((resolve) => {
          const timer = setTimeout(() => {
            pendingSsh.delete(id);
            resolve({ ok: false, error: "Timed out waiting for browser smartcard approval" });
          }, 90_000);
          pendingSsh.set(id, { item, resolve, timer });
        });
        return sendJson(result.ok ? 200 : 403, result);
      }

      const cookies = parseCookies(req.headers.cookie);
      const authed = auth.verifySession(cookies[COOKIE_NAME]);

      if (req.method === "GET" && url.pathname === "/healthz") {
        return sendJson(200, { ok: true });
      }

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

      if (!authed) {
        if (req.method === "GET" && url.pathname === "/") {
          return sendHtml(200, renderSolarizedGate());
        }
        return sendJson(401, { error: "Passkey required" });
      }

      if (req.method === "GET" && url.pathname === "/") {
        return sendHtml(200, renderMinimalChat());
      }

      // Static chat assets (same-origin, cacheable; CSP script-src 'self')
      if (req.method === "GET" && url.pathname === "/chat-client.js") {
        return assetFile("./chat-client.js", "text/javascript; charset=utf-8");
      }
      if (req.method === "GET" && url.pathname === "/mermaid-vendor.js") {
        return assetFile("../node_modules/mermaid/dist/mermaid.min.js", "text/javascript; charset=utf-8");
      }

      if (req.method === "GET" && url.pathname === "/chat-images.js") {
        return assetFile("./chat-images.js", "text/javascript; charset=utf-8");
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/image/")) {
        const id = url.pathname.slice("/api/image/".length);
        if (!ID_RE.test(id)) return sendJson(404, { error: "not_found" });
        for (const ext of ["png", "jpg", "gif", "webp"]) {
          try {
            const buf = await readFile(join(dataDirResolved, "images", `${id}.${ext}`));
            res.writeHead(200, {
              "Content-Type": ext === "jpg" ? "image/jpeg" : `image/${ext}`,
              ...SECURITY_HEADERS,
              "Cache-Control": "private, max-age=31536000, immutable",
            });
            return res.end(buf);
          } catch {}
        }
        return sendJson(404, { error: "not_found" });
      }

      if (req.method === "POST" && url.pathname === "/api/render") {
        const body = await readJsonLimited(req, 65_536);
        return sendJson(200, { html: renderMarkdown(String(body.text || "")) });
      }

      if (req.method === "GET" && url.pathname === "/api/ssh-sign/pending") {
        const pending = Array.from(pendingSsh.values()).map((p) => p.item);
        return sendJson(200, { pending });
      }

      if (req.method === "POST" && url.pathname === "/api/ssh-sign/resolve") {
        const body = await readJsonLimited(req, 8192);
        const entry = pendingSsh.get(String(body.id || ""));
        if (!entry) return sendJson(404, { error: "No such pending SSH request" });
        clearTimeout(entry.timer);
        pendingSsh.delete(entry.item.id);
        if (!body.approve) {
          entry.resolve({ ok: false, error: String(body.error || "Denied") });
          return sendJson(200, { ok: true });
        }
        entry.resolve({
          ok: true,
          flags: String(body.flags || "01"),
          counter: Number(body.counter || 1),
          sigR: String(body.sigR || ""),
          sigS: String(body.sigS || ""),
        });
        return sendJson(200, { ok: true });
      }

      if (req.method === "GET" && url.pathname === "/api/workers") {
        // Short cache: sidebar polls; daemon snapshot is authoritative, never guessed.
        const now = Date.now();
        if (!workersCache || now - workersCache.at > WORKERS_TTL_MS) {
          const [out, st] = await Promise.all([
            unixRpc(sockPath, "GET", "/workers"),
            unixRpc(sockPath, "GET", "/status").catch(() => null),
          ]);
          if (out?.error) return sendJson(500, out);
          const statusSummary = st && !st.error
            ? { lead: st.lead || null, liveTasks: st.liveTasks || 0, usage: { totalTokens: st.usage?.totalTokens || 0, costUsd: st.usage?.costUsd || 0 } }
            : null;
          workersCache = { at: now, body: { workers: out?.workers || [], status: statusSummary } };
        }
        return sendJson(200, workersCache.body, { "Cache-Control": "private, max-age=2" });
      }

      if (req.method === "GET" && url.pathname === "/api/orchestrations") {
        const out = await unixRpc(sockPath, "GET", "/orchestrations");
        return sendJson(out?.error ? 500 : 200, out);
      }
      if (req.method === "POST" && url.pathname === "/api/orchestrations") {
        const body = await readJsonLimited(req, 4096);
        const out = await unixRpc(sockPath, "POST", "/orchestrations", { name: body.name });
        return sendJson(out?.error ? 400 : 201, out);
      }
      if (req.method === "POST" && url.pathname === "/api/orchestration-workers") {
        const body = await readJsonLimited(req, 32_768);
        const out = await unixRpc(sockPath, "POST", "/orchestration-workers", body);
        workersCache = null;
        return sendJson(out?.error ? 400 : 201, out);
      }
      if (req.method === "POST" && url.pathname === "/api/orchestration-worker") {
        const body = await readJsonLimited(req, 4096);
        const out = await unixRpc(sockPath, "POST", "/orchestration-worker", body);
        workersCache = null;
        return sendJson(out?.error ? 400 : 200, out);
      }

      if (req.method === "GET" && url.pathname === "/api/status") {
        const st = await unixRpc(sockPath, "GET", "/status");
        if (st?.error) return sendJson(500, st);
        return sendJson(200, {
          lead: st.lead || null,
          liveTasks: st.liveTasks || 0,
          pendingSubmissions: st.pendingSubmissions || 0,
          usage: st.usage || null,
        });
      }

      if (req.method === "GET" && url.pathname === "/api/history") {
        const max = Math.min(Math.max(Number(url.searchParams.get("max") || 40) || 40, 1), 200);
        const requestedConv = Number(url.searchParams.get("convId") || "1");
        const convId = Number.isSafeInteger(requestedConv) && requestedConv > 0 ? requestedConv : 1;
        const out = await unixRpc(sockPath, "GET", `/transcript?convId=${convId}&max=${max}`);
        if (out?.error) return sendJson(500, out);
        // Entry ids let the client reconcile in place (no re-render wipe, no duplicates).
        const entries = [];
        for (const e of out?.entries || []) {
          const text = String(e.text || "");
          if (e.role === "user") {
            const clean = text.replace(/^\[ROUTER_HINT:[^\]]+\]\n/, "");
            entries.push({ id: e.id, role: "user", text: clean, html: renderMarkdown(clean), ...(e.images?.length ? { images: e.images } : {}) });
          } else if (e.role === "assistant") {
            if (text) {
              entries.push({ id: e.id, role: "assistant", text, html: renderMarkdown(text) });
            } else if (e.errorMessage) {
              const errText = `Error: ${e.errorMessage}`;
              entries.push({ id: e.id, role: "assistant", isError: true, text: errText, html: renderMarkdown(errText) });
            }
          }
        }
        return sendJson(200, { conversationId: out?.conversationId || 1, entries });
      }

      if (req.method === "POST" && url.pathname === "/api/chat") {
        const body = await readJsonLimited(req, MAX_BODY_BYTES);
        const text = String(body.text || "").trim();
        let images = [];
        try {
          images = await storeImages(dataDirResolved, body.images);
        } catch (err) {
          const msg = String(err?.message || err);
          return sendJson(msg.startsWith("Payload") ? 413 : 400, { error: msg });
        }
        if (!text && !images.length) return sendJson(400, { error: "Empty prompt" });
        if (!images.length) {
          const out = await unixRpc(sockPath, "POST", "/chat", {
            text,
            steer: !!body.steer,
            targetWorkerId: body.targetWorkerId || "lead",
            wait: true,
          });
          if (out && !out.error && out.text) out.html = renderMarkdown(out.text);
          return sendJson(out?.error ? 500 : 200, out);
        }
        // Images present: ship base64 content blocks alongside the text.
        const payload = [];
        for (const i of images) {
          payload.push({ mimeType: i.mimeType, data: (await readFile(join(dataDirResolved, "images", `${i.id}.${extOf(i.mimeType)}`))).toString("base64") });
        }
        const out = await unixRpc(sockPath, "POST", "/chat", {
          text,
          images: payload,
          steer: !!body.steer,
          targetWorkerId: body.targetWorkerId || "lead",
          wait: true,
        });
        if (out && !out.error && out.text) out.html = renderMarkdown(out.text);
        if (out && !out.error) out.images = images.map((i) => i.id);
        return sendJson(out?.error ? 500 : 200, out);
      }

      if (req.method === "POST" && url.pathname === "/api/model") {
        const body = await readJsonLimited(req, 4096);
        const out = await unixRpc(sockPath, "POST", "/model", {
          provider: String(body.provider || ""),
          modelId: String(body.modelId || ""),
        });
        workersCache = null; // next poll reflects the new Lead model immediately
        return sendJson(out?.error ? 400 : 200, out);
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

  return { server, auth, port, bridgeSecret };
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
