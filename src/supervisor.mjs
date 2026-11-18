/**
 * supervisor.mjs — durable auto-continue for background workers.
 *
 * Only `turn_limit` is retried (never auth/billing/policy, i.e. `model_error`/`no_model` are terminal).
 * Bounded: `maxAutoResumes` per worker + `backoffMs` before each resume. Context is preserved because a
 * resume is a bare durable `continue`, never a fresh prompt.
 */

export const SUPERVISOR_DEFAULTS = { maxAutoResumes: 3, backoffMs: 2_000, intervalMs: 2_000 };

export const RETRYABLE = new Set(["turn_limit"]);

const COMMIT_RE = /^[0-9a-f]{7,40}\b.*/i;
const TEST_RE = /\b(\d+ (?:tests?|passing|failing)|ok \d+|Verified:\s*PASS.*|not ok \d+.*)/i;
const ERROR_RE = /\b(error|Error|ERR_|exception|failed|FAIL)\b/;

/** Failure signature used for "don't retry the same dead end forever". */
export function failureKey(runFailure) {
  return `${runFailure?.reason || ""}|${runFailure?.detail || ""}`;
}

/** Last commit/test/error lines of a transcript, for the final bus message. */
export function summarizeTranscript(entries = []) {
  let commit = "";
  const tests = [];
  const errors = [];
  for (const e of entries) {
    const text = String(e.text || "");
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!commit && COMMIT_RE.test(t)) commit = t.slice(0, 200);
      if (tests.length < 3 && TEST_RE.test(t)) tests.push(t.slice(0, 200));
      else if (errors.length < 3 && ERROR_RE.test(t)) errors.push(t.slice(0, 200));
    }
  }
  return { commit, tests, errors };
}

/**
 * Pure bounded decision, so the policy is testable without a harness.
 * @returns {{action:"none"|"wait"|"resume"|"exhausted"|"terminal"}}
 */
export function decideRecovery({ worker, live, now, opts = SUPERVISOR_DEFAULTS }) {
  const sup = worker?.supervisor || {};
  if (sup.status === "done" || sup.status === "terminal" || sup.status === "exhausted") {
    if (live?.run) return { action: "none", reason: "already_settled_running" };
    return { action: "none", reason: "settled" };
  }
  if (live?.run) return { action: "none", reason: "running" };

  const failure = live?.runFailure;
  if (!failure) return { action: "none", reason: sup.seenRun ? "no_failure" : "not_started" };

  const max = opts.maxAutoResumes ?? SUPERVISOR_DEFAULTS.maxAutoResumes;
  const resumes = sup.autoResumes || 0;

  if (!RETRYABLE.has(failure.reason)) return { action: "terminal", failure, reason: "not_retryable" };
  if (resumes >= max) return { action: "exhausted", failure, reason: "max_reached" };

  const nextAt = sup.nextAt || 0;
  if (now < nextAt) return { action: "wait", failure, waitMs: nextAt - now, reason: "backoff" };

  return { action: "resume", failure, reason: "turn_limit" };
}

/** Bounded, de-duplicated supervisor. All side effects are injected for network-free tests. */
export function createSupervisor({
  workers,
  live,
  patch,
  resumeWorker,
  notifyLead,
  transcript = async () => [],
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
  opts = SUPERVISOR_DEFAULTS,
}) {
  const o = { ...SUPERVISOR_DEFAULTS, ...opts };
  let timer = null;
  let ticking = false;

  const lead = (topic, body) => notifyLead(topic, body).catch(() => {});

  async function notifyStart(worker) {
    const sup = worker.supervisor || {};
    if (sup.startedAnnounced) return;
    await patch(worker.workerId, (w) => {
      w.supervisor = { ...(w.supervisor || {}), startedAnnounced: true, status: "supervising", nextAt: now() + o.backoffMs };
    });
    await lead(
      "SUPERVISOR_START",
      `[supervisor] supervising ${worker.workerId} (${worker.role}) — max ${o.maxAutoResumes} auto-resumes, ${o.backoffMs}ms backoff.\nGoal: ${(worker.goal || "").slice(0, 400)}`,
    );
  }

  async function doResume(worker, failure) {
    const sup = worker.supervisor || {};
    const attempt = (sup.autoResumes || 0) + 1;
    await patch(worker.workerId, (w) => {
      w.supervisor = {
        ...(w.supervisor || {}),
        autoResumes: attempt,
        lastFailure: { reason: failure.reason, detail: failure.detail || "", at: now() },
        nextAt: now() + o.backoffMs,
        status: "resuming",
      };
    });
    await lead(
      "SUPERVISOR_RESUME",
      `[supervisor] auto-resume ${attempt}/${o.maxAutoResumes} for ${worker.workerId} after ${failure.reason} (${failure.detail || "no detail"}).\nGoal: ${(worker.goal || "").slice(0, 400)}`,
    );
    await resumeWorker(worker, { attempt, failure, notice: resumeNotice(worker, failure, attempt, o) });
  }

  async function doExhausted(worker, failure) {
    const summary = summarizeTranscript(await transcript(worker.convId));
    await patch(worker.workerId, (w) => {
      w.supervisor = {
        ...(w.supervisor || {}),
        status: "exhausted",
        lastFailure: { reason: failure.reason, detail: failure.detail || "", at: now() },
      };
    });
    await lead(
      "SUPERVISOR_EXHAUSTED",
      `[supervisor] EXHAUSTED ${worker.workerId} after ${o.maxAutoResumes} auto-resumes (${failure.reason}: ${failure.detail || "no detail"}). Needs attention.\nGoal: ${(worker.goal || "").slice(0, 400)}${formatSummary(summary)}`,
    );
  }

  async function doTerminal(worker, failure) {
    if ((worker.supervisor || {}).status === "terminal") return;
    const summary = summarizeTranscript(await transcript(worker.convId));
    await patch(worker.workerId, (w) => {
      w.supervisor = {
        ...(w.supervisor || {}),
        status: "terminal",
        lastFailure: { reason: failure.reason, detail: failure.detail || "", at: now() },
      };
    });
    await lead(
      "SUPERVISOR_FAILED",
      `[supervisor] FAILED ${worker.workerId} (${failure.reason}: ${failure.detail || "no detail"}; not retried).\nGoal: ${(worker.goal || "").slice(0, 400)}${formatSummary(summary)}`,
    );
  }

  /** Worker ended cleanly: one final message, never twice. */
  async function notifyDone(worker) {
    const sup = worker.supervisor || {};
    if (sup.status === "done" || sup.doneAnnounced) return;
    const summary = summarizeTranscript(await transcript(worker.convId));
    await patch(worker.workerId, (w) => {
      w.supervisor = { ...(w.supervisor || {}), status: "done", doneAnnounced: true };
    });
    await lead(
      "WORKER_DONE",
      `[supervisor] ${worker.workerId} (${worker.role}) finished after ${sup.autoResumes || 0} auto-resume(s).${formatSummary(summary)}`,
    );
  }

  function formatSummary({ commit, tests, errors }) {
    const parts = [];
    if (commit) parts.push(`commit: ${commit}`);
    if (tests.length) parts.push(`tests: ${tests.join(" | ")}`);
    if (errors.length) parts.push(`errors: ${errors.join(" | ")}`);
    return parts.length ? `\n${parts.join("\n")}` : "\ncommit/tests: none reported";
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      for (const worker of Object.values(await workers())) {
        if (worker.role === "btw") continue;
        const l = await live(worker.convId);
        await notifyStart(worker);
        if (l?.run && !(worker.supervisor || {}).seenRun) {
          await patch(worker.workerId, (w) => {
            w.supervisor = { ...(w.supervisor || {}), seenRun: true };
          });
        }
        const d = decideRecovery({ worker, live: l, now: now(), opts: o });
        if (d.action === "resume") await doResume(worker, d.failure);
        else if (d.action === "exhausted") await doExhausted(worker, d.failure);
        else if (d.action === "terminal") await doTerminal(worker, d.failure);
        else if (d.action === "none" && d.reason === "no_failure" && (worker.supervisor || {}).status !== "done") {
          await notifyDone(worker);
        }
      }
    } finally {
      ticking = false;
    }
  }

  return {
    tick,
    start() {
      if (timer) return;
      const loop = async () => {
        try {
          await tick();
        } catch {}
        timer = setTimer(loop, Math.max(100, o.intervalMs));
      };
      timer = setTimer(loop, Math.max(100, o.intervalMs));
    },
    stop() {
      if (timer) clearTimer(timer);
      timer = null;
    },
  };
}

export function resumeNotice(worker, failure, attempt, opts = SUPERVISOR_DEFAULTS) {
  return `[SUPERVISOR AUTO-RESUME ${attempt}/${opts.maxAutoResumes ?? SUPERVISOR_DEFAULTS.maxAutoResumes}] Previous run hit turn_limit (${failure?.detail || "max turns"}). Context is preserved. Continue the SAME goal to completion, reuse what you already have, then finish with Verified: PASS. Original goal: ${worker.goal || "(see transcript)"}`;
}
