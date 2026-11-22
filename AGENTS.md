# Repository Working Standards (`code-emin-de`)

Follow these mandatory rules on every turn that modifies code, configuration, infrastructure, or docs in this repository:

1. **Per-Turn Changelog (File + Response)**:
   - Update `CHANGELOG.md` with every meaningful change made in the turn (grouped by date, reverse chronological).
   - Always include a concise **`### Changelog`** section in every final turn response summarizing what changed, commit hash(es), and verification receipts.
2. **Always Keep `README.md` Synced on GitHub**:
   - Whenever behavior, architecture, commands, models, hooks, benchmarks, or ops change, update `README.md` (and `docs/ARCHITECTURE.md` if architectural) in the same commit/push so GitHub `main` always explains **WHY** we do **WHAT**.
   - Never leave `README.md` stale behind code changes.
3. **Verify Before Claiming**:
   - Run the offline test suite (`npm test` / `node --test ...`) before pushing, and verify live on VPS `178.105.82.203` after deploying.
4. **Preserve Core Invariants**:
   - Keep `config/APPEND_SYSTEM.md` exact (`486` bytes V3 `CAVEMAN + ADHD MODE`).
   - Never commit secrets, bearer tokens, or `.env` files.
   - Open-weights models only; Tier-3 `local-llama` (`127.0.0.1:8089`) stays active as zero-silent-shutdown failsafe.
