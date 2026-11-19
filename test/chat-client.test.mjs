// Client-side reconcile/poll behaviour of the chat page, run in jsdom against the real
// embedded script (extracted from src/web.mjs) with a stubbed fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const src = readFileSync(new URL("../src/web.mjs", import.meta.url), "utf8");
const clientScript = [...src.matchAll(/<script>\n([\s\S]*?)\n<\/script>/g)].pop()[1];

function boot(history, workers = [], status = null) {
  const dom = new JSDOM(
    `<!doctype html><body><div id="topbar"><button id="tLeft"></button><button id="tRight"></button></div><div id="backdrop" hidden></div><aside id="leftCol"><div id="targets"></div></aside><main><div id="log"></div><div id="sshBar"><span id="sshDesc"></span><button id="sshApprove"></button><button id="sshDeny"></button></div><div id="statusBar"></div><form id="f"><textarea id="q"></textarea></form></main><aside id="rightCol"><ul id="agents"></ul><p id="agentsEmpty"></p></aside></body>`,
    { runScripts: "outside-only", pretendToBeVisual: true },
  );
  const w = dom.window;
  if (!w.CSS) w.CSS = { escape: (s) => String(s).replace(/([^a-zA-Z0-9_-])/g, "\\$1") };
  const calls = [];
  w.fetch = async (url) => {
    calls.push(url);
    if (String(url).startsWith("/api/history")) return { ok: true, status: 200, json: async () => ({ entries: history.slice() }) };
    if (String(url).startsWith("/api/render")) return { ok: true, status: 200, json: async () => ({ html: "" }) };
    if (String(url).startsWith("/api/workers")) return { ok: true, status: 200, json: async () => ({ workers: workers.slice(), status }) };
    return { ok: true, status: 200, json: async () => ({ pending: [] }) };
  };
  w.eval(clientScript);
  return { w, calls, log: w.document.getElementById("log") };
}

const flush = () => new Promise((r) => setTimeout(r, 30));

test("history renders with stable entry ids and no duplicates on re-sync", async () => {
  const history = [
    { id: 7, role: "user", text: "hi", html: "<p>hi</p>" },
    { id: 8, role: "assistant", text: "yo", html: "<p>yo</p>" },
  ];
  const { w, log } = boot(history);
  await flush();
  assert.equal(log.children.length, 2);
  assert.equal(log.children[0].dataset.id, "7");
  assert.equal(log.children[1].dataset.id, "8");
  // second poll with identical data must not duplicate or rebuild
  const first = log.children[0];
  await w.eval("syncHistory()");
  assert.equal(log.children.length, 2);
  assert.ok(log.children[0].isSameNode(first));
  w.close();
});

test("new background reply is appended in place while a draft is preserved", async () => {
  const history = [{ id: 1, role: "user", text: "q", html: "<p>q</p>" }];
  const { w, log } = boot(history);
  await flush();
  const q = w.document.getElementById("q");
  q.value = "unsent draft";
  history.push({ id: 2, role: "assistant", text: "late reply", html: "<p>late reply</p>" });
  await w.eval("syncHistory()");
  assert.equal(log.children.length, 2);
  assert.match(log.children[1].textContent, /late reply/);
  assert.equal(q.value, "unsent draft");
  w.close();
});

test("poll backs off on fetch errors and pauses while hidden", async () => {
  const { w, calls } = boot([]);
  await flush();
  const before = calls.length;
  w.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  assert.equal(await w.eval("tick().then(function(){return backoff})"), 6000);
  assert.equal(await w.eval("tick().then(function(){return backoff})"), 12000);
  // hidden: tick reschedules without fetching
  Object.defineProperty(w.document, "hidden", { value: true, configurable: true });
  const n = calls.length;
  await w.eval("tick()");
  assert.equal(calls.length, n);
  w.close();
});

test("no history fetch while a chat request is active", async () => {
  const { w, calls } = boot([{ id: 1, role: "user", text: "q", html: "<p>q</p>" }]);
  await flush();
  const n = calls.filter((u) => String(u).startsWith("/api/history")).length;
  w.eval("busy = true");
  await w.eval("tick()");
  assert.equal(calls.filter((u) => String(u).startsWith("/api/history")).length, n);
  w.close();
});

test("reply placeholder survives until the assistant entry lands, then goes", async () => {
  const history = [{ id: 1, role: "user", text: "q", html: "<p>q</p>" }];
  const { w, log } = boot(history);
  await flush();
  w.eval("addHtml('a','','…')");
  assert.equal(log.querySelectorAll(".pending").length, 1);
  await w.eval("syncHistory()");
  assert.equal(log.querySelectorAll(".pending").length, 1, "kept while last entry is the user turn");
  history.push({ id: 2, role: "assistant", text: "done", html: "<p>done</p>" });
  await w.eval("syncHistory()");
  assert.equal(log.querySelectorAll(".pending").length, 0);
  assert.equal(log.children.length, 2);
  w.close();
});

test("right AGENTS sidebar renders newly attached workers and statusBar shows model/context/workers", async () => {
  const workers = [
    { id: "w-coder", role: "coder", state: "running", createdAt: Date.now() - 5000, lastError: null },
    { id: "btw-sidechat", role: "btw", state: "idle_done", createdAt: Date.now() - 120000, lastError: null },
  ];
  const status = {
    lead: { provider: "allmodels", model: "moonshotai/kimi-k3.1-pro-abliterated", contextTokens: 42000, contextWindow: 1048576 },
    usage: { costUsd: 0.0412 },
  };
  const { w } = boot([], workers, status);
  await flush();
  const agentsUl = w.document.getElementById("agents");
  assert.equal(agentsUl.children.length, 2, "newly created worker <li> nodes must be inserted into #agents");
  assert.match(agentsUl.children[0].textContent, /coder · w-coder/);
  assert.equal(w.document.getElementById("agentsEmpty").hidden, true);
  const bar = w.document.getElementById("statusBar").textContent;
  assert.match(bar, /kimi-k3\.1-pro-abliterated/);
  assert.match(bar, /42k\/1\.05M/);
  assert.match(bar, /1 running \/ 2 total/);
  w.close();
});
