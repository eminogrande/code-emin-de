# Cross-Harness Coding Benchmark — Same Model (`Kimi K3.1 Pro`), 4 Different Harnesses

- **Episode ID:** `ep4-agents-sidebar-repair` (pre-fix commit `eb803b4`)
- **Controlled Variable:** All 4 harnesses run **`Kimi K3.1 Pro`** (`thinking=high`) with the exact `486`-byte `V3_CAVEMAN_ADHD` prompt discipline, `0` external skills, and standardized K3.1 Pro token pricing (`$2.00 / $0.20 cache / $10.00` per 1M tokens).
- **Judge Protocol:** `human-like-retrospective-v2` — blinded labels (`Candidate-A..D`), 3 personas (`correctness`, `readability`, `maintainability`), scored by OpenAI Frontier Judge (`openai/gpt-reserve`).

## Head-to-Head Harness Results (Sorted by Composite Rank)

| Rank | Harness | Model | Pass | Judge Mean (`/100`) | Tool Calls | Total Tokens | Uncached In | Cache Read | Output Tok | Code LOC | Norm. Cost | Wall Time |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| #1 | **pi-durable Swarm Harness (our upgraded Lead+Coder)** (`pi-durable-swarm`) | `k3.1-pro` | FAIL | **70.67** | 9 | 33,451 | 10,380 | 20,992 | 2,079 | 16 | $0.0457 | 173.14s |
| #2 | **Pi Coding Agent CLI v1.5.2** (`pi-cli`) | `k3.1-pro` | FAIL | **61.67** | 8 | 26,151 | 6,673 | 18,176 | 1,302 | 16 | $0.0300 | 180.03s |

## Blinded Frontier Judge Rationales (`openai/gpt-reserve`)

### pi-durable Swarm Harness (our upgraded Lead+Coder) — `harness-pi-durable-swarm-k31` (Blinded as `Candidate-B` — Mean: `70.67/100`)
- **`correctness` (`68/100`):** The minimal source fix and focused regression test address the reported rendering bug, but the required test command fails and times out, so the solution is not fully validated or high quality.
- **`readability` (`76/100`):** The fix is minimal, readable, and directly addresses the blank sidebar with a focused regression test, but the required test command failed and timed out, so the submission is not fully validated.
- **`maintainability` (`68/100`):** The minimal source fix appears correct and the regression test covers the reported behavior, but the required test command fails and times out, so the submission is not fully validated or high quality.

### Pi Coding Agent CLI v1.5.2 — `harness-pi-cli-k31` (Blinded as `Candidate-A` — Mean: `61.67/100`)
- **`correctness` (`45/100`):** The fix is minimal and plausibly addresses the missing append, but the required test does not pass cleanly or terminate, making the submission incomplete despite the adversarial render result.
- **`readability` (`72/100`):** The fix and regression test are minimal and readable, but the required test run failed and timed out, so the solution is not fully validated.
- **`maintainability` (`68/100`):** The root-cause fix and focused regression test are minimal and maintainable, but the reported test run failed and timed out, so the required verification was not achieved.

