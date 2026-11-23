# `code-emin-de` — Empirically Benchmarked Open-Weights Multi-Agent Coding Daemon

A durable, self-hosting, **open-weights-only** multi-agent coding, review, memory, and operations daemon built on `@earendil-works/pi-durable@1.5.2`, designed around one rule:

> **Never guess, never trust vibes — measure every prompt byte, harness invariant, failover hop, and hardware dollar against real benchmarks.**

Live deployment: `https://code.emin.de` (Ubuntu 24.04 LTS, 4 vCPU Skylake / 7.6 GiB RAM, hardware Passkey / FIDO2 Smartcard auth, `0` bearer tokens, `$0/mo` Tier-3 local `llama.cpp` failsafe). Login and chat use a transparent inline 🤔 SVG favicon, so no extra asset request or opaque background. Chat tables scroll instead of splitting words, and tinted **You** bubbles plus **Kimi** labels keep message authorship obvious. Rapid Enter/submit messages receive unique request IDs and run independently when Lead is busy; only explicit Ctrl/Cmd+S steers the active Lead turn.

---

## Table of Contents

1. [Why We Built This (And Why Every Piece Exists)](#1-why-we-built-this-and-why-every-piece-exists)
2. [Architecture at a Glance](#2-architecture-at-a-glance)
3. [Empirical Evidence — Why We Do What](#3-empirical-evidence--why-we-do-what)
   - [3.1 Prompt Floor & Zero Skill-Leak Rule](#31-prompt-floor--zero-skill-leak-rule)
   - [3.2 Cross-Harness Benchmark: Same Model (`Kimi K3.1 Pro`), 4 Harnesses](#32-cross-harness-benchmark-same-model-kimi-k31-pro-4-harnesses)
   - [3.3 Isolated Docker `/reinforce` Replay Benchmark](#33-isolated-docker-reinforce-replay-benchmark)
   - [3.4 Local vs. Cloud Model Reality Check (`ep4` + VPS `llama-bench`)](#34-local-vs-cloud-model-reality-check-ep4--vps-llama-bench)
4. [3-Tier Open-Weights Failover & Zero-Silent-Shutdown Local Failsafe](#4-3-tier-open-weights-failover--zero-silent-shutdown-local-failsafe)
5. [Deterministic Zero-LLM Slash Commands (`src/commands.mjs`)](#5-deterministic-zero-llm-slash-commands-srccommandsmjs)
6. [Out-of-Core Guardrail & Lifecycle Hook Registry (`src/hooks.mjs`)](#6-out-of-core-guardrail--lifecycle-hook-registry-srchooksmjs)
7. [Open-Weights Role Roster & Hard Invariants](#7-open-weights-role-roster--hard-invariants)
8. [Security Model — Zero Bearer Tokens & Hardware Smartcard Auth](#8-security-model--zero-bearer-tokens--hardware-smartcard-auth)
9. [Quickstart, Commands & Testing](#9-quickstart-commands--testing)
10. [Repository Map & Deep-Dive Docs](#10-repository-map--deep-dive-docs)
11. [Handover & Verified State](#11-handover--verified-state)

---

## 1. Why We Built This (And Why Every Piece Exists)

Most agent frameworks fail in production for four concrete, measurable reasons:

| Production Failure Mode | What Typically Goes Wrong | What `pi-durable-swarm` Does Instead (and WHY) |
| :--- | :--- | :--- |
| **1. Hidden prompt & skill bloat** | Harnesses silently inject `6,700+` tokens of unused skill catalogs into every turn, blowing budgets and confusing small/fast models. | Strict **486-byte (`~116`-token) V3 prompt floor** (`config/APPEND_SYSTEM.md`) + `enableSkills: false` / `--no-skills`. Turning off skill leak jumped `pi-cli` from **`0/100` to `87.67/100`** on `ep3`. |
| **2. "Hallucinated PASS" & paraphrased specs** | Orchestrators paraphrase public function signatures when delegating, or workers claim "tests pass" without running them. | **Verbatim Spec Rule** in `src/prompts.mjs` + deterministic **`coder-hard-test-gate`** in `src/hooks.mjs` that actually runs `node --check` + `node --test` on disk before allowing a worker to yield. Jumped `pi-durable-swarm` from **`19.33/100` to `95.33/100`** (#1 across 4 harnesses). |
| **3. Silent outages when credits run dry** | When a cloud API returns HTTP `402` or `5xx`, the agent dies silently and even basic status checks fail because they route through the LLM. | **3-tier open-weights failover** (`llmgateway` -> `allmodels` -> local VPS `llama-server` with an explicit `⚠️ [LOCAL FAILSAFE ACTIVE]` banner listing exact failed providers) **plus** **deterministic zero-LLM slash commands** (`/status`, `/workers`, `/hooks`, `/credits`, `/help`) that answer in `<50ms` even if **all** cloud & local models are dead. |
| **4. Guardrails tangled inside orchestration** | Security rules (read-only roles, destructive bash blocking, draft-only outbound blocks) get buried inside monolithic loops where they are hard to audit, test, or extend. | **Out-of-core `HookRegistry`** (`src/hooks.mjs`) with strict manifests (`id`, `description`, `priority`, `events`), fail-closed `beforeTool`, `afterTool`, `onYield`, isolated `onError`, and live counters inspectable via `/hooks` and `GET /hooks`. |

---

## 2. Architecture at a Glance

```text
                    ┌─────────────────────────────────────────────────────┐
                    │  Browser (https://code.emin.de — Solarized Light)   │
                    │  Hardware Passkey / FIDO2 Smartcard Only (0 tokens) │
                    └──────────────────────────┬──────────────────────────┘
                                               │ HTTPS + HttpOnly Session Cookie
                                               ▼
                    ┌─────────────────────────────────────────────────────┐
                    │  Web UI Server (src/web.mjs — 127.0.0.1:3001)       │
                    │  GFM Markdown + Highlight + Sanitized Mermaid SVG   │
                    │  Click-to-Sign Smartcard SSH Bridge (127.0.0.1:4199)│
                    └──────────────────────────┬──────────────────────────┘
                                               │ 0600 Unix Socket (swarm.sock)
                                               ▼
┌──────────────────────────────────────────────────────────────────────────────────────┐
│  pi-durable Swarm Daemon (src/daemon.mjs + @earendil-works/pi-durable@1.5.2)         │
│                                                                                      │
│  ┌───────────────────────────────────────┐   ┌────────────────────────────────────┐  │
│  │ 1. Deterministic Zero-LLM Commands    │   │ 2. Out-of-Core Guardrail Hooks     │  │
│  │    src/commands.mjs (<50ms, 0 tokens) │   │    src/hooks.mjs (fail-closed)     │  │
│  │    /help /status /workers /hooks      │   │    • readonly-role-guard           │  │
│  │    /credits (live 3-tier health probe)│   │    • optmem-lead-only-guard        │  │
│  └──────────────────┬────────────────────┘   │    • destructive-bash-guard        │  │
│                     │ (non-command text)     │    • subagent-deploy-guard         │  │
│                     ▼                        │    • draft-only-outbound-guard     │  │
│  ┌───────────────────────────────────────┐   │    • coder-hard-test-gate (onYield)│  │
│  │ 3. System-1 Triage (src/triage.mjs)   │   │    • lead-auto-backup-gate         │  │
│  │    /btw -> read-only side-chat        │   └────────────────────────────────────┘  │
│  │    multi-task -> parallel fan-out     │                                           │
│  └──────────────────┬────────────────────┘   ┌────────────────────────────────────┐  │
│                     ▼                        │ 4. Durable State & Coordination    │  │
│  ┌───────────────────────────────────────┐   │    • SQLite Harness (durable.sqlite│  │
│  │ 5. 3-Tier Open-Weights Router         │   │    • AgentBus FTS5 (bus.sqlite)    │  │
│  │    src/models.mjs                     │   │    • OptMem (Lead-only writer)     │  │
│  │    Tier 1: llmgateway (5m breaker)    │   │    • Supervisor (turn_limit resume)│  │
│  │    Tier 2: allmodels (max_tok 8192)   │   └────────────────────────────────────┘  │
│  │    Tier 3: local-llama (127.0.0.1:8089│                                           │
│  │            LFM3-1.7B-Q4_K_M + banner) │                                           │
│  └───────────────────────────────────────┘                                           │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Empirical Evidence — Why We Do What

Every major design choice in this repository has a reproducible benchmark receipt in [`docs/`](docs/).

### 3.1 Prompt Floor & Zero Skill-Leak Rule

- **What we do:** Every agent role shares the exact 4-line, **486-byte (`~116`-token)** prompt floor in `config/APPEND_SYSTEM.md` (`V3_CAVEMAN_ADHD`), enforced by unit test `test/swarm.test.mjs#1`. External skill auto-injection is permanently disabled (`enableSkills: false` / `--no-skills --no-prompt-templates`).
- **Why:**
  1. During our `ep3` harness audit, leaving default skills enabled injected **6,700+ tokens** of unrelated skill descriptions into every turn, causing `pi-cli` to score **`0/100` (FAIL)**. Adding `--no-skills` immediately jumped the exact same model on the exact same task to **`87.67/100` (PASS)**.
  2. Tight, imperative constraints ("reuse first", "minimum code/files/tools", "keep exact syntax, negations, tests and security") reduce unnecessary verbosity and token burn without sacrificing edge-case rigor.

### 3.2 Cross-Harness Benchmark: Same Model (`Kimi K3.1 Pro`), 4 Harnesses

To prove our harness improves outcomes independent of the underlying model, we ran **`Kimi K3.1 Pro` (`thinking=high`)** across 4 different harnesses on `ep3-async-singleflight-cache` (singleflight coalescing + abort isolation + retries + SWR + LRU eviction) with identical prompt discipline, `0` skills, standardized pricing (`$2.00 / $0.20 cache / $10.00` per 1M tokens), and **blinded 3-persona judging** (`correctness`, `readability`, `maintainability`) by `openai/gpt-reserve` ([full report](docs/HARNESS_BENCHMARK_ep3.md)):

| Rank | Harness | Pass | Blinded Judge Mean (`/100`) | Tool Calls | Total Tokens | Code LOC | Norm. Cost | Wall Time |
| :---: | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **#1** | **`pi-durable-swarm` (Lead + Coder)** | **PASS** | **95.33** (`96 / 96 / 94`) | 14 | 147,618 | 432 | `$0.1692` | `292.82s` |
| #2 | OpenCode CLI v1.19.3 (`--pure`) | PASS | `91.67` (`94 / 92 / 89`) | 24 | 649,596 | 475 | `$0.2609` | `369.71s` |
| #3 | Pi Coding Agent CLI v1.5.2 (`--no-skills`) | PASS | `87.67` (`86 / 86 / 91`) | 6 | 41,884 | 540 | `$0.1187` | `390.05s` |
| #4 | Kimi Code CLI v2.5.2 (native) | FAIL | `46.00` (`38 / 58 / 42`) | 9 | 148,530 | 121 | `$0.1180` | `390.79s` |

**Why `pi-durable-swarm` jumped from `19.33/100` (initial run) to `95.33/100` (#1):**
0. **Delegation Mandate:** the Lead never implements on its own — every actionable build/fix/investigation request must first `spawn_worker` an appropriate role, because a Lead that codes itself burns its orchestration context and stops fanning out. Exempt: greetings, direct factual questions, status queries, bus/worker notifications (no recursive notification loops); workers never spawn workers (no infinite nesting).
1. **Single-worker module ownership:** Never split `src/foo.mjs` and `test/foo.test.mjs` across two separate coders (otherwise signatures drift). Only fan out across disjoint modules.
2. **Verbatim Spec Rule:** Lead must copy exact exported names, option keys, return fields, and file paths verbatim into `spawn_worker.brief`.
3. **Hard Test Gate (`coder-hard-test-gate`):** A coder worker cannot finish on a hallucinated `"Verified: PASS"` — `onYield` executes real syntax + unit tests on disk and forces repair if anything fails (preventing Kimi Code CLI's failure mode where tests were omitted entirely).

### 3.3 Isolated Docker `/reinforce` Replay Benchmark

`/reinforce` (`src/reinforce.mjs`) replays real production coding tasks inside disposable Docker containers (`SWARM_SELF_REPO=/nonexistent`, zero live side effects) and scores diffs with a blinded frontier judge panel (`claude-fable-5-2` + `gpt-6.2-astra`). On `ep1-markdown-mermaid-ui` (GFM Markdown + highlight.js + copy button + safe Mermaid SVG in the Solarized chat UI, [full report](docs/REINFORCE_BENCHMARK.md)):

| Rank | Candidate (Lead + Coder) | OptMem | Pass | Human Nudges | Auto-Resumes | Judge Mean (`/100`) | Total Tokens | Cost (USD) | Wall Time |
| :---: | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **#1** | **`cand-kimi-dsflash-optmem-off`** (`kimi-k3.1-pro` + `deepseek-v4.1-flash-uncensored`) | OFF | **PASS** | **0** | 1 | **88.0** | 2.31M | **`$0.1548`** | **`308.87s`** |
| #2 | `live-baseline-session1` (pre-upgrade human-steered session) | OFF | PASS | 6 | 0 | `44.8` | 12.00M | `$1.0940` | `3960s` |
| #3 | `cand-kimi-dsflash-optmem-on` | ON | FAIL | 0 | 0 | `61.0` | 448k | `$0.0472` | `307.45s` |
| #4 | `cand-kimi-dsv4pro-optmem-on` | ON | FAIL | 0 | 0 | `23.17` | 268k | `$0.1175` | `309.60s` |

**Why this matters:** Adding the durable `turn_limit` auto-resume supervisor (`src/supervisor.mjs`) + Hard Test Gate cut cost by **7x** (`$1.0940 -> $0.1548`), wall time by **12.8x** (`66 min -> 5.1 min`), human nudges from **6 to 0**, and nearly **doubled** blinded code quality (`44.8 -> 88.0/100`).

### 3.4 Local vs. Cloud Model Reality Check (`ep4` + VPS `llama-bench`)

Before spending money upgrading VPS RAM to host a larger local coding model, we benchmarked local and smaller open-weights models on `ep4-agents-sidebar-repair` ([Kimi ref](docs/HARNESS_BENCHMARK_ep4-kimi-ref.md), [Qwen3.8-27B](docs/HARNESS_BENCHMARK_ep4-qwen38-27b.md), [LFM3-1.7B + LoRA](docs/LOCAL_ADAPTER_BENCHMARK_ep4.md)) **and** benchmarked `llama.cpp` directly on our live 4-vCPU / 7.6 GiB Hetzner VPS:

| Model / Tier | Host | Task (`ep4`) | Result | Speed / Cost | Decision (WHY) |
| :--- | :--- | :--- | :---: | :--- | :--- |
| **`Kimi K3.1 Pro`** (`pi-durable-swarm`) | Cloud Tier 1 | Real UI/API bugfix | **PASS (`70.67/100`, 16 LOC)** | `$0.0457` / run | **Primary solver** — orders of magnitude higher accuracy per dollar. |
| `Qwen3.8-27B` | Cloud / ~18 GB RAM | Same bugfix | **FAIL (`0/100`, 0 LOC)** | N/A | Proves upgrading to a 24–32 GiB CPU VPS for a 27B model still cannot solve real repo bugs reliably. |
| `LFM3-1.7B-Q4_K_M` (base & +HF-pi-LoRA) | Apple Silicon / VPS | Same bugfix | **FAIL (`0/100`, 0 LOC)** | `13.2–17.3 tok/s` | Not a coding solver — do **not** use for autonomous edits. |
| **`LFM3-1.7B-Q4_K_M` (`--reasoning-budget 0`)** | **Existing 7.6 GiB VPS** (`127.0.0.1:8089`) | **Tier-3 Outage Failsafe** | **PASS (`5.28s` live E2E takeover)** | `pp512: 74.6 tok/s` · `tg128: 15.25 tok/s` · **`$0/mo` extra** · `5.9 GiB` RAM still free | **Ideal Tier-3 Failsafe:** keeps chat alive during total cloud billing/network outages and tells the user *why* cloud failed without upgrading the VPS. |

### 3.5 External Terminal-Bench 2.1 on the Real VPS Harness

To evaluate Emin Swarm outside our self-authored episodes, we use **Harbor 0.27.0 + Terminal-Bench 2.1** on `178.105.82.203`. Harbor provides the tasks and independent verifier; it is not the agent being measured. The custom `BaseInstalledAgent` in `bench/harbor-emin/` runs the real `openSwarmDaemon()` with the production roster, prompts, hooks, and supervisor in isolated task containers.

- **Environment receipt:** the official five-task oracle passed **5/5 with mean reward `1.000` and zero exceptions** (`/tmp/emin-harbor-runs/jobs/2026-11-22__12-43-05/result.json` on the VPS).
- **Reproducible source:** `git archive` pins the exact baseline commit `77addff` and uploads it, so private GitHub authentication is never needed inside a task container.
- **Isolation:** fresh per-trial durable data/workspace, `SWARM_SELF_REPO=/nonexistent-harbor`, no production deployment, no OptMem mirror, and only required model credentials.
- **Scoring:** Harbor’s verifier is authoritative. The driver receipt records Lead submission completion, worker failures, usage, cost, and bounded sanitized errors; extended-timeout smoke runs are labeled and are not claimed as standard-timeout comparable scores.

See [`bench/harbor-emin/README.md`](bench/harbor-emin/README.md) for the exact staged setup and invocation, and [`docs/TERMINAL_BENCHMARK_emin-swarm.md`](docs/TERMINAL_BENCHMARK_emin-swarm.md) for the receipt. The first real `write-compressor` attempts completed with **reward `0.000`**: the adapter ran correctly, but the Lead hit `turn_limit` at both 16 and 64 turns. This is a working benchmark path with a failing model baseline, not a claimed solve.

---

## 4. 3-Tier Open-Weights Failover & Zero-Silent-Shutdown Local Failsafe

Implemented in [`src/models.mjs`](src/models.mjs) (`attachOpenWeightsFailover`) and tested in [`test/models-failover.test.mjs`](test/models-failover.test.mjs):

```text
Request (e.g. llmgateway/kimi-k3.1-pro)
  │
  ├─► Tier 1: llmgateway (primary open-weights router)
  │     └─ On HTTP 402 / billing / 5xx / timeout -> trips 5-min circuit breaker
  │
  ├─► Tier 2: allmodels (mapped equivalent -> z-ai/glm-5.3-abliterated -> deepseek-v4.1-flash-abliterated)
  │     └─ Caps max_tokens <= 8192 to avoid upstream 402 reservation rejections
  │
  └─► Tier 3: local-llama (http://127.0.0.1:8089/v1 — LFM3-1.7B-Q4_K_M via llama-failsafe.service)
        ├─ Injects EMERGENCY FAILSAFE MODE into systemPrompt
        └─ Deterministically prepends banner to BOTH stream and final message:
           ⚠️ [LOCAL FAILSAFE ACTIVE: `local-llama/LFM3-1.7B-Q4_K_M`]
           Cloud APIs unavailable (<exact provider/model/error per failed hop>).
           Top up credits / check provider keys to restore full cloud frontier models.
```

**Why the banner is deterministic (not LLM-generated):** A 1.7B model under outage conditions can forget to mention *which* cloud provider returned `402` vs `503`. Prepending `formatLocalFailsafeBanner()` directly in `src/models.mjs` guarantees outages are **never silent** and always surface exact diagnostic proof.

**VPS Service (`llama-failsafe.service`):**
- Runs `llama.cpp` `b12532` (`libggml-cpu-skylakex.so` using AVX2/AVX-512 on Xeon Skylake) bound exclusively to `127.0.0.1:8089`.
- Flags: `-t 4 -c 8192 --parallel 1 --reasoning-budget 0 --alias LFM3-1.7B-Q4_K_M` (`--reasoning-budget 0` prevents the 1.7B model from spending its token budget inside hidden thinking tags, cutting reply latency from `13.97s` empty -> `5.28s` clean answer).
- `MemoryMax=2800M` — total VPS footprint with both `swarmd` and `llama-failsafe` running is **`1.7 GiB / 7.6 GiB`** (`5.9 GiB` available).

---

## 5. Deterministic Zero-LLM Slash Commands (`src/commands.mjs`)

Inspired by `system-on-an-agent`'s rule-based control plane: operational commands intercept `daemon.chat()` **before** triage or any LLM call (`llmCalls: 0`, `<50ms` response time). Even if Tier 1, Tier 2, **and** Tier 3 local `llama-server` are all simultaneously offline, operators can still inspect the swarm:

| Command | LLM Calls | What It Does |
| :--- | :---: | :--- |
| `/help` | `0` | Prints all deterministic zero-LLM commands and LLM-routed slash commands (`/btw`, `/reinforce`). |
| `/status` | `0` | Reports active Lead provider/model, busy/idle state, context window usage (`%`), total session tokens & USD spend, live tasks, workers, pending drafts, and forever-watchers. |
| `/workers` | `0` | Lists every registered worker sorted running-first with role, model, phase/status, and turn count (`turns/maxTurns`). |
| `/hooks` | `0` | Lists all registered out-of-core guardrail & lifecycle hooks with enabled status, priority, events, and live `calls / blocks / continues / errors` counters. |
| `/model [provider modelId]` | `0` | Shows or switches the Lead model from a fixed allowlist of verified open-weights pairs (e.g. `llmgateway/kimi-k3.1-pro`, `allmodels/moonshotai/kimi-k3.1-pro-abliterated`). Durable in `SwarmDoc.leadModelOverride`; arbitrary IDs are rejected. |
| `/credits` | `0` | Runs a parallel zero-token `GET /models` health & billing probe against Tier 1 (`llmgateway`), Tier 2 (`allmodels`), and Tier 3 (`local-llama`), reporting exact HTTP status (`200`, `402 credits exhausted`, `401`, `unreachable`) and latency in ms. |

**Lead model dropdown (`#statusBar`)** — the same allowlist is a `<select>` in the chat status bar; changes `POST /api/model` (passkey-session only) → daemon `POST /model`, validated against `LEAD_MODEL_CHOICES` (`src/models.mjs`), so no arbitrary model/provider can be persisted and no extra secrets/OAuth are needed. The choice is **global and applies to new turns** (never retroactively to a running turn), survives restarts, is disabled while Lead is busy, and a rejected switch restores the previous value with an inline error (e.g. an `allmodels` quota error is shown, never faked as switched).

**LLM-routed slash commands** (intentionally go through models):
- `/btw <question>` — Routes to an isolated read-only side-chat conversation (`deepseek-v4.1-flash-1017`) without blocking or interrupting Lead.
- `/reinforce [quick|<candidate>]` — Starts an isolated Docker replay tournament and notifies Lead on completion.

---

## 6. Out-of-Core Guardrail & Lifecycle Hook Registry (`src/hooks.mjs`)

Inspired by `system-on-an-agent`'s `AddonManifest`/`AddonLoader` and Hugging Face `safeagents` deterministic tool-call rule proxy: all policy, security, and verification rules are decoupled from `src/daemon.mjs` into manifest-validated hooks executed in deterministic `priority` order.

### Supported Lifecycle Events

| Event | Return Value | Failure Behavior |
| :--- | :--- | :--- |
| `beforeTool(call, ctx)` | `{ block: string }` or `{ arguments: object }` or `undefined` | **Fail-closed:** if a security hook throws, the tool call is **blocked** and `onError` is notified. |
| `afterTool(call, result, ctx)` | Replacement `result` or `undefined` | Isolated via `onError`; subsequent hooks still run. |
| `onYield(answer, ctx)` | `{ continue: string }` or `undefined` | First `{ continue }` forces the agent to keep working; errors isolated via `onError`. |
| `onError(error, ctx)` | `void` | Never throws; prevents observer bugs from crashing the daemon. |

### Built-In Deterministic Guardrails (Zero LLM Tokens, `<1ms`)

| Priority | Hook ID | Event | What It Enforces |
| :---: | :--- | :--- | :--- |
| `10` | `readonly-role-guard` | `beforeTool` | Blocks `write`/`edit` for `btw`, `reviewer`, `planner`, and blocks `bash` for `/btw`. |
| `20` | `optmem-lead-only-guard` | `beforeTool` | Enforces single-writer OptMem invariant: subagents cannot call `memory_note` directly (must send findings to Lead via `bus_send`). |
| `30` | `destructive-bash-guard` | `beforeTool` | Blocks `rm -rf /`, `rm -fr /`, `git push --force/+ref/--delete`, `git reset --hard`, `mkfs.`, `dd of=/dev/`, `curl \| sh`, and edits to `authorized_keys`/`sshd_config`/`ufw disable`. |
| `40` | `subagent-deploy-guard` | `beforeTool` | Prevents subagents from calling `swarm-ctl apply/reload/rollback` or `git push` directly; Lead owns deploy & backup. |
| `50` | `draft-only-outbound-guard` | `beforeTool` | Prevents `support` and `social` roles from running outbound SMTP/Resend/SendGrid/X API shell sends. |
| `10` | `coder-hard-test-gate` | `onYield` | Requires `Verified: PASS` and independently runs `node --check` + `node --test` (or `go test` / `pytest`) before a `coder` worker may finish. Worker shells and the gate clear inherited `NODE_TEST_CONTEXT` so nested test commands execute real tests. |
| `20` | `lead-auto-backup-gate` | `onYield` | Validates, commits, pushes (append-only), and reloads VPS self-repo edits via `swarm-ctl apply` when Lead yields. |

Model streams are bounded to **120 seconds per attempt**, so provider stalls surface through failover instead of leaving workers pending indefinitely.

### Registering Custom Out-of-Core Hooks

Pass custom hooks directly into `openSwarmDaemon({ hooks: [...] })` or call `daemon.hooks.register(...)` at runtime:

```js
const daemon = await openSwarmDaemon({
  dataDir,
  workspaceDir,
  hooks: [
    {
      id: "no-prod-env-reads",
      description: "Blocks reading .env files from subagents",
      priority: 15,
      events: ["beforeTool"],
      beforeTool(call, { meta }) {
        if (meta.role !== "lead" && call.name === "read" && /\.env\b/.test(call.arguments?.path || "")) {
          return { block: "Subagents cannot read .env files." };
        }
      },
    },
  ],
});
```

---

## 7. Open-Weights Role Roster & Hard Invariants

Configured in [`src/models.mjs`](src/models.mjs) (`ROLE_MODELS` + `ROLE_THINKING`, all overrideable via env vars). Orchestrators/planners/reviewers default to **`thinkingLevel: "max"`**, while `coder` workers, recurring jobs, watchers, support, and `/btw` default to **`"low"`** for fast execution. Setting `PAYMENTREQUIRED_FAILOVER=1` enables per-model cooldown failover across remaining live subscription/router buckets (`gemini-4-neon-xhigh` → `claude-opus-5-5-high` → `gemini-4-argon-high` → `claude-sonnet-5-5-high` → `deepseek-v4.1-flash-abliterated`) before falling back to cheap `llmgateway/deepseek-v4.1-flash-uncensored` → `allmodels` (DeepSeek abliterated) → Tier-3 `local-llama`:

| Role | Default Open-Weights Model | Tools & Invariant |
| :--- | :--- | :--- |
| **`lead`** | `kimi-k3.1-pro` (`max`) | Orchestrator, parallel worker fan-out, Verbatim Spec Rule, serialized shared OptMem (`memory_wake`/`memory_note`/`memory_recall`, auto-injected across all orchestrators), sole `swarm-ctl` / `git push` owner. |
| **`planner`** | `kimi-k3.1-pro` (`max`) | Strictly read-only (`readonly-role-guard`); outputs `<=5` atomic steps with exact paths & verification commands. |
| **`coder`** | `deepseek-v4.1-flash-uncensored` (`max`, fails over to `allmodels` `deepseek/deepseek-v4.1-flash-abliterated` `max`; fast: `deepseek-v4.1-flash-1017`) | Full workspace coding + `bus_send`/`read_sibling`; guarded by `coder-hard-test-gate` and `subagent-deploy-guard`. |
| **`reviewer`** | `kimi-k3.1-pro` | Strictly read-only security/bug audit (`VERDICT: APPROVE` or `REQUEST_CHANGES`). |
| **`support` / `social`** | `glm-5.3` / `kimi-k3.1-pro` | **Draft-only** (`save_draft`, 1 ticket per human on support); outbound sends blocked by `draft-only-outbound-guard`. |
| **`watcher`** | `glm-5.3` + System-1 triage (`src/triage.mjs`) | Forever-agent polling; stays silent on routine noise (`0` LLM wakeups) and surfaces only verified errors/drafts. |
| **`btw`** | `deepseek-v4.1-flash-1017` | Read-only concurrent side-chat; zero file mutation, zero `bash`. |

---

## 8. Security Model — Zero Bearer Tokens & Hardware Smartcard Auth

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for full details and diagrams:

- **Zero bearer tokens & zero exposed daemon TCP ports:** `swarmd` binds only to a `0600` Unix domain socket (`swarm.sock`).
- **Hardware-only SSH:** `sshd` accepts **only** FIDO2/Smartcard resident keys (`sk-ecdsa-sha2-nistp256@openssh.com` via `ACS ACR39U` / Nuri smartcard).
- **Hardware-only Web UI (`https://code.emin.de`):** WebAuthn Passkeys only (`mac-touchid` + `nuri-card-acr39u` via local bridge `127.0.0.1:4199`), HttpOnly SameSite cookies, CSP + DOMPurify XSS sanitization on Markdown & Mermaid SVG.
- **Click-to-Sign Smartcard SSH Bridge:** The VPS holds **zero** remote SSH private keys — running `ssh nuri.com` from the VPS pauses and pops a `[Sign with Smartcard]` / `[Deny]` prompt in the authenticated browser, signing on the physical card over `127.0.0.1:4199`.
- **Append-only GitHub backup:** Force-pushes are blocked by `destructive-bash-guard`; rollbacks use `git revert`.
- **Chat image attachments:** server-side strict re-validation in [`src/image-util.mjs`](src/image-util.mjs) — data-URL/base64 shape only, magic-byte sniff (a lying prefix cannot smuggle SVG/HTML), full PNG chunk framing (`IHDR`, `IDAT`, `IEND`) + zlib `inflateSync` verification (preventing malformed PNGs from poisoning conversation history), startup `sanitizeCorruptDurableImages(dbPath)` self-healing for `durable.sqlite`, 4 MB decoded + 20 MB body cap, header-derived pixel caps (16000 px side / 40 MP), content-addressed store under `<dataDir>/images`, and authenticated immutable `GET /api/image/:id` (32-hex id regex, no traversal, no public URL).

---

## 9. Quickstart, Commands & Testing

### Prerequisites

- Node.js `>= 22.19.0` (uses built-in `node:sqlite` and `node:test`)
- At least one open-weights API key (`LLMGATEWAY_API_KEY` and/or `ALLMODELS_API_KEY`), a free router key (`ROUTER_PAYMENTREQUIRED_API_KEY`), or a local OpenAI-compatible `llama-server` on `LOCAL_LLAMA_URL` (`http://127.0.0.1:8089/v1`)

### Local / VPS Setup

```sh
cp .env.example .env              # set LLMGATEWAY_API_KEY / ALLMODELS_API_KEY (chmod 600 .env)
npm install
```

`jsdom` is a **production dependency** because `src/markdown.mjs` imports it at runtime. Production deploys use `npm ci --omit=dev --ignore-scripts` and therefore retain it.

### Free / Subscription Router Lead Models (`paymentrequired`)

The internal router is a built-in provider (`PaymentRequired Free`) at
`https://router.paymentrequired.com/v1/internal` (OpenAI-compatible), backing Kimi and Gemini subscription
models plus free models — `k3.1-pro`, `k3.1-pro-highspeed`, `k3`, `kimi-for-coding`,
`kimi-for-coding-highspeed`, `deepseek-v4.1-flash-abliterated`, `gemini-4-neon-xhigh`,
`gemini-4-hydrogen-xhigh`, `gemini-4-argon-high`, `gemini-3.8-flash-high`, `gemini-3.8-flash-tiered`,
`gemini-3.5-flash-lite`, `gemini-3-flash`, `claude-opus-5-5-high`, `claude-sonnet-5-5-high`,
`gpt-oss-120b-medium`, `glm-5.3-abliterated`, `glm-5.3-flash-abliterated`,
`cohere/north-mini-code:free`, `dots-studio/dots-3-note-preview:free`,
`nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`, `nvidia/nemotron-3-ultra-550b-a55b:free`,
`nvidia/nemotron-3.5-lightning:free` — all selectable globally on `General` or per-agent on any named
Agent-Orchestrator (`1M` context windows aligned 1:1 with `router-paymentrequired-com`, no artificial client-side `max_tokens` clamp, native `64K`–`128K` output limits, with `reasoning.effort = "max"`).

```sh
ROUTER_PAYMENTREQUIRED_API_KEY=<key>   # in .env only, never committed
```

Catalog costs are declared `0` because the endpoint is free; labels say *free router* rather than
*subscription/OAuth* since no Moonshot billing identity is verified for it. `paymentrequired` requests
skip cross-provider failover, so the router's real error (quota, outage) is shown
instead of a silent downgrade.

### Typed Agent-Orchestrators & Grouped Sidebar

**WHY:** one global Lead and a flat list cannot cleanly separate repo owners (`nuri-website`), draft-only marketers (`linkedin-marketer`, `tiktok-marketer`), and read-only security auditors (`security-review-agent`).
Each named orchestration is a durable **Agent-Orchestrator** with a preset (`repo`, `marketing`, `security`, `ops`, `custom`), `group`, workspace-contained `cwd` (automatically inherited by every worker it spawns), optional `repoUrl`, and custom `instructions`. Every repo orchestrator receives live `[GIT_CONTEXT]` (`repo`, `branch`, `head`, `dirty`) on each turn, clarifies ambiguous/question prompts before spawning coding workers, and follows safe GitOps (tests + `CHANGELOG.md`/`README.md` + push to non-prod branch for human merge into `main`). Old or repoless orchestrations can be archived (`archived: true`) without losing SQLite history.
`Repos` membership is derived from trusted durable bindings (`repo` preset, `repoUrl`, or a `cwd` other than the generic workspace), never from display names. Rebinding updates the existing registry record and conversation configuration in place, preserving its agent id, history, and identity; repo-less agents using the generic workspace remain in their normal domain.
Preset guardrails are deterministic (`src/hooks.mjs`): `security` is strictly read-only, `marketing` is draft-only (blocks email/X/LinkedIn/TikTok publish APIs), and `repo`/`ops` orchestrators may run non-force `git push` to trigger GitHub Actions while `swarm-ctl` self-deploy stays exclusive to `General`.
Agents discover and delegate across domains via `list_agents` and `ask_agent`. The Solarized left sidebar groups agents by domain (`Repos`, `Marketing`, `Security`, `Ops`, `Agents`) with in-place editing; the right sidebar manages that agent's one-shot and recurring workers.

- **One task:** a persistent worker conversation runs immediately and remains available for `Run now`.
- **Recurring:** durable `swarm.forever_work` uses `sleepUntil`: **zero model tokens while sleeping**,
  restart recovery, and the same worker conversation on every run.
- **Safety:** intervals are 10 seconds–31 days, busy ticks are skipped instead of queued, pause/resume
  is durable, roles are allowlisted, and private goals never appear in sidebar JSON.
- **Limits:** 50 named orchestrations and 25 workers per orchestration bound accidental fanout. Workers
  spawned by an orchestration Lead inherit its ownership automatically.

“Permanent” means durable identity, history, ownership, and schedule—not an infinite generation loop.
Each recurring run is bounded and returns, keeping cost and concurrency explicit.

### Chat Composer Attachments (Drag-and-Drop / Copy-and-Paste Images & Files)

There is no `Attach` button: simply **paste (`Ctrl/Cmd+V`)** or **drag-and-drop** anywhere on the page or composer:
- **Images (`image/png|jpeg|webp|gif`, max 3 × 4 MB):** decoded in-browser via canvas and normalized to PNG (or JPEG `0.92` fallback if PNG > 4 MB), rendered as removable thumbnails in `#pending-images`, and sent as real vision content blocks (Caddy `request_body.max_size 25MB` + `MAX_BODY_BYTES = 20MB` in `src/web.mjs`). History replays content-addressed IDs only and renders via the authenticated `/api/image/:id` endpoint.
- **Text, code & config files (`.md`, `.txt`, `.json`, `.yaml`, `.toml`, `.csv`, `.js`, `.mjs`, `.ts`, `.py`, `.sh`, `.go`, `.rs`, `.sql`, `.html`, `.css`, `.diff`, `.patch`, `.log`, `.svg`, etc., max 5 × 1 MB):** rendered as removable `FILE` chips in `#pending-images` and appended as fenced file blocks to the prompt on send.
Tests: `test/images.test.mjs` (sniff/caps/dimensions/store), `test/chat-images.test.mjs` (paste, drag-and-drop, text files, rejections, clear), `test/chat-images-api.test.mjs` (auth, caps, payload, traversal), `test/chat-images-e2e.test.mjs` (full-page send, accepted-shape composer clearing, failure retention).

**Composer clearing contract:** pending thumbnails in `#pending-images` (the `window.chatImages` deck) clear immediately once the server accepts the message — every accepted response shape (`text`, `html`, `images`, HTTP `202`/pending, daemon reload, malformed body) goes through one `acceptSend()` helper that clears once and revokes the object URLs. Attachments stay on validation/provider/network failure (`error` field, HTTP `413`, fetch throw) so the message can be retried, and the deck is never cleared before the request `await`. Already-sent messages keep their own history thumbnails, which render from the sent payload and the authenticated `/api/image/:id` endpoint, not from the composer deck.

### Native Solarized UI, Single-Line Status Bar & Automatic Worker Archiving

The chat uses only its native Solarized layout and controls. No external component library, theme,
stylesheet, framework, or credit link is loaded. Code blocks have a small local **Copy / Copied**
button implemented in `src/markdown.mjs`, `src/chat-client.js`, and inline CSS in `src/web.mjs`.
- **Single-line `#statusBar`:** renders the Lead model selector, context free %, and active worker count on one single line (`flex-wrap: nowrap; white-space: nowrap; overflow-x: auto`).
- **Automatic archiving of finished one-shot workers:** only currently running workers (`state === 'running'`) and permanent recurring workers (`mode === 'recurring'`) remain in the active `#agents` list and status bar total (`isActiveWorker`). Finished or stopped one-shot workers (`mode !== 'recurring'`) automatically move into the collapsible `<details id="archived"><summary>Archived workers (N)</summary><ul id="archive"></ul></details>` drawer so old completed tasks never clutter the active count.
- **Optimistic bubble reconciliation & Live CoT:** Optimistic `.pending` chat bubbles reconcile deterministically against `/api/history` as soon as `/api/chat` settles so sent user messages and ephemeral slash-command outputs never stay pinned below newer transcript entries. Collapsible Chain-of-Thought (`<details class="cot">` in `#log` and `<details class="wcot">` on agent cards in `#agents`) streams live reasoning (`thinking`) and active tool executions from `LiveDoc` at 1-second busy-poll intervals while defaulting to collapsed on completed turns and preserving manual open/close toggle state across polls.
Tests: `test/ui-theme.test.mjs`, `test/markdown.test.mjs`, `test/chat-client.test.mjs`, and browser E2E coverage.

### Run the Full Unit & Integration Test Suite

```sh
# Syntax-check every module
for f in src/*.mjs; do node --check "$f" || exit 1; done

# Run all offline unit + integration + JSDOM + failover + hooks + commands tests
for t in test/*.test.mjs; do
  [ "$t" = "test/swarm.test.mjs" ] && continue
  node --no-warnings --test "$t" || exit 1
done

# Optional: run live E2E swarm test (requires LLMGATEWAY_API_KEY or ALLMODELS_API_KEY)
node --no-warnings --test test/swarm.test.mjs
```

### Docker / SSH CLI Usage

```sh
./scripts/init.sh                 # loads smartcard SSH public keys into .ssh/authorized_keys
docker compose up -d --build
./test/smoke.sh

# Interactive & scripted CLI over smartcard SSH
swarm                             # interactive REPL
swarm status                      # JSON status from Unix socket
swarm ask "/status"               # deterministic zero-LLM status (<50ms, 0 tokens)
swarm ask "/credits"              # live 3-tier provider + local failsafe health check
swarm ask "/hooks"                # inspect active guardrail hooks & block counts
swarm ask "/btw what is w-1 doing?"
swarm steer w-auth "use timingSafeEqual"
```

### Emin Swarm MCP for Kimi Code/Desktop

**Naming:** **Emin Swarm** is the whole system; **Emin Orchestrator** is the General Lead (`lead` / `orchestration:general`). The MCP namespace is `emin-swarm`, so calls are unambiguous (for example `mcp__emin-swarm__swarm_list`).

**WHY:** use the same live swarm from Kimi without a second UI or control plane. The local stdio MCP server reaches the existing daemon through the system SSH alias and remote `curl`:

```text
Kimi Code/Desktop → stdio MCP → ssh swarm-host → curl --unix-socket /home/swarm/.pi-durable/swarm.sock → Pi Durable daemon
```

`SWARM_MCP_SSH_HOST` overrides `swarm-host`; `SWARM_MCP_SOCKET` overrides the socket path. Direct dependencies are `@modelcontextprotocol/sdk@1.32.2` and `zod@4.6.7`. This exposes the same daemon data as `code.emin.de`, with no duplicate UI, new approval layer, public port, or bearer token.

| Tool | Inputs and defaults | Purpose |
| :--- | :--- | :--- |
| `swarm_list` | Optional `orchestrationId` filter | Status, orchestrations, and workers, including live activity. |
| `swarm_read` | `conversationId: 1`, `max: 40` (capped at `200`) | Bounded transcript plus live CoT; use to poll nonblocking submissions. |
| `swarm_prompt` | Required `text`; `target: "lead"`; always `wait: false` | Prompt `lead`, `orchestration:<id>`, or a worker ID, then poll with `swarm_read`. |
| `swarm_steer` | Required `text` and `target` | Steer `lead`, `orchestration:<id>`, or a worker ID with `steer: true`, `wait: false`. |

`orchestration:general` maps to the existing General Lead. Calls are cancellable, requests share one serialized SSH path, and successful results are capped at 4 MiB; reduce `swarm_read.max` to page large transcripts.

Merge this server into user-level `~/.kimi-code/mcp.json` (keep any existing servers):

```json
{
  "mcpServers": {
    "emin-swarm": {
      "command": "/Users/eminmahrt/.local/bin/node",
      "args": [
        "/Users/eminmahrt/Developer/pi-durable-deploy/src/swarm-mcp.mjs"
      ],
      "env": {
        "SWARM_MCP_SSH_HOST": "swarm-host",
        "SWARM_MCP_SOCKET": "/home/swarm/.pi-durable/swarm.sock"
      }
    }
  }
}
```

These absolute paths are this machine's example; adjust `command` and `args` for your setup. The `env` values are the defaults and may be omitted. Start a **new Kimi Code/Desktop session** after saving the configuration.

Verify from the repository root after implementation, then check the remote and public health endpoints:

```sh
node --check src/swarm-mcp.mjs
node --no-warnings --test test/swarm-mcp.test.mjs
ssh swarm-host 'curl -fsS --unix-socket /home/swarm/.pi-durable/swarm.sock http://localhost/healthz'
curl -fsS https://code.emin.de/healthz
```

The SSH check requires the local smartcard bridge and SSH key to work; the public health check alone does not verify MCP.

### Unix Socket HTTP RPC Endpoints (`swarm.sock`)

| Method & Path | Description |
| :--- | :--- |
| `GET /healthz` | Liveness check (`{ ok: true, pid }`) |
| `GET /status` | Full Lead state, usage ledger, active tasks, hooks, drafts, cron watchers |
| `GET /workers` | Authoritative worker list sorted running-first, including orchestration/schedule metadata |
| `GET /orchestrations` | List `General` and named durable Lead conversations |
| `POST /orchestrations` | Create a named orchestration (`{ name }`) |
| `POST /orchestration-workers` | Create one-shot/recurring worker (`{ orchestrationId, name, role, goal, mode, everyMs? }`) |
| `POST /orchestration-worker` | `{ workerId, action: "run" | "pause" | "resume" }` |
| `GET /hooks` | Registered out-of-core guardrail & lifecycle hooks with live counters |
| `GET /transcript?convId=1&max=40` | Bounded conversation transcript |
| `POST /chat` | Submit user message (`{ text: string, images?: [{mimeType,data} base64] }`, validated non-empty unless images are attached; deterministic slash commands, `/btw`, `/reinforce`, steer, or Lead turn) |
| `POST /cron` | Register a durable `ForeverWatchTask` watcher |

---

## 10. Repository Map & Deep-Dive Docs

### Core Modules (`src/`)
- `src/daemon.mjs` — Durable swarm orchestration (`Harness`, `SwarmDoc`, `RoleMetaDoc`, tools, `ForeverWatchTask`, `ForeverWorkTask`, Lead/worker lifecycle)
- `src/orchestrations.mjs` — Pure validation/public shaping for named Leads, worker modes, intervals, and schedules
- `src/hooks.mjs` — Out-of-core `HookRegistry`, manifest validator, and built-in deterministic security & verification guardrails
- `src/commands.mjs` — Deterministic zero-LLM slash commands (`/help`, `/status`, `/workers`, `/hooks`, `/credits`) + 3-tier health probe
- `src/models.mjs` — Open-weights model catalog, role roster, and 3-tier failover (`llmgateway` -> `allmodels` -> `local-llama` with explicit warning banner)
- `src/prompts.mjs` & `config/APPEND_SYSTEM.md` — 486-byte V3 prompt floor, Verbatim Spec Rule, and per-role instructions
- `src/supervisor.mjs` — Bounded `turn_limit` auto-resume supervisor (never retries auth/billing/policy errors)
- `src/bus.mjs` — Zero-dependency `node:sqlite` FTS5 cross-agent message bus with broadcast ack isolation
- `src/optmem.mjs` & `src/memo` — Durable cross-session memory with auto-`nap` drain (Lead-only writer)
- `src/triage.mjs` — System-1 watcher & prompt router (`jev-latest` with deterministic offline fallback)
- `src/web.mjs`, `src/webauthn.mjs`, `src/markdown.mjs`, `src/chat-client.js` — Solarized Light Passkey Web UI, XSS-safe Markdown/Mermaid rendering, copied Rare UI copy button, and Click-to-Sign SSH bridge UI
- `src/chat-images.js` & `src/image-util.mjs` — Composer image paste/attach (client) and strict magic-byte validation, caps, content-addressed storage + authenticated `/api/image/:id` serving (server)
- `src/image-util.mjs`, `src/chat-images.js` — strict image sniff/decode/store and composer paste UI
- `src/reinforce.mjs` & `src/harness-bench.mjs` — Reproducible Docker `/reinforce` and cross-harness benchmark harnesses

### Documentation & Benchmark Receipts (`docs/`)
- [`CHANGELOG.md`](CHANGELOG.md) — Chronological per-turn changelog (updated on every change alongside `README.md`, per [`AGENTS.md`](AGENTS.md))
- [`AGENTS.md`](AGENTS.md) — Working standards for contributors & autonomous turns (per-turn changelog, README sync, verification, invariants)
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — Production VPS architecture, Smartcard Bridge (`127.0.0.1:4199`), 3-tier failover, hook registry, zero-LLM commands, and `swarm-ctl` deploy pipeline
- [`docs/HARNESS_BENCHMARK_ep3.md`](docs/HARNESS_BENCHMARK_ep3.md) — Controlled 4-harness `Kimi K3.1 Pro` benchmark (`pi-durable-swarm` #1 at `95.33/100`)
- [`docs/REINFORCE_BENCHMARK.md`](docs/REINFORCE_BENCHMARK.md) — Isolated Docker `/reinforce` Ep1 replay (`88.0/100`, 0 nudges, `$0.1548` vs `44.8/100`, 6 nudges, `$1.0940`)
- [`docs/TERMINAL_BENCHMARK_emin-swarm.md`](docs/TERMINAL_BENCHMARK_emin-swarm.md) — Real VPS Terminal-Bench 2.1 adapter, oracle and model receipts, isolation, failure analysis, and extended-timeout caveats
- [`docs/HARNESS_BENCHMARK_ep4-kimi-ref.md`](docs/HARNESS_BENCHMARK_ep4-kimi-ref.md), [`docs/HARNESS_BENCHMARK_ep4-qwen38-27b.md`](docs/HARNESS_BENCHMARK_ep4-qwen38-27b.md), [`docs/LOCAL_ADAPTER_BENCHMARK_ep4.md`](docs/LOCAL_ADAPTER_BENCHMARK_ep4.md) — Cloud vs. local model empirical reality check


---

## 11. Handover & Verified State

**Repository:** <https://github.com/eminogrande/code-emin-de> · **Live UI:** <https://code.emin.de>

GitHub `main` and live deployment are aligned on the handover documentation commit; use Git history for the exact SHA. Feature baseline: **`49a2abc`** (MCP/Harbor) and **`7cf3b30`** (production dependency fix), followed by handover documentation updates.

- **Tests:** full `npm test` passed **138/138**, including the bounded live swarm E2E in **144.76s**. Isolated bounded-stream live E2E also passed in **70.34s**.
- **Production:** `swarm-ctl pull` returned `PULLED_OK`; `swarmd`, `swarm-web`, and Caddy are active. `https://code.emin.de/healthz` and the Unix-socket daemon both return healthy.
- **MCP:** the deployed `emin-swarm` stdio server completed a real `swarm_list` read over smartcard SSH: **6 orchestrations / 33 workers**, with live status and transcripts available through `swarm_read`.
- **External benchmark:** Harbor oracle passed **5/5** with mean reward `1.000`. Real Emin Swarm `write-compressor` attempts returned **reward `0.000`** after Lead `turn_limit`; the adapter works, but the model baseline has not solved that task. See [`docs/TERMINAL_BENCHMARK_emin-swarm.md`](docs/TERMINAL_BENCHMARK_emin-swarm.md).
- **Deployment backup:** pre-existing VPS changes are preserved in Git stashes `pre-49a2abc-backup-root` and `pre-49a2abc-backup`. No reset, force-push, or deletion was used.
- **Dependencies:** `jsdom` is retained in production because `src/markdown.mjs` imports it at runtime. Model credentials are not committed; Harbor receives them through an agent-owned `0600` file inside each isolated container.
- **Known remaining work:** the first model baseline needs a shorter deterministic smoke and measured prompt/Lead improvements. The separate `npm audit` report still contains existing Mermaid/transitive advisories; the newly added MCP SDK and Zod dependencies no longer contribute findings.
