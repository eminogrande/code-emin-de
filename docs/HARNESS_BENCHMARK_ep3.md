# Cross-Harness Coding Benchmark — Same Model (`Kimi K3.1 Pro`), 4 Different Harnesses

- **Episode ID:** `ep3-async-singleflight-cache` (pre-fix commit `1809247`)
- **Controlled Variable:** All 4 harnesses run **`Kimi K3.1 Pro`** (`thinking=high`) with the exact `486`-byte `V3_CAVEMAN_ADHD` prompt discipline, `0` external skills, and standardized K3.1 Pro token pricing (`$2.00 / $0.20 cache / $10.00` per 1M tokens).
- **Judge Protocol:** `human-like-retrospective-v2` — blinded labels (`Candidate-A..D`), 3 personas (`correctness`, `readability`, `maintainability`), scored by OpenAI Frontier Judge (`openai/gpt-reserve`).

## Head-to-Head Harness Results (Sorted by Composite Rank)

| Rank | Harness | Model | Pass | Judge Mean (`/100`) | Tool Calls | Total Tokens | Uncached In | Cache Read | Output Tok | Code LOC | Norm. Cost | Wall Time |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| #1 | **pi-durable Swarm Harness (our upgraded Lead+Coder)** (`pi-durable-swarm`) | `k3.1-pro` | **PASS** | **95.33** | 14 | 147,618 | 29,150 | 109,568 | 8,900 | 432 | $0.1692 | 292.82s |
| #2 | **OpenCode CLI v1.19.3 (--pure)** (`opencode`) | `router-internal/k3.1-pro` | **PASS** | **91.67** | 24 | 649,596 | 31,761 | 610,304 | 7,531 | 475 | $0.2609 | 369.71s |
| #3 | **Pi Coding Agent CLI v1.5.2 (--no-skills)** (`pi-cli`) | `k3.1-pro` | **PASS** | **87.67** | 6 | 41,884 | 11,491 | 21,248 | 9,145 | 540 | $0.1187 | 390.05s |
| #4 | **Kimi Code CLI v2.5.2 (native)** (`kimi-code`) | `kimi-code/k3.1-pro` | FAIL | **46** | 9 | 148,530 | 11,604 | 130,048 | 6,878 | 121 | $0.1180 | 390.79s |

## Blinded Frontier Judge Rationales (`openai/gpt-reserve`)

### pi-durable Swarm Harness (our upgraded Lead+Coder) — `harness-pi-durable-swarm-k31` (Blinded as `Candidate-D` — Mean: `95.33/100`)
- **`correctness` (`96/100`):** Clean, minimal implementation with strong deterministic coverage of coalescing, abort isolation, retries, SWR, LRU, and eviction, with no evident security or correctness defects in the provided evidence.
- **`readability` (`96/100`):** Clean, idiomatic, focused implementation with strong deterministic coverage; only minor concern is missing validation for invalid options such as negative maxEntries.
- **`maintainability` (`94/100`):** Clear minimal state model, strong deterministic coverage, and careful handling of retries, abort isolation, SWR, and LRU make this highly maintainable, with only minor untested edge risks around invalidation races.

### OpenCode CLI v1.19.3 (--pure) — `harness-opencode-k31` (Blinded as `Candidate-C` — Mean: `91.67/100`)
- **`correctness` (`94/100`):** Strong, focused implementation with deterministic tests covering the specified behaviors, though immediate in-flight eviction after all waiters abort is handled indirectly rather than explicitly.
- **`readability` (`92/100`):** Clean, idiomatic, focused implementation with strong deterministic coverage and correct singleflight, cancellation, retry, SWR, and LRU behavior, though invalidate and clear do not cancel or suppress already running background refreshes.
- **`maintainability` (`89/100`):** Human-like, focused, and well-tested implementation with strong coalescing, abort, retry, SWR, and LRU coverage, though the API lacks input validation and some edge-case lifecycle behavior is implicit rather than clearly structured.

### Pi Coding Agent CLI v1.5.2 (--no-skills) — `harness-pi-cli-k31` (Blinded as `Candidate-A` — Mean: `87.67/100`)
- **`correctness` (`86/100`):** Strong, focused implementation with deterministic coverage, but it has a race where a new caller can join an already-aborted in-flight promise before eviction completes, plus questionable eviction counting during refresh replacement.
- **`readability` (`86/100`):** Clean, idiomatic implementation with strong deterministic coverage, though aborting during retry leaves the underlying sleep unresolved and the coalescing statistics semantics are somewhat unclear.
- **`maintainability` (`91/100`):** Clean, minimal implementation with strong deterministic coverage and sensible concurrency handling, though edge-case semantics around abort reasons and in-flight invalidation remain lightly specified.

### Kimi Code CLI v2.5.2 (native) — `harness-kimi-code-k31` (Blinded as `Candidate-B` — Mean: `46/100`)
- **`correctness` (`38/100`):** The implementation is fairly minimal and addresses many core behaviors, but it omits the explicitly required comprehensive test file, causing the self-test failure, and provides no evidence that edge cases are verified.
- **`readability` (`58/100`):** The implementation is compact and readable, but the required comprehensive test file is missing and the self-test fails, making the submission incomplete despite covering many specified behaviors.
- **`maintainability` (`42/100`):** The implementation is compact and mostly aligned with the core behavior, but it omits the required comprehensive test file and leaves lifecycle edge cases around invalidate, clear, and background refresh insufficiently covered.

