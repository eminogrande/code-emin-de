# Architecture, Failover, Guardrails & Smartcard Bridge

## 1. System Overview (`code.emin.de` / `178.105.82.203`)

`pi-durable-swarm` runs as a self-hosting, **open-weights-only** multi-agent daemon (`@earendil-works/pi-durable@1.5.2`) on Ubuntu 24.04 LTS (4 vCPU Intel Xeon Skylake, 7.6 GiB RAM) behind hardware FIDO2/Passkey authentication.

- **Zero bearer tokens:** SSH accepts **only** `sk-ecdsa-sha2-nistp256@openssh.com` (`id_nuri_pcsc_sk_backup`); HTTPS (`code.emin.de`) accepts **only** enrolled hardware Passkeys (`mac-touchid` + `nuri-card-acr39u`). `swarmd` exposes **zero** TCP ports — only a `0600` Unix domain socket (`/home/swarm/.pi-durable/swarm.sock`).
- **Prompt & Skill Discipline (`486` bytes, `~116` tokens):** Every role (`lead`, `planner`, `coder`, `reviewer`, `support`, `social`, `watcher`, `btw`) enforces the exact 4-line `V3` `CAVEMAN + ADHD MODE` prompt (`config/APPEND_SYSTEM.md`) with `enableSkills: false` (`0` skill-leak tokens).
- **Verified Open-Weights Roster (`src/models.mjs`):**
  - `lead` / `planner` / `reviewer` / `reviewerDeep` / `social`: `kimi-k3.1-pro`
  - `coder`: `deepseek-v4.1-flash-uncensored` (fast: `deepseek-v4.1-flash-1017`)
  - `support` / `watcher`: `glm-5.3`
  - `btw` (read-only side-chat): `deepseek-v4.1-flash-1017`
  - System-1 triage (`src/triage.mjs`): `jev-latest` (`/v1/decisions`) with deterministic offline fallback

## 1.1 Durable Multi-Orchestration Control Plane

`SwarmDoc.orchestrations` maps stable orchestration IDs to named Lead conversations. `General` maps to
the existing root conversation for backwards compatibility. Every worker carries `orchestrationId`;
workers spawned by a named Lead inherit it, while existing workers default to `General`.

A UI-created worker has a durable goal, role, mode, conversation, enabled flag, run counter, and schedule.
One-shot workers run immediately and remain manually triggerable. Recurring workers own a registered
`swarm.forever_work` task. Its `tick` commits run metadata, submits bounded work to the same conversation,
then `sleepUntil` the next interval. The harness—not a JavaScript `setInterval`—owns recovery after restart.
Busy workers record `skipped_overlap`; paused workers retain their durable task but receive no submissions.
This avoids token-burning infinite loops and unbounded queued submissions. Creation is capped at 50 named
orchestrations and 25 workers per orchestration. Role/mode/interval/goal validation is model-free in
`src/orchestrations.mjs`; authenticated web routes proxy to the existing `0600` Unix socket.

## 2. 3-Tier Open-Weights Failover & Local Failsafe (`src/models.mjs` + `llama-failsafe.service`)

Cloud billing exhaustion (HTTP `402`) or provider outages (`5xx` / timeouts) must **never** cause a silent shutdown:

1. **Tier 1 (`llmgateway`):** Primary open-weights API router. On HTTP `402`/billing/5xx/network failure, trips a 5-minute circuit-breaker cooldown so subsequent turns immediately skip the dead hop.
2. **Tier 2 (`allmodels`):** Transparently retries on the mapped open-weights equivalent (`LLMGATEWAY_TO_ALLMODELS_MAP`), followed by cheaper fallbacks (`z-ai/glm-5.3-abliterated`, `deepseek/deepseek-v4.1-flash-abliterated`) with `max_tokens` capped at `8192` to prevent upstream credit-reservation `402` errors.
3. **Tier 3 (`local-llama` on `http://127.0.0.1:8089/v1`):**
   - Served by `/etc/systemd/system/llama-failsafe.service` running `llama.cpp` `b12532` (`libggml-cpu-skylakex.so`, AVX2/AVX-512) with `/opt/local-models/LFM3-1.7B-Q4_K_M.gguf` (`1.02 GiB`) and flags `-t 4 -c 8192 --parallel 1 --reasoning-budget 0 --alias LFM3-1.7B-Q4_K_M`, capped at `MemoryMax=2800M`.
   - Injects `EMERGENCY FAILSAFE MODE` into `systemPrompt` and **deterministically prepends** `⚠️ **[LOCAL FAILSAFE ACTIVE: local-llama/LFM3-1.7B-Q4_K_M]**` with the exact failed provider/model/error summary to both streaming deltas and the final message.
   - Measured live on VPS: `pp512` `74.59–75.04 tok/s`, `tg128` `15.25–15.97 tok/s`, full E2E outage takeover in `5.28s`, total RAM used (`swarmd` + `llama-failsafe`) = `1.7 GiB / 7.6 GiB` (`5.9 GiB` available, `$0/mo` extra).

## 3. Deterministic Zero-LLM Control Plane (`src/commands.mjs`)

Operational slash commands are intercepted at the top of `daemon.chat()` **before** System-1 triage or any LLM call (`llmCalls: 0`, `<50ms` latency). They work even if **both** cloud providers and `llama-failsafe.service` are offline:

- `/help` — Command reference (zero-LLM + LLM-routed commands)
- `/status` — Lead model/provider/context %, token & USD spend ledger, active tasks, pending drafts, cron watchers
- `/workers` — Authoritative worker roster (running first, role, model, phase, turns)
- `/hooks` — Registered out-of-core guardrail & lifecycle hooks with live invocation/block/continue/error counters
- `/credits` — Zero-token parallel `GET /models` health & billing probe across Tier 1 (`llmgateway`), Tier 2 (`allmodels`), and Tier 3 (`local-llama`)

## 4. Out-of-Core Guardrail & Lifecycle Hook Registry (`src/hooks.mjs`)

Policy and security invariants live outside `src/daemon.mjs` orchestration inside `HookRegistry`, validated via explicit manifests (`id`, `description`, `priority`, `events`, `enabled`) and wired into `pi-durable`'s `ToolTask` (`beforeTool`, `afterTool`) and `GenerationTask` (`onYield`):

- **Fail-closed `beforeTool`:** If a security hook throws, the tool call is **blocked** and `onError` is notified.
- **Built-in guardrails (`createBuiltinGuardHooks`):**
  1. `readonly-role-guard` (`p10`): blocks `write`/`edit` for `btw`, `reviewer`, `planner`; blocks `bash` for `btw`.
  2. `optmem-lead-only-guard` (`p20`): blocks `memory_note` for non-Lead roles.
  3. `destructive-bash-guard` (`p30`): blocks `rm -rf /`, `rm -fr /`, force-push, `git reset --hard`, `mkfs.`, `dd of=/dev/`, `curl|sh`, `authorized_keys`/`sshd_config`/`ufw disable`.
  4. `subagent-deploy-guard` (`p40`): blocks subagents from running `swarm-ctl apply/reload/rollback` or `git push`.
  5. `draft-only-outbound-guard` (`p50`): blocks outbound SMTP/Resend/SendGrid/X API sends for `support` and `social`.
  6. `coder-hard-test-gate` (`onYield p10`): requires `Verified: PASS` and independently runs real syntax + unit tests in `workspaceDir` before a `coder` worker can finish.
  7. `lead-auto-backup-gate` (`onYield p20`): validates, commits, pushes (append-only), and reloads `/opt/pi-durable-swarm` edits via `swarm-ctl apply`.
- **Extensible:** Custom addons can be passed via `openSwarmDaemon({ hooks: [...] })` or registered at runtime on `daemon.hooks`, and inspected live via `/hooks` or `GET /hooks` on `swarm.sock`.

## 5. Why We Built the Local Smartcard Bridge (`ops/mac-smartcard-bridge.py`)

Two browser/OS boundaries prevent a raw web tab from directly using a T=0 contact smartcard for both WebAuthn and remote SSH:

1. **Safari + T=0 Contact Reader Quirk:** macOS Safari's native WebAuthn sheet only talks USB-HID or T=1 CCID and silently skips T=0 contact readers like `ACS ACR39U ICC Reader` (`ATR=3b119580`). `nuri_pcsc.py` patches `python-fido2` with the `default -> T0 -> T1` ladder so CTAP2 works reliably on `ACR39U`.
2. **WebAuthn RP ID vs OpenSSH `application="ssh:"`:** Browser `navigator.credentials.get()` enforces `rpId = "code.emin.de"`, whereas remote `sshd` servers (`nuri.com`, `sign.nuri.com`, etc.) verify an ECDSA-SK signature over `SHA256("ssh:")` + the raw `SSH_MSG_USERAUTH_REQUEST` packet.

### How the Click-to-Sign Bridge Works (Zero Key Export)

```text
[VPS: ssh nuri.com]
   └─ ops/ssh-pcsc-sk-provider.c -> src/vps-ssh-sk-helper.mjs
        └─ POST http://127.0.0.1:3001/internal/ssh-sign/request (blocks)
             └─ [Browser: https://code.emin.de] shows:
                "SSH request: ssh nuri.com ... [Sign with Smartcard] [Deny]"
                  └─ User clicks [Sign with Smartcard]
                       └─ POST http://127.0.0.1:4199/ssh-sign (CORS locked to https://code.emin.de)
                            └─ ops/mac-smartcard-bridge.py -> physical Nuri Smartcard (ACR39U)
                                 └─ Returns ONLY one-time (sig_r, sig_s, counter) -> ssh connects!
```

- **Zero private keys leave the card:** `/home/swarm/.ssh/id_nuri_pcsc_sk_backup` on the VPS is only the public key handle stub (`ECDSA-SK`), useless without physical card presence + browser click.
- **Zero silent background SSH:** If `code.emin.de` is closed or you click `Deny`, the VPS cannot open an SSH session. `ControlPersist 15m` reuses an approved connection for 15 minutes so follow-up commands don't spam prompts.
- **Same local daemon (`127.0.0.1:4199`)** also exposes `/webauthn-create` and `/webauthn-get` (`rpId` pinned strictly to `code.emin.de`) so Safari can enroll and unlock `code.emin.de` directly with the `ACR39U` smartcard.
- **Reproducible Mac install (`launchd`):** run `./ops/install-mac-smartcard-bridge.sh` (installs `ops/de.emin.code.smartcard-bridge.plist` -> `~/Library/LaunchAgents/` and verifies `http://127.0.0.1:4199/healthz`).

## 6. VPS-First Self-Improvement + Append-Only GitHub Backup

- Live repo on VPS: `/opt/pi-durable-swarm` (pushing via single-repo deploy key to `eminogrande/pi-durable-swarm`).
- Deterministic `lead-auto-backup-gate` (`onYield` hook in `src/hooks.mjs` / `src/daemon.mjs`): whenever `lead` leaves modified files in `/opt/pi-durable-swarm`, it automatically runs `sudo /usr/local/bin/swarm-ctl apply`, which:
  1. Runs `node --check` on `src/*.mjs` and unit tests (feeding errors back to the agent if anything fails).
  2. Blocks secrets (`.env`, `.sqlite`, `.pem`, `.key`, `authorized_keys`).
  3. Commits and pushes to `origin/main` (append-only; force-push blocked by `destructive-bash-guard`, rollbacks use `git revert`).
  4. Reloads `swarm-web` immediately and schedules `swarmd` restart cleanly after the HTTP response finishes.
