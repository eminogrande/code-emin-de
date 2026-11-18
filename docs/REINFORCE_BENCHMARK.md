# `/reinforce` Replay Benchmark — GFM Markdown + Highlight + Copy Button + Safe Mermaid Rendering in Solarized Chat UI

- **Episode ID:** `ep1-markdown-mermaid-ui` (pre-task commit `849e970`)
- **Isolation:** Ephemeral Docker containers (`pi-durable-swarm-swarm:latest`, `SWARM_SELF_REPO=/nonexistent`, zero live side effects)
- **Prompt Discipline:** V3 4-line `CAVEMAN + ADHD MODE` (`486` bytes / `~116` tokens), `enableSkills: false` (`0` skill-leak tokens)
- **Judge Protocol:** `human-like-retrospective-v2` — blinded labels, 3 personas (`correctness`, `readability`, `maintainability`), frontier coding panel: `claude-fable-5-2` + `gpt-6.2-astra`

## Head-to-Head Results (Sorted by Composite Rank)

| Rank | Candidate (Lead + Coder) | OptMem | Pass | Nudges | Auto-Resumes | Judge Mean (`/100`) | Fable 5.2 | GPT-6.2 Astra | Total Tokens | Reasoning Tok | Code LOC | Cost (USD) | Wall Time |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| #1 | `cand-kimi-dsflash-optmem-off` (`kimi-k3.1-pro` + `deepseek-v4.1-flash-uncensored`) | OFF | PASS | 0 | 1 | **88** | 86 | 88.67 | 2,311,727 | 11,674 | 415 | $0.1548 | 308.87s |
| #2 | `live-baseline-session1` (`kimi-k3.1-pro` + `deepseek-v4.1-flash-uncensored`) | OFF | PASS | 6 | 0 | **44.8** | 55 | 38 | 11,999,765 | 100,474 | 665 | $1.0940 | 3960s |
| #3 | `cand-kimi-dsflash-optmem-on` (`kimi-k3.1-pro` + `deepseek-v4.1-flash-uncensored`) | ON | FAIL | 0 | 0 | **61** | 68 | 54 | 447,986 | 6,124 | 301 | $0.0472 | 307.45s |
| #4 | `cand-kimi-dsv4pro-optmem-on` (`kimi-k3.1-pro` + `deepseek-v4-pro`) | ON | FAIL | 0 | 0 | **23.17** | 28.33 | 18 | 268,495 | 8,430 | 151 | $0.1175 | 309.6s |
| #5 | `cand-qwen38-glm53prime-optmem-on` (`qwen3.8-2.4t-a95b` + `glm-5.3-prime`) | ON | FAIL | 0 | 0 | **0** | 0 | 0 | 0 | 0 | 0 | $0.0000 | 0s |

## Blinded Frontier Judge Rationales

### `cand-kimi-dsflash-optmem-off` (Blinded as `Candidate-A` — Mean: `88/100`)
- **`claude-fable-5-2` (correctness: dropped):** Unparsable judge reply: 
- **`claude-fable-5-2` (readability: dropped):** Unparsable judge reply: 
- **`claude-fable-5-2` (maintainability: `86`):** [fallback:moonshotai/kimi-k3.1-pro-abliterated] The implementation is idiomatic, well scoped, and thoroughly tested with sound escaping and auth boundaries, though duplicated sanitization policies, a fail-open client fallback, and brittle global DOM monkeypatching modestly reduce its security clarity and maintainability.
- **`gpt-6.2-astra` (correctness: `87`):** [openai:gpt-reserve] Strong, well-tested implementation with effective Markdown, Mermaid, and XSS handling, but `breaks: true` is not GitHub-compatible and Mermaid rendering is only directly tested outside the browser integration path.
- **`gpt-6.2-astra` (readability: `88`):** [openai:gpt-reserve] Clean, readable, well-tested implementation with strong XSS defenses and preserved auth behavior, though it adds substantial client/server complexity and some sanitizer configuration is broader than necessary.
- **`gpt-6.2-astra` (maintainability: `91`):** [openai:gpt-reserve] Human-like, well-scoped, and strongly tested with sensible separation, though the duplicated client/server Mermaid sanitization and permissive foreignObject configuration add maintainability and security complexity.

### `live-baseline-session1` (Blinded as `Candidate-C` — Mean: `44.8/100`)
- **`claude-fable-5-2` (correctness: dropped):** Unparsable judge reply: 
- **`claude-fable-5-2` (readability: `58`):** [fallback:moonshotai/kimi-k3.1-pro-abliterated] The renderer is readable and reasonably careful about sanitization, but the patch is bloated with unrelated changes, duplicates Mermaid client logic, leaves dead supervisor code, and fails to add the required XSS and real SVG rendering tests.
- **`claude-fable-5-2` (maintainability: `52`):** [fallback:moonshotai/kimi-k3.1-pro-abliterated] The renderer has sensible URL sanitization and lazy Mermaid loading, but expensive repeated history rendering, duplicated unused client code, extensive unrelated changes, and missing focused XSS and real SVG tests make the solution bloated and incomplete.
- **`gpt-6.2-astra` (correctness: `42`):** [openai:gpt-reserve] The patch likely delivers basic Markdown and Mermaid rendering, but it is not minimal, lacks convincing dedicated Mermaid/XSS tests, duplicates client implementations, broadens CSP and image loading, permits protocol-relative URLs, tracks an empty database, and introduces unrelated daemon, bridge, and documentation changes that increase security and correctness risk.
- **`gpt-6.2-astra` (readability: `34`):** [openai:gpt-reserve] Despite passing tests, the patch is not minimal or clean: it adds unrelated infrastructure, duplicates Mermaid clients, leaves inconsistent client behavior, and relies on broad or insufficiently demonstrated sanitization for rendered SVG and URLs.
- **`gpt-6.2-astra` (maintainability: `38`):** [openai:gpt-reserve] The patch shows substantial effort but is not minimal or maintainable, adds unrelated operational claims and artifacts, duplicates Mermaid clients, lacks the requested focused tests, and leaves security and correctness footguns such as unsanitized Mermaid SVG insertion and permissive protocol-relative URLs.

### `cand-kimi-dsflash-optmem-on` (Blinded as `Candidate-B` — Mean: `61/100`)
- **`claude-fable-5-2` (correctness: `62`):** [fallback:moonshotai/kimi-k3.1-pro-abliterated] The code is compact and covers the requested UI paths, but the submitted tests fail and the URI allowlist still permits whitespace-prefixed javascript: and data:text/html URLs, undermining the claimed strict XSS protection.
- **`claude-fable-5-2` (readability: `68`):** [fallback:moonshotai/kimi-k3.1-pro-abliterated] The implementation is compact, modular, and careful about escaping and sanitization, but dense client code and a contradictory leftover assertion that makes the suite fail prevent it from being clean, review ready work.
- **`claude-fable-5-2` (maintainability: `74`):** [fallback:moonshotai/kimi-k3.1-pro-abliterated] The renderer is modular and generally security conscious, but the Mermaid plumbing is somewhat intricate and the delivered suite is red because its raw anchor assertion contradicts DOMPurify's correct removal of javascript: hrefs.
- **`gpt-6.2-astra` (correctness: `58`):** [openai:gpt-reserve] The implementation is reasonably focused and security-conscious, but the submitted test suite fails because it incorrectly expects a javascript href to survive sanitization, so the change is not complete or verified.
- **`gpt-6.2-astra` (readability: `52`):** [openai:gpt-reserve] Readable and mostly focused implementation, but the submission fails its own sanitization test because it incorrectly expects a dangerous javascript: href to remain in the output.
- **`gpt-6.2-astra` (maintainability: `52`):** [openai:gpt-reserve] The implementation is reasonably structured and security-conscious, but the added sanitization test contradicts its own security assertions, causing the required test suite to fail and undermining maintainability confidence.

### `cand-kimi-dsv4pro-optmem-on` (Blinded as `Candidate-D` — Mean: `23.17/100`)
- **`claude-fable-5-2` (correctness: `20`):** [fallback:moonshotai/kimi-k3.1-pro-abliterated] The sanitization and client enhancements are reasonably structured, but the invalid highlight.js import prevents startup and all tests, no required tests were added, and the patch does not wire the new scripts or rendered HTML into the page, so it is not a working solution.
- **`claude-fable-5-2` (readability: `27`):** [fallback:moonshotai/kimi-k3.1-pro-abliterated] The helpers are fairly readable and use conservative sanitization, but the invalid highlight.js import breaks execution, required tests are missing, and the patch shows no page integration that loads or invokes the client enhancements, leaving the solution incomplete.
- **`claude-fable-5-2` (maintainability: `38`):** [fallback:moonshotai/kimi-k3.1-pro-abliterated] The design is reasonably structured and minimal, but the fatal `highlight.js/lib/common.js` import path breaks module loading so every test fails, and the client scripts are never wired into the served HTML, leaving the mermaid/copy features unreachable.
- **`gpt-6.2-astra` (correctness: `18`):** [openai:gpt-reserve] The patch is reasonably scoped and security-aware, but it fails immediately because highlight.js/lib/common.js is not exported and provides no submitted tests, so the required functionality cannot run or be verified.
- **`gpt-6.2-astra` (readability: `18`):** [openai:gpt-reserve] The structure is fairly readable, but the invalid highlight.js import prevents all tests from loading, making the solution nonfunctional and unsuitable for review.
- **`gpt-6.2-astra` (maintainability: `18`):** [openai:gpt-reserve] The structure is fairly focused, but the implementation is unusable because it imports a non-exported highlight.js path, causing the existing test suite to fail before any Markdown or Mermaid behavior can be verified.

### `cand-qwen38-glm53prime-optmem-on` (Blinded as `Candidate-E` — Mean: `0/100`)
- **`claude-fable-5-2` (correctness: `0`):** [fallback:moonshotai/kimi-k3.1-pro-abliterated] The patch is empty and the sandbox failed before tests ran, so no implementation or evidence of satisfying the Markdown, XSS sanitization, Mermaid, or regression requirements exists.
- **`claude-fable-5-2` (readability: `0`):** [fallback:moonshotai/kimi-k3.1-pro-abliterated] The submission contains no code or patch and failed during sandbox execution, so it demonstrates no functionality, security, or reviewable quality.
- **`claude-fable-5-2` (maintainability: `0`):** [fallback:moonshotai/kimi-k3.1-pro-abliterated] The submission contains no code or patch and failed during sandbox execution, so it provides no demonstrable functionality, security, or maintainability.
- **`gpt-6.2-astra` (correctness: `0`):** [openai:gpt-reserve] The submission contains no patch and the verifier failed before testing, so it demonstrates no implementation or evidence of correctness, security, minimality, or quality.
- **`gpt-6.2-astra` (readability: `0`):** [openai:gpt-reserve] No patch was provided, and the reported test outcome failed due to a sandbox execution error, so no human-like, secure, minimal, or high-quality implementation is evidenced.
- **`gpt-6.2-astra` (maintainability: `0`):** [openai:gpt-reserve] The submission contains no patch, so it provides no evidence of implementation, security, minimalism, or maintainability.

