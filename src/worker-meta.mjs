/**
 * worker-meta.mjs — pure shaping for the read-only sidebar worker list.
 *
 * Authoritative source only: `swarm.workers` (SwarmDoc) + per-conversation `LiveDoc`.
 * Never guesses: no live snapshot -> `idle_done`; no worker record -> not listed.
 */

const MAX_ERROR = 160;
const FAILED_TURN_LIMIT = "failed:turn_limit";

/** Concise, secret-free last error from a run failure (`reason: detail`, truncated). */
export function lastError(runFailure) {
  if (!runFailure) return null;
  const reason = String(runFailure.reason || "failed");
  const detail = String(runFailure.detail || "").replace(/\s+/g, " ").trim();
  const s = detail ? `${reason}: ${detail}` : reason;
  return s.length > MAX_ERROR ? `${s.slice(0, MAX_ERROR - 1)}…` : s;
}

/** running | idle_done | failed:turn_limit | failed */
export function workerState(live) {
  if (live?.run) return "running";
  const reason = live?.runFailure?.reason;
  if (!reason) return "idle_done";
  return reason === "turn_limit" ? FAILED_TURN_LIMIT : "failed";
}

/** Public record for one worker (no goal/prompts/internals). */
export function describeWorker(worker, live) {
  const out = {
    id: String(worker.workerId || worker.id || ""),
    role: String(worker.role || "coder"),
    conversationId: worker.convId ?? worker.conversationId ?? null,
    state: workerState(live),
    createdAt: Number(worker.createdAt) || 0,
    lastError: lastError(live?.runFailure),
    orchestrationId: String(worker.orchestrationId || "general"),
    name: String(worker.name || worker.workerId || worker.id || "worker"),
    mode: worker.mode === "recurring" ? "recurring" : "once",
    enabled: worker.enabled !== false,
    everyMs: worker.mode === "recurring" ? Number(worker.everyMs) || null : null,
    runCount: Number(worker.runCount) || 0,
    lastRunAt: Number(worker.lastRunAt) || null,
    lastAction: worker.lastAction ? String(worker.lastAction).slice(0, 80) : null,
  };
  if (worker.modelId) out.model = String(worker.modelId);
  return out;
}

/** Running first, then newest first; id tie-break keeps ordering stable. */
export function sortWorkers(list = []) {
  return list.slice().sort((a, b) => {
    const ra = a.state === "running" ? 0 : 1;
    const rb = b.state === "running" ? 0 : 1;
    if (ra !== rb) return ra - rb;
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
