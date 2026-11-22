import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { configure, LiveDoc } from "@earendil-works/pi-durable";
import { openSwarmDaemon } from "./src/daemon.mjs";

const OUTCOME_MARKER = "EMIN_SWARM_OUTCOME:";
const SOURCE_COMMIT = "77addff168d4201f3c7f3d60d3abbd9167f8d09a";
const startedAt = Date.now();
const timeoutSec = Number(process.env.EMIN_SWARM_TIMEOUT_SEC || "3600");
if (!Number.isFinite(timeoutSec) || timeoutSec < 60) {
  throw new Error("EMIN_SWARM_TIMEOUT_SEC must be at least 60");
}
const timeoutMs = timeoutSec * 1000;
const pollDeadline = startedAt + timeoutMs - Math.min(15_000, timeoutMs * 0.1);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const secrets = [
  "LLMGATEWAY_API_KEY",
  "ALLMODELS_API_KEY",
  "ROUTER_PAYMENTREQUIRED_API_KEY",
  "LOCAL_LLAMA_API_KEY",
].map((name) => process.env[name]).filter(Boolean);

function bounded(value, max = 1000) {
  let text = String(value ?? "");
  for (const secret of secrets) text = text.replaceAll(secret, "[REDACTED]");
  text = text
    .replace(/Bearer\s+[^\s,;"']+/gi, "Bearer [REDACTED]")
    .replace(/((?:api[_-]?key|authorization)["']?\s*[:=]\s*["']?)[^\s,;"'}]+/gi, "$1[REDACTED]");
  return text.length > max ? `${text.slice(0, max)}…[truncated]` : text;
}

let watchdogFired = false;
const watchdog = setTimeout(async () => {
  watchdogFired = true;
  const outcome = {
    ok: false,
    status: "timeout",
    sourceCommit: SOURCE_COMMIT,
    error: `Emin Swarm exceeded its ${timeoutSec}s overall cap`,
    wallClockSec: +((Date.now() - startedAt) / 1000).toFixed(2),
  };
  if (daemon) {
    await Promise.race([
      daemon.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  }
  process.stdout.write(`${OUTCOME_MARKER}${JSON.stringify(outcome)}\n`, () => process.exit(1));
}, timeoutMs);

let daemon;
let outcome = { ok: false, status: "error", sourceCommit: SOURCE_COMMIT };
let exitCode = 1;

try {
  const instructionPath = process.argv[2];
  if (!instructionPath) throw new Error("Usage: driver.mjs <instruction-file>");
  const instruction = await readFile(instructionPath, "utf8");
  const dataDir = await mkdtemp(join(tmpdir(), "emin-harbor-durable-"));
  daemon = await openSwarmDaemon({ dataDir, workspaceDir: process.cwd() });
  const leadMaxTurns = Number(process.env.EMIN_SWARM_LEAD_MAX_TURNS || "64");
  if (!Number.isInteger(leadMaxTurns) || leadMaxTurns < 16) {
    throw new Error("EMIN_SWARM_LEAD_MAX_TURNS must be an integer of at least 16");
  }
  await daemon.harness.commit(async (tx) => {
    await configure(tx, 1, { maxTurns: leadMaxTurns });
  }, BACKGROUND_CONTEXT);
  daemon.harness.resume();
  const submission = await daemon.chat(instruction, { wait: false });
  if (!submission?.submissionId) {
    throw new Error(`Daemon rejected the Harbor instruction: ${bounded(submission?.error || submission)}`);
  }
  daemon.harness.resume();

  async function sampleActivity() {
    const status = await daemon.status();
    const workers = Object.values(status.swarm?.workers || {}).filter((worker) => worker?.role !== "btw");
    const lives = await Promise.all(
      workers.map((worker) => daemon.harness.snapshot(LiveDoc, worker.convId, BACKGROUND_CONTEXT)),
    );
    let active = Boolean(
      status.liveTasks > 0 || status.pendingSubmissions > 0 || status.lead?.busy,
    );
    for (let index = 0; index < workers.length; index += 1) {
      const worker = workers[index];
      const live = lives[index];
      if (live?.run || live?.generation || live?.tools?.some((tool) => ["pending", "running"].includes(tool.status))) {
        active = true;
      }
      const supervisorStatus = worker.supervisor?.status;
      if (
        worker.supervisor &&
        !["done", "exhausted", "terminal"].includes(supervisorStatus)
      ) {
        active = true;
      }
    }
    return { active, status, workers, lives };
  }

  let timedOut = false;
  let quietSince = null;
  let consecutivePollErrors = 0;
  while (Date.now() < pollDeadline) {
    try {
      await daemon.supervisor.tick();
      const sample = await sampleActivity();
      consecutivePollErrors = 0;
      if (sample.active) {
        quietSince = null;
      } else if (quietSince === null) {
        quietSince = Date.now();
      } else if (Date.now() - quietSince >= 3000) {
        break;
      }
    } catch (error) {
      consecutivePollErrors += 1;
      quietSince = null;
      if (consecutivePollErrors >= 5) throw error;
    }
    await sleep(1000);
  }
  if (quietSince === null || Date.now() - quietSince < 3000) timedOut = true;

  await daemon.supervisor.tick();
  const finalSample = await sampleActivity();
  const finalStatus = finalSample.status;
  const workers = finalSample.workers;
  const durableSubmission = await daemon.harness.submission(submission.submissionId, BACKGROUND_CONTEXT);
  const submissionResult = durableSubmission
    ? await durableSubmission.status(BACKGROUND_CONTEXT)
    : null;
  const submissionError = submissionResult?.status === "done"
    ? null
    : `Lead submission ${bounded(submissionResult?.reason || submissionResult?.detail || submissionResult?.status || "not found", 600)}`;
  const conversations = [
    { conversationId: 1, workerId: "lead", role: "lead" },
    ...workers.map((worker) => ({
      conversationId: worker.convId,
      workerId: worker.workerId,
      role: worker.role,
    })),
  ];
  const errors = [];
  const transcriptPreviews = {};
  let finalReply = "";
  let toolCalls = 0;
  for (const conversation of conversations) {
    const transcript = await daemon.readTranscript(conversation.conversationId, 200);
    for (const entry of transcript) {
      if (Array.isArray(entry.toolCalls)) toolCalls += entry.toolCalls.length;
    }
    transcriptPreviews[conversation.workerId] = transcript.slice(-8).map((entry) => ({
      role: entry.role,
      stopReason: entry.stopReason,
      text: bounded(entry.text, 800),
      errorMessage: bounded(entry.errorMessage, 800),
      toolCalls: entry.toolCalls,
    }));
    const lastAssistant = [...transcript].reverse().find((entry) => entry.role === "assistant");
    if (conversation.conversationId === 1) finalReply = lastAssistant?.text || "";
    if (lastAssistant?.stopReason === "error" || lastAssistant?.errorMessage) {
      errors.push(
        `${conversation.workerId}: ${bounded(lastAssistant.errorMessage || lastAssistant.stopReason, 600)}`,
      );
    }
  }
  for (const worker of workers) {
    const supervisorStatus = worker.supervisor?.status;
    if (["terminal", "exhausted"].includes(supervisorStatus)) {
      const failure = worker.supervisor?.lastFailure;
      errors.push(
        `${worker.workerId}: supervisor ${supervisorStatus} (${bounded(failure?.reason || "unknown", 100)}: ${bounded(failure?.detail, 500)})`,
      );
    }
  }
  for (let index = 0; index < workers.length; index += 1) {
    const failure = finalSample.lives[index]?.runFailure;
    if (failure) {
      errors.push(`${workers[index].workerId}: ${bounded(failure.reason || "failed", 100)}: ${bounded(failure.detail, 600)}`);
    }
  }
  if (submissionError) errors.push(submissionError);
  if (finalSample.active) errors.push("Emin Swarm still has active work after the quiescence window");

  const usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, totalTokens: 0, costUsd: 0 };
  for (const model of Object.values(finalStatus.usage?.byModel || {})) {
    usage.inputTokens += model.input || 0;
    usage.outputTokens += model.output || 0;
    usage.reasoningTokens += model.reasoning || 0;
    usage.cacheReadTokens += model.cacheRead || 0;
    usage.totalTokens += model.totalTokens || 0;
    usage.costUsd += model.cost?.total || 0;
  }
  usage.costUsd = +usage.costUsd.toFixed(5);
  if (timedOut) errors.push(`Emin Swarm did not settle before its ${timeoutSec}s overall cap`);

  outcome = {
    ok: !timedOut && !finalSample.active && errors.length === 0,
    status: timedOut ? "timeout" : "settled",
    sourceCommit: SOURCE_COMMIT,
    submission: {
      route: submission.route,
      submissionId: submission.submissionId,
      conversationId: submission.conversationId,
    },
    finalReply: bounded(finalReply, 4000),
    liveTasks: finalStatus.liveTasks,
    pendingSubmissions: finalStatus.pendingSubmissions,
    workers: workers.slice(0, 50).map((worker) => ({
      workerId: bounded(worker.workerId, 120),
      role: bounded(worker.role, 40),
      conversationId: worker.convId,
      supervisorStatus: worker.supervisor?.status || null,
      autoResumes: worker.supervisor?.autoResumes || 0,
    })),
    workerCount: workers.length,
    autoResumes: workers.reduce((sum, worker) => sum + (worker.supervisor?.autoResumes || 0), 0),
    toolCalls,
    usage,
    errors: [...new Set(errors)].slice(0, 20),
    ...(errors.length ? { transcriptPreviews } : {}),
  };
  exitCode = outcome.ok ? 0 : 1;
} catch (error) {
  outcome = {
    ok: false,
    status: "error",
    sourceCommit: SOURCE_COMMIT,
    error: bounded(error?.stack || error?.message || error, 4000),
  };
  exitCode = 1;
} finally {
  if (daemon) {
    let closeTimer;
    try {
      await Promise.race([
        daemon.close(),
        new Promise((_, reject) => {
          closeTimer = setTimeout(() => reject(new Error("daemon.close() exceeded 10s")), 10_000);
        }),
      ]);
    } catch (error) {
      outcome.ok = false;
      outcome.status = "error";
      outcome.errors = [...(outcome.errors || []), bounded(error?.message || error, 1000)].slice(0, 20);
      exitCode = 1;
    } finally {
      clearTimeout(closeTimer);
    }
  }
}

if (!watchdogFired) {
  clearTimeout(watchdog);
  outcome.wallClockSec = +((Date.now() - startedAt) / 1000).toFixed(2);
  await new Promise((resolve) => process.stdout.write(`${OUTCOME_MARKER}${JSON.stringify(outcome)}\n`, resolve));
  process.exit(exitCode);
}
