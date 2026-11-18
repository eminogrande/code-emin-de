// Client-side reconcile/poll behaviour of the chat page, run in jsdom against the real
// embedded script (extracted from src/web.mjs) with a stubbed fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const src = readFileSync(new URL("../src/web.mjs", import.meta.url), "utf8");
const clientScript = [...src.matchAll(/<script>\n([\s\S]*?)\n<\/script>/g)].pop()[1];

function boot(history) {
  const dom = new JSDOM(
    `<!doctype html><body><div id="log"></div><div id="sshBar"><span id="sshDesc"></span><button id="sshApprove"></button><button id="sshDeny"></button></div><form id="f"><textarea id="q"></textarea></form></body>`,
    { runScripts: "outside-only", pretendToBeVisual: true },
  );
  const w = dom.window;
  const calls = [];
  w.fetch = async (url) => {
    calls.push(url);
    if (String(url).startsWith("/api/history")) return { ok: true, status: 200, json: async () => ({ entries: history.slice() }) };
    if (String(url).startsWith("/api/render")) return { ok: true, status: 200, json: async () => ({ html: "" }) };
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
