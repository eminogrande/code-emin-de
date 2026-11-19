# Local Self-Hosted Coding Benchmark — `LFM3-1.7B-Q4_K_M` BASE vs HF `pi` LoRA

- **Episode ID:** `ep4-agents-sidebar-repair` (pre-fix commit `eb803b4`)
- **Controlled Variable:** Local `llama-server` (`LFM3-1.7B-Q4_K_M`, `$0` inference) with and without HF `harness-hub` `pi` LoRA adapter across `pi-cli` and `pi-durable-swarm`, exact `486`-byte `V3_CAVEMAN_ADHD` prompt, `0` external skills.
- **Judge Protocol:** `human-like-retrospective-v2` — blinded labels (`Candidate-A..D`), 3 personas (`correctness`, `readability`, `maintainability`), scored by OpenAI Frontier Judge (`openai/gpt-reserve`).

## Head-to-Head Harness Results (Sorted by Composite Rank)

| Rank | Harness | Model | Pass | Judge Mean (`/100`) | Tool Calls | Total Tokens | Uncached In | Cache Read | Output Tok | Code LOC | Norm. Cost | Wall Time |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| #1 | **LFM3-1.7B-Q4_K_M BASE [pi-durable-swarm] (17.3 tok/s)** (`pi-durable-swarm`) | `lfm3-1-7b-q4-k-m-base` | FAIL | **-** | 2 | 5,360 | 2,874 | 2,236 | 250 | 0 | $0.0000 | 173.29s |
| #2 | **LFM3-1.7B-Q4_K_M BASE [pi-cli] (17.3 tok/s)** (`pi-cli`) | `lfm3-1-7b-q4-k-m-base` | FAIL | **-** | 6 | 45,476 | 20,806 | 23,381 | 1,289 | 0 | $0.0000 | 180.26s |
| #3 | **LFM3-1.7B-Q4_K_M +HF-pi-LoRA [pi-cli] (13.2 tok/s)** (`pi-cli`) | `lfm3-1-7b-q4-k-m-pi-lora` | FAIL | **-** | 4 | 5,391 | 3,679 | 1,401 | 311 | 0 | $0.0000 | 213.86s |
| #4 | **LFM3-1.7B-Q4_K_M +HF-pi-LoRA [pi-durable-swarm] (13.2 tok/s)** (`pi-durable-swarm`) | `lfm3-1-7b-q4-k-m-pi-lora` | FAIL | **-** | 0 | 0 | 0 | 0 | 0 | 0 | $0.0000 | 403.84s |

## Blinded Frontier Judge Rationales (`openai/gpt-reserve`)

### LFM3-1.7B-Q4_K_M BASE [pi-durable-swarm] (17.3 tok/s) — `local-lfm3-1-7b-q4-k-m-base-pi-durable-swarm` (Blinded as `Candidate-D` — Mean: `-/100`)
- **`correctness` (dropped):** codex exit -1
- **`readability` (dropped):** codex exit -1
- **`maintainability` (dropped):** codex exit -1

### LFM3-1.7B-Q4_K_M BASE [pi-cli] (17.3 tok/s) — `local-lfm3-1-7b-q4-k-m-base-pi-cli` (Blinded as `Candidate-A` — Mean: `-/100`)
- **`correctness` (dropped):** codex exit -1
- **`readability` (dropped):** codex exit -1
- **`maintainability` (dropped):** codex exit -1

### LFM3-1.7B-Q4_K_M +HF-pi-LoRA [pi-cli] (13.2 tok/s) — `local-lfm3-1-7b-q4-k-m-pi-lora-pi-cli` (Blinded as `Candidate-C` — Mean: `-/100`)
- **`correctness` (dropped):** codex exit -1
- **`readability` (dropped):** codex exit -1
- **`maintainability` (dropped):** codex exit -1

### LFM3-1.7B-Q4_K_M +HF-pi-LoRA [pi-durable-swarm] (13.2 tok/s) — `local-lfm3-1-7b-q4-k-m-pi-lora-pi-durable-swarm` (Blinded as `Candidate-B` — Mean: `-/100`)
- **`correctness` (dropped):** codex exit -1
- **`readability` (dropped):** codex exit -1
- **`maintainability` (dropped):** codex exit -1

