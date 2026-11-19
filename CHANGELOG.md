# Changelog

All notable changes to `pi-durable-swarm` are recorded here in reverse chronological order.
Standard: every code/config/ops turn updates `CHANGELOG.md`, keeps `README.md` in sync, pushes to GitHub, and reports a concise changelog in the turn summary.

---

## 2026-11-19

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
