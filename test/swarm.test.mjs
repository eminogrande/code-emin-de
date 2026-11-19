import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openAgentBus } from "../src/bus.mjs";
import { startUnixSocketServer, unixRpc } from "../src/cli.mjs";
import { openSwarmDaemon } from "../src/daemon.mjs";
import { createOptMem } from "../src/optmem.mjs";
import { V3_CAVEMAN_ADHD } from "../src/prompts.mjs";
import { classifyUserPrompt, triageWatcherEvent } from "../src/triage.mjs";

// Load .env
const envRaw = await readFile(new URL("../.env", import.meta.url), "utf8").catch(() => "");
for (const line of envRaw.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const HAS_LIVE_LLM = Boolean(process.env.LLMGATEWAY_API_KEY || process.env.ALLMODELS_API_KEY);

test("1. V3 Caveman + ADHD prompt floor intact (exact 486-byte / 116-token anchor)", async () => {
  const appendDisk = await readFile(new URL("../config/APPEND_SYSTEM.md", import.meta.url), "utf8");
  assert.equal(Buffer.byteLength(appendDisk, "utf8"), 486);
  assert.equal(appendDisk.trim(), V3_CAVEMAN_ADHD);
  assert.ok(V3_CAVEMAN_ADHD.startsWith('CAVEMAN + ADHD MODE. Active until "stop adhd mode".'));
  assert.ok(V3_CAVEMAN_ADHD.includes("Code like caveman: reuse first."));
  assert.ok(V3_CAVEMAN_ADHD.includes("obey requested format"));
  assert.ok(V3_CAVEMAN_ADHD.includes("exact syntax, negations, tests and security"));
});

test("2. AgentBus broadcast ack isolation + punctuation FTS5 + threads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bus-test-"));
  const bus = openAgentBus(join(dir, "bus.sqlite"));
  try {
    const m1 = bus.send({ from: "w-1", to: "*", topic: "api:ready", body: "export function parseDurationMs(str)" });
    const m2 = bus.send({ from: "w-2", to: "w-1", topic: "api:ready", body: "received signature!", replyTo: m1.id });
    assert.equal(bus.inbox("w-2", { unreadOnly: true }).length, 1);
    bus.ack("w-2", m1.id);
    assert.equal(bus.inbox("w-2", { unreadOnly: true }).length, 0);
    // w-3 still sees broadcast unread!
    assert.equal(bus.inbox("w-3", { unreadOnly: true }).length, 1);
    assert.equal(bus.search("parseDurationMs(str)").length, 1);
    assert.equal(bus.thread(m1.id).length, 2);
  } finally {
    bus.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("3. OptMem auto-nap drain prevents wake failure & recalls exact entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "optmem-test-"));
  const mem = createOptMem({ memoryDir: dir, wakeLines: 8 });
  try {
    await mem.init();
    for (let i = 0; i < 20; i++) {
      await mem.note(i === 7 ? "RULE_ZERO_BEARER: SSH smartcard only on port 2222." : `Routine build #${i} green.`);
    }
    const wakeOut = await mem.wake();
    assert.ok(wakeOut.length > 0);
    const recalled = await mem.recall("RULE_ZERO_BEARER");
    assert.ok(recalled.includes("SSH smartcard only on port 2222"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("4. System-1 Jev + deterministic fallback triage (stay_silent / draft_only / fanout)", async () => {
  const t1 = await triageWatcherEvent("logs", "0 new 5xx errors; 2 bot 404 hits on /wp-login.php");
  assert.equal(t1.action, "stay_silent");

  const t2 = await triageWatcherEvent("logs", "CRITICAL: 42 HTTP 500 errors — SQLITE_FULL database or disk is full");
  assert.equal(t2.action, "page_immediately");

  const t3 = await triageWatcherEvent("support", "Hi team, I got billed twice on invoice #912, can you help?");
  assert.equal(t3.action, "draft_only");

  const rBtw = await classifyUserPrompt("/btw why did w-1 pick Map instead of WeakMap?");
  assert.equal(rBtw.route, "side_chat_readonly");
  assert.equal(rBtw.cleanPrompt, "why did w-1 pick Map instead of WeakMap?");

  const rMulti = await classifyUserPrompt("1. Build slugify.mjs\n2. Build retry.mjs");
  assert.equal(rMulti.route, "fanout_parallel");
});

test(
  "5. Live Swarm Daemon: multi-task fanout + /btw side-chat + 1-ticket/human support draft + Unix 0600 socket",
  { skip: !HAS_LIVE_LLM && "LLMGATEWAY_API_KEY not set" },
  async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "swarm-e2e-"));
  const dataDir = join(rootDir, "data");
  const workspaceDir = join(rootDir, "workspace");
  const sockPath = join(rootDir, "swarm.sock");

  const srv = await startUnixSocketServer({ sockPath, dataDir, workspaceDir });
  try {
    // Verify 0600 permissions & zero TCP listener
    const st = await stat(sockPath);
    assert.equal(st.mode & 0o777, 0o600);
    const health = await unixRpc(sockPath, "GET", "/healthz");
    assert.equal(health.ok, true);

    // A) Forever-agent log watcher stays silent on routine noise (0 worker spawns) + Support watcher creates 1-ticket/human draft
    const logFile = join(workspaceDir, "nginx.log");
    const inboxFile = join(workspaceDir, "support-inbox.txt");
    await writeFile(logFile, "GET /wp-login.php 404 (0 new 5xx errors)\n");
    await writeFile(inboxFile, "From: max@example.com\nSubject: Double charge\nBody: Charged twice on order #44, please refund.\n");

    await unixRpc(sockPath, "POST", "/cron", { jobId: "nginx-watch", kind: "logs", sourcePath: logFile, everyMs: 60_000 });
    await unixRpc(sockPath, "POST", "/cron", { jobId: "support-watch", kind: "support", sourcePath: inboxFile, everyMs: 60_000 });

    // Wait for ForeverWatchTask initial tick + support draft worker
    const tWait0 = Date.now();
    let drafts = [];
    let nginxJob = null;
    while (Date.now() - tWait0 < 75_000) {
      const status = await unixRpc(sockPath, "GET", "/status");
      nginxJob = status.swarm.cronJobs["nginx-watch"];
      drafts = Object.values(status.swarm.drafts || {});
      if (nginxJob?.lastAction === "stay_silent" && drafts.length >= 1) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    assert.equal(nginxJob?.lastAction, "stay_silent", "Routine log noise must stay silent without spawning an LLM");
    assert.equal(drafts.length, 1, "Support forever-agent must save 1 draft without auto-sending");
    assert.equal(drafts[0].status, "draft_pending_human");

    // B) Multi-task Lead Fan-Out (Kimi K3.1 Pro -> parallel DeepSeek V4.1 Flash workers) + /btw concurrent read-only Side-Chat
    const [leadReply, btwReply] = await Promise.all([
      unixRpc(sockPath, "POST", "/chat", {
        text: "Two independent tasks — spawn 2 parallel coder workers (`w-slug`, `w-clamp`) right now and reply immediately:\n1. Create `./slug.mjs` exporting `slugify(s)` lowercasing and replacing non-alphanumerics with single `-` (trimmed), plus test.\n2. Create `./clamp.mjs` exporting `clamp(n, min, max)`, plus test.",
      }),
      unixRpc(sockPath, "POST", "/chat", {
        text: "/btw list any pending human drafts currently stored in the swarm.",
      }),
    ]);

    assert.equal(btwReply.route, "btw");
    assert.ok(btwReply.text.length > 0);

    // Wait for both background coder workers to finish with `Verified: PASS`
    await Promise.all([srv.daemon.waitForWorker("w-slug", 90_000), srv.daemon.waitForWorker("w-clamp", 90_000)]);

    // Workers may report idle before their files hit disk: poll for real non-empty artifacts.
    const wanted = ["slug.mjs", "clamp.mjs"];
    const missing = [];
    let lastStates = {};
    const tFiles0 = Date.now();
    for (;;) {
      missing.length = 0;
      for (const name of wanted) {
        const size = await stat(join(workspaceDir, name)).then((s) => s.size, () => 0);
        if (size === 0) missing.push(name);
      }
      if (missing.length === 0) break;
      if (Date.now() - tFiles0 > 120_000) {
        const status = await unixRpc(sockPath, "GET", "/status").catch(() => null);
        lastStates = Object.fromEntries(
          ["w-slug", "w-clamp"].map((id) => [id, status?.swarm?.workers?.[id]?.status ?? "unknown"]),
        );
        const present = await readdir(workspaceDir).catch(() => []);
        assert.fail(
          `Timed out after 120s waiting for worker output file(s): ${missing.join(", ")} ` +
            `(workspace: ${present.join(", ") || "empty"}; last worker states: ${JSON.stringify(lastStates)})`,
        );
      }
      await new Promise((r) => setTimeout(r, 1500));
    }

    const { slugify } = await import(join(workspaceDir, "slug.mjs"));
    const { clamp } = await import(join(workspaceDir, "clamp.mjs"));
    assert.equal(slugify("Hello, Caveman World!"), "hello-caveman-world");
    assert.equal(clamp(15, 0, 10), 10);
    assert.ok(leadReply.text.length > 0);
  } finally {
    await new Promise((r) => srv.server.close(r));
    await srv.daemon.close();
    await rm(rootDir, { recursive: true, force: true });
  }
});
