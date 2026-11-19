/** Pure validation/shaping for durable orchestration control. No model calls. */
export const DEFAULT_ORCHESTRATION_ID = "general";
export const MIN_WORKER_INTERVAL_MS = 10_000;
export const MAX_WORKER_INTERVAL_MS = 31 * 24 * 60 * 60 * 1000;
export const WORKER_ROLES = Object.freeze(["coder", "reviewer", "planner", "support", "social", "watcher"]);

function boundedString(value, label, max) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  const out = value.trim();
  if (out.length > max) throw new Error(`${label} must be at most ${max} characters`);
  return out;
}

export function validateOrchestrationName(value) {
  return boundedString(value, "name", 60);
}

export function validateWorkerInput({ name, role = "coder", goal, mode = "once", everyMs } = {}) {
  const cleanName = boundedString(name, "name", 60);
  const cleanGoal = boundedString(goal, "goal", 12_000);
  if (!WORKER_ROLES.includes(role)) throw new Error(`Unknown worker role: ${role}`);
  if (mode !== "once" && mode !== "recurring") throw new Error("mode must be once or recurring");
  const interval = mode === "recurring" ? Number(everyMs) : null;
  if (mode === "recurring" && (!Number.isFinite(interval) || interval < MIN_WORKER_INTERVAL_MS || interval > MAX_WORKER_INTERVAL_MS)) {
    throw new Error(`everyMs must be ${MIN_WORKER_INTERVAL_MS}–${MAX_WORKER_INTERVAL_MS}`);
  }
  return { name: cleanName, role, goal: cleanGoal, mode, everyMs: interval };
}

export function publicOrchestration(o, live) {
  return {
    id: String(o.id),
    name: String(o.name),
    conversationId: o.convId,
    createdAt: Number(o.createdAt) || 0,
    state: live?.run ? "running" : live?.runFailure ? "failed" : "idle",
  };
}

export function nextRunAt(worker, now = Date.now()) {
  if (worker.mode !== "recurring" || worker.enabled === false) return null;
  const base = Number(worker.lastRunAt || worker.createdAt || now);
  return base + Number(worker.everyMs);
}
