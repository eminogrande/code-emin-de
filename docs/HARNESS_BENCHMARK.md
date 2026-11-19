# Cross-Harness Coding Benchmark — Same Model (`Kimi K3.1 Pro`), 4 Different Harnesses

- **Episode ID:** `ep2-supervisor-chatclient-bugfix` (pre-fix commit `8838f14`)
- **Controlled Variable:** All 4 harnesses run **`Kimi K3.1 Pro`** (`thinking=high`) with the exact `486`-byte `V3_CAVEMAN_ADHD` prompt discipline, `0` external skills, and standardized K3.1 Pro token pricing (`$2.00 / $0.20 cache / $10.00` per 1M tokens).
- **Judge Protocol:** `human-like-retrospective-v2` — blinded labels (`Candidate-A..D`), 3 personas (`correctness`, `readability`, `maintainability`), scored by OpenAI Frontier Judge (`openai/gpt-reserve`).

## Head-to-Head Harness Results (Sorted by Composite Rank)

| Rank | Harness | Model | Pass | Judge Mean (`/100`) | Tool Calls | Total Tokens | Uncached In | Cache Read | Output Tok | Code LOC | Norm. Cost | Wall Time |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| #1 | **pi-durable Swarm Harness (our upgraded Lead+Coder)** (`pi-durable-swarm`) | `k3.1-pro` | **PASS** | **34.67** | 78 | 1,467,678 | 92,534 | 1,362,115 | 13,029 | 82 | $0.5878 | 410.06s |
| #2 | **Pi Coding Agent CLI v1.5.2** (`pi-cli`) | `k3.1-pro` | FAIL | **25.33** | 43 | 582,312 | 65,865 | 511,232 | 5,215 | 8 | $0.2861 | 240.03s |
| #3 | **Kimi Code CLI v2.5.2 (native)** (`kimi-code`) | `kimi-code/k3.1-pro` | FAIL | **8** | 24 | 0 | 0 | 0 | 0 | 3 | $0.0000 | 240.91s |
| #4 | **OpenCode CLI v1.19.3 (--pure)** (`opencode`) | `router-internal/k3.1-pro` | FAIL | **4** | 23 | 589,072 | 62,414 | 523,776 | 2,882 | 2 | $0.2584 | 240.03s |

## Blinded Frontier Judge Rationales (`openai/gpt-reserve`)

### pi-durable Swarm Harness (our upgraded Lead+Coder) — `harness-pi-durable-swarm-k31` (Blinded as `Candidate-D` — Mean: `34.67/100`)
- **`correctness` (`38/100`):** The patch makes tests pass but is not minimal or robust because it adds an unrequested debug test, leaves debug logging, masks all resume errors with catch(() => true), and uses brittle response routing that can conceal real integration failures.
- **`readability` (`38/100`):** Although tests pass, the patch is not clean or minimal because it adds a debug test and logging, uses unnecessary var globals, relies on brittle message-string routing, and swallows resume errors with catch(() => true).
- **`maintainability` (`28/100`):** Although the targeted tests pass, the patch is not maintainable or minimal because it adds a committed debug test and logging, uses brittle message inspection, weakens error handling by swallowing resume failures, and introduces unnecessary var-based timer changes.

### Pi Coding Agent CLI v1.5.2 — `harness-pi-cli-k31` (Blinded as `Candidate-A` — Mean: `25.33/100`)
- **`correctness` (`24/100`):** The patch is small and plausibly addresses specific harness issues, but the required suite still fails one test, so it does not resolve the issue and its correctness remains unproven.
- **`readability` (`28/100`):** The solution is not high quality because the required test suite still fails, and replacing let with var is an unclear, non-idiomatic workaround that does not demonstrate a clean root-cause fix.
- **`maintainability` (`24/100`):** The patch is incomplete because one test still fails, changes let a shared variable declaration mask a likely issue, and modifies integration fixtures without addressing the broader requested root causes.

### Kimi Code CLI v2.5.2 (native) — `harness-kimi-code-k31` (Blinded as `Candidate-B` — Mean: `8/100`)
- **`correctness` (`4/100`):** The patch does not resolve the failures, exceeds the 15 second requirement, adds diagnostic output, and changes let to var without evidence of correctness or necessity.
- **`readability` (`12/100`):** The patch is not minimal or clean: it changes let to var without an evident root-cause fix, adds unconditional debug output, and the verifier still reports two failing tests.
- **`maintainability` (`8/100`):** The patch is superficially minimal but does not fix the two failing tests, introduces an unnecessary var change, and adds noisy debug output, making it low quality and poorly maintainable.

### OpenCode CLI v1.19.3 (--pure) — `harness-opencode-k31` (Blinded as `Candidate-C` — Mean: `4/100`)
- **`correctness` (`5/100`):** The one line change is minimal but unjustified, does not address the reported failures or timing requirement, and weakening let to var may introduce avoidable global mutation risk.
- **`readability` (`5/100`):** The patch changes let to var without addressing the two failing tests, root causes, or stated files, making it non idiomatic, ineffective, and low quality.
- **`maintainability` (`2/100`):** The one-line var change is unexplained and unrelated to the reported failures, while two tests still fail and the suite exceeds the required runtime.

