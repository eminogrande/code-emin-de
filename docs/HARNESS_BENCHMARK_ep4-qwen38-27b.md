# Cross-Harness Coding Benchmark — Same Model (`Kimi K3.1 Pro`), 4 Different Harnesses

- **Episode ID:** `ep4-agents-sidebar-repair` (pre-fix commit `eb803b4`)
- **Controlled Variable:** All 4 harnesses run **`Kimi K3.1 Pro`** (`thinking=high`) with the exact `486`-byte `V3_CAVEMAN_ADHD` prompt discipline, `0` external skills, and standardized K3.1 Pro token pricing (`$2.00 / $0.20 cache / $10.00` per 1M tokens).
- **Judge Protocol:** `human-like-retrospective-v2` — blinded labels (`Candidate-A..D`), 3 personas (`correctness`, `readability`, `maintainability`), scored by OpenAI Frontier Judge (`openai/gpt-reserve`).

## Head-to-Head Harness Results (Sorted by Composite Rank)

| Rank | Harness | Model | Pass | Judge Mean (`/100`) | Tool Calls | Total Tokens | Uncached In | Cache Read | Output Tok | Code LOC | Norm. Cost | Wall Time |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| #1 | **Qwen3.8-27B (24GB-eGPU tier) [pi-cli]** (`pi-cli`) | `qwen/qwen3.8-27b-abliterated` | FAIL | **0** | 6 | 19,441 | 19,135 | 0 | 306 | 0 | $0.0413 | 180.1s |
| #2 | **Qwen3.8-27B (24GB-eGPU tier) [pi-durable-swarm]** (`pi-durable-swarm`) | `qwen/qwen3.8-27b-abliterated` | FAIL | **0** | 11 | 51,701 | 51,165 | 0 | 536 | 0 | $0.1077 | 172.56s |

## Blinded Frontier Judge Rationales (`openai/gpt-reserve`)

### Qwen3.8-27B (24GB-eGPU tier) [pi-cli] — `tier27b-qwen38-pi-cli` (Blinded as `Candidate-B` — Mean: `0/100`)
- **`correctness` (`0/100`):** The empty patch leaves the reported bug unfixed, adds no regression test, and fails the required worker-rendering verification.
- **`readability` (`0/100`):** The empty patch leaves the reported bug unfixed and provides no regression test, while the adversarial check confirms workers are still not rendered.
- **`maintainability` (`0/100`):** The empty patch makes no fix or regression test, and the adversarial verification confirms that workers remain absent from #agents.

### Qwen3.8-27B (24GB-eGPU tier) [pi-durable-swarm] — `tier27b-qwen38-swarm` (Blinded as `Candidate-A` — Mean: `0/100`)
- **`correctness` (`0/100`):** No patch was provided, and the regression check fails because workers are not rendered in #agents.
- **`readability` (`0/100`):** The empty patch leaves the reported bug unfixed and fails the required regression verification.
- **`maintainability` (`0/100`):** No patch was provided, and the regression check shows workers are still not rendered in #agents.

