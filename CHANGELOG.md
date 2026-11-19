# Changelog

All notable changes to `pi-durable-swarm` are recorded here in reverse chronological order.
Standard: every code/config/ops turn updates `CHANGELOG.md`, keeps `README.md` in sync, pushes to GitHub, and reports a concise changelog in the turn summary.

---

## Unreleased

### Features

- models: add free internal router provider `paymentrequired` ("PaymentRequired Free",
  OpenAI-compatible) with the **full** router catalogue: `k3.1-pro`, `k3.1-pro-highspeed`,
  `kimi-for-coding`, `kimi-for-coding-highspeed`, `deepseek-v4.1-flash-abliterated`,
  `gemini-3.5-flash-lite`, `gemini-3.8-flash-high`, `gemini-4-argon-high`, `glm-5.3-abliterated`,
  `glm-5.3-flash-abliterated`, `cohere/north-mini-code:free`, `dots-studio/dots-3-note-preview:free`,
  `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`, `nvidia/nemotron-3-ultra-550b-a55b:free`,
  `nvidia/nemotron-3.5-lightning:free`. All are allowlisted Lead choices; costs are declared zero
  (free endpoint, no verified subscription plan). UI mirrors the full list with readable
  `PaymentRequired · <id>` labels (`Kimi K3.1 Pro · free router`) instead of identical bare IDs.
  The provider is excluded from cross-provider failover so real quota/error responses surface.
  Configure via env `ROUTER_PAYMENTREQUIRED_API_KEY` only. Covered by offline unit tests.

### UI

- sidebars simplified: left holds only the orchestrator (Lead select, no generated worker buttons);
  right lists only *running* agents, everything done/failed collapses into `<details>` `Archived workers`
  (no transcript deletion, real poll error text when nothing is visible). Registry states now match
  actual `failed:turn_limit` / `stopped:<reason>` values and cron jobs are filtered out.
- chat theme redesign (`src/chat-theme.css`, Rare UI *inspiration*, no framework swap): Solarized
  paper/navy kept, warm accent; 3-column rail 248/1fr/280px with hairline borders + faint warm grid
  instead of boxed cards, compact truncating lists, plain speech messages, bordered code with
  highlight tokens, rounded composer with visible focus ring, 40px labeled actions, subdued empty
  state. Rails collapse to existing `.open` drawers ≤1100px/≤800px (topbar triggers + backdrop, no
  content overlay), `prefers-reduced-motion` honoured. Attribution in the CSS header and a footer
  link. Stylesheet is a same-origin asset with a tiny CSP-safe `<link>`; no class/ID/functionality
  changes (markdown, Mermaid, model select, worker poll, image upload untouched).
  Tests: `test/ui-theme.test.mjs`.

## 2026-11-20

### Lead Model Dropdown in `code.emin.de` Chat
- **Why**: the Lead could only be switched by env restart; open-weights failover existed but was invisible/untunable from the chat. Users now pick `Kimi` on either gateway (or DeepSeek/GLM) directly in the status bar.
- **Allowlist**: `LEAD_MODEL_CHOICES` / `resolveLeadModelChoice()` in `src/models.mjs` — exactly seven verified, registry-known, provider-explicit pairs (so the existing `llmgateway → allmodels` failover map still resolves the same model). No arbitrary IDs, no new secrets/OAuth.- **Auth route**: authenticated `POST /api/model` (`src/web.mjs`, passkey session) → Unix-socket `POST /model` (`src/cli.mjs`) → `daemon.setLeadModel()`, which rejects unknown provider/model with `400` and a clear `allowlist` error.
- **Durable + global**: stored as `SwarmDoc.leadModelOverride { provider, modelId, updatedAt }`, re-applied to the Lead conversation on restart (role `ROLE_MODELS` untouched, spawns unchanged). Effective override is reported by `/status` and `/api/workers` as `lead.overridden` with the previous model as `lastUsed`.
- **UI**: status-bar `<select>` labeled `provider/modelId` (all text via `textContent`), optimistic but revert-on-error with inline error text, disabled while Lead is busy, no auto reset. `allmodels` quota errors surface as the real error.
- **Also**: deterministic zero-LLM `/model [provider modelId]` command (`src/commands.mjs`) + `/help` entry.
- **Tests**: `test/lead-model.test.mjs` (allowlist validation incl. wrong provider/unknown model, persistence + effective `/status` across restart, `/api/model` auth + `/model` socket route). `test/chat-client.test.mjs` updated for the `<select>`.

## 2026-11-19

### Guard Against Empty/Undefined `POST /chat` Transcript Poisoning
- **Fixed root cause of `content is not iterable` outage**: `POST /chat` (`src/cli.mjs`) and `daemon.chat()` (`src/daemon.mjs`) now strictly validate non-empty string `text` before touching `@earendil-works/pi-durable`, returning HTTP `400 { error: "text is required" }` / `{ route: "invalid", status: "rejected" }` instead of inserting a contentless `pi.user` entry that breaks subsequent LLM turns.
- Added regression assertions in `test/commands.test.mjs` and repaired the poisoned live entry (`#3497`) on VPS `durable.sqlite` (backup saved to `durable.sqlite.bak-entry3497`).

### Standards & Documentation
- Added `CHANGELOG.md` and `AGENTS.md` codifying the per-turn changelog + GitHub `README.md` sync standard for both local sessions and the live VPS Lead Orchestrator (`src/prompts.mjs`).
- Added `Changelog` link and standard note in `README.md`.

### Deterministic Zero-LLM Control Plane & Out-of-Core Guardrail Hooks (`1052b9a`, `a78d188`)
- **Added `src/hooks.mjs`**: Decoupled all 7 built-in security & verification guardrails (`readonly-role-guard`, `optmem-lead-only-guard`, `destructive-bash-guard`, `subagent-deploy-guard`, `draft-only-outbound-guard`, `coder-hard-test-gate`, `lead-auto-backup-gate`) out of `src/daemon.mjs` into a manifest-validated `HookRegistry` (`beforeTool`, `afterTool`, `onYield`, `onError`) with priority ordering, fail-closed `beforeTool` semantics, isolated `onError` observers, runtime `setEnabled`, and live counters.
- **Added `src/commands.mjs`**: Intercepted `/help`, `/status`, `/workers`, `/hooks`, and `/credits` at the top of `daemon.chat()` before triage or any LLM call (`0` tokens, `<50ms` local, works during simultaneous cloud + local outages).
- **Added `GET /hooks`** Unix socket RPC endpoint in `src/cli.mjs`.
- **Tests**: Added `test/hooks.test.mjs` (4 tests) and `test/commands.test.mjs` (4 tests); fixed `DESTRUCTIVE_BASH_RE` trailing `\b` regex bug on `rm -rf /`.
- **Live VPS verification fixes (`a78d188`)**: Fixed `/workers` formatting to match `describeWorker()` fields (`id`, `state`, `model`, `lastError`) and fixed Tier-2 `/credits` default probe URL to `https://api.allmodels.io/v1/models` (`HTTP 200`).
- **Docs**: Rewrote `README.md` (WHY-behind-WHAT with empirical benchmark tables) and updated `docs/ARCHITECTURE.md`.

### Tier-3 Local Failsafe (`LFM3-1.7B-Q4_K_M`) & Web UI Ordering (`1a68a32`, `b96ae6f`)
- Compiled `llama.cpp` (`b12532`, Skylake AVX-512) on the VPS and installed `llama-failsafe.service` serving `LFM3-1.7B-Q4_K_M.gguf` on `127.0.0.1:8089` (`--reasoning-budget 0`, `MemoryMax=2800M`, ~895 MB RSS, `14.7–15.9 tok/s` decode).
- Wired automatic 3-tier failover in `src/models.mjs`: Tier 1 `llmgateway` (5-min circuit breaker on HTTP 402/5xx) → Tier 2 `allmodels` (`max_tokens` capped at 8192) → Tier 3 `local-llama` with deterministic `⚠️ **[LOCAL FAILSAFE ACTIVE: ...]**` warning banner.
- Fixed `pi-ai` `ApiKeyAuth` return shape for `local-llama` (`b96ae6f`) and chat user/placeholder message ordering in `src/web.mjs` (`1a68a32`).

### Cross-Harness & Local Adapter Benchmarks (`eb803b4`, `2ec75a8`, `9b9fb9f`, `495b517`, `d2c1bd8`)
- Ran controlled 4-harness `Kimi K3.1 Pro` benchmark (`ep3`): `pi-durable-swarm` ranked #1 (`95.33/100` PASS vs `opencode` `91.67`, `pi-cli --no-skills` `87.67`, `kimi-code` `46.00` FAIL) after fixing skill-leak tokens (`enableSkills: false`) and adding the Verbatim Spec Rule + generalized `onYield` Hard Test Gate (`js/mjs/go/py`).
- Ran cloud vs. local reality benchmark (`ep4`): empirically confirmed `Kimi K3.1 Pro` (`70.67/100` at `$0.0457`) outperforms `Qwen3.8-27B` (`0/100`) and `LFM3-1.7B` base / +LoRA (`0` LOC) for coding, motivating Tier-3 `LFM3-1.7B` strictly as an outage failsafe rather than a primary coder.
- Upgraded `planner` and `reviewer` default models to `kimi-k3.1-pro` (`495b517`).
