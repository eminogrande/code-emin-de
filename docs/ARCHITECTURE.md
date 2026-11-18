# Architecture, Security & Smartcard Bridge

## 1. System Overview (`code.emin.de` / `178.105.82.203`)

`pi-durable-swarm` runs as a self-hosting, open-weights multi-agent daemon (`@earendil-works/pi-durable@1.5.2`) on Ubuntu 24.04 LTS behind hardware FIDO2/Passkey authentication.

- **Zero bearer tokens:** SSH accepts **only** `sk-ecdsa-sha2-nistp256@openssh.com` (`id_nuri_pcsc_sk_backup`); HTTPS (`code.emin.de`) accepts **only** enrolled hardware Passkeys (`mac-touchid` + `nuri-card-acr39u`).
- **Prompt & Skill Discipline (`486` bytes, `~116` tokens):** Every role (`lead`, `planner`, `coder`, `reviewer`, `support`, `social`, `watcher`, `btw`) enforces the exact 4-line `V3` `CAVEMAN + ADHD MODE` prompt with `enableSkills: false` (`0` skill-leak tokens).
- **Open-Weights Roster (`src/models.mjs`):**
  - `lead` / `social`: `kimi-k3.1-pro`
  - `coder`: `deepseek-v4.1-flash-uncensored` + `deepseek-v4.1-flash-1017`
  - `reviewer` / `planner` / `support` / `watcher`: `glm-5.3` (deep escalation: `deepseek-v4-pro`)
  - `btw` (read-only side-chat): `deepseek-v4.1-flash-1017`
  - System-1 triage (`src/triage.mjs`): `jev-latest` (`/v1/decisions`)

## 2. Why We Built the Local Smartcard Bridge (`ops/mac-smartcard-bridge.py`)

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

## 3. VPS-First Self-Improvement + Append-Only GitHub Backup

- Live repo on VPS: `/opt/pi-durable-swarm` (pushing via single-repo deploy key to `eminogrande/pi-durable-swarm`).
- Deterministic `onYield` hook in `src/daemon.mjs`: whenever `lead` or `coder` leaves modified files in `/opt/pi-durable-swarm`, it automatically runs `sudo /usr/local/bin/swarm-ctl apply`, which:
  1. Runs `node --check` on `src/*.mjs` and `node --test test/webauthn.test.mjs` (feeding errors back to the agent if anything fails).
  2. Blocks secrets (`.env`, `.sqlite`, `.pem`, `.key`, `authorized_keys`).
  3. Commits and pushes to `origin/main` (append-only; force-push blocked by `beforeTool`, rollbacks use `git revert`).
  4. Reloads `swarm-web` immediately and schedules `swarmd` restart cleanly after the HTTP response finishes.
