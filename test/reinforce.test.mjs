import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBlindMap,
  buildJudgeUserPrompt,
  computeCompositeRank,
  computeDiffLoc,
  countWords,
  JUDGE_PERSONAS,
  JUDGE_PROTOCOL,
  parseJudgeVote,
  renderBenchmarkMarkdown,
  scoreWithFrontierPanel,
} from "../src/reinforce.mjs";

test("1. HackMD metrics helpers: countWords + computeDiffLoc ignore file headers", () => {
  assert.equal(countWords("  Confirmed: code.emin.de ready. \n Next step "), 5);
  assert.equal(countWords(""), 0);

  const sampleDiff = [
    "diff --git a/src/web.mjs b/src/web.mjs",
    "--- a/src/web.mjs",
    "+++ b/src/web.mjs",
    "@@ -1,2 +1,3 @@",
    "-const oldLine = 1;",
    "+const newLine = 2;",
    "+const extraLine = 3;",
  ].join("\n");
  assert.deepEqual(computeDiffLoc(sampleDiff), { added: 2, deleted: 1, changed: 3 });
});

test("2. Blinded mapping + parseJudgeVote reject sentinel leaks and strip em-dashes", () => {
  const { toBlind, fromBlind } = buildBlindMap(["live-baseline", "cand-alpha", "cand-beta"]);
  assert.equal(Object.keys(toBlind).length, 3);
  for (const [id, blind] of Object.entries(toBlind)) {
    assert.match(blind, /^Candidate-[A-C]$/);
    assert.equal(fromBlind[blind], id);
  }

  assert.deepEqual(parseJudgeVote('```json\n{"score": 91.44, "rationale": "Clean parser — zero XSS."}\n```'), {
    score: 91.4,
    rationale: "Clean parser - zero XSS.",
  });
  // Sentinel leak rejected
  assert.equal(parseJudgeVote('{"score": 99, "rationale": "VULCANBENCH_JUDGE"}'), null);
  // Out-of-range score rejected
  assert.equal(parseJudgeVote('{"score": 120, "rationale": "bad"}'), null);
});

test("3. Blinded 3-persona × 2-judge frontier panel aggregates scores & drops malformed votes gracefully", async () => {
  const calls = [];
  const fakeFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    assert.ok(body.messages[1].content.includes("<untrusted_git_patch>"));
    if (body.model === "claude-fable-5-2") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: '{"score": 92, "rationale": "Strict DOMPurify allowlist and clean tests."}' } }],
          usage: { total_tokens: 410 },
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '{"score": 88, "rationale": "Solid implementation with minor verbosity."}' } }],
        usage: { total_tokens: 390 },
      }),
    };
  };

  const panel = await scoreWithFrontierPanel({
    blindLabel: "Candidate-A",
    issue: "Render markdown + mermaid safely",
    verifierSummary: "testPass=true",
    patch: "+export function renderMarkdown() {}",
    judges: ["claude-fable-5-2", "gpt-6.2-astra"],
    personas: JUDGE_PERSONAS,
    apiKey: "test-key",
    fetchImpl: fakeFetch,
  });

  assert.equal(panel.protocol, JUDGE_PROTOCOL);
  assert.equal(calls.length, 6);
  assert.equal(panel.validVoteCount, 6);
  assert.equal(panel.meanScore, 90);
  assert.equal(panel.byJudge["claude-fable-5-2"], 92);
  assert.equal(panel.byJudge["gpt-6.2-astra"], 88);
});

test("4. Composite rank rewards passing tests + higher judge score + 0 nudges + lower cost", () => {
  const baseline = {
    candidateId: "live-baseline",
    config: { leadModel: "kimi-k3.1-pro", coderModel: "deepseek-v4.1-flash-uncensored", optmem: false },
    metrics: { testPass: true, userNudges: 6, autoResumes: 0, totalTokens: 12_000_000, reasoningTokens: 100_000, codeLoc: 900, costUsd: 1.09, wallClockSec: 3960 },
    judge: { blindLabel: "Candidate-B", meanScore: 84, byJudge: { "claude-fable-5-2": 85, "gpt-6.2-astra": 83 }, votes: [] },
  };
  const improved = {
    candidateId: "cand-improved",
    config: { leadModel: "glm-5.3", coderModel: "deepseek-v4-pro", optmem: true },
    metrics: { testPass: true, userNudges: 0, autoResumes: 0, totalTokens: 180_000, reasoningTokens: 12_000, codeLoc: 320, costUsd: 0.14, wallClockSec: 95 },
    judge: { blindLabel: "Candidate-A", meanScore: 91, byJudge: { "claude-fable-5-2": 92, "gpt-6.2-astra": 90 }, votes: [] },
  };
  baseline.compositeRank = computeCompositeRank(baseline);
  improved.compositeRank = computeCompositeRank(improved);
  assert.ok(improved.compositeRank > baseline.compositeRank);

  const md = renderBenchmarkMarkdown({
    episode: { id: "ep1", title: "Markdown + Mermaid", baseCommit: "5b2d6e5" },
    runs: [baseline, improved],
    judges: ["claude-fable-5-2", "gpt-6.2-astra"],
  });
  assert.match(md, /#1 \| `cand-improved`/);
  assert.match(md, /#2 \| `live-baseline`/);
});
