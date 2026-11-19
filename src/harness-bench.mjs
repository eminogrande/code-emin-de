/**
 * `/reinforce harness` — Cross-Harness Coding Subagent Benchmark (`kimi-code` vs `pi` vs `opencode` vs `pi-durable`).
 *
 * Holds the open-weights coding model constant (`k3.1-pro`) and isolates each CLI/SDK harness inside
 * its own fresh git clone at a pre-fix commit (`8838f14`), measuring:
 *   1. Hard deterministic test verification (`node --check` + `node --test` under a strict 20s timeout)
 *   2. Blinded `human-like-retrospective-v2` 3-persona frontier coding judge score
 *   3. Full HackMD telemetry (`totalTokens`, `inputTokens`, `cacheReadTokens`, `outputTokens`, `reasoningTokens`,
 *      `toolCalls`, `replyWords`, `codeLoc`, `costUsd`, `wallClockSec`)
 */

import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { V3_CAVEMAN_ADHD } from "./prompts.mjs";
import {
  buildBlindMap,
  buildJudgeUserPrompt,
  computeCompositeRank,
  computeDiffLoc,
  countWords,
  JUDGE_PERSONAS,
  JUDGE_PROTOCOL,
  JUDGE_SYSTEM_PROMPT,
  parseJudgeVote,
  scoreWithFrontierPanel,
} from "./reinforce.mjs";

const execFileAsync = promisify(execFile);

/**
 * Episode #2: Real multi-file bugfix task from `pi-durable-swarm` commit `8838f14` -> `fa7d96c`.
 * Pre-fix state has TWO subtle, coupled harness/runtime bugs:
 *   1. `test/chat-client.test.mjs` fails subtest 4 (`2 !== 1`) and hangs on exit because inline `let busy` in
 *      `src/web.mjs` is unreachable via `w.eval("busy = true")` in JSDOM and `setInterval` timers aren't cleared on unload.
 *   2. `test/supervisor.integration.test.mjs` hangs/fails because:
 *      - `extractAssistantText(entryOrMsg)` in `src/daemon.mjs` does `entryOrMsg?.model?.[0] ?? entryOrMsg` (indexing char 0 of `AssistantMessage.model` string `"faux-1"` -> `"f"`), breaking `onYield`!
 *      - `resumeWorker` calls non-existent `conv.configure(...)` and undefined `patch(...)` instead of `configure(tx, conv.id, ...)` + `SwarmDoc` commit!
 *      - `src/supervisor.mjs` `setTimer` doesn't `.unref?.()` background timers, and Lead + Worker share a single `fauxProvider` queue in `test/supervisor.integration.test.mjs`.
 */
export const EPISODE_2_SUPERVISOR_AND_CLIENT_BUGFIX = {
  id: "ep2-supervisor-chatclient-bugfix",
  title: "Fix Hanging Supervisor Integration & Chat-Client JSDOM Polling Bugs (`8838f14`)",
  baseCommit: "8838f14",
  prompt: [
    "Fix all failing and hanging tests in `test/chat-client.test.mjs` and `test/supervisor.integration.test.mjs` without breaking `test/supervisor.test.mjs`, `test/webauthn.test.mjs`, `test/worker-meta.test.mjs`, `test/markdown.test.mjs`, or `test/mermaid.test.mjs`.",
    "",
    "Constraints:",
    "- Do NOT run `npm install` or add dependencies (`./node_modules` is already symlinked).",
    "- Keep the root causes clean and minimal in `src/daemon.mjs`, `src/supervisor.mjs`, `src/web.mjs`, and `test/supervisor.integration.test.mjs` (do not delete assertions or skip tests).",
    "- Do NOT leave debug files, temporary test files, or `console.log` statements in git working tree; keep your final `git diff` minimal and production-ready.",
    "- Run `node --test test/chat-client.test.mjs test/supervisor.integration.test.mjs test/supervisor.test.mjs test/webauthn.test.mjs test/worker-meta.test.mjs` and ensure the command exits 0 cleanly within 15 seconds with 0 hanging timers.",
  ].join("\n"),
};

export const EPISODE_3_STANDALONE_RETRY_CACHE = {
  id: "ep3-async-singleflight-cache",
  title: "Greenfield: Bounded Async Singleflight + Stale-While-Revalidate + Exponential Jitter Module",
  baseCommit: "1809247",
  prompt: [
    "Create `src/singleflight-cache.mjs` and comprehensive unit tests in `test/singleflight-cache.test.mjs` (do NOT modify existing files or add npm dependencies).",
    "",
    "Export `createSingleflightCache({ ttlMs, staleWhileRevalidateMs = 0, maxEntries = 128, maxRetries = 0, baseRetryDelayMs = 20, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) })` with methods:",
    "1. `async get(key, loader, { signal } = {})`: ",
    "   - Fresh hit (`age < ttlMs`): returns cached value without calling `loader` and updates LRU recency.",
    "   - Stale-while-revalidate hit (`ttlMs <= age < ttlMs + staleWhileRevalidateMs`): immediately returns stale value and triggers at most ONE background refresh for `key` (errors in background refresh must NOT cause unhandled rejections and must keep the stale entry until it fully expires).",
    "   - Miss / expired: deduplicates concurrent in-flight calls for the same `key` so `loader({ signal })` runs ONCE; however, if an individual caller's `signal` aborts while waiting, ONLY that caller rejects with `AbortError` while remaining non-aborted callers still receive the shared in-flight result (unless ALL waiting callers abort, in which case the underlying `loader`'s `signal` aborts and the failed/aborted promise is evicted).",
    "   - Bounded retries: on `loader` rejection (except `AbortError`), retry up to `maxRetries` times using `sleep(baseRetryDelayMs * (2 ** attempt))` before rejecting all waiting callers and evicting in-flight state (never cache errors).",
    "   - Strict LRU capacity (`maxEntries`): evicts least-recently-used settled key when inserting beyond `maxEntries`.",
    "2. `invalidate(key)` and `clear()` and `stats()` (`{ size, hits, staleHits, misses, coalesced, evictions }`).",
    "",
    "Write thorough deterministic tests in `test/singleflight-cache.test.mjs` using injected fake `now`/`sleep` (must run in <2s with `node --test test/singleflight-cache.test.mjs` and 0 hanging timers).",
  ].join("\n"),
};

/**
 * Episode #4: Real single-file repair mined directly from commit `eb803b4` -> `2ec75a8`
 * (`Repo2RLEnvs`-style): detached `<li>` bug keeps right `AGENTS` sidebar blank forever.
 */
export const EPISODE_4_AGENTS_SIDEBAR_REPAIR = {
  id: "ep4-agents-sidebar-repair",
  title: "Repair: Fix Blank Right AGENTS Sidebar DOM Insertion Bug (`eb803b4`)",
  baseCommit: "eb803b4",
  prompt: [
    "Bug report: On `code.emin.de`, the right `AGENTS` sidebar (`#agents`) stays completely blank even when `/api/workers` returns workers (while the left `SEND TO` sidebar renders them normally).",
    "",
    "1. Find and fix the root cause in `src/web.mjs` (keep the fix minimal and clean; do not touch unrelated code).",
    "2. Add a deterministic regression test in `test/chat-client.test.mjs` verifying that workers returned by `/api/workers` are inserted into `#agents` and hide `#agentsEmpty`.",
    "3. Run `node --test test/chat-client.test.mjs` and ensure all tests exit 0 cleanly.",
    "",
    "Constraints: do NOT run `npm install` or add dependencies (`./node_modules` is already symlinked).",
  ].join("\n"),
};
// so cross-harness cost comparison reflects actual token efficiency rather than subscription vs API billing artifacts.
export const K31_PRO_PRICING_PER_M = {
  input: 2.0,
  cacheRead: 0.2,
  output: 10.0,
};

export function computeStandardizedKimiCost({ inputTokens = 0, cacheReadTokens = 0, outputTokens = 0 }) {
  // Note: `inputTokens` here is uncached input tokens (`inputOther`).
  const cost =
    (inputTokens * K31_PRO_PRICING_PER_M.input +
      cacheReadTokens * K31_PRO_PRICING_PER_M.cacheRead +
      outputTokens * K31_PRO_PRICING_PER_M.output) /
    1_000_000;
  return +cost.toFixed(5);
}

export const DEFAULT_HARNESS_CANDIDATES = [
  {
    id: "harness-kimi-code-k31",
    harness: "kimi-code",
    label: "Kimi Code CLI v2.5.2 (native)",
    modelId: "kimi-code/k3.1-pro",
  },
  {
    id: "harness-pi-cli-k31",
    harness: "pi-cli",
    label: "Pi Coding Agent CLI v1.5.2",
    provider: "paymentrequired",
    modelId: "k3.1-pro",
  },
  {
    id: "harness-opencode-k31",
    harness: "opencode",
    label: "OpenCode CLI v1.19.3 (--pure)",
    modelId: "router-internal/k3.1-pro",
  },
  {
    id: "harness-pi-durable-swarm-k31",
    harness: "pi-durable-swarm",
    label: "pi-durable Swarm Harness (our upgraded Lead+Coder)",
    provider: "paymentrequired",
    modelId: "k3.1-pro",
  },
];

async function runProcessWithTimeout(cmd, args, { cwd, env, stdinText = null, timeoutMs = 240_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: [stdinText !== null ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref?.();
    }, timeoutMs);
    timer.unref?.();
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
    if (stdinText !== null) {
      child.stdin.end(stdinText);
    }
  });
}

/** Parse Kimi Code CLI `stream-json` + `~/.kimi-code/sessions/.../wire.jsonl` for exact tokens, reasoning, and tool calls. */
export async function parseKimiCodeTelemetry(
  stdout,
  {
    sessionIndexPath = join(homedir(), ".kimi-code", "session_index.jsonl"),
    workDir = null,
  } = {},
) {
  let sessionId = null;
  let toolCalls = 0;
  let finalReply = "";
  let reasoningChars = 0;

  for (const line of String(stdout || "").split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const ev = JSON.parse(t);
      if (ev.type === "session.resume_hint" && ev.session_id) sessionId = ev.session_id;
      if (ev.role === "assistant" && Array.isArray(ev.tool_calls)) toolCalls += ev.tool_calls.length;
      if (ev.role === "assistant" && typeof ev.content === "string" && ev.content.trim()) {
        finalReply = ev.content.trim();
      }
    } catch {}
  }

  let inputOther = 0;
  let cacheRead = 0;
  let output = 0;

  try {
    let sessionDir = null;
    const idxLines = (await readFile(sessionIndexPath, "utf8")).trim().split("\n");
    for (let i = idxLines.length - 1; i >= 0; i--) {
      const row = JSON.parse(idxLines[i]);
      if ((sessionId && row.sessionId === sessionId) || (workDir && row.workDir && row.workDir.includes(workDir))) {
        sessionDir = row.sessionDir;
        break;
      }
    }
    if (sessionDir) {
      const wireRaw = await readFile(join(sessionDir, "agents", "main", "wire.jsonl"), "utf8");
      for (const wLine of wireRaw.split("\n")) {
        if (!wLine.trim()) continue;
        try {
          const w = JSON.parse(wLine);
          if (w.type === "usage.record" && w.usageScope === "turn" && w.usage) {
            inputOther += w.usage.inputOther || 0;
            cacheRead += w.usage.inputCacheRead || 0;
            output += w.usage.output || 0;
          }
          if (w.type === "agent.message.appended" && Array.isArray(w.message?.message?.content)) {
            for (const part of w.message.message.content) {
              if (part.type === "think" && part.think) reasoningChars += part.think.length;
            }
          }
        } catch {}
      }
    }
  } catch {}

  const reasoningTokens = Math.round(reasoningChars / 4);
  const totalTokens = inputOther + cacheRead + output;
  return {
    inputTokens: inputOther,
    cacheReadTokens: cacheRead,
    outputTokens: output,
    reasoningTokens,
    totalTokens,
    toolCalls,
    finalReply,
    costUsd: computeStandardizedKimiCost({ inputTokens: inputOther, cacheReadTokens: cacheRead, outputTokens: output }),
  };
}

/** Parse `pi --mode json` event stream for exact tokens, reasoning, and tool calls. */
export function parsePiCliTelemetry(stdout) {
  let inputOther = 0;
  let cacheRead = 0;
  let output = 0;
  let reasoning = 0;
  let toolCalls = 0;
  let finalReply = "";

  for (const line of String(stdout || "").split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const ev = JSON.parse(t);
      if (ev.type === "message_end" && ev.message?.role === "assistant") {
        const u = ev.message.usage || {};
        inputOther += u.input || 0;
        cacheRead += u.cacheRead || 0;
        output += u.output || 0;
        reasoning += u.reasoning || 0;
        for (const c of ev.message.content || []) {
          if (c.type === "toolCall") toolCalls += 1;
          if (c.type === "text" && c.text?.trim()) finalReply = c.text.trim();
        }
      }
    } catch {}
  }

  const totalTokens = inputOther + cacheRead + output;
  return {
    inputTokens: inputOther,
    cacheReadTokens: cacheRead,
    outputTokens: output,
    reasoningTokens: reasoning,
    totalTokens,
    toolCalls,
    finalReply,
    costUsd: computeStandardizedKimiCost({ inputTokens: inputOther, cacheReadTokens: cacheRead, outputTokens: output }),
  };
}

/** Parse `opencode run --format json` event stream for exact tokens, reasoning, and tool calls. */
export function parseOpenCodeTelemetry(stdout) {
  let inputOther = 0;
  let cacheRead = 0;
  let output = 0;
  let reasoning = 0;
  let toolCalls = 0;
  let finalReply = "";

  for (const line of String(stdout || "").split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const ev = JSON.parse(t);
      if (ev.type === "tool_use") toolCalls += 1;
      if (ev.type === "text" && ev.part?.text?.trim()) finalReply = ev.part.text.trim();
      if (ev.type === "step_finish" && ev.part?.tokens) {
        const tk = ev.part.tokens;
        inputOther += tk.input || 0;
        cacheRead += tk.cache?.read || 0;
        output += tk.output || 0;
        reasoning += tk.reasoning || 0;
      }
    } catch {}
  }

  const totalTokens = inputOther + cacheRead + output;
  return {
    inputTokens: inputOther,
    cacheReadTokens: cacheRead,
    outputTokens: output,
    reasoningTokens: reasoning,
    totalTokens,
    toolCalls,
    finalReply,
    costUsd: computeStandardizedKimiCost({ inputTokens: inputOther, cacheReadTokens: cacheRead, outputTokens: output }),
  };
}

/** Deterministic hard verifier for Episode #2 or Episode #3 (must exit 0 within 20s — zero hanging handles). */
export async function verifyHarnessWorkspace(wsDir, episode = EPISODE_2_SUPERVISOR_AND_CLIENT_BUGFIX) {
  const logs = [];
  let pass = true;

  // 1. Syntax check all src/*.mjs
  const srcFiles = (await readdir(join(wsDir, "src"))).filter((f) => f.endsWith(".mjs")).map((f) => join("src", f));
  for (const sf of srcFiles) {
    const r = await runProcessWithTimeout("node", ["--check", sf], { cwd: wsDir, timeoutMs: 8000 });
    if (r.code !== 0 || r.timedOut) {
      pass = false;
      logs.push(`SYNTAX FAIL ${sf}: ${r.stderr || "timeout"}`);
    }
  }

  if (episode.id === "ep3-async-singleflight-cache") {
    // Run candidate's own unit tests PLUS an independent adversarial spec verifier so weak self-tests can't game PASS!
    const selfTest = await runProcessWithTimeout("node", ["--test", "test/singleflight-cache.test.mjs"], { cwd: wsDir, timeoutMs: 10_000 });
    if (selfTest.code !== 0 || selfTest.timedOut) {
      pass = false;
      logs.push(`SELF TEST FAIL (code=${selfTest.code}, timedOut=${selfTest.timedOut})`);
    }
    logs.push((selfTest.stdout + "\n" + selfTest.stderr).trim().slice(-1200));

    const specScript = `
      import assert from "node:assert/strict";
      import { createSingleflightCache } from "./src/singleflight-cache.mjs";
      let t = 1000;
      const sleeps = [];
      const cache = createSingleflightCache({
        ttlMs: 100,
        staleWhileRevalidateMs: 50,
        maxEntries: 2,
        maxRetries: 2,
        baseRetryDelayMs: 10,
        now: () => t,
        sleep: async (ms) => { sleeps.push(ms); },
      });
      // 1. Coalescing + partial caller abort isolation
      let calls = 0;
      let loaderAborted = false;
      let release;
      const gate = new Promise((r) => { release = r; });
      const c1 = new AbortController();
      const c2 = new AbortController();
      const p1 = cache.get("k1", async ({ signal } = {}) => {
        calls++;
        signal?.addEventListener("abort", () => { loaderAborted = true; });
        await gate;
        return "v1";
      }, { signal: c1.signal });
      const p2 = cache.get("k1", async () => { calls++; return "v2"; }, { signal: c2.signal });
      c1.abort();
      await assert.rejects(p1, (e) => e?.name === "AbortError" || /abort/i.test(String(e)));
      assert.equal(loaderAborted, false, "underlying loader must NOT abort when 1 caller still waits");
      release();
      assert.equal(await p2, "v1");
      assert.equal(calls, 1);

      // 2. Fresh hit + SWR background refresh
      t = 1050;
      assert.equal(await cache.get("k1", async () => "never"), "v1");
      t = 1120; // stale window [1100, 1150)
      let bgCalls = 0;
      assert.equal(await cache.get("k1", async () => { bgCalls++; return "v1-refreshed"; }), "v1");
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(bgCalls, 1);
      assert.equal(await cache.get("k1", async () => "never2"), "v1-refreshed");

      // 3. Retries + LRU eviction
      let flops = 0;
      const vRetry = await cache.get("k2", async () => {
        if (++flops <= 2) throw new Error("transient");
        return "ok-after-2";
      });
      assert.equal(vRetry, "ok-after-2");
      assert.deepEqual(sleeps.slice(0, 2), [10, 20]);
      await cache.get("k3", async () => "v3"); // evicts LRU (k1)
      assert.equal(cache.stats().size, 2);
      assert.ok(cache.stats().evictions >= 1);
      console.log("ADVERSARIAL_SPEC_PASS");
    `;
    const adv = await runProcessWithTimeout("node", ["--input-type=module", "-e", specScript], { cwd: wsDir, timeoutMs: 10_000 });
    if (adv.code !== 0 || adv.timedOut || !adv.stdout.includes("ADVERSARIAL_SPEC_PASS")) {
      pass = false;
      logs.push(`ADVERSARIAL SPEC FAIL (code=${adv.code}):\n${adv.stderr || adv.stdout}`);
    } else {
      logs.push("ADVERSARIAL SPEC: PASS (coalescing, partial-abort isolation, SWR, exponential retry, LRU)");
    }
    return { pass, verifierOutput: logs.join("\n") };
  }

  if (episode.id === "ep4-agents-sidebar-repair") {
    const selfTest = await runProcessWithTimeout("node", ["--test", "test/chat-client.test.mjs"], { cwd: wsDir, timeoutMs: 12_000 });
    if (selfTest.code !== 0 || selfTest.timedOut) {
      pass = false;
      logs.push(`SELF TEST FAIL (code=${selfTest.code}, timedOut=${selfTest.timedOut})`);
    }
    logs.push((selfTest.stdout + "\n" + selfTest.stderr).trim().slice(-1200));

    const advScript = `
      import assert from "node:assert/strict";
      import { readFileSync } from "node:fs";
      import { JSDOM } from "jsdom";
      const src = readFileSync("./src/web.mjs", "utf8");
      const clientScript = [...src.matchAll(/<script>\\n([\\s\\S]*?)\\n<\\/script>/g)].pop()[1];
      const dom = new JSDOM(
        '<!doctype html><body><div id="topbar"><button id="tLeft"></button><button id="tRight"></button></div><div id="backdrop" hidden></div><aside id="leftCol"><div id="targets"></div></aside><main><div id="log"></div><div id="sshBar"><span id="sshDesc"></span><button id="sshApprove"></button><button id="sshDeny"></button></div><form id="f"><textarea id="q"></textarea></form></main><aside id="rightCol"><ul id="agents"></ul><p id="agentsEmpty"></p></aside></body>',
        { runScripts: "outside-only", pretendToBeVisual: true },
      );
      const w = dom.window;
      if (!w.CSS) w.CSS = { escape: (s) => String(s).replace(/([^a-zA-Z0-9_-])/g, "\\\\$1") };
      let workers = [
        { id: "w-1", role: "coder", state: "running", createdAt: Date.now() - 2000, lastError: null },
        { id: "w-2", role: "btw", state: "idle_done", createdAt: Date.now() - 9000, lastError: null },
      ];
      w.fetch = async (url) => {
        if (String(url).startsWith("/api/workers")) return { ok: true, status: 200, json: async () => ({ workers: workers.slice() }) };
        if (String(url).startsWith("/api/history")) return { ok: true, status: 200, json: async () => ({ entries: [] }) };
        return { ok: true, status: 200, json: async () => ({ pending: [] }) };
      };
      w.eval(clientScript);
      await new Promise((r) => setTimeout(r, 40));
      const ul = w.document.getElementById("agents");
      assert.equal(ul.children.length, 2, "initial 2 workers must be rendered inside #agents");
      assert.equal(w.document.getElementById("agentsEmpty").hidden, true);
      workers.push({ id: "w-3", role: "watcher", state: "running", createdAt: Date.now(), lastError: null });
      await w.eval("pollWorkers()");
      assert.equal(ul.children.length, 3, "3rd newly-arriving worker must append without duplicates");
      w.close();
      console.log("ADVERSARIAL_EP4_PASS");
    `;
    const adv = await runProcessWithTimeout("node", ["--input-type=module", "-e", advScript], { cwd: wsDir, timeoutMs: 10_000 });
    if (adv.code !== 0 || adv.timedOut || !adv.stdout.includes("ADVERSARIAL_EP4_PASS")) {
      pass = false;
      logs.push(`ADVERSARIAL EP4 FAIL (code=${adv.code}):\n${adv.stderr || adv.stdout}`);
    } else {
      logs.push("ADVERSARIAL EP4: PASS (initial 2 workers + 3rd live worker render cleanly in #agents)");
    }
    return { pass, verifierOutput: logs.join("\n") };
  }

  // 2. Episode #2: Run target + regression test suite with hard 22s wall-clock cap
  const suite = [
    "test/chat-client.test.mjs",
    "test/supervisor.integration.test.mjs",
    "test/supervisor.test.mjs",
    "test/webauthn.test.mjs",
    "test/worker-meta.test.mjs",
    "test/markdown.test.mjs",
    "test/mermaid.test.mjs",
  ];
  const tr = await runProcessWithTimeout("node", ["--test", ...suite], { cwd: wsDir, timeoutMs: 22_000 });
  if (tr.code !== 0 || tr.timedOut) {
    pass = false;
    logs.push(`TEST SUITE FAIL (code=${tr.code}, timedOut=${tr.timedOut})`);
  }
  logs.push((tr.stdout + "\n" + tr.stderr).trim().slice(-2400));
  return { pass, verifierOutput: logs.join("\n") };
}

/** Execute one harness candidate inside a clean, isolated git clone at `episode.baseCommit`. */
export async function runSingleHarnessCandidate({
  repoDir,
  episode = EPISODE_2_SUPERVISOR_AND_CLIENT_BUGFIX,
  candidate,
  routerKey,
  timeoutMs = 390_000,
}) {
  const sandbox = await mkdtemp(join(tmpdir(), `harness-bench-${candidate.harness}-`));
  const wsDir = join(sandbox, "ws");
  const emptySkills = join(sandbox, "empty-skills");
  await mkdir(emptySkills, { recursive: true });

  try {
    await execFileAsync("git", ["clone", "--quiet", repoDir, wsDir]);
    await execFileAsync("git", ["checkout", "--quiet", episode.baseCommit], { cwd: wsDir });
    await symlink(resolve(repoDir, "node_modules"), join(wsDir, "node_modules"));

    // Place identical 486-byte V3 Caveman + ADHD discipline in AGENTS.md? No — keep repo untouched at 8838f14
    // and pass V3_CAVEMAN_ADHD uniformly in the prompt/addendum so git diff is 100% clean!
    const fullPrompt = `${V3_CAVEMAN_ADHD}\n\n${episode.prompt}`;
    const env = {
      ...process.env,
      ROUTER_INTERNAL_KEY: routerKey || process.env.ROUTER_INTERNAL_KEY || "",
      SWARM_SELF_REPO: "/nonexistent-harness-bench",
    };

    const t0 = Date.now();
    let telemetry;

    if (candidate.harness === "kimi-code") {
      const kimiBin = join(homedir(), ".kimi-code", "bin", "kimi");
      const res = await runProcessWithTimeout(
        kimiBin,
        ["-m", candidate.modelId, "--skills-dir", emptySkills, "--output-format", "stream-json", "-p", fullPrompt],
        { cwd: wsDir, env, timeoutMs },
      );
      telemetry = await parseKimiCodeTelemetry(res.stdout, { workDir: wsDir });
      if (res.timedOut) telemetry.finalReply = `[TIMEOUT] ${telemetry.finalReply}`;
    } else if (candidate.harness === "pi-cli") {
      const piBin = join(homedir(), ".local", "bin", "pi");
      const piEnv = { ...env };
      if (candidate.baseUrl) {
        const agentDir = join(sandbox, "pi-agent");
        await mkdir(agentDir, { recursive: true });
        await writeFile(join(agentDir, "APPEND_SYSTEM.md"), V3_CAVEMAN_ADHD + "\n");
        await writeFile(
          join(agentDir, "models.json"),
          JSON.stringify(
            {
              providers: {
                [candidate.provider || "local-llama"]: {
                  baseUrl: candidate.baseUrl,
                  api: "openai-completions",
                  apiKey: candidate.apiKey || "local-llama",
                  models: [
                    {
                      id: candidate.modelId,
                      name: candidate.label || candidate.modelId,
                      reasoning: Boolean(candidate.reasoning),
                      input: ["text"],
                      contextWindow: candidate.contextWindow || 32768,
                      maxTokens: candidate.maxTokens || 4096,
                      compat: { supportsDeveloperRole: false, supportsStore: false, maxTokensField: "max_tokens" },
                    },
                  ],
                },
              },
            },
            null,
            2,
          ),
        );
        piEnv.PI_CODING_AGENT_DIR = agentDir;
      }
      const res = await runProcessWithTimeout(
        piBin,
        [
          "--provider",
          candidate.provider || "paymentrequired",
          "--model",
          candidate.modelId,
          "--thinking",
          candidate.reasoning === false ? "off" : "high",
          "--no-session",
          "--no-skills",
          "--no-prompt-templates",
          "--no-extensions",
          "--no-mcp",
          "--mode",
          "json",
          "-p",
          episode.prompt, // APPEND_SYSTEM.md injects exact 486B V3_CAVEMAN_ADHD!
        ],
        { cwd: wsDir, env: piEnv, timeoutMs },
      );
      telemetry = parsePiCliTelemetry(res.stdout);
      if (candidate.zeroCost) telemetry.costUsd = 0;
      if (res.timedOut) telemetry.finalReply = `[TIMEOUT] ${telemetry.finalReply}`;
    } else if (candidate.harness === "opencode") {
      const ocBin = join(homedir(), ".local", "bin", "opencode");
      const res = await runProcessWithTimeout(
        ocBin,
        ["run", "--pure", "--auto", "--agent", "build", "-m", candidate.modelId, "--variant", "high", "--format", "json", fullPrompt],
        { cwd: wsDir, env, timeoutMs },
      );
      telemetry = parseOpenCodeTelemetry(res.stdout);
      if (res.timedOut) telemetry.finalReply = `[TIMEOUT] ${telemetry.finalReply}`;
    } else if (candidate.harness === "pi-durable-swarm") {
      // Run our upgraded pi-durable swarm harness inside an isolated child Node process so `daemon.close()`
      // can never hang the parent tournament if an in-flight worker tool/generation exceeds `timeoutMs`!
      const innerOut = join(sandbox, "durable-telemetry.json");
      const provId = candidate.provider || "paymentrequired";
      const baseUrl = candidate.baseUrl || "https://router.paymentrequired.com/v1/internal";
      const modelId = candidate.modelId || "k3.1-pro";
      const staticApiKey = candidate.apiKey || "";
      const ctxWin = candidate.contextWindow || 1048576;
      const maxTok = candidate.maxTokens || 65536;
      const isReasoning = candidate.reasoning !== false;
      const childScript = `
        import { writeFile } from "node:fs/promises";
        import { createModels, createProvider } from "@earendil-works/pi-ai";
        import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
        import { LiveDoc } from "@earendil-works/pi-durable";
        import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
        import { openSwarmDaemon } from ${JSON.stringify(resolve(repoDir, "src/daemon.mjs"))};

        const models = createModels();
        models.setProvider(
          createProvider({
            id: ${JSON.stringify(provId)},
            name: ${JSON.stringify(provId)},
            baseUrl: ${JSON.stringify(baseUrl)},
            auth: {
              apiKey: {
                async resolve() {
                  const k = ${JSON.stringify(staticApiKey)} || process.env.ROUTER_INTERNAL_KEY;
                  return k ? { auth: { apiKey: k }, source: "env" } : undefined;
                },
              },
            },
            models: [
              {
                id: ${JSON.stringify(modelId)},
                name: ${JSON.stringify(candidate.label || modelId)},
                api: "openai-completions",
                provider: ${JSON.stringify(provId)},
                baseUrl: ${JSON.stringify(baseUrl)},
                type: "chat",
                contextWindow: ${ctxWin},
                maxTokens: ${maxTok},
                reasoning: ${isReasoning},
                input: ["text"],
                cost: ${candidate.zeroCost ? "{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }" : "{ input: 2.0, output: 10.0, cacheRead: 0.2, cacheWrite: 0 }"},
                compat: { supportsDeveloperRole: false, supportsStore: false, maxTokensField: "max_tokens", thinkingFormat: "openrouter" },
              },
            ],
            api: openAICompletionsApi(),
          }),
        );
        const kRef = { provider: ${JSON.stringify(provId)}, modelId: ${JSON.stringify(modelId)} };
        const roleModels = { lead: kRef, coder: kRef, coderFast: kRef, reviewer: kRef, reviewerDeep: kRef, planner: kRef, support: kRef, social: kRef, watcher: kRef, btw: kRef };
        const daemon = await openSwarmDaemon({
          dataDir: ${JSON.stringify(join(sandbox, "durable-data"))},
          workspaceDir: ${JSON.stringify(wsDir)},
          models,
          roleModels,
          supervisor: { maxAutoResumes: 2, backoffMs: 500, intervalMs: 500 },
        });
        daemon.harness.resume();
        const deadline = Date.now() + ${timeoutMs - 8000};
        let replyText = "";
        const r = await Promise.race([
          daemon.chat(${JSON.stringify(episode.prompt)}, { wait: true }),
          new Promise((res) => setTimeout(() => res({ text: "[TIMEOUT]" }), Math.max(5000, deadline - Date.now()))),
        ]);
        replyText = r?.text || "";
        while (Date.now() < deadline) {
          await daemon.supervisor.tick();
          const st = await daemon.status();
          const workers = Object.values(st.swarm?.workers || {}).filter((w) => w.role !== "btw");
          let anyActive = st.liveTasks > 0;
          for (const w of workers) {
            const l = await daemon.harness.snapshot(LiveDoc, w.convId, BACKGROUND_CONTEXT);
            if (l?.run) anyActive = true;
            const supStatus = w.supervisor?.status;
            if (w.supervisor && supStatus !== "done" && supStatus !== "exhausted" && supStatus !== "terminal") anyActive = true;
          }
          if (!anyActive) {
            await new Promise((r2) => setTimeout(r2, 600));
            await daemon.supervisor.tick();
            if ((await daemon.status()).liveTasks === 0) break;
          }
          await new Promise((r2) => setTimeout(r2, 1000));
        }
        const stFinal = await daemon.status();
        const leadTr = await daemon.readTranscript(1, 50);
        const lastAss = [...leadTr].reverse().find((h) => h.role === "assistant" && (h.text || "").trim());
        if (lastAss) replyText = lastAss.text;
        let inputOther = 0, cacheRead = 0, output = 0, reasoning = 0, toolCalls = 0;
        for (const m of Object.values(stFinal.usage?.byModel || {})) {
          inputOther += m.input || 0;
          cacheRead += m.cacheRead || 0;
          output += m.output || 0;
          reasoning += m.reasoning || 0;
        }
        const convIds = [1, ...Object.values(stFinal.swarm?.workers || {}).map((w) => w.convId)];
        for (const cid of new Set(convIds)) {
          const tr = await daemon.readTranscript(cid, 200);
          for (const e of tr) if (Array.isArray(e.toolCalls)) toolCalls += e.toolCalls.length;
        }
        await writeFile(${JSON.stringify(innerOut)}, JSON.stringify({ inputTokens: inputOther, cacheReadTokens: cacheRead, outputTokens: output, reasoningTokens: reasoning, totalTokens: inputOther + cacheRead + output, toolCalls, finalReply: replyText }));
        process.exit(0);
      `;
      const res = await runProcessWithTimeout("node", ["--no-warnings", "--input-type=module", "-e", childScript], {
        cwd: repoDir,
        env,
        timeoutMs,
      });
      try {
        const rawT = JSON.parse(await readFile(innerOut, "utf8"));
        telemetry = {
          ...rawT,
          costUsd: candidate.zeroCost ? 0 : computeStandardizedKimiCost(rawT),
        };
      } catch {
        telemetry = {
          inputTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0,
          toolCalls: 0,
          finalReply: res.timedOut ? "[TIMEOUT]" : (res.stderr || "").slice(-300),
          costUsd: 0,
        };
      }
    } else {
      throw new Error(`Unknown harness: ${candidate.harness}`);
    }

    const wallClockSec = +((Date.now() - t0) / 1000).toFixed(2);
    const { pass, verifierOutput } = await verifyHarnessWorkspace(wsDir, episode);

    await execFileAsync("git", ["add", "-A"], { cwd: wsDir });
    const { stdout: patch } = await execFileAsync(
      "git",
      ["diff", "--cached", "--no-color", "--", ".", ":!node_modules", ":!package-lock.json"],
      { cwd: wsDir, maxBuffer: 8 * 1024 * 1024 },
    );
    const loc = computeDiffLoc(patch);

    return {
      candidateId: candidate.id,
      episodeId: episode.id,
      config: {
        harness: candidate.harness,
        label: candidate.label,
        leadModel: candidate.modelId,
        coderModel: candidate.modelId,
        optmem: false,
      },
      metrics: {
        testPass: pass,
        userNudges: 0,
        autoResumes: 0,
        totalTokens: telemetry.totalTokens,
        inputTokens: telemetry.inputTokens,
        cacheReadTokens: telemetry.cacheReadTokens,
        outputTokens: telemetry.outputTokens,
        reasoningTokens: telemetry.reasoningTokens,
        replyWords: countWords(telemetry.finalReply),
        codeLoc: loc.changed,
        codeAdded: loc.added,
        codeDeleted: loc.deleted,
        toolCalls: telemetry.toolCalls,
        costUsd: telemetry.costUsd,
        wallClockSec,
      },
      verifierOutput,
      patch,
      finalReplyPreview: String(telemetry.finalReply || "").slice(0, 500),
    };
  } finally {
    await rm(sandbox, { recursive: true, force: true }).catch(() => {});
  }
}

/** Call OpenAI `gpt-reserve` via `codex exec` as an independent frontier coding judge alongside Kimi/GLM fallback. */
export async function callCodexOpenAIJudge({ personaName, personaPrompt, blindLabel, issue, verifierSummary, patch }) {
  const dir = await mkdtemp(join(tmpdir(), "codex-hjudge-"));
  const outFile = join(dir, "last.txt");
  try {
    const prompt = `${JUDGE_SYSTEM_PROMPT}\n\nPersona (${personaName}): ${personaPrompt}\n\n${buildJudgeUserPrompt({
      blindLabel,
      issue,
      verifierSummary,
      patch,
    })}`;
    const res = await runProcessWithTimeout(
      join(homedir(), ".local", "bin", "codex"),
      ["-c", "model_provider=openai", "-c", "mcp_servers={}", "-m", "gpt-reserve", "exec", "--skip-git-repo-check", "-s", "read-only", "-o", outFile, "-"],
      { stdinText: prompt, timeoutMs: 120_000 },
    );
    if (res.code !== 0) return { judgeModel: "openai/gpt-reserve", persona: personaName, valid: false, error: `codex exit ${res.code}` };
    const raw = await readFile(outFile, "utf8");
    const parsed = parseJudgeVote(raw);
    if (!parsed) return { judgeModel: "openai/gpt-reserve", persona: personaName, valid: false, error: "Unparsable judge output" };
    return {
      judgeModel: "openai/gpt-reserve",
      persona: personaName,
      valid: true,
      score: parsed.score,
      rationale: parsed.rationale,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export function renderHarnessBenchmarkMarkdown({ episode, runs, title = null, controlledDesc = null }) {
  const sorted = [...runs].sort((a, b) => b.compositeRank - a.compositeRank);
  const lines = [
    title || `# Cross-Harness Coding Benchmark — Same Model (\`Kimi K3.1 Pro\`), 4 Different Harnesses`,
    "",
    `- **Episode ID:** \`${episode.id}\` (pre-fix commit \`${episode.baseCommit}\`)`,
    `- **Controlled Variable:** ${controlledDesc || "All 4 harnesses run **`Kimi K3.1 Pro`** (`thinking=high`) with the exact `486`-byte `V3_CAVEMAN_ADHD` prompt discipline, `0` external skills, and standardized K3.1 Pro token pricing (`$2.00 / $0.20 cache / $10.00` per 1M tokens)."}`,
    `- **Judge Protocol:** \`${JUDGE_PROTOCOL}\` — blinded labels (\`Candidate-A..D\`), 3 personas (\`correctness\`, \`readability\`, \`maintainability\`), scored by OpenAI Frontier Judge (\`openai/gpt-reserve\`).`,
    "",
    "## Head-to-Head Harness Results (Sorted by Composite Rank)",
    "",
    "| Rank | Harness | Model | Pass | Judge Mean (`/100`) | Tool Calls | Total Tokens | Uncached In | Cache Read | Output Tok | Code LOC | Norm. Cost | Wall Time |",
    "| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |",
  ];

  sorted.forEach((r, idx) => {
    const m = r.metrics;
    lines.push(
      `| #${idx + 1} | **${r.config.label}** (\`${r.config.harness}\`) | \`${r.config.coderModel}\` | ${m.testPass ? "**PASS**" : "FAIL"} | **${r.judge?.meanScore ?? "-"}** | ${m.toolCalls} | ${(m.totalTokens || 0).toLocaleString("en-US")} | ${(m.inputTokens || 0).toLocaleString("en-US")} | ${(m.cacheReadTokens || 0).toLocaleString("en-US")} | ${(m.outputTokens || 0).toLocaleString("en-US")} | ${m.codeLoc} | $${Number(m.costUsd || 0).toFixed(4)} | ${m.wallClockSec}s |`,
    );
  });

  lines.push("", "## Blinded Frontier Judge Rationales (`openai/gpt-reserve`)", "");
  for (const r of sorted) {
    lines.push(`### ${r.config.label} — \`${r.candidateId}\` (Blinded as \`${r.judge?.blindLabel || "?"}\` — Mean: \`${r.judge?.meanScore ?? "-"}/100\`)`);
    for (const v of r.judge?.votes || []) {
      if (v.valid) {
        lines.push(`- **\`${v.persona}\` (\`${v.score}/100\`):** ${v.rationale}`);
      } else {
        lines.push(`- **\`${v.persona}\` (dropped):** ${v.error}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

export async function runHarnessTournament({
  repoDir,
  episode = EPISODE_2_SUPERVISOR_AND_CLIENT_BUGFIX,
  candidates = DEFAULT_HARNESS_CANDIDATES,
  routerKey,
  reportDir = join(repoDir, "docs"),
  reportPrefix = null,
  concurrency = 1,
  timeoutMs = 390_000,
}) {
  // Run harnesses with bounded concurrency so upstream Kimi API never throttles concurrent high-thinking streams!
  const runs = [];
  const queue = [...candidates];
  const pool = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (queue.length > 0) {
      const candidate = queue.shift();
      if (!candidate) break;
      runs.push(
        await runSingleHarnessCandidate({
          repoDir,
          episode,
          candidate,
          routerKey,
          timeoutMs,
        }),
      );
    }
  });
  await Promise.all(pool);

  // Blind and score with OpenAI frontier judge across all 3 personas (all candidates in parallel)
  const { toBlind } = buildBlindMap(runs.map((r) => r.candidateId), "harness-bench-v1");
  await Promise.all(
    runs.map(async (r) => {
      const blindLabel = toBlind[r.candidateId];
      const verifierSummary = `testPass=${r.metrics.testPass}; codeLoc=${r.metrics.codeLoc}; toolCalls=${r.metrics.toolCalls}; wallClockSec=${r.metrics.wallClockSec}\n${r.verifierOutput || ""}`;
      const votes = await Promise.all(
        JUDGE_PERSONAS.map(([pName, pPrompt]) =>
          callCodexOpenAIJudge({
            personaName: pName,
            personaPrompt: pPrompt,
            blindLabel,
            issue: episode.prompt,
            verifierSummary,
            patch: r.patch,
          }),
        ),
      );
      const valid = votes.filter((v) => v.valid);
      const meanScore = valid.length ? +(valid.reduce((a, b) => a + b.score, 0) / valid.length).toFixed(2) : null;
      r.judge = {
        protocol: JUDGE_PROTOCOL,
        blindLabel,
        meanScore,
        validVoteCount: valid.length,
        totalVoteCount: votes.length,
        votes,
      };
      r.compositeRank = computeCompositeRank(r);
    }),
  );

  runs.sort((a, b) => b.compositeRank - a.compositeRank);
  const markdown = renderHarnessBenchmarkMarkdown({ episode, runs });

  if (reportDir) {
    await mkdir(reportDir, { recursive: true });
    const receiptRuns = runs.map(({ patch, ...rest }) => ({
      ...rest,
      patchBytes: Buffer.byteLength(patch || "", "utf8"),
      patchPreview: String(patch || "").slice(0, 40_000),
    }));
    const prefix = reportPrefix || episode.id;
    await writeFile(join(reportDir, `HARNESS_BENCHMARK_${prefix}.md`), markdown + "\n");
    await writeFile(
      join(reportDir, `harness-${prefix}-receipt.json`),
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          protocol: JUDGE_PROTOCOL,
          episodeId: episode.id,
          winner: runs[0]?.candidateId,
          runs: receiptRuns,
        },
        null,
        2,
      ) + "\n",
    );
  }

  return { winner: runs[0] || null, runs, markdown };
}

/** Boot a temporary `llama-server` (with optional `--lora`), probe raw tok/s, run `fn`, and tear down cleanly. */
export async function withLlamaServer(
  { modelPath, loraPath = null, alias = "local-model", port = 18088, ctxSize = 32768 },
  fn,
) {
  const args = ["-m", modelPath, "-ngl", "99", "-np", "1", "-c", String(ctxSize), "--port", String(port), "--alias", alias, "--jinja"];
  if (loraPath) args.push("--lora", loraPath);
  const child = spawn("llama-server", args, { stdio: ["ignore", "pipe", "pipe"] });
  let errTail = "";
  child.stderr.on("data", (d) => {
    errTail = (errTail + d.toString()).slice(-1500);
  });
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  try {
    const deadline = Date.now() + 60_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`llama-server exited early (${child.exitCode}): ${errTail}`);
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`);
        if (r.ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 400));
    }
    if (!ready) throw new Error(`llama-server health timeout: ${errTail}`);

    // Measure raw generation & prefill speed on this hardware
    let genTokPerSec = 0;
    let promptTokPerSec = 0;
    try {
      const pr = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: alias,
          max_tokens: 48,
          temperature: 0,
          messages: [{ role: "user", content: "Write a 3-line JS function sum(a,b) returning a+b." }],
        }),
      });
      if (pr.ok) {
        const j = await pr.json();
        genTokPerSec = +(j?.timings?.predicted_per_second || 0).toFixed(1);
        promptTokPerSec = +(j?.timings?.prompt_per_second || 0).toFixed(1);
      }
    } catch {}

    return await fn({ baseUrl, alias, genTokPerSec, promptTokPerSec });
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3000);
      t.unref?.();
      child.once("close", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

/**
 * Local Open-Weights + HF Harness-Adapter LoRA A/B Benchmark (`base` vs `+pi-lora` across `pi-cli` & `pi-durable-swarm`).
 * Reuses the exact blinded `human-like-retrospective-v2` frontier judge (`openai/gpt-reserve`) + external adversarial verifiers.
 */
export async function runLocalAdapterTournament({
  repoDir,
  episode = EPISODE_4_AGENTS_SIDEBAR_REPAIR,
  modelPath,
  loraPath = null,
  modelLabel = "LFM3-1.7B-Q4_K_M",
  ctxSize = 32768,
  reportDir = join(repoDir, "docs"),
  reportPrefix = null,
  timeoutMs = 180_000,
}) {
  const runs = [];
  const variants = [{ key: "base", lora: null, suffix: "BASE" }];
  if (loraPath) variants.push({ key: "pi-lora", lora: loraPath, suffix: "+HF-pi-LoRA" });

  let port = 18088;
  for (const v of variants) {
    const alias = `${modelLabel.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}-${v.key}`;
    await withLlamaServer({ modelPath, loraPath: v.lora, alias, port: port++, ctxSize }, async ({ baseUrl, genTokPerSec, promptTokPerSec }) => {
      for (const harness of ["pi-cli", "pi-durable-swarm"]) {
        const candidate = {
          id: `local-${alias}-${harness}`,
          harness,
          label: `${modelLabel} ${v.suffix} [${harness}] (${genTokPerSec} tok/s)`,
          provider: "local-llama",
          baseUrl,
          apiKey: "local-llama",
          modelId: alias,
          contextWindow: ctxSize,
          maxTokens: 8192,
          reasoning: true,
          zeroCost: true,
        };
        const r = await runSingleHarnessCandidate({ repoDir, episode, candidate, timeoutMs });
        r.metrics.genTokPerSec = genTokPerSec;
        r.metrics.promptTokPerSec = promptTokPerSec;
        runs.push(r);
      }
    });
  }

  const { toBlind } = buildBlindMap(runs.map((r) => r.candidateId), "local-adapter-v1");
  for (const r of runs) {
    const blindLabel = toBlind[r.candidateId];
    if (!r.patch || !r.patch.trim()) {
      r.judge = {
        protocol: JUDGE_PROTOCOL,
        blindLabel,
        meanScore: 0,
        validVoteCount: JUDGE_PERSONAS.length,
        totalVoteCount: JUDGE_PERSONAS.length,
        votes: JUDGE_PERSONAS.map(([pName]) => ({ judgeModel: "deterministic-empty-diff", persona: pName, valid: true, score: 0, rationale: "Empty patch (0 LOC changed)." })),
      };
      r.compositeRank = computeCompositeRank(r);
      continue;
    }
    const verifierSummary = `testPass=${r.metrics.testPass}; codeLoc=${r.metrics.codeLoc}; toolCalls=${r.metrics.toolCalls}; wallClockSec=${r.metrics.wallClockSec}; genTokPerSec=${r.metrics.genTokPerSec}\n${r.verifierOutput || ""}`;
    const votes = await Promise.all(
      JUDGE_PERSONAS.map(([pName, pPrompt]) =>
        callCodexOpenAIJudge({
          personaName: pName,
          personaPrompt: pPrompt,
          blindLabel,
          issue: episode.prompt,
          verifierSummary,
          patch: r.patch,
        }),
      ),
    );
    const valid = votes.filter((v) => v.valid);
    const meanScore = valid.length ? +(valid.reduce((a, b) => a + b.score, 0) / valid.length).toFixed(2) : null;
    r.judge = { protocol: JUDGE_PROTOCOL, blindLabel, meanScore, validVoteCount: valid.length, totalVoteCount: votes.length, votes };
    r.compositeRank = computeCompositeRank(r);
  }

  runs.sort((a, b) => b.compositeRank - a.compositeRank);
  const markdown = renderHarnessBenchmarkMarkdown({
    episode,
    runs,
    title: `# Local Self-Hosted Coding Benchmark — \`${modelLabel}\` BASE vs HF \`pi\` LoRA`,
    controlledDesc: `Local \`llama-server\` (\`${modelLabel}\`, \`$0\` inference) with and without HF \`harness-hub\` \`pi\` LoRA adapter across \`pi-cli\` and \`pi-durable-swarm\`, exact \`486\`-byte \`V3_CAVEMAN_ADHD\` prompt, \`0\` external skills.`,
  });

  if (reportDir) {
    await mkdir(reportDir, { recursive: true });
    const receiptRuns = runs.map(({ patch, ...rest }) => ({
      ...rest,
      patchBytes: Buffer.byteLength(patch || "", "utf8"),
      patchPreview: String(patch || "").slice(0, 40_000),
    }));
    const prefix = reportPrefix || episode.id;
    await writeFile(join(reportDir, `LOCAL_ADAPTER_BENCHMARK_${prefix}.md`), markdown + "\n");
    await writeFile(
      join(reportDir, `local-adapter-${prefix}-receipt.json`),
      JSON.stringify({ timestamp: new Date().toISOString(), protocol: JUDGE_PROTOCOL, episodeId: episode.id, winner: runs[0]?.candidateId, runs: receiptRuns }, null, 2) + "\n",
    );
  }
  return { winner: runs[0] || null, runs, markdown };
}
