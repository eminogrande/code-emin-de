#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { V3_CAVEMAN_ADHD } from "../src/prompts.mjs";
import { createFrontierModels, FRONTIER_ROSTER } from "./providers.mjs";

const execFileAsync = promisify(execFile);

const CODING_SPEC = `Write a production-ready ES module at \`./bus.mjs\` with zero external dependencies (Node >=22 built-in \`node:sqlite\` \`DatabaseSync\` ONLY).

Export \`openAgentBus(dbPath)\` returning an object with synchronous methods:
1. \`send({ from, to, topic, body, replyTo })\`:
   - \`from\`, \`to\`, \`topic\`, \`body\` are required non-empty strings (throw \`TypeError\` if missing/blank/non-string).
   - \`replyTo\` is optional integer message id or \`null\`/\`undefined\`; if provided and no message with that id exists, throw \`RangeError\`.
   - Stores \`createdAt = Date.now()\` and \`ackAt = null\`. Returns \`{ id, from, to, topic, body, replyTo: replyTo ?? null, createdAt, ackAt: null }\` where \`id\` is strictly increasing integer starting at 1.
2. \`inbox(agentId, { unreadOnly = true, limit = 50, afterId = 0 } = {})\`:
   - Returns messages addressed to \`to === agentId\` OR broadcast \`to === "*"\` (excluding messages where \`from === agentId\` when \`to === "*"\`), with \`id > afterId\`, ordered by \`id ASC\`, capped at \`limit\`.
   - CRITICAL PER-AGENT ACK RULE: acknowledging a broadcast (\`to === "*"\`) or direct message for \`agentA\` MUST only mark it read for \`agentA\`, NEVER for \`agentB\`! Direct messages can only be acked by their \`to\` recipient (throw \`Error\` if another agent tries to ack a direct message not addressed to them or \`"*"\`).
   - In \`inbox(agentId, ...)\`, \`ackAt\` in each returned row reflects when \`agentId\` acknowledged it (\`number | null\`), and \`unreadOnly: true\` filters to messages \`agentId\` has NOT yet acknowledged.
3. \`ack(agentId, messageId)\`:
   - Marks \`messageId\` acknowledged by \`agentId\` at \`Date.now()\`. Idempotent if already acked by \`agentId\` (keep original \`ackAt\` timestamp!). Throw \`RangeError\` if \`messageId\` does not exist. Returns \`{ id: messageId, ackAt }\`.
4. \`search(query, { limit = 20 } = {})\`:
   - Uses SQLite FTS5 over \`topic\` and \`body\`. Empty/whitespace \`query\` returns \`[]\`. Must safely handle punctuation/quotes/hyphens in \`query\` (e.g. \`"pi-durable"\`, \`"foo:bar"\`, \`"a'b"\`) as token prefix/phrase matches WITHOUT throwing SQLite FTS5 syntax errors! Returns matching messages ordered by relevance or \`id DESC\`, up to \`limit\`, with \`{ id, from, to, topic, body, replyTo, createdAt }\`.
5. \`thread(rootId)\`:
   - Returns the root message \`rootId\` plus ALL transitive replies (\`replyTo\` chain of arbitrary depth) ordered by \`id ASC\`. If \`rootId\` does not exist, return \`[]\`.
6. \`close()\`: closes the SQLite connection cleanly.

Write \`./bus.mjs\`, write a quick self-test, run \`node\` via \`bash\` to verify it works, and reply briefly when done.`;

const GRADER_TEST_CODE = `import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAgentBus } from "./bus.mjs";

function withBus(fn) {
  const dir = mkdtempSync(join(tmpdir(), "bus-grade-"));
  const dbPath = join(dir, "bus.sqlite");
  const bus = openAgentBus(dbPath);
  try {
    return fn(bus, dbPath);
  } finally {
    try { bus.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
}

test("1. validation & sequential ids", () => withBus((bus) => {
  assert.throws(() => bus.send({ from: "", to: "b", topic: "t", body: "x" }), TypeError);
  assert.throws(() => bus.send({ from: "a", to: "   ", topic: "t", body: "x" }), TypeError);
  assert.throws(() => bus.send({ from: "a", to: "b", topic: "t", body: "x", replyTo: 999 }), RangeError);
  const m1 = bus.send({ from: "lead", to: "coder", topic: "init", body: "start work" });
  const m2 = bus.send({ from: "coder", to: "lead", topic: "init", body: "on it", replyTo: m1.id });
  assert.equal(m1.id, 1);
  assert.equal(m2.id, 2);
  assert.equal(m2.replyTo, 1);
}));

test("2. broadcast isolation & per-agent idempotent ack", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bus-grade-"));
  const dbPath = join(dir, "bus.sqlite");
  const bus = openAgentBus(dbPath);
  try {
    const b1 = bus.send({ from: "lead", to: "*", topic: "alert", body: "freeze deploy" });
    const d1 = bus.send({ from: "lead", to: "coder", topic: "task", body: "fix bug" });
    // Sender excluded from own broadcast
    assert.equal(bus.inbox("lead").length, 0);
    // Both coder and reviewer see broadcast; only coder sees d1
    assert.equal(bus.inbox("coder").length, 2);
    assert.equal(bus.inbox("reviewer").length, 1);

    // Reviewer cannot ack coder's direct message
    assert.throws(() => bus.ack("reviewer", d1.id));
    // Non-existent message throws RangeError
    assert.throws(() => bus.ack("coder", 9999), RangeError);

    // Coder acks broadcast -> unread for reviewer MUST still include b1!
    const a1 = bus.ack("coder", b1.id);
    await new Promise((r) => setTimeout(r, 15));
    const a2 = bus.ack("coder", b1.id);
    assert.equal(a1.ackAt, a2.ackAt, "ack must be idempotent keeping original timestamp");

    assert.equal(bus.inbox("coder", { unreadOnly: true }).length, 1);
    assert.equal(bus.inbox("coder", { unreadOnly: false }).length, 2);
    assert.equal(bus.inbox("reviewer", { unreadOnly: true }).length, 1, "broadcast ack leaked across agents!");
  } finally {
    try { bus.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test("3. FTS5 punctuation safety & recall", () => withBus((bus) => {
  bus.send({ from: "a", to: "b", topic: "pi-durable", body: "crash recovery on foo:bar and user's sqlite" });
  bus.send({ from: "a", to: "b", topic: "other", body: "unrelated message" });
  assert.deepEqual(bus.search("   "), []);
  const r1 = bus.search("pi-durable");
  assert.equal(r1.length, 1);
  const r2 = bus.search("foo:bar");
  assert.equal(r2.length, 1);
  const r3 = bus.search("user's");
  assert.equal(r3.length, 1);
}));

test("4. deep transitive thread & persistence across reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "bus-grade-"));
  const dbPath = join(dir, "bus.sqlite");
  let bus = openAgentBus(dbPath);
  const m1 = bus.send({ from: "a", to: "b", topic: "root", body: "level 0" });
  const m2 = bus.send({ from: "b", to: "a", topic: "re", body: "level 1", replyTo: m1.id });
  const m3 = bus.send({ from: "a", to: "b", topic: "re", body: "level 2", replyTo: m2.id });
  const m4 = bus.send({ from: "c", to: "a", topic: "re", body: "level 3", replyTo: m3.id });
  bus.send({ from: "x", to: "y", topic: "other", body: "noise" });
  bus.close();

  bus = openAgentBus(dbPath);
  try {
    assert.deepEqual(bus.thread(999), []);
    const th = bus.thread(m1.id);
    assert.deepEqual(th.map((x) => x.id), [m1.id, m2.id, m3.id, m4.id]);
  } finally {
    bus.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
`;

async function runSingleCandidate(candidate) {
  const workDir = await mkdtemp(join(tmpdir(), `bench-${candidate.modelId.replace(/[^a-z0-9]/gi, "_")}-`));
  const dbFile = join(workDir, ".durable.sqlite");
  const models = createFrontierModels();
  const registry = createRegistry();
  registry.install(CodingTools);

  const t0 = Date.now();
  let storage;
  let harness;
  let settledStatus = "error";
  let errorDetail = null;
  let usage = null;
  let turns = 0;

  try {
    storage = await openNodeSqliteStorage(dbFile);
    harness = await Harness.open(
      storage,
      {
        models,
        registry,
        settings: {
          retry: { enabled: true, maxRetries: 2, baseDelayMs: 1000 },
        },
        env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd || workDir }),
      },
      BACKGROUND_CONTEXT,
    );

    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: {
        model: { provider: candidate.provider, modelId: candidate.modelId },
        thinkingLevel: "high",
        cwd: workDir,
        maxTurns: 20,
        instructions: V3_CAVEMAN_ADHD,
      },
    });

    const sub = await root.submit({ type: "input", content: CODING_SPEC }, BACKGROUND_CONTEXT);
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("TIMEOUT_240S")), 240_000));
    const settled = await Promise.race([sub.wait(BACKGROUND_CONTEXT), timeout]);
    settledStatus = settled.status === "done" ? "done" : `${settled.status}:${settled.reason}`;
  } catch (err) {
    errorDetail = err?.message || String(err);
  } finally {
    try {
      if (harness) {
        const root = await harness.root(BACKGROUND_CONTEXT);
        const ctx = await root.context(BACKGROUND_CONTEXT);
        turns = ctx.entries.filter((e) => e.kind === "pi.assistant").length;
        usage = await harness.usage(BACKGROUND_CONTEXT);
        await harness.close(BACKGROUND_CONTEXT);
      }
    } catch {}
  }

  const wallSec = +((Date.now() - t0) / 1000).toFixed(2);

  // Run independent pristine grader suite!
  let passCount = 0;
  let totalTests = 4;
  let graderOutput = "";
  let loc = 0;
  let bestSource = null;
  try {
    const src = await readFile(join(workDir, "bus.mjs"), "utf8");
    loc = src.split("\n").filter((l) => l.trim().length > 0).length;
    await writeFile(join(workDir, "grader.test.mjs"), GRADER_TEST_CODE, "utf8");
    const { stdout, stderr } = await execFileAsync("node", ["--test", "grader.test.mjs"], {
      cwd: workDir,
      timeout: 15_000,
    });
    graderOutput = stdout + stderr;
    const mPass = graderOutput.match(/ℹ pass (\d+)/);
    passCount = mPass ? Number(mPass[1]) : 4;
    if (passCount === 4) bestSource = src;
  } catch (err) {
    graderOutput = (err?.stdout || "") + "\n" + (err?.stderr || err?.message || "");
    const mPass = graderOutput.match(/ℹ pass (\d+)/);
    passCount = mPass ? Number(mPass[1]) : 0;
  }

  await rm(workDir, { recursive: true, force: true });

  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, totalTokens = 0, costUsd = 0;
  if (usage?.models) {
    for (const u of Object.values(usage.models)) {
      inputTokens += u.input ?? 0;
      outputTokens += u.output ?? 0;
      cacheReadTokens += u.cacheRead ?? 0;
      totalTokens += u.totalTokens ?? 0;
      costUsd += u.cost?.total ?? 0;
    }
  }
  return {
    label: candidate.label,
    provider: candidate.provider,
    modelId: candidate.modelId,
    status: settledStatus,
    error: errorDetail,
    pass: `${passCount}/${totalTests}`,
    passCount,
    wallSec,
    turns,
    loc,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    totalTokens,
    costUsd: +costUsd.toFixed(4),
    graderTail: passCount === 4 ? "ALL_GREEN" : graderOutput.slice(-300).replace(/\s+/g, " ").trim(),
    bestSource,
  };
}

// Load .env
const envRaw = await readFile(new URL("../.env", import.meta.url), "utf8");
for (const line of envRaw.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const filter = process.argv[2];
const filterRegex = filter ? new RegExp(filter, "i") : null;
const selected = filterRegex
  ? FRONTIER_ROSTER.filter((c) => filterRegex.test(c.modelId) || filterRegex.test(c.label))
  : FRONTIER_ROSTER;

console.log(`Running Coding Benchmark across ${selected.length} frontier models (concurrency=4)...`);

const results = [];
const queue = [...selected];
const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
  while (queue.length > 0) {
    const c = queue.shift();
    if (!c) break;
    const res = await runSingleCandidate(c);
    results.push(res);
    console.log(
      `[${res.pass}] ${res.label.padEnd(42)} | ${String(res.wallSec).padStart(6)}s | turns=${String(res.turns).padStart(2)} | tok=${String(res.totalTokens).padStart(6)} | $${res.costUsd.toFixed(4)} | loc=${res.loc} | ${res.status}${res.error ? " ERR:" + res.error : ""}`,
    );
  }
});
await Promise.all(workers);

results.sort((a, b) => b.passCount - a.passCount || a.wallSec - b.wallSec);
await writeFile(
  new URL(filter ? "./results-round1b-extra.json" : "./results-round1-coding.json", import.meta.url),
  JSON.stringify(results.map(({ bestSource, ...r }) => r), null, 2),
);
const winner = results.find((r) => r.passCount === 4 && r.bestSource);
if (winner && !filter) {
  await writeFile(new URL("./winner-bus.mjs", import.meta.url), winner.bestSource);
}
console.log("\nSaved bench/results-round1-coding.json" + (winner ? ` + bench/winner-bus.mjs (from ${winner.label})` : ""));
