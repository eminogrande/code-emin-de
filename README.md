# pi-durable Open-Weights Swarm Daemon

Headless multi-agent coding, review, memory, and forever-agent daemon on `@earendil-works/pi-durable@1.5.2` + `@earendil-works/pi-coding-agent@1.5.2`.

## Security Invariants

- **Zero bearer tokens (`0` HTTP TCP ports exposed):** Daemon listens only on `0600` Unix domain socket (`/home/agent/.pi-durable/swarm.sock`), reachable solely over smartcard/FIDO2 SSH (`sk-ecdsa-sha2-nistp256@openssh.com` / `sk-ssh-ed25519@openssh.com`).
- **Deterministic `beforeTool` + `onYield` gates:** Blocks destructive shell commands, blocks file writes from read-only roles (`btw`, `reviewer`, `planner`), blocks outbound sends from draft-only roles (`support`, `social`), and requires `Verified: PASS` before coder completion.
- **No 6.7k skill leak:** `enableSkills: false` + `pi --no-skills` + `V3` Caveman+ADHD 116-token anchor.

## Proven Open-Weights Role Roster

- **Lead Orchestrator:** `kimi-k3.1-pro` (8s non-blocking parallel fan-out)
- **Coding Worker:** `deepseek-v4.1-flash-uncensored` / `deepseek-v4.1-flash-1017`
- **Security Reviewer:** `glm-5.3` + `deepseek-v4-pro`
- **System-1 Triage / Router:** `jev-latest` (`/v1/decisions`, `$0.000018`/call) with deterministic offline fallback
- **Permanent Memory:** `OptMem` (`src/memo` + `src/optmem.mjs` auto-`nap` drain; Lead-only writes)
- **Cross-Agent Bus:** Zero-dep `node:sqlite` `openAgentBus` (`src/bus.mjs`) + full sibling transcript reader (`read_sibling`)

## Local / VPS Run (ARM64 & AMD64)

```sh
cp .env.example .env              # add LLMGATEWAY_API_KEY (chmod 600)
./scripts/init.sh                 # loads smartcard SSH public keys into .ssh/authorized_keys
docker compose up -d --build
./test/smoke.sh
npm test                          # runs 5/5 unit + live swarm integration tests
```

## SSH Commands

```sh
ssh -p 2222 agent@127.0.0.1 'swarm'                                   # interactive REPL
ssh -p 2222 agent@127.0.0.1 'swarm status'                            # workers, drafts, cron, token spend
ssh -p 2222 agent@127.0.0.1 'swarm ask "/btw list pending drafts"'    # read-only side-chat while swarm works
ssh -p 2222 agent@127.0.0.1 'swarm steer w-auth "use timingSafeEqual"'# live mid-turn steer
```
