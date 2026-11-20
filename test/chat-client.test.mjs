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
    `<!doctype html><body><div id="topbar"><button id="tLeft"></button><button id="tRight"></button></div><div id="backdrop" hidden></div><aside id="leftCol"><button data-target="lead" data-conv="1" aria-current="true">General</button><div id="targets"></div><form id="new-orch"><input id="orch-name"><button>Add</button></form><p id="orch-status"></p></aside><main><div id="log"></div><div id="sshBar"><span id="sshDesc"></span><button id="sshApprove"></button><button id="sshDeny"></button></div><div id="statusBar"></div><form id="f"><textarea id="q"></textarea></form></main><aside id="rightCol"><button id="toggle-worker-form"></button><form id="new-worker"><input id="worker-name"><select id="worker-role"></select><select id="worker-mode"><option value="once">once</option></select><label id="worker-interval-label"><input id="worker-minutes"></label><textarea id="worker-goal"></textarea></form><p id="worker-form-status"></p><ul id="agents"></ul><p id="agentsEmpty"></p><details id="archived"><summary>Archived workers</summary><ul id="archive"></ul></details></aside></body>`,
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

test("history poll continues at faster BUSY_POLL_MS while a chat request is active so live CoT streams", async () => {
  const { w, calls } = boot([{ id: 1, role: "user", text: "q", html: "<p>q</p>" }]);
  await flush();
  const n = calls.filter((u) => String(u).startsWith("/api/history")).length;
  w.eval("busy = true");
  const nextInterval = await w.eval("tick().then(function(){return backoff})");
  assert.equal(calls.filter((u) => String(u).startsWith("/api/history")).length, n + 1);
  assert.equal(nextInterval, 1000);
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

test("right sidebar shows active/recurring workers and archives finished one-shot workers", async () => {
  const workers = [
    { id: "w-coder", role: "coder", state: "running", createdAt: Date.now() - 5000, lastError: null },
    { id: "w-recur", role: "watcher", state: "idle_done", mode: "recurring", everyMs: 300000, createdAt: Date.now() - 10000, lastError: null },
    { id: "btw-sidechat", role: "btw", state: "idle_done", createdAt: Date.now() - 120000, lastError: null },
    { id: "w-fail", role: "coder", state: "stopped:aborted", mode: "once", createdAt: Date.now() - 9000, lastError: "aborted: user stop" },
    { id: "w-done", role: "coder", state: "idle_done", mode: "once", createdAt: Date.now() - 20000, lastError: null },
    { id: "cron-1", role: "cron", state: "running", createdAt: Date.now(), lastError: null },
  ];
  const status = {
    lead: { provider: "allmodels", model: "moonshotai/kimi-k3.1-pro-abliterated", contextTokens: 42000, contextWindow: 1048576 },
    usage: { costUsd: 0.0412 },
  };
  const { w } = boot([], workers, status);
  await flush();
  const agentsUl = w.document.getElementById("agents");
  assert.equal(agentsUl.children.length, 2, "running and recurring workers stay in active list; finished one-shot workers move to archive: " + [...agentsUl.children].map((n) => n.dataset.id).join(","));
  assert.match(agentsUl.children[0].textContent, /w-coder/);
  assert.match(agentsUl.children[1].textContent, /w-recur/);
  assert.equal(w.document.getElementById("agentsEmpty").hidden, true);
  const box = w.document.getElementById("archived");
  assert.equal(box.hidden, false, "archived box becomes visible when finished one-shot workers exist");
  assert.match(box.querySelector("summary").textContent, /Archived workers \(2\)/);
  const archiveUl = w.document.getElementById("archive");
  assert.equal(archiveUl.children.length, 2);
  assert.match(archiveUl.textContent, /aborted: user stop/);
  const bar = w.document.getElementById("statusBar").textContent;
  assert.match(bar, /kimi-k3\.1-pro-abliterated/);
  assert.match(bar, /42k\/1\.05M/);
  assert.match(bar, /1 running \/ 2 total/);
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

test("named orchestration switches conversation and scopes its workers", async () => {
  const { w, calls } = boot([], [
    { id: "general-w", name: "General worker", role: "coder", state: "idle_done", orchestrationId: "general" },
    { id: "ops-w", name: "Ops worker", role: "watcher", state: "idle_done", orchestrationId: "orch-ops", mode: "recurring", everyMs: 60000, enabled: true },
  ]);
  await flush();
  w.eval(`renderTargets([{id:'general',name:'General',conversationId:1},{id:'orch-ops',name:'Operations',conversationId:9}])`);
  const button = w.document.querySelector('[data-target="orchestration:orch-ops"]');
  assert.equal(button.querySelector('.tname').textContent, 'Operations');
  button.click();
  await flush();
  assert.equal(button.dataset.conv, '9');
  assert.match(w.document.getElementById('q').placeholder, /Operations/);
  assert.ok(calls.some((u) => String(u).includes('/api/history?convId=9')));
  assert.match(w.document.getElementById('agents').textContent, /Ops worker/);
  assert.doesNotMatch(w.document.getElementById('agents').textContent, /General worker/);
  assert.match(w.document.getElementById('agents').textContent, /every 1m/);
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
  assert.equal(w.eval("workerCountText([{state:'running'},{state:'idle_done',mode:'once'},{state:'idle_done',mode:'recurring'},{state:'running'}])"), "2 running / 3 total");
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

  ctx = boot([], [{ id: "w-fail", state: "failed:turn_limit", mode: "recurring" }, { id: "w-run", state: "running" }], lead(800));
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

test("settled optimistic user/assistant nodes never stay pinned at bottom after new transcript entries or local commands", async () => {
  const history = [
    { id: 1, role: "user", text: "first", html: "<p>first</p>" },
    { id: 2, role: "assistant", text: "first reply", html: "<p>first reply</p>" },
  ];
  const { w, log } = boot(history);
  await flush();
  const origFetch = w.fetch;

  // 1) Ephemeral slash command (/status) returns route='command' without writing to transcript.
  // It should stay visible right after send(), and be cleaned up as soon as a new transcript entry or next send() arrives.
  w.fetch = async (url, init) => {
    if (String(url) === "/api/chat") {
      return { ok: true, status: 200, json: async () => ({ route: "command", conversationId: 1, text: "status ok", html: "<p>status ok</p>" }) };
    }
    return origFetch(url, init);
  };
  const q = w.document.getElementById("q");
  q.value = "/status";
  await w.eval("send(false)");
  assert.equal(log.querySelectorAll(".pending").length, 2, "ephemeral command output remains visible until new transcript activity");
  // Unchanged history poll keeps the ephemeral command output readable:
  await w.eval("syncHistory()");
  assert.equal(log.querySelectorAll(".pending").length, 2);

  // 2) Now a real conversation turn lands in history (even if text differs or ends on a user turn):
  // the old settled pending nodes must be purged and never pinned below the new entries.
  history.push(
    { id: 3, role: "user", text: "test", html: "<p>test</p>" },
    { id: 4, role: "assistant", text: "real answer", html: "<p>real answer</p>" },
  );
  await w.eval("syncHistory()");
  assert.equal(log.querySelectorAll(".pending").length, 0, "ephemeral pending nodes removed once new transcript entries land");
  assert.deepEqual([...log.children].map((n) => n.dataset.id), ["1", "2", "3", "4"]);

  // 3) Normal persisted send() reconciles immediately against /api/history and leaves zero pinned .pending nodes.
  w.fetch = async (url, init) => {
    if (String(url) === "/api/chat") {
      history.push(
        { id: 5, role: "user", text: "normalized on server", html: "<p>normalized on server</p>" },
        { id: 6, role: "assistant", text: "done", html: "<p>done</p>" },
      );
      return { ok: true, status: 200, json: async () => ({ route: "direct", conversationId: 1, text: "done", html: "<p>done</p>" }) };
    }
    return origFetch(url, init);
  };
  q.value = "raw client text";
  await w.eval("send(false)");
  assert.equal(log.querySelectorAll(".pending").length, 0, "persisted turn leaves zero pinned .pending nodes even if server text was normalized");
  assert.deepEqual([...log.children].map((n) => n.dataset.id), ["1", "2", "3", "4", "5", "6"]);
  w.close();
});

test("collapsible Chain of Thought (CoT) renders live and on completed chat turns and workers, preserving user open/close state", async () => {
  const history = [
    { id: 1, role: "user", text: "deploy fix", html: "<p>deploy fix</p>" },
  ];
  let liveState = {
    running: true,
    turns: 1,
    thinking: "Inspecting daemon socket and checking test output...",
    tools: [{ callId: "c1", name: "bash", status: "running", output: "TAP version 13" }],
  };
  const workers = [
    {
      id: "w-audit",
      name: "Security Auditor",
      role: "reviewer",
      state: "running",
      mode: "recurring",
      everyMs: 300000,
      runCount: 2,
      live: {
        running: true,
        thinking: "Checking open ports and passkey session cookies...",
        tools: [{ callId: "t9", name: "bash", status: "running", output: "127.0.0.1:3001" }],
      },
    },
  ];
  const { w, log } = boot(history, workers);
  const origFetch = w.fetch;
  w.fetch = async (url, init) => {
    if (String(url).startsWith("/api/history")) {
      return { ok: true, status: 200, json: async () => ({ entries: history.slice(), ...(liveState ? { live: liveState } : {}) }) };
    }
    return origFetch(url, init);
  };
  await w.eval("syncHistory()");
  await w.eval("pollWorkers()");

  // 1) Live CoT in main chat log defaults to open while live
  const liveDet = log.querySelector("details.cot");
  assert.ok(liveDet, "live CoT details element rendered in chat log");
  assert.equal(liveDet.open, true, "live CoT defaults to open while working");
  assert.equal(liveDet.dataset.live, "1");
  assert.match(liveDet.querySelector("summary").textContent, /Working live · Chain of thought \(bash\)/);
  assert.match(liveDet.querySelector(".cot-think").textContent, /Inspecting daemon socket/);
  assert.match(liveDet.querySelector(".cot-tools").textContent, /bash \[running\]: TAP version 13/);

  // User closes the live CoT drawer; next live poll must respect user's closed state
  liveDet.open = false;
  liveDet.dataset.userToggled = "1";
  liveState = {
    running: true,
    turns: 1,
    thinking: "Inspecting daemon socket and checking test output... step 2",
    tools: [{ callId: "c1", name: "bash", status: "done", output: "all pass" }],
  };
  await w.eval("syncHistory()");
  const liveDetAfter = log.querySelector("details.cot");
  assert.equal(liveDetAfter.open, false, "user-closed CoT stays closed across live polls");
  assert.match(liveDetAfter.querySelector(".cot-think").textContent, /step 2/);

  // 2) Turn finishes and lands in transcript with thinking + toolCalls
  liveState = null;
  history.push({
    id: 2,
    role: "assistant",
    text: "All tests pass.",
    html: "<p>All tests pass.</p>",
    thinking: "Verified socket and ran test suite.",
    toolCalls: ['bash({"command":"npm test"})'],
  });
  await w.eval("syncHistory()");
  assert.equal(log.querySelectorAll(".m.a.live-stream").length, 0, "ephemeral live-stream node removed once entry lands");
  const entryNode = log.querySelector('[data-id="2"]');
  const entryCot = entryNode.querySelector("details.cot");
  assert.ok(entryCot, "completed assistant turn has collapsible CoT drawer");
  assert.equal(entryCot.open, false, "completed turn CoT defaults to collapsed so chat stays clean");
  assert.match(entryCot.querySelector("summary").textContent, /Chain of thought \(1 tool\)/);
  assert.match(entryCot.querySelector(".cot-think").textContent, /Verified socket and ran test suite/);
  // User opens completed CoT; re-sync preserves open state
  entryCot.open = true;
  entryCot.dataset.userToggled = "1";
  await w.eval("syncHistory()");
  assert.equal(entryNode.querySelector("details.cot").open, true, "completed CoT open state preserved across polls");

  // 3) Right-sidebar agent card renders collapsible live CoT (`details.wcot`)
  const agentCard = w.document.querySelector('#agents li[data-id="w-audit"]');
  assert.ok(agentCard, "worker card rendered in right sidebar");
  const wcot = agentCard.querySelector("details.wcot");
  assert.ok(wcot, "worker card has collapsible CoT details.wcot");
  assert.equal(wcot.open, true, "running worker CoT defaults to open");
  assert.match(wcot.querySelector("summary").textContent, /Working live · CoT \(bash\)/);
  assert.match(wcot.querySelector(".cot-think").textContent, /Checking open ports/);
  w.close();
});
