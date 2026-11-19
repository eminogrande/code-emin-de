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
    `<!doctype html><body><div id="topbar"><button id="tLeft"></button><button id="tRight"></button></div><div id="backdrop" hidden></div><aside id="leftCol"><button data-target="lead" aria-current="true">Lead</button><div id="targets"></div></aside><main><div id="log"></div><div id="sshBar"><span id="sshDesc"></span><button id="sshApprove"></button><button id="sshDeny"></button></div><div id="statusBar"></div><form id="f"><textarea id="q"></textarea></form></main><aside id="rightCol"><ul id="agents"></ul><p id="agentsEmpty"></p><details id="archived"><summary>Archived workers</summary><ul id="archive"></ul></details></aside></body>`,
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

test("right sidebar shows only running agents; anything else is collapsed into Archived workers", async () => {
  const workers = [
    { id: "w-coder", role: "coder", state: "running", createdAt: Date.now() - 5000, lastError: null },
    { id: "btw-sidechat", role: "btw", state: "idle_done", createdAt: Date.now() - 120000, lastError: null },
    { id: "w-fail", role: "coder", state: "stopped:aborted", createdAt: Date.now() - 9000, lastError: "aborted: user stop" },
    { id: "cron-1", role: "cron", state: "running", createdAt: Date.now(), lastError: null },
  ];
  const status = {
    lead: { provider: "allmodels", model: "moonshotai/kimi-k3.1-pro-abliterated", contextTokens: 42000, contextWindow: 1048576 },
    usage: { costUsd: 0.0412 },
  };
  const { w } = boot([], workers, status);
  await flush();
  const agentsUl = w.document.getElementById("agents");
  assert.equal(agentsUl.children.length, 1, "only the running worker stays live");
  assert.match(agentsUl.children[0].textContent, /coder · w-coder/);
  assert.equal(w.document.getElementById("agentsEmpty").hidden, true);
  const archive = w.document.getElementById("archive");
  assert.equal(archive.children.length, 2, "done + failed workers are archived, cron excluded");
  assert.match(archive.textContent, /idle/);
  assert.match(archive.textContent, /aborted: user stop/);
  assert.ok([...archive.children].some((li) => li.className.includes("s-stopped_aborted")));
  const box = w.document.getElementById("archived");
  assert.equal(box.hidden, false);
  assert.equal(box.open, false, "archived section starts collapsed");
  const bar = w.document.getElementById("statusBar").textContent;
  assert.match(bar, /kimi-k3\.1-pro-abliterated/);
  assert.match(bar, /42k\/1\.05M/);
  assert.match(bar, /1 running \/ 3 total/);
  w.close();
});

test("left sidebar keeps only the lead target (no generated worker buttons)", async () => {
  const { w } = boot([], [
    { id: "w-coder", role: "coder", state: "running", createdAt: Date.now(), lastError: null },
    { id: "w-two", role: "btw", state: "idle_done", createdAt: Date.now(), lastError: null },
  ]);
  await flush();
  const targets = w.document.getElementById("targets");
  assert.equal(targets.children.length, 0);
  const lead = w.document.querySelector('[data-target="lead"]');
  assert.equal(lead.getAttribute("aria-current"), "true", "static Lead target remains active");
  assert.equal(targets.querySelectorAll("[data-target]").length, 0);
  w.close();
});

test("failed poll surfaces a real message when nothing is listed", async () => {
  const { w } = boot([]);
  await flush();
  w.fetch = async () => {
    throw new Error("network down");
  };
  await w.eval("pollWorkers()");
  assert.match(w.document.getElementById("agentsEmpty").textContent, /network down/);
  w.close();
});

test("pure status formatting helpers: free %, budget level, worker count, id truncation", async () => {
  const { w } = boot([]);
  await flush();
  assert.equal(w.eval("ctxFreePct(0,1000)"), 100);
  assert.equal(w.eval("ctxFreePct(920,1000)"), 8);
  assert.equal(w.eval("ctxFreePct(500,0)"), null);
  assert.equal(w.eval("ctxFreePct(5,1000)"), 100, "clamped");
  assert.equal(w.eval("budgetLevel(30)"), "");
  assert.equal(w.eval("budgetLevel(24)"), "warn");
  assert.equal(w.eval("budgetLevel(9)"), "bad");
  assert.equal(w.eval("budgetLevel(null)"), "");
  assert.equal(w.eval("workerCountText([{state:'running'},{state:'idle_done'},{state:'running'}])"), "2 running / 3 total");
  assert.equal(w.eval("workerCountText(null)"), "0 running / 0 total");
  assert.equal(w.eval("truncId('short')"), "short");
  const long = w.eval("truncId('a'.repeat(80), 10)");
  assert.equal(long.length, 10);
  assert.ok(long.endsWith("\u2026"));
  w.close();
});

test("status bar marks low context amber/red and colours badge by worst worker state", async () => {
  const lead = (tokens) => ({ lead: { model: "m".repeat(80), contextTokens: tokens, contextWindow: 1000 } });
  let ctx = boot([], [], lead(950));
  await flush();
  let bar = ctx.w.document.getElementById("statusBar");
  assert.equal(bar.hidden, false);
  const ctxEl = bar.querySelector(".sb-ctx");
  assert.ok(ctxEl.classList.contains("bad"));
  assert.match(ctxEl.textContent, /5% frei/);
  const sel = bar.querySelector(".sb-model");
  assert.equal(sel.tagName, "SELECT");
  assert.ok(sel.options.length >= 4, "allowlisted model choices rendered");
  assert.match(sel.value, /^llmgateway \S+$/, "value is provider + modelId");
  assert.ok(sel.hidden === false);
  ctx.w.close();

  ctx = boot([], [{ id: "w-fail", state: "failed:turn_limit" }, { id: "w-run", state: "running" }], lead(800));
  await flush();
  bar = ctx.w.document.getElementById("statusBar");
  assert.ok(bar.querySelector(".sb-ctx").classList.contains("warn"));
  assert.ok(bar.querySelector(".sb-workers").classList.contains("bad"));
  ctx.w.close();
});

test("status bar stays hidden without lead or workers", async () => {
  const { w } = boot([], [], null);
  await flush();
  assert.equal(w.document.getElementById("statusBar").hidden, true);
  w.close();
});

test("send() renders user message synchronously BEFORE pending assistant placeholder (never '…' above 'hi')", async () => {
  const { w } = boot([]);
  await flush();
  let resolveChat;
  const origFetch = w.fetch;
  w.fetch = (url, init) => {
    const s = String(url);
    if (s === "/api/render") {
      return new Promise((res) =>
        setTimeout(() => res({ ok: true, status: 200, json: async () => ({ html: "<p>hi</p>" }) }), 25),
      );
    }
    if (s === "/api/chat") {
      return new Promise((res) => {
        resolveChat = () => res({ ok: true, status: 200, json: async () => ({ text: "pong", html: "<p>pong</p>" }) });
      });
    }
    return origFetch(url, init);
  };
  const q = w.document.getElementById("q");
  q.value = "hi";
  w.eval("send(false)");
  const nodes = [...w.document.querySelectorAll("#log .m")];
  assert.equal(nodes.length, 2);
  assert.ok(nodes[0].classList.contains("u"), "first bubble must be user message");
  assert.equal(nodes[0].textContent, "hi");
  assert.ok(nodes[1].classList.contains("a"), "second bubble must be assistant placeholder");
  assert.equal(nodes[1].textContent, "…");
  await new Promise((r) => setTimeout(r, 40));
  const afterMd = [...w.document.querySelectorAll("#log .m")];
  assert.equal(afterMd.length, 2, "async markdown upgrade must update user bubble in-place without reordering");
  assert.ok(afterMd[0].classList.contains("u"));
  assert.equal(afterMd[0].innerHTML, "<p>hi</p>");
  assert.ok(afterMd[1].classList.contains("a"));
  resolveChat();
  await flush();
  w.close();
});
