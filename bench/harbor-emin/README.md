# Emin Swarm Harbor installed agent

Minimal Harbor adapter for the real `openSwarmDaemon`, using Harbor 0.27.0's installed-agent API. The adapter is live-verified on Terminal-Bench 2.1. Its model baseline currently fails `write-compressor` with Lead `turn_limit`; this is a working execution path, not a claimed solve. Exact receipts and extended-timeout caveats are in `docs/TERMINAL_BENCHMARK_emin-swarm.md`.

## Files

- `emin_agent.py`: Harbor `BaseInstalledAgent` implementation.
- `driver.mjs`: per-trial daemon runner uploaded into the task container.
- `README.md`: architecture and intended operation.

## Architecture

### Installation

`install()` uses Harbor's `ensure_system_dependencies()` and `exec_as_root()` to:

1. Install the required shell, download, Git, Python 3, tar, and xz packages.
2. Install checksummed official Node.js 22.20.0 binaries under `/opt`, with `node`, `npm`, and `npx` linked into `/usr/local/bin`. Node 22.20.0 satisfies the project's `>=22.19.0` requirement. Linux x86-64 and arm64 on glibc are supported; musl/Alpine and other architectures fail explicitly.
3. Upload a pinned `source.tar` created with `git archive` from the real repository, extract it into `/opt/emin-swarm`, verify the embedded commit marker `77addff168d4201f3c7f3d60d3abbd9167f8d09a`, and run `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`. No GitHub credentials or network clone is needed inside the task container.

`configure()` uploads `driver.mjs` through `environment.upload_file()` and copies it to `/opt/emin-swarm/harbor-driver.mjs`. That location lets Node resolve the pinned daemon and its production dependencies. The harness clone is never placed in the task workspace.

### Trial execution

`run()` uploads the rendered Harbor instruction as an exact UTF-8 file, without adding a newline or interpolating it into a shell command. It then uses `exec_as_agent()` with the task environment's configured working directory (normally `/app`). Thus the daemon's `workspaceDir` is the fresh, verifier-visible task workspace, while durable state and OptMem are created in a fresh `mkdtemp` directory for each driver invocation.

The driver calls only `openSwarmDaemon({ dataDir, workspaceDir })`: production role models and instructions, built-in hooks, retry policy, and supervisor defaults are unchanged. It submits the exact instruction with `daemon.chat(instruction, { wait: false })`, resumes the harness, and polls Lead, pending submissions, live tasks, workers, and worker supervisor state. It requires three continuous seconds of complete quiescence, including supervisor-to-Lead wakeups. The default overall cap is 3600 seconds; setup, polling, timeout, terminal worker, final model-error, and close failures produce a nonzero exit.

`SWARM_SELF_REPO=/nonexistent-harbor` prevents self-deployment. No OptMem mirror or wake context is loaded, no production web server or deployment is started, and no paid judge, task-specific test, or episode verifier is invoked. Harbor's independent verifier remains authoritative.

The driver emits one bounded `EMIN_SWARM_OUTCOME:<json>` receipt with reply preview, worker/supervisor counts, tool calls, token usage, cost, and sanitized errors. Known credentials and bearer/API-key patterns are redacted. The adapter saves this receipt as `emin-swarm-outcome.json` in Harbor's agent logs and populates token/cost fields in `AgentContext`.

## Credentials and optional configuration

The baseline needs `LLMGATEWAY_API_KEY` for the default roster, or `ALLMODELS_API_KEY` for its open-weights failover path. Export at least one in Harbor's host environment, or supply it through Harbor's agent-environment mechanism. The adapter forwards only recognized model settings that are present:

- `LLMGATEWAY_API_KEY`, `ALLMODELS_API_KEY`, `ROUTER_PAYMENTREQUIRED_API_KEY`
- `LOCAL_LLAMA_URL`, `LOCAL_LLAMA_MODEL`, `LOCAL_LLAMA_API_KEY`, `LOCAL_LLAMA_CTX`
- `MODEL_<ROLE>` and `PROVIDER_<ROLE>` for the existing role names

No constructor or `--model` option is required. Optional agent kwargs are `timeout_sec` (default 3600, minimum 60), `setup_timeout_sec` (default 1200, minimum 60), and `lead_max_turns` (default 64, minimum 16). The larger Lead budget is benchmark-specific because the production default of 16 was insufficient for `write-compressor`; it does not change the production daemon. Do not override the source commit for the baseline. Model credentials are shell-escaped into an agent-owned `0600` file inside the task container and sourced before starting Node; they are not passed through `docker compose exec -e`, process arguments, logs, or committed files.

A local-llama failsafe is used only when its existing environment settings are supplied. Its URL must be reachable **from inside each task container**; a host-side `127.0.0.1:8089` listener is not automatically reachable and is not rewritten by this adapter.

## Verified invocation

Run from the repository root on `swarm-host`, with credentials already exported but not echoed. Build the source archive first; it is a generated artifact and intentionally not committed:

```bash
git archive --format=tar --output=bench/harbor-emin/source.tar HEAD
```

Then run:

```bash
PYTHONPATH="$PWD/bench/harbor-emin" /tmp/emin-harbor-venv/bin/harbor run \
  --dataset terminal-bench/terminal-bench-2-1 \
  --agent emin_agent:EminSwarmAgent \
  --n-concurrent 1 \
  --agent-timeout-multiplier 6 \
  --jobs-dir jobs/emin-swarm-tb21
```

Select one task while bringing up the adapter:

```bash
PYTHONPATH="$PWD/bench/harbor-emin" /tmp/emin-harbor-venv/bin/harbor run \
  --dataset terminal-bench/terminal-bench-2-1 \
  --include-task-name 'terminal-bench/write-compressor' \
  --agent emin_agent:EminSwarmAgent \
  --n-concurrent 1 \
  --agent-timeout-multiplier 6 \
  --agent-kwarg timeout_sec=3600
```

Harbor 0.27.0 imports `emin_agent:EminSwarmAgent` as a Python module, so the adapter directory must be on `PYTHONPATH`; a `.py` path is not a valid module. The outer Harbor/task timeout must be at least as generous as the driver's cap. `write-compressor` has a 900-second agent timeout and the example multiplier allows 5400 seconds, so this first smoke is explicitly an extended-timeout run, not a standard-timeout comparable score. The adapter class also raises the complete setup deadline to 1200 seconds.

## Offline validation

```bash
node --check bench/harbor-emin/driver.mjs
python3 -m py_compile bench/harbor-emin/emin_agent.py
```

These checks validate syntax. Live container installation, credential-file injection, model execution, failure receipts, and Harbor verification were also exercised. The real `write-compressor` attempts returned reward `0.000` after Lead `turn_limit`; see the benchmark receipt for exact jobs, costs, and analysis.
