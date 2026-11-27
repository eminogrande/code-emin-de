# Changelog

All notable changes to `code-emin-de` are recorded here in reverse chronological order.
Standard: every code/config/ops turn updates `CHANGELOG.md`, keeps `README.md` in sync, pushes to GitHub, and reports a concise changelog in the turn summary.

---

## Unreleased

### Fixes (2026-11-27)

- **Tight chat bubbles, no runaway `<br>`/blank lines (`src/markdown.mjs`, `src/web.mjs`):**
  - WHY: `.m.u{white-space:pre-wrap}` turned literal inter-tag/trailing `\n` from `marked` (`<p>x</p>\n`, `<br>\n`, `<hr>\n`, `r.code` trailing `\n`) into visible blank lines on top of browser-default `1em` `<p>` margins that user bubbles never reset.
  - Added exported `compactBreaks()` in `src/markdown.mjs` to strip newlines strictly at block-tag and void-tag (`<br>`, `<hr>`) boundaries while keeping in-paragraph newlines and `<pre>/<code>` whitespace byte-exact (DOMPurify allowlist unchanged).
  - Added compact `.45rem` block margins on `.m.u` followed by `.m.u>:first-child{margin-top:0}` and `.m.u>:last-child{margin-bottom:0}` (ordered after `.m.u .cb/.mmd/.table-scroll` so equal-specificity edge resets always win).
  - Tests: `test/markdown.test.mjs`, `test/ui-theme.test.mjs`, `test/chat-client.test.mjs` (including hard-break `<br>`/`<hr>` and timer-safe JSDOM single-line bubble assertions).

### Features & Fixes (2026-11-26)

- **OptMem optimization & cross-machine SSH/MCP memory sharing (`src/optmem.mjs`, `src/daemon.mjs`, `src/cli.mjs`, `src/swarm-mcp.mjs`, `test/optmem.test.mjs`, `test/swarm-mcp.test.mjs`):**
  - WHY: smaller wake trees keep Message-1 context tiny and stop orchestrators from overthinking, while exposing OptMem over the SSH-only `0600` Unix socket + MCP lets local Mac and VPS orchestrators share one persistent memory on `code.emin.de`.
  - Lowered default OptMem wake budget from `48` lines / `8000` chars to `24` lines / `3000` chars (`OPTMEM_WAKE_LINES` / `OPTMEM_WAKE_CHARS`).
  - Upgraded `defaultCompressPair` to deduplicate and split the 275-char node budget evenly across merged halves; added file-stat `refreshVersion()` so external writes invalidate cached wake blocks immediately.
  - Added Unix-socket routes (`GET /memory/wake`, `GET /memory/recall?pattern=...`, `POST /memory/note`) in `src/cli.mjs` and MCP tools (`memory_wake`, `memory_recall`, `memory_note`) in `src/swarm-mcp.mjs`.
- **Upgraded global prompt floor to Round 10 `V11` visual caveman + numbered tables (`config/APPEND_SYSTEM.md`, `src/prompts.mjs`, `test/swarm.test.mjs`):**
  - Restores true caveman fragments (`0` articles/filler on Gemini 4), adds bold visual anchors, and prefers one tiny numbered table (`# | Item | Status or Pick`) for open calls, comparisons, or 3+ items while keeping `0.0` code pills, parens, and semicolons (`1,158` chars / `~289` tokens; `3/3` H2 pass, `6/6` tables).

### Features & Fixes (2026-11-24)

- **Parallel inbox web integration (`src/web.mjs`, `test/chat-client.test.mjs`):** Each composer send now carries a unique daemon-deduplicated `requestId`; Enter/submit always start independent work while explicit Ctrl/Cmd+S still steers. Poll cadence follows the actual Lead busy snapshot, not an immediately accepted parallel HTTP request, so rapid sends cannot accidentally steer. Image upload and accepted-send attachment cleanup are unchanged.

- **Clipboard-only composer cleanup (`src/web.mjs`, `test/ui-theme.test.mjs`, `test/chat-images-e2e.test.mjs`):**
  - Removed the unwanted **Attach images** button, hidden picker input, styling and picker handler again. Screenshot paste and drag-and-drop remain; no upload workflow was removed.
  - Composer form submission and Enter now share the real `send()` path. After successful submission, message text, pasted thumbnail, filename, attachment counter and object URL clear immediately; the sent history image remains. Failed submission preserves the draft.

- **Durable repo classification and in-place frontend binding (`src/orchestrations.mjs`, `src/daemon.mjs`, `test/orchestrations.test.mjs`):**
  - Derive `Repos` membership from validated durable `cwd`/`repoUrl`/`repo` preset metadata instead of names or a stale sidebar group; generic-workspace agents remain repo-less.
  - Rebind the existing frontend orchestrator to `/opt/pi-durable-swarm` without replacing its id or conversation. Regression coverage verifies repo-bound vs repo-less classification and preservation of agent id/history.

- **Composer attachments clear on accepted send (`src/web.mjs`, `test/chat-images-e2e.test.mjs`):**
  - WHY: after sending a message with a pasted screenshot the thumbnail stayed in the composer, so the user could not tell the image had been sent and could re-send it by accident.
  - Cleanup used to run at the very end of the reply-rendering chain inside `send()`'s `try`, so any throw in the markdown/CoT render branches skipped it and left stale thumbnails and leaked object URLs behind.
  - Now a single `acceptSend()` helper runs immediately after the response is classified as accepted and clears `window.chatImages` exactly once (revoking the object URLs), before rendering. Covered accepted paths: `text`, `html`, `images`, HTTP `202`/pending, daemon-reload (`502/503/504`) and malformed non-JSON bodies.
  - Attachments are deliberately kept on validation/provider/network failure (`d.error`, HTTP `413`, fetch throw) so the user can retry, and the request is never cleared before the `await`.
  - Sent-message history thumbnails are untouched: the optimistic `.himages` node renders from the payload data URLs, not from the composer deck.
  - New E2E regressions in `test/chat-images-e2e.test.mjs` assert composer empty + object URL revoked exactly once after every accepted shape, preserved on `500`/`413`, and cleared even when reply rendering throws.

- **Lead Delegation Mandate (`src/prompts.mjs`, `test/swarm.test.mjs`):**
  - WHY: Lead kept coding small fixes itself, so the orchestrator burned its own context and lost the parallelism/verification benefits the swarm exists for. The Lead prompt now hard-requires `spawn_worker` (appropriate role) BEFORE any implementation on every actionable build/fix/investigation request; Lead only coordinates, integrates, independently verifies, and handles approved deploy/backup.
  - Exemptions keep it from looping: pure greetings, direct factual questions, status queries, and bus/worker notifications spawn no worker; workers never spawn workers (no infinite nesting).
  - Existing parallel fanout for >=2 disjoint tasks and single-coder ownership for the same module/file are preserved verbatim; the 486-byte V3 caveman/ADHD prompt floor is untouched (Lead additions are appended below it).
  - New test `1b` pins the mandate, the exemptions, the nesting rule, and asserts every role prompt still starts with the exact caveman floor.

### Features & Fixes (2026-11-23)

- **Simplified sidebars to match real `Repos` + `Workers & Jobs` model (`src/web.mjs`, `src/daemon.mjs`):** Removed the preset/group dropdowns (`#orch-preset`, `#edit-orch-preset`, `#orch-group`) and worker-role jargon dropdown (`#worker-role`), dropped redundant `REPOS` headers and `[REPO]` badges, surfaced each repo's live Git `branch` + dirty marker (`main*`) directly in the left sidebar (`Repos`), and unified right-sidebar creation to clean `Workers & Jobs` (`One-shot worker` / `Recurring job`).
- **Merged root `General` into `code-emin-de` (`src/daemon.mjs`, `src/web.mjs`):** Root orchestrator (`convId: 1`, owns `swarm-ctl` self-deploy) is now labeled and bound directly to `code-emin-de` (`/opt/pi-durable-swarm`, live `[GIT_CONTEXT]`), and the duplicate `code-emin-de` orchestration (`orch-mwp7jfei-dygg`) was archived on VPS so every active sidebar entry is a single real Git repo (`code-emin-de`, `nuri-website`, `router-paymentrequired-com`).
- **Subscription-chain failover before paid tokens & switch off exhausted Kimi weekly limit (`src/models.mjs`, `test/models-failover.test.mjs`, VPS `.env`):**
  - Updated `PAYMENTREQUIRED_FAILOVER=1` to hop across remaining live subscription/router buckets (`gemini-4-neon-xhigh` → `claude-opus-5-5-high` → `gemini-4-argon-high` → `claude-sonnet-5-5-high` → `deepseek-v4.1-flash-abliterated`) BEFORE touching paid gateways, and changed the paid fallback from expensive `llmgateway/kimi-k3.1-pro` (`$2/$10`) to cheap `llmgateway/deepseek-v4.1-flash-uncensored` → `allmodels/deepseek/deepseek-v4.1-flash-abliterated` → `local-llama`.
  - Switched live VPS defaults off 7-day-exhausted Kimi (`429`) to `paymentrequired/gemini-4-neon-xhigh` (`max`) for orchestrators/reviewers and `paymentrequired/deepseek-v4.1-flash-abliterated` (`low`) for workers/recurring jobs (saving sub weekly quotas for high-leverage orchestration).
- **Clarify-first orchestration, live Git branch context, safe GitOps policy, and orchestration archiving (`src/prompts.mjs`, `src/triage.mjs`, `src/daemon.mjs`, `.gitignore`, `test/orchestrations.test.mjs`):**
  - Added a `CLARIFY-FIRST GATE` in `src/prompts.mjs` and narrowed `classifyUserPrompt` (`src/triage.mjs`) so questions and brainstorming stay `single_agent` (answer + clarify first) instead of prematurely spawning coding workers, while ≥2 concrete independent build/fix tasks still auto-fanout in parallel.
  - Injected live `[GIT_CONTEXT: repo=... | branch=... | head=... | dirty=...]` before repo orchestrator turns and codified safe GitOps policy (tests + `CHANGELOG.md`/`README.md` + non-force push to staging/feature branch so Emin manually merges `main` for production deploy).
  - Added `archived: true` support on orchestrations (`listOrchestrations` hides archived sessions while preserving SQLite history), archived the 4 legacy repoless sessions on VPS, and ignored `test/_repro*` scratch files in `.gitignore`.
- **Fixed cross-agent OptMem (`src/optmem.mjs`, `src/hooks.mjs`, `src/daemon.mjs`, `test/hooks.test.mjs`, `test/orchestrations.test.mjs`):**
  - Serialized all OptMem calls (`init`/`wake`/`note`/`recall`/`zoom`) through an internal promise queue + monotonic version counter in `src/optmem.mjs` so concurrent writes from multiple agents never race on `.lock` or `LOG.txt`.
  - Allowed named orchestrators (`role === "orchestrator"`) to call `memory_note` (auto-tagging notes with `[<AgentName>]`) and granted `memory_wake`/`memory_note`/`memory_recall` to all orchestrator presets while keeping subagent workers blocked in `optmem-lead-only-guard`.
  - Auto-injected the live `optmem.wake()` shared memory tree into `General` and every named orchestrator on daemon startup, orchestration create/update, `ask_agent` delegation, and before idle `daemon.chat()` turns (cached by OptMem version so unchanged turns have zero overhead).
- **Removed artificial `8192`/`256K` client caps (`src/models.mjs`, `test/models-failover.test.mjs`):** Deleted the legacy `max_tokens` clamping wrapper on `allmodels` and `paymentrequired`, raised `ALLMODELS_OPEN_MODELS` output limits from `8192` to native `65536`/`131072` (keeping `1M` context), aligned `ROUTER_PAYMENTREQUIRED_MODELS` context windows (`1M` for `kimi-for-coding`, `glm-5.3-abliterated`, `gemini-3.5-flash-lite`, `claude-5.5`, etc.) 1:1 with `router-paymentrequired-com`'s `postpriced.mjs` (which already had zero request caps), and raised Kimi K3.1/K3 `maxTokens` to `131072`.
- **Subscription-first tiering, per-role thinking (`ROLE_THINKING`), `PAYMENTREQUIRED_FAILOVER=1`, and `router-paymentrequired-com` repo agent (`src/models.mjs`, `src/daemon.mjs`, `test/models-failover.test.mjs`, VPS `.env`):**
  - Added `ROLE_THINKING` (`lead`/`orchestrator`/`planner`/`reviewer`/`social`: `"max"`, `coder`/`watcher`/`support`/`btw`/recurring jobs: `"low"`, all env-overrideable) so orchestrators reason deeply while workers and recurring jobs stay fast.
  - Added opt-in `PAYMENTREQUIRED_FAILOVER=1` with per-model 5-minute cooldown in `attachOpenWeightsFailover`: when a subscription bucket hits `429` / `model_cooldown` / `5xx`, requests transparently fail over to `llmgateway` → `allmodels` (DeepSeek abliterated) → Tier-3 `local-llama` (`127.0.0.1:8089`). Configured VPS `.env` for Kimi-sub-first (`k3.1-pro` lead/coder, `kimi-for-coding` recurring/watcher/support/btw) with automatic DeepSeek failover.
  - Connected `nuri-com/router-paymentrequired-com` on the VPS (`/opt/pi-durable-swarm/workspace/router-paymentrequired-com`) via a scoped single-repo write deploy key and created the live `router-paymentrequired-com` `repo` Agent-Orchestrator under `Repos`.
- **Added Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B router models + per-agent model picker (`src/models.mjs`, `src/web.mjs`, `test/models-failover.test.mjs`, `test/lead-model.test.mjs`):**
  - Expanded `ROUTER_PAYMENTREQUIRED_MODELS` (20 → 23 models) and the web UI dropdown with `claude-opus-5-5-high`, `claude-sonnet-5-5-high`, and `gpt-oss-120b-medium` (all live-verified HTTP 200 on `router.paymentrequired.com/v1/internal`), alongside `gemini-4-neon-xhigh`, `gemini-4-hydrogen-xhigh`, `gemini-4-argon-high`, `gemini-3.8-flash-high`, Kimi K3.1/K3, and DeepSeek abliterated.
  - Added per-agent model selectors (`#orch-model`, `#edit-orch-model`) and made the `#statusBar` model selector context-aware: switches global Lead when viewing `General`, or persists a per-agent model override (`POST /api/orchestration-update`) when viewing any named Agent-Orchestrator.

### Features & Fixes (2026-11-22)

- **Typed Agent-Orchestrators, cross-agent delegation, and `nuri-website` repo workflow (`src/orchestrations.mjs`, `src/daemon.mjs`, `src/hooks.mjs`, `src/cli.mjs`, `src/web.mjs`, `test/orchestrations.test.mjs`):**
  - Upgraded named orchestrations into typed Agent-Orchestrators (`repo`, `marketing`, `security`, `ops`, `custom`) with `group`, workspace-contained `cwd` (inherited by all spawned workers and the hard test gate), `repoUrl`, custom `instructions`, and in-place updates (`POST /orchestration-update` / `POST /api/orchestration-update`).
  - Added preset-aware guardrails in `src/hooks.mjs`: `security` preset enforces `readonly-role-guard`, `marketing` preset enforces `draft-only-outbound-guard` (including LinkedIn/TikTok publish endpoints), and `repo`/`ops` presets permit non-force `git push` (so repo orchestrators can push to GitHub/GitHub Actions) while still blocking `swarm-ctl` self-deploy and destructive force-pushes.
  - Added `list_agents` and `ask_agent` tools so specialist orchestrators (`General`, `nuri-website`, `linkedin-marketer`, `tiktok-marketer`, `security-review-agent`) can delegate across agents via `AgentBus` + durable queues.
  - Grouped the left sidebar in `src/web.mjs` by domain (`Repos`, `Marketing`, `Security`, `Ops`, `Agents`) with preset badges, expanded `+ Add agent` options, and an `Edit selected agent` drawer.
  - Connected `nuri-com/nuri-website` on the VPS (`/opt/pi-durable-swarm/workspace/nuri-website`) via a dedicated single-repo SSH deploy key and created the live `nuri-website` `repo` Agent-Orchestrator for editing and pushing to GitHub Actions.

### Fixes & Models (2026-11-22)

- **Clear message authorship:** user turns now have a subtle tinted right-aligned **You** bubble; assistant and error turns get **Kimi** / **System** labels without changing rendering or history behavior.
- **Readable tables:** table cells no longer split words mid-token; first-column labels stay intact and wide tables scroll horizontally instead of crushing columns.
- **Transparent favicon:** added an inline SVG 🤔 favicon with no background rectangle to both login and chat, avoiding another static asset/request.

- **VPS ownership, SSH remote, and `swarm-ctl` guard (`ops/swarm-ctl`):** Fixed root-owned `/opt/pi-durable-swarm/.git/index` and stray `caddy`-owned image file on `code.emin.de` (`chown -R swarm:swarm`), switched VPS `origin` from HTTPS to `git@github.com:eminogrande/code-emin-de.git` (using `/home/swarm/.ssh/id_ed25519_github`), and added `chown -R swarm:swarm "$REPO/.git"` guards to `swarm-ctl` `apply|reload|reload-web|pull`.
- **Max reasoning for Kimi K3.1 + DeepSeek Abliterated (`src/daemon.mjs`, `src/models.mjs`, `test/models-failover.test.mjs`):** Switched all primary daemon roles (`lead`, orchestrators, `coder`, `planner`, `reviewer`, `watcher`, `support`, `social`) from `thinkingLevel: "high"` to `"max"` (keeping `/btw` at `"low"`), stopped `llmgateway` payload wrapper from downgrading `reasoning.effort` to `"high"`, and defaulted `reasoning.effort` to `"max"` across `llmgateway`, `allmodels`, and `paymentrequired`.
- **Gemini & Kimi subscription router wiring (`src/models.mjs`, `src/web.mjs`, `test/lead-model.test.mjs`, VPS `.env`):** Expanded `ROUTER_PAYMENTREQUIRED_MODELS` + Web UI dropdown from 15 to 20 models (`k3`, `gemini-4-neon-xhigh`, `gemini-4-hydrogen-xhigh`, `gemini-3.8-flash-tiered`, `gemini-3-flash`), raised `contextWindow`/`maxTokens` to `1M`/`64K` for frontier Kimi/DeepSeek/Gemini entries, and configured `ROUTER_PAYMENTREQUIRED_API_KEY` + `LOCAL_LLAMA_URL` (`127.0.0.1:8089`) in VPS `.env` (runtime-only, uncommitted).

### Handover

- **Repository rename to `code-emin-de`:** GitHub was renamed from `pi-durable-swarm` to `code-emin-de` and the local checkout moved to `/Users/eminmahrt/Developer/code-emin-de`. Updated the Git remote, Kimi MCP absolute path, package metadata, and canonical documentation links. The old GitHub URL redirects for compatibility; the production checkout path and historical benchmark receipts remain unchanged.

- **Verified GitHub + production deployment:** `main` includes **`49a2abc`** (MCP/Harbor feature), **`7cf3b30`** (production dependency fix), and handover documentation, deployed to `code.emin.de` with `PULLED_OK`. Full suite passed **138/138**; bounded live E2E passed **70.34s** and the final suite's live E2E passed **144.76s**. All three services and public/daemon health checks pass. A real deployed MCP `swarm_list` returned **6 orchestrations / 33 workers**. Pre-existing VPS changes remain in two named stash backups; no reset, force-push, or deletion was used.

### Features

- **Production deployment fixes:** moved `jsdom` into production dependencies because `src/markdown.mjs` imports it at runtime; `npm ci --omit=dev` otherwise makes `swarm-ctl pull` fail its WebAuthn/Markdown checks. Corrected `/opt/pi-durable-swarm` ownership to the `swarm` service account and replaced stale GitHub known-host entries only after all three scanned keys matched GitHub's official metadata. Pre-existing VPS changes are preserved in named stash backups.

- **External Terminal-Bench 2.1 + real Emin Swarm Harbor adapter (`bench/harbor-emin/`, `docs/TERMINAL_BENCHMARK_emin-swarm.md`):**
  - Added a Harbor `BaseInstalledAgent` that runs the real `openSwarmDaemon()` in isolated task containers on `178.105.82.203`, with pinned `git archive` source upload, production roster/hooks/supervisor, and Harbor as independent verifier.
  - Hardened the execution path: correct Harbor 0.27 module/task IDs, 1200s setup deadline, secure `0600` model-env file instead of process-argument credentials, original-Lead `done` validation, worker failure/final activity checks, bounded cleanup, and structured failure receipts/transcript previews.
  - **Environment:** official oracle passed **5/5** with mean reward `1.000` and zero exceptions.
  - **Real model receipt:** `write-compressor` returned **reward `0.000`** in both measured attempts (Lead `turn_limit` at 16 turns, then 64 turns/66 tool calls). This is a working adapter with a failing model baseline, not a claimed solve. Full receipts and extended-timeout caveats are in `docs/TERMINAL_BENCHMARK_emin-swarm.md`.

- **Live swarm reliability fixes (`src/daemon.mjs`, `test/swarm.test.mjs`, `test/supervisor.integration.test.mjs`):**
  - Watchers now retain `lastEventAction` separately from latest-poll `lastAction`, so an empty tick cannot overwrite the last real triage decision. Added an offline noisy-then-empty regression and made fallback-triage tests disable network access explicitly.
  - `waitForWorker` now surfaces the underlying provider/model error on terminal failure and includes the latest model error on timeout; failure-only live receipts preserve worker state, supervisor metadata, transcripts, and workspace evidence.
  - Worker shells and the hard test gate clear inherited `NODE_TEST_CONTEXT`, fixing nested `node --test` runs that previously skipped tests and sometimes exited 0 without executing them. A deterministic marker-file regression proves nested tests execute for real.
  - Model streams are bounded to **120s per attempt**, so a provider that stops responding cannot leave a worker pending indefinitely; live worker waits allow the bounded response/failover path to finish instead of expiring anonymously first.
  - **Verified:** isolated bounded-stream live E2E passed in **70.34s**; final full `npm test` passed **138/138**, including live E2E in **144.76s**.

- **Emin Swarm MCP adapter (`src/swarm-mcp.mjs`, `test/swarm-mcp.test.mjs`, user-level `~/.kimi-code/mcp.json`):** Registered under the `emin-swarm` namespace; **Emin Swarm** means the whole system and **Emin Orchestrator** means the General Lead. Added four stdio tools (`swarm_list`, `swarm_read`, `swarm_prompt`, `swarm_steer`) using system SSH and remote `curl` over the existing daemon Unix socket, without another UI, approval layer, public port, or bearer token. Prompts always submit nonblocking for transcript/CoT polling, and requests are serialized per transport to avoid parallel cold smartcard-signing flows. Uses patched direct dependencies `@modelcontextprotocol/sdk@1.32.2` and `zod@4.6.7`.
  - **Verified:** full `npm test` passed **138/138** (including **21** MCP tests); a real official SDK client launched the actual stdio server and exercised list/read/prompt/steer, live worker/transcript CoT, and General target normalization through a fake SSH endpoint. Public `https://code.emin.de/healthz` returns `{"ok":true}`.
  - **Live VPS verification:** the real configured `emin-swarm` stdio server connected through smartcard SSH to `swarm.sock`; `swarm_list` returned **6 orchestrations / 33 workers** with live status, `swarm_read` returned a bounded transcript, and `swarm_prompt` targeted General with deterministic `/status` at **0 LLM calls**. The local Kimi registration loads in a new Kimi Code/Desktop session. No deployment or commit was performed in this turn.

- **Fixed screenshot upload HTTP 502 ('Swarm reloading — syncing reply…'), removed Attach button for drag-and-drop & paste of images + files, made status bar single-line, and archived finished one-shot workers (`ops/Caddyfile`, `src/web.mjs`, `src/chat-images.js`, `test/chat-client.test.mjs`, `test/chat-images.test.mjs`, `test/chat-images-e2e.test.mjs`, `test/ui-theme.test.mjs`):**
  - **Root cause of screenshot upload hang:** `/etc/caddy/Caddyfile` and `ops/Caddyfile` had `request_body { max_size 64KB }`, which caused Caddy to abort any `/api/chat` POST carrying a base64 screenshot (>64KB, e.g. ~4.9MB) with internal HTTP `413` (`requestbody.errorWrapper.Read: http: request body too large`) and return HTTP `502` to the browser (`reverseproxy.statusError`). The client treated HTTP `502` as a daemon reload (`Swarm reloading — syncing reply…`) while the request never reached `swarm-web`. Raised Caddy `max_size` to `25MB` (matching `MAX_BODY_BYTES = 20MB` in `src/web.mjs`), reloaded Caddy live on `swarm-host`, and added explicit HTTP `413` error handling in `src/web.mjs`.
  - **Removed `Attach` button & added drag-and-drop + paste for both images and files:** Removed `#attach-btn` and `#attach-input` from `src/web.mjs`. Enhanced `src/chat-images.js` with page-wide `dragenter`/`dragover`/`dragleave`/`drop` and `paste` handlers that accept both images (`image/png`, `image/jpeg`, `image/webp`, `image/gif`, max 3 × 4MB, normalized via canvas to PNG/JPEG) and text/code/config files (`.md`, `.txt`, `.json`, `.yaml`, `.toml`, `.csv`, `.js`, `.mjs`, `.ts`, `.py`, `.sh`, `.go`, `.rs`, `.sql`, `.html`, `.css`, `.diff`, `.patch`, `.log`, `.svg`, etc., max 5 × 1MB), rendering removable file chips in `#pending-images` and appending fenced file blocks on send.
  - **Single-line `#statusBar` & automatic archiving of finished one-shot workers:** Styled `#statusBar` with `flex-wrap: nowrap; white-space: nowrap; overflow-x: auto` so the model selector, context free %, and worker badge stay on one single line. Added `isActiveWorker(w)` (`isRunning(w) || w.mode === 'recurring'`) so finished one-shot workers (`mode !== 'recurring'` and not running) automatically move into `<details id="archived"><summary>Archived workers (N)</summary><ul id="archive"></ul></details>` and no longer inflate the active worker badge (`0 running / 29 total` -> counts only running + recurring workers).

- **Fixed persistent `prepare image failed error` HTTP 400 in General chat (`src/image-util.mjs`, `src/daemon.mjs`, `src/web.mjs`, `test/images.test.mjs`, `test/chat-images-daemon.test.mjs`):**
  - Root cause: historic entry `6231` (`e2e image probe`) in `conversation_id = 1` stored a 67-byte base64 PNG whose `IDAT` chunk declared length `13` for a 10-byte zlib payload (and lacked valid chunk framing), which passed 8-byte magic sniffing at the time and was replayed to upstream vision models on every turn in `General`, causing `failed to decode image: invalid or unsupported image format` even on plain text prompts.
  - Hardened `verifyPngStructure` and `decodeImage` in `src/image-util.mjs` (and `daemon.chat()`) to walk all PNG chunks (`IHDR`, `IDAT`, `IEND`), verify chunk bounds, and inflate the `IDAT` zlib stream (`inflateSync`) before accepting or persisting any PNG.
  - Added startup `sanitizeCorruptDurableImages(dbPath)` in `openSwarmDaemon` so any legacy corrupt image blocks in `durable.sqlite` `entries` are automatically repaired in-place with a valid 1x1 PNG (`VALID_1X1_PNG_BASE64`).
  - Escaped `\n` inside `renderMinimalChat`'s inline script template literal (`src/web.mjs`) so `node --check` on the inline boot script passes cleanly.

- **Live & Collapsible Chain of Thought (CoT) for Chat and Agents (`src/daemon.mjs`, `src/cli.mjs`, `src/web.mjs`, `test/chat-client.test.mjs`, `test/worker-meta.test.mjs`):**
  - Added `extractAssistantThinking`, `extractAssistantToolCalls`, `summarizeLiveProgress`, and `readLiveConversationSnapshot` in `src/daemon.mjs` to surface both persisted `{ type: 'thinking' }` / `{ type: 'toolCall' }` blocks and live in-flight `LiveDoc` generation reasoning + active tool slots (`live.generation.message` and `live.tools`).
  - Exposed `live` progress and per-entry `thinking` / `toolCalls` on `GET /transcript` (`GET /api/history`) and per-worker `live` / `lastThinking` / `lastToolCalls` on `GET /workers` (`GET /api/workers`).
  - Rendered collapsible Solarized `<details class="cot">` drawers on chat messages (auto-opened while streaming live at 1s busy poll intervals, defaulting to collapsed once completed so the transcript stays clean, and preserving the user's open/closed toggle state across live polls) and `<details class="wcot">` drawers on right-sidebar agent cards.

- **Fixed pinned optimistic chat messages (`src/web.mjs`, `test/chat-client.test.mjs`):** optimistic `.pending` user and assistant bubbles no longer remain permanently pinned at the bottom of `#log` after `/api/chat` settles. Persisted turns mark their optimistic bubbles settled and reconcile immediately with `/api/history` (even if server text normalization differs from raw input or trailing roles vary), while non-transcript turns (`/status`, `/workers`, `/hooks`, `/credits`, `/help`, `/model`, `/btw`, `/reinforce`, or errors) remain visible until the next message or new transcript entry arrives and are then cleanly retired.

- **Removed RareUI completely:** deleted the `About · Credits` link, stylesheet/route, copied component
  markup, and attribution requirement. Replaced it with a local Solarized `Copy / Copied` button;
  orchestration, image, model, and chat behavior is unchanged. Updated UI/Markdown regression tests.

- **Durable multi-orchestration jobs:** named left-sidebar orchestrations now own independent Lead
  conversations, transcripts, and worker rosters. The approved Solarized visual design is unchanged.
- **Persistent one-shot and recurring workers:** create workers from the right sidebar, run them manually,
  or schedule them every 10 seconds–31 days. `swarm.forever_work` survives SQLite/daemon restarts,
  sleeps without model spend, reuses conversation history, supports durable pause/resume, and skips
  overlapping ticks. Caps: 50 named orchestrations, 25 workers/orchestration.
- Added authenticated web + Unix-socket orchestration APIs, private-goal-safe public metadata, model-free
  validation, ownership inheritance for Lead-spawned workers, and `GET /api/history?convId=<id>`.
- Added `test/orchestrations.test.mjs` and browser coverage for session switching, worker scoping,
  scheduling, pause behavior, validation, and real close/reopen persistence. Full suite: **111 passing**.

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
- images (provider compatibility): browser decodes pasted bytes and normalizes WebP/GIF/screenshot inputs to PNG, then JPEG if PNG >4MB; MIME and magic bytes now agree instead of provider `prepare image failed`. Invalid decodes show a local error.
- **chat images (paste/attach)** — images first, no generic files: Ctrl/Cmd+V anywhere (page or
  composer, plain text paste untouched) and an accessible `Attach` button + hidden
  `input[type=file][multiple]` accept `image/png|jpeg|webp|gif`, max 3 × 4 MB. Immediate thumbnails
  with alt filename and a per-image remove button in the composer deck; deck survives failures and
  only clears on a successful send, rejections (type/size/count) report a specific status line.
- server re-validates strictly (`src/image-util.mjs`): data-URL/base64 shape, magic-byte sniff (a
  lying prefix cannot smuggle SVG/HTML), 4 MB decoded + 20 MB body cap, header-derived pixel caps
  (16000 px side / 40 MP, no decompression), content-addressed store under `<dataDir>/images` and
  authenticated, immutable-cache `GET /api/image/:id` (id regex = no traversal, no public URL).
- images travel as real model content blocks (`[{type:"text"},{type:"image",mimeType,data}]` through
  `POST /api/chat` → `POST /chat` → `harness.submit`), so vision providers see the actual bytes;
  history replays ids only (never base64 bloat) and renders via the image endpoint. Models without
  vision reject the turn and the composer shows "the current model may not accept images; switch to
  a vision model" while keeping the attachments.
  Tests: `test/images.test.mjs` (sniff/caps/dimensions/store), `test/chat-images.test.mjs` (paste,
  text passthrough, rejections, remove/clear, history links), `test/chat-images-api.test.mjs`
  (auth, body caps, daemon payload, error surfacing, traversal).
- images (fix): defer loaded client hooks after the inline boot, allowing a fast early send to drop the screenshot while preserving text. Scripts now execute in HTML order at the end of `body`; full-page real-script E2E confirms byte-identical paste and MIME rejection (`test/chat-images-e2e.test.mjs`). A real end-user probe produced a saved PNG and a vision-aware model response.
- UI undo: drop the whole-page Rare UI restyle. `src/chat-theme.css` and its `<link>`/route are
  removed, so the original inline Solarized chat layout is the base again (no rail grid, no
  gradients, no page-wide type/spacing overrides); images, models and sidebar behaviour unchanged.
  Instead one real Rare UI component is **copied**: `CopyButton` from
  `components/CopyButton.tsx` (raw.githubusercontent.com/swamimalode07/rare-ui/main), translated
  1:1 to native attributes/CSS in `src/rare-button.css` (data-slot/data-copied + blur swap,
  reduced-motion guard). License MIT + Commons Clause + Attribution: source URL, copyright and
  license stay in the CSS header, unobtrusive `About · Credits` sidebar link links rareui.com (no chat-bottom banner). Tests:
  `test/ui-theme.test.mjs`, `test/markdown.test.mjs`.

## 2026-11-20

### Lead Model Dropdown in `code.emin.de` Chat
- **Why**: the Lead could only be switched by env restart; open-weights failover existed but was invisible/untunable from the chat. Users now pick `Kimi` on either gateway (or DeepSeek/GLM) directly in the status bar.
- **Allowlist**: `LEAD_MODEL_CHOICES` / `resolveLeadModelChoice()` in `src/models.mjs` — exactly the verified, registry-known, provider-explicit pairs (so the existing `llmgateway → allmodels` failover map still resolves the same model). No arbitrary IDs, no new secrets/OAuth.- **Auth route**: authenticated `POST /api/model` (`src/web.mjs`, passkey session) → Unix-socket `POST /model` (`src/cli.mjs`) → `daemon.setLeadModel()`, which rejects unknown provider/model with `400` and a clear `allowlist` error.
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
