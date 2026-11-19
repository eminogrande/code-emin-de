/**
 * Deterministic Zero-LLM Slash Commands (`src/commands.mjs`)
 *
 * Inspired by `system-on-an-agent`'s rule-based control plane:
 * Operational inspection commands execute deterministically BEFORE any LLM call,
 * spending 0 tokens and responding in <50ms even when both cloud APIs and the
 * Tier-3 local `llama-server` failsafe are completely offline.
 *
 * Supported zero-LLM commands:
 *   - `/help`     -> Lists all deterministic zero-LLM commands + LLM-routed slash commands (`/btw`, `/reinforce`)
 *   - `/status`   -> Live Lead model/context, token/USD usage, active tasks, pending drafts, cron watchers
 *   - `/workers`  -> Authoritative worker roster (status, role, model, turns, live state)
 *   - `/hooks`    -> Registered out-of-core guardrail & lifecycle hooks (priority, events, block/trigger counts)
 *   - `/credits`  -> Zero-token provider & local failsafe health/billing reachability check
 */

import { DEFAULT_LOCAL_LLAMA_MODEL } from "./models.mjs";

export const DETERMINISTIC_COMMAND_NAMES = Object.freeze([
  "/help",
  "/status",
  "/workers",
  "/hooks",
  "/credits",
]);

export function parseSlashCommand(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed.startsWith("/")) return null;
  const m = trimmed.match(/^(\/[a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i);
  if (!m) return null;
  return {
    name: m[1].toLowerCase(),
    args: (m[2] || "").trim(),
    raw: trimmed,
  };
}

function fmtTokens(n) {
  const num = Number(n || 0);
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k`;
  return String(num);
}

function fmtPct(used, total) {
  if (!total || total <= 0) return "0%";
  return `${Math.min(100, Math.round((Number(used || 0) / Number(total)) * 100))}%`;
}

async function probeEndpoint({ name, tier, url, headers = {}, fetchImpl = fetch, timeoutMs = 2500, configured = true }) {
  if (!configured) {
    return { name, tier, ok: false, status: "unconfigured", latencyMs: 0, detail: "API key not set" };
  }
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  timer.unref?.();
  try {
    const res = await fetchImpl(url, { method: "GET", headers, signal: ctrl.signal });
    const latencyMs = Date.now() - t0;
    const status = res.status;
    if (res.ok) {
      return { name, tier, ok: true, status: `HTTP ${status}`, latencyMs, detail: "reachable" };
    }
    let bodySnippet = "";
    try {
      bodySnippet = (await res.text()).replace(/\s+/g, " ").trim().slice(0, 120);
    } catch {}
    const hint =
      status === 402
        ? "credits exhausted (HTTP 402)"
        : status === 401 || status === 403
          ? "auth rejected"
          : `HTTP ${status}`;
    return {
      name,
      tier,
      ok: false,
      status: `HTTP ${status}`,
      latencyMs,
      detail: bodySnippet ? `${hint}: ${bodySnippet}` : hint,
    };
  } catch (err) {
    const latencyMs = Date.now() - t0;
    const msg = err?.name === "AbortError" ? `timeout (${timeoutMs}ms)` : String(err?.message || err);
    return { name, tier, ok: false, status: "unreachable", latencyMs, detail: msg };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeProviderHealth({
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 2500,
} = {}) {
  const llmgKey = (env.LLMGATEWAY_API_KEY || "").trim();
  const llmgBase = (env.LLMGATEWAY_BASE_URL || "https://api.llmgateway.io/v1").replace(/\/+$/, "");

  const allmKey = (env.ALLMODELS_API_KEY || "").trim();
  const allmBase = (env.ALLMODELS_BASE_URL || "https://allmodels.io/api/v1").replace(/\/+$/, "");

  const localBase = (env.LOCAL_LLAMA_URL || "http://127.0.0.1:8089/v1").replace(/\/+$/, "");
  const localModel = env.LOCAL_LLAMA_MODEL || DEFAULT_LOCAL_LLAMA_MODEL;

  const [tier1, tier2, tier3] = await Promise.all([
    probeEndpoint({
      name: "llmgateway",
      tier: "Tier 1 (Primary)",
      url: `${llmgBase}/models`,
      headers: llmgKey ? { Authorization: `Bearer ${llmgKey}` } : {},
      configured: Boolean(llmgKey),
      fetchImpl,
      timeoutMs,
    }),
    probeEndpoint({
      name: "allmodels",
      tier: "Tier 2 (Cloud Failover)",
      url: `${allmBase}/models`,
      headers: allmKey ? { Authorization: `Bearer ${allmKey}` } : {},
      configured: Boolean(allmKey),
      fetchImpl,
      timeoutMs,
    }),
    probeEndpoint({
      name: `local-llama (${localModel})`,
      tier: "Tier 3 (Local Failsafe)",
      url: `${localBase}/models`,
      headers: {},
      configured: Boolean(localBase),
      fetchImpl,
      timeoutMs,
    }),
  ]);

  return [tier1, tier2, tier3];
}

function formatHelp() {
  return [
    "**Deterministic Zero-LLM Commands** (0 tokens, `<50ms`, work even during total LLM outages):",
    "- `/help` — Show this command reference",
    "- `/status` — Live Lead model, context usage, token/USD totals, active tasks, drafts, and watchers",
    "- `/workers` — List all registered swarm workers with role, model, state, and turn counts",
    "- `/hooks` — Inspect active out-of-core guardrail & lifecycle hooks (`beforeTool`, `afterTool`, `onYield`, `onError`)",
    "- `/credits` — Zero-token reachability check across Tier 1 (`llmgateway`), Tier 2 (`allmodels`), and Tier 3 (`local-llama`)",
    "",
    "**LLM-Routed Commands:**",
    "- `/btw <question>` — Concurrent read-only side-chat (does not interrupt Lead)",
    "- `/reinforce [quick|<candidate>]` — Launch isolated Docker replay benchmark",
  ].join("\n");
}

function formatStatus(st) {
  const lead = st?.lead || {};
  const usage = st?.usage || {};
  const swarm = st?.swarm || {};
  const workers = Object.values(swarm.workers || {});
  const drafts = Object.values(swarm.drafts || {});
  const crons = Object.values(swarm.cronJobs || {});
  const pct = fmtPct(lead.contextTokens, lead.contextWindow);

  const lines = [
    `**Swarm Status** _(deterministic, 0 LLM tokens)_`,
    `- **Lead:** \`${lead.provider || "unknown"}/${lead.model || "unknown"}\` (${lead.busy ? "busy" : "idle"}) · ctx \`${fmtTokens(lead.contextTokens)}/${fmtTokens(lead.contextWindow)}\` (${pct})`,
    `- **Session Usage:** \`${fmtTokens(usage.totalTokens)}\` tokens · \`$${Number(usage.costUsd || 0).toFixed(5)}\` USD · live tasks: \`${st?.liveTasks ?? 0}\` · queued: \`${st?.pendingSubmissions ?? 0}\``,
    `- **Registry:** \`${workers.length}\` worker(s) · \`${drafts.length}\` pending draft(s) · \`${crons.length}\` forever-watcher(s)`,
  ];

  const byModel = Object.entries(usage.byModel || {});
  if (byModel.length > 0) {
    lines.push("", "**Usage by Model:**");
    for (const [m, u] of byModel) {
      lines.push(`- \`${m}\`: ${fmtTokens(u.totalTokens)} tok ($${Number(u.cost?.total || 0).toFixed(5)})`);
    }
  }
  return lines.join("\n");
}

function formatWorkers(workers) {
  if (!workers || workers.length === 0) {
    return "**Swarm Workers** _(0 registered)_ — idle.";
  }
  const lines = [`**Swarm Workers** _(${workers.length} registered, running first)_:`];
  for (const w of workers) {
    const state = w.running ? `RUNNING (${w.phase || "active"})` : (w.status || "idle").toUpperCase();
    const turns = w.maxTurns ? ` · turns ${w.turns ?? 0}/${w.maxTurns}` : "";
    const model = w.modelId ? ` · \`${w.modelId}\`` : "";
    lines.push(`- \`${w.workerId}\` [${w.role || "worker"}] — **${state}**${model}${turns}`);
  }
  return lines.join("\n");
}

function formatHooks(hooks) {
  if (!hooks || hooks.length === 0) {
    return "**Guardrail Hooks** _(0 registered)_.";
  }
  const lines = [`**Out-of-Core Guardrail & Lifecycle Hooks** _(${hooks.length} registered)_:`];
  for (const h of hooks) {
    const badge = h.enabled ? "ON" : "OFF";
    const evs = (h.events || []).join(", ");
    const st = h.stats || {};
    const metrics = `calls=${st.invocations ?? 0}, blocks=${st.blocks ?? 0}, continues=${st.continues ?? 0}, errors=${st.errors ?? 0}`;
    lines.push(`- \`${h.id}\` [${badge} · p${h.priority} · ${evs}] — ${h.description} _(${metrics})_`);
  }
  return lines.join("\n");
}

function formatCredits(probes, usage) {
  const lines = ["**Provider & Failsafe Health** _(zero-token `/models` probe)_:"];
  for (const p of probes) {
    const icon = p.ok ? "OK" : "DOWN";
    const lat = p.latencyMs ? ` · ${p.latencyMs}ms` : "";
    lines.push(`- **${p.tier}** \`${p.name}\` — **${icon}** (${p.status}${lat}): ${p.detail}`);
  }
  if (usage) {
    lines.push(
      "",
      `- **Session Spend (local ledger):** \`$${Number(usage.costUsd || 0).toFixed(5)}\` USD across \`${fmtTokens(usage.totalTokens)}\` tokens`,
    );
  }
  return lines.join("\n");
}

/**
 * Execute a deterministic zero-LLM slash command if `text` matches one.
 * Returns `null` when `text` is not a deterministic command (caller proceeds to triage/LLM).
 */
export async function handleDeterministicCommand(
  text,
  {
    getStatus,
    listWorkers,
    listHooks,
    probeCredits = probeProviderHealth,
    conversationId = 1,
  } = {},
) {
  const parsed = parseSlashCommand(text);
  if (!parsed || !DETERMINISTIC_COMMAND_NAMES.includes(parsed.name)) return null;

  const t0 = Date.now();
  let replyText = "";
  let data = null;

  switch (parsed.name) {
    case "/help": {
      replyText = formatHelp();
      data = { commands: [...DETERMINISTIC_COMMAND_NAMES] };
      break;
    }
    case "/status": {
      const st = await getStatus();
      replyText = formatStatus(st);
      data = st;
      break;
    }
    case "/workers": {
      const workers = await listWorkers();
      replyText = formatWorkers(workers);
      data = { workers };
      break;
    }
    case "/hooks": {
      const hooks = listHooks ? listHooks() : [];
      replyText = formatHooks(hooks);
      data = { hooks };
      break;
    }
    case "/credits": {
      const [probes, st] = await Promise.all([
        probeCredits(),
        getStatus ? getStatus().catch(() => null) : Promise.resolve(null),
      ]);
      replyText = formatCredits(probes, st?.usage);
      data = { probes, usage: st?.usage ?? null };
      break;
    }
    default:
      return null;
  }

  return {
    route: "command",
    command: parsed.name,
    deterministic: true,
    llmCalls: 0,
    latencyMs: Date.now() - t0,
    conversationId,
    status: "done",
    text: replyText,
    data,
  };
}
