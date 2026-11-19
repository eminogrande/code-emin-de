/**
 * Out-of-Core Guardrail & Lifecycle Hook Registry (`src/hooks.mjs`)
 *
 * Inspired by `system-on-an-agent` (`AddonManifest` / `AddonLoader`) + HF `safeagents`:
 * Policy, security guardrails, verification gates, and observability hooks live outside
 * `src/daemon.mjs` core orchestration behind explicit manifests (`id`, `description`,
 * `priority`, `events`, `enabled`).
 *
 * Supported deterministic lifecycle hooks:
 *   - `beforeTool(call, ctx)`  -> `{ block: string }` | `{ arguments: object }` | undefined
 *   - `afterTool(call, result, ctx)` -> replacement `result` | undefined
 *   - `onYield(answer, ctx)`   -> `{ continue: string }` | undefined
 *   - `onError(error, ctx)`    -> void (never throws; errors isolated so one faulty observer never breaks the swarm)
 */

export const HOOK_EVENTS = Object.freeze(["beforeTool", "afterTool", "onYield", "onError"]);

export const DESTRUCTIVE_BASH_RE =
  /(?:\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+\/(?:\s|$|[;&|])|\brm\s+-[a-z]*f[a-z]*r[a-z]*\s+\/(?:\s|$|[;&|])|\bgit\s+push\s+(?:--force|-f|--delete)\b|\bgit\s+push\s+\S+\s+\+|\bgit\s+reset\s+--hard\b|\bmkfs\.|\bdd\s+if=.*of=\/dev\/|\bcurl\b.*\|\s*(?:ba)?sh\b|\b(?:authorized_keys|sshd_config|00-nuri-smartcard)\b|\bufw\s+disable\b)/i;

export const OUTBOUND_SEND_RE =
  /\b(sendmail|postfix|smtp|api\.resend\.com|api\.sendgrid\.com|api\.twitter\.com\/2\/tweets|x\.com\/i\/api)\b/i;

export const SUBAGENT_DEPLOY_RE =
  /\b(swarm-ctl\s+(?:apply|reload|reload-web|pull|rollback)|git\s+push)\b/i;

export const READONLY_ROLES = Object.freeze(new Set(["btw", "reviewer", "planner"]));

export function validateHookManifest(def) {
  if (!def || typeof def !== "object") {
    throw new TypeError("Hook definition must be an object");
  }
  const id = String(def.id || "").trim();
  if (!id || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id)) {
    throw new TypeError(`Invalid hook id "${def.id}" (expected /^[a-z0-9][a-z0-9._-]{0,63}$/i)`);
  }
  const description = String(def.description || "").trim();
  if (!description) {
    throw new TypeError(`Hook "${id}" requires a non-empty description`);
  }
  const priority = def.priority === undefined ? 100 : Number(def.priority);
  if (!Number.isFinite(priority)) {
    throw new TypeError(`Hook "${id}" priority must be a finite number`);
  }
  const enabled = def.enabled !== false;
  const declaredEvents = Array.isArray(def.events)
    ? def.events.map((e) => String(e))
    : HOOK_EVENTS.filter((e) => typeof def[e] === "function");

  if (declaredEvents.length === 0) {
    throw new TypeError(`Hook "${id}" must implement at least one lifecycle event (${HOOK_EVENTS.join(", ")})`);
  }
  for (const ev of declaredEvents) {
    if (!HOOK_EVENTS.includes(ev)) {
      throw new TypeError(`Hook "${id}" declares unknown event "${ev}"`);
    }
    if (typeof def[ev] !== "function") {
      throw new TypeError(`Hook "${id}" declares event "${ev}" without a function handler`);
    }
  }

  return {
    id,
    description,
    priority,
    enabled,
    events: Object.freeze([...new Set(declaredEvents)]),
    beforeTool: def.beforeTool,
    afterTool: def.afterTool,
    onYield: def.onYield,
    onError: def.onError,
  };
}

export class HookRegistry {
  #hooks = new Map();
  #stats = new Map();

  constructor(initialHooks = []) {
    for (const h of initialHooks) this.register(h);
  }

  register(def) {
    const manifest = validateHookManifest(def);
    if (this.#hooks.has(manifest.id)) {
      throw new Error(`Hook "${manifest.id}" is already registered`);
    }
    this.#hooks.set(manifest.id, manifest);
    this.#stats.set(manifest.id, {
      invocations: 0,
      blocks: 0,
      continues: 0,
      rewrites: 0,
      errors: 0,
      lastTriggeredAt: null,
    });
    return manifest;
  }

  unregister(id) {
    this.#stats.delete(id);
    return this.#hooks.delete(id);
  }

  setEnabled(id, enabled) {
    const h = this.#hooks.get(id);
    if (!h) return false;
    this.#hooks.set(id, { ...h, enabled: Boolean(enabled) });
    return true;
  }

  get(id) {
    return this.#hooks.get(id) ?? null;
  }

  list() {
    return [...this.#hooks.values()]
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
      .map((h) => ({
        id: h.id,
        description: h.description,
        priority: h.priority,
        enabled: h.enabled,
        events: [...h.events],
        stats: { ...(this.#stats.get(h.id) || {}) },
      }));
  }

  #orderedFor(event) {
    return [...this.#hooks.values()]
      .filter((h) => h.enabled && h.events.includes(event))
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  }

  async runBeforeTool(call, ctx = {}) {
    let activeCall = call;
    let rewrittenArgs;
    for (const h of this.#orderedFor("beforeTool")) {
      const st = this.#stats.get(h.id);
      st.invocations += 1;
      try {
        const res = await h.beforeTool(activeCall, ctx);
        if (!res) continue;
        if (typeof res.block === "string" && res.block.length > 0) {
          st.blocks += 1;
          st.lastTriggeredAt = Date.now();
          return { block: res.block, blockedBy: h.id };
        }
        if (res.arguments && typeof res.arguments === "object") {
          st.rewrites += 1;
          st.lastTriggeredAt = Date.now();
          rewrittenArgs = res.arguments;
          activeCall = { ...activeCall, arguments: res.arguments };
        }
      } catch (err) {
        st.errors += 1;
        st.lastTriggeredAt = Date.now();
        await this.runOnError(err, { ...ctx, phase: "beforeTool", hookId: h.id, call: activeCall });
        // Fail-closed for security guardrails: a throwing beforeTool blocks execution.
        return {
          block: `Hook '${h.id}' failed closed: ${err?.message || String(err)}`,
          blockedBy: h.id,
        };
      }
    }
    return rewrittenArgs ? { arguments: rewrittenArgs } : undefined;
  }

  async runAfterTool(call, result, ctx = {}) {
    let current = result;
    let modified = false;
    for (const h of this.#orderedFor("afterTool")) {
      const st = this.#stats.get(h.id);
      st.invocations += 1;
      try {
        const next = await h.afterTool(call, current, ctx);
        if (next !== undefined) {
          current = next;
          modified = true;
          st.rewrites += 1;
          st.lastTriggeredAt = Date.now();
        }
      } catch (err) {
        st.errors += 1;
        st.lastTriggeredAt = Date.now();
        await this.runOnError(err, { ...ctx, phase: "afterTool", hookId: h.id, call });
      }
    }
    return modified ? current : undefined;
  }

  async runOnYield(answer, ctx = {}) {
    for (const h of this.#orderedFor("onYield")) {
      const st = this.#stats.get(h.id);
      st.invocations += 1;
      try {
        const res = await h.onYield(answer, ctx);
        if (res && typeof res.continue === "string" && res.continue.length > 0) {
          st.continues += 1;
          st.lastTriggeredAt = Date.now();
          return { continue: res.continue, triggeredBy: h.id };
        }
      } catch (err) {
        st.errors += 1;
        st.lastTriggeredAt = Date.now();
        await this.runOnError(err, { ...ctx, phase: "onYield", hookId: h.id });
      }
    }
    return undefined;
  }

  async runOnError(error, ctx = {}) {
    for (const h of this.#orderedFor("onError")) {
      const st = this.#stats.get(h.id);
      st.invocations += 1;
      st.lastTriggeredAt = Date.now();
      try {
        await h.onError(error, ctx);
      } catch {
        st.errors += 1;
      }
    }
  }
}

/**
 * Built-in deterministic security & invariant guardrails (zero LLM tokens, <1ms evaluation).
 */
export function createBuiltinGuardHooks({
  onYieldHardTestGate = null,
  onYieldAutoBackupGate = null,
} = {}) {
  const hooks = [
    {
      id: "readonly-role-guard",
      description: "Blocks file writes/edits for read-only roles (btw, reviewer, planner) and bash for /btw side-chat",
      priority: 10,
      events: ["beforeTool"],
      beforeTool(call, { meta }) {
        const role = meta?.role || "lead";
        if (READONLY_ROLES.has(role) && (call.name === "write" || call.name === "edit")) {
          return { block: `Role '${role}' is strictly read-only.` };
        }
        if (role === "btw" && call.name === "bash") {
          return { block: "Side-chat (/btw) cannot execute shell commands." };
        }
      },
    },
    {
      id: "optmem-lead-only-guard",
      description: "Enforces OptMem single-writer invariant: subagents cannot call memory_note directly",
      priority: 20,
      events: ["beforeTool"],
      beforeTool(call, { meta }) {
        const role = meta?.role || "lead";
        if (role !== "lead" && call.name === "memory_note") {
          return {
            block: "OptMem invariant: subagents must not write to OptMem; send findings to Lead via bus_send.",
          };
        }
      },
    },
    {
      id: "destructive-bash-guard",
      description: "Blocks destructive shell commands (rm -rf /, force-push, reset --hard, sshd/ufw edits, curl|sh)",
      priority: 30,
      events: ["beforeTool"],
      beforeTool(call) {
        if (call.name !== "bash") return;
        const cmd = String(call.arguments?.command || "");
        if (DESTRUCTIVE_BASH_RE.test(cmd)) {
          return {
            block: `Blocked destructive command (${cmd.slice(0, 80)}). Requires human smartcard SSH confirmation.`,
          };
        }
      },
    },
    {
      id: "subagent-deploy-guard",
      description: "Prevents subagents from running swarm-ctl apply/reload/rollback or git push directly",
      priority: 40,
      events: ["beforeTool"],
      beforeTool(call, { meta }) {
        const role = meta?.role || "lead";
        if (call.name !== "bash" || role === "lead") return;
        const cmd = String(call.arguments?.command || "");
        if (SUBAGENT_DEPLOY_RE.test(cmd)) {
          return {
            block:
              "Subagents must not run `swarm-ctl apply/reload` or `git push` directly; notify Lead via `bus_send` once tests pass.",
          };
        }
      },
    },
    {
      id: "draft-only-outbound-guard",
      description: "Blocks outbound email/SMTP/X API shell sends for draft-only roles (support, social)",
      priority: 50,
      events: ["beforeTool"],
      beforeTool(call, { meta }) {
        const role = meta?.role || "lead";
        if (call.name !== "bash") return;
        const cmd = String(call.arguments?.command || "");
        if ((role === "support" || role === "social") && OUTBOUND_SEND_RE.test(cmd)) {
          return { block: `Role '${role}' is draft-only; outbound sending is strictly prohibited.` };
        }
      },
    },
  ];

  if (typeof onYieldHardTestGate === "function") {
    hooks.push({
      id: "coder-hard-test-gate",
      description: "Requires Verified: PASS and runs real syntax + unit tests before a coder worker may yield",
      priority: 10,
      events: ["onYield"],
      onYield: onYieldHardTestGate,
    });
  }

  if (typeof onYieldAutoBackupGate === "function") {
    hooks.push({
      id: "lead-auto-backup-gate",
      description: "Automatically validates, commits, pushes, and reloads VPS self-repo changes when Lead yields",
      priority: 20,
      events: ["onYield"],
      onYield: onYieldAutoBackupGate,
    });
  }

  return hooks;
}
