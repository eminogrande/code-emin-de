# Emin Swarm on Terminal-Bench 2.1 — Initial VPS Receipt

- **Runner:** Harbor `0.27.0` on `178.105.82.203`
- **Measured agent:** real `openSwarmDaemon()` with production roster, instructions, hooks, and supervisor
- **Baseline source:** `77addff168d4201f3c7f3d60d3abbd9167f8d09a` plus the separately reviewed `bench/harbor-emin/` adapter
- **Isolation:** fresh durable data and `/app` workspace per trial, `SWARM_SELF_REPO=/nonexistent-harbor`, no production deployment or OptMem mirror
- **Verifier:** Harbor, independently of the driver’s infrastructure outcome

## Environment Baseline

The official five-task oracle passed **5/5 trials with mean reward `1.000` and zero exceptions**, in `5m 2s`.

Receipt: `/tmp/emin-harbor-runs/jobs/2026-11-22__12-43-05/result.json` on the VPS.

## Real Emin Swarm Attempts

| Attempt | Lead budget | Harbor reward | Driver outcome | Tool calls | Tokens | Cost | Driver time |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| `2026-11-22__16-50-19` | 16 | **0.000** | `turn_limit` | 17 | 113,698 | $0.1459 | 124.24s |
| `2026-11-22__16-57-11` | 64 | **0.000** | `turn_limit` | 66 | 1,626,004 | $0.60219 | 393.98s |

Both attempts used `terminal-bench/write-compressor`: create `data.comp` of at most 2500 bytes that `/app/decomp` expands exactly to `data.txt`.

The second attempt produced a candidate file, but it still did not decompress byte-for-byte at the final check. Its Lead continued compression experiments until the larger turn budget was exhausted. **Neither attempt is a solve, and no standard-timeout or leaderboard-comparable result is claimed.** Both were extended-timeout compatibility runs.

Receipts:

- `jobs/2026-11-22__16-50-19/result.json` and `write-compressor__kLzz3JN/agent/emin-swarm-outcome.json`
- `jobs/2026-11-22__16-57-11/result.json` and `write-compressor__WVHJUBM/agent/emin-swarm-outcome.json`

## Adapter Corrections Made Before the Runs

- Corrected Harbor 0.27 module import to `emin_agent:EminSwarmAgent` on `PYTHONPATH`.
- Corrected task selection to the fully qualified `terminal-bench/write-compressor` ID.
- Replaced private GitHub cloning inside the task container with a pinned `git archive` upload, removing the need for repository credentials.
- Raised the complete setup deadline to 1200 seconds.
- Preserved structured failure receipts before raising nonzero driver exits.
- Required the original Lead submission to finish as `done`; failed Lead/worker runs cannot be mistaken for successful quiescence.
- Included final worker failures and active-work checks, bounded daemon cleanup, and failure transcript previews.
- Moved model credentials out of process arguments into an agent-owned `0600` environment file sourced inside the isolated container.

## Interpretation

The adapter now provides a genuine real-VPS, real-harness execution path. The initial result is a **working adapter with a failing model baseline**, not a passing benchmark. The task exposed both the small default Lead turn budget and the cost of unbounded iterative algorithm exploration. The next smoke should use a shorter deterministic task before any further model or prompt changes. Lead continuation/planning changes should be adopted only if a measured comparison shows benefit.
