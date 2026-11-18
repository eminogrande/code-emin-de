import assert from "node:assert/strict";
import test from "node:test";
import {
  createSupervisor,
  decideRecovery,
  failureKey,
  resumeNotice,
  summarizeTranscript,
  SUPERVISOR_DEFAULTS,
} from "../src/supervisor.mjs";

/** Fake harness: workers + live state in memory, no network, no timers. */
function fakeWorld({ workers, liveByConv, transcriptByConv = {} }) {
  const state = structuredClone(workers);
  const live = structuredClone(liveByConv);
  const lead = [];
  const resumes = [];
  const clock = { t: 10_000 };
  const sup = createSupervisor({
    workers: async () => state,
    live: async (convId) => live[convId],
    patch: async (workerId, mutate) => mutate(state[workerId]),
    transcript: async (convId) => transcriptByConv[convId] || [],
    resumeWorker: async (worker, info) => {
      resumes.push({ workerId: worker.workerId, ...info });
      live[worker.convId] = { run: { turns: 1 } }; // resume starts a run
    },
    notifyLead: async (topic, body) => lead.push({ topic, body }),
    now: () => clock.t,
    setTimer: () => 0,
    clearTimer: () => {},
  });
  return { sup, state, live, lead, resumes, clock };
}

const worker = (over = {}) => ({
  workerId: "w-1",
  role: "coder",
  convId: 7,
  goal: "Build slugify + tests",
  supervisor: { status: "supervising", autoResumes: 0, nextAt: 0 },
  ...over,
});

test("1. turn_limit resumes with same goal + failure detail, context preserved (no fresh prompt)", async () => {
  const w = fakeWorld({
    workers: { "w-1": worker() },
    liveByConv: { 7: { runFailure: { reason: "turn_limit", detail: "40 turns" } } },
    transcriptByConv: { 7: [{ role: "assistant", text: "Verified: PASS (node --test)" }] },
  });
  await w.sup.tick(); // start notice arms the backoff
  assert.equal(w.resumes.length, 0);
  w.clock.t += 2_000;
  await w.sup.tick();
  assert.equal(w.resumes.length, 1);
  assert.match(w.resumes[0].notice, /SAME goal/);
  assert.match(w.resumes[0].notice, /40 turns/);
  assert.match(w.resumes[0].notice, /Build slugify \+ tests/);
  assert.equal(w.state["w-1"].supervisor.autoResumes, 1);
  assert.equal(w.state["w-1"].supervisor.lastFailure.reason, "turn_limit");
  // start + resume notifications only, no duplicate start
  assert.deepEqual(w.lead.map((l) => l.topic), ["SUPERVISOR_START", "SUPERVISOR_RESUME"]);
  assert.match(w.lead[0].body, /Build slugify \+ tests/);
});

test("2. bounded: stops after maxAutoResumes and notifies exhaustion once", async () => {
  const w = fakeWorld({
    workers: { "w-1": worker({ supervisor: { status: "supervising", autoResumes: 3, nextAt: 0, startedAnnounced: true } }) },
    liveByConv: { 7: { runFailure: { reason: "turn_limit", detail: "40 turns" } } },
  });
  await w.sup.tick();
  w.clock.t += 5_000;
  await w.sup.tick();
  assert.equal(w.resumes.length, 0);
  assert.equal(w.state["w-1"].supervisor.status, "exhausted");
  assert.equal(w.lead.filter((l) => l.topic === "SUPERVISOR_EXHAUSTED").length, 1);
  assert.equal(SUPERVISOR_DEFAULTS.maxAutoResumes, 3);
});

test("3. auth/billing/policy (model_error, no_model) never retried", async () => {
  for (const reason of ["model_error", "no_model"]) {
    const w = fakeWorld({
      workers: { "w-1": worker({ supervisor: { status: "supervising", autoResumes: 0, nextAt: 0, startedAnnounced: true } }) },
      liveByConv: { 7: { runFailure: { reason, detail: "401 invalid api key / billing" } } },
    });
    await w.sup.tick();
    w.clock.t += 5_000;
    await w.sup.tick();
    assert.equal(w.resumes.length, 0, reason);
    assert.equal(w.state["w-1"].supervisor.status, "terminal");
    assert.equal(w.lead.filter((l) => l.topic === "SUPERVISOR_FAILED").length, 1);
  }
});

test("4. backoff waits before resuming", () => {
  const base = { worker: worker({ supervisor: { status: "supervising", autoResumes: 0, nextAt: 5_000 } }), live: { runFailure: { reason: "turn_limit" } }, now: 1_000 };
  assert.equal(decideRecovery(base).action, "wait");
  assert.equal(decideRecovery({ ...base, now: 6_000 }).action, "resume");
});

test("5. no duplicate resume while running, none before first run, none when settled", () => {
  const running = decideRecovery({ worker: worker(), live: { run: { turns: 2 }, runFailure: { reason: "turn_limit" } }, now: 1 });
  assert.equal(running.action, "none");
  assert.equal(running.reason, "running");

  const notStarted = decideRecovery({ worker: worker(), live: {}, now: 1 });
  assert.equal(notStarted.reason, "not_started");

  const done = decideRecovery({ worker: worker({ supervisor: { status: "done" } }), live: {}, now: 1 });
  assert.equal(done.reason, "settled");
});

test("6. completed worker notifies lead once with commit/tests, never twice", async () => {
  const w = fakeWorld({
    workers: { "w-1": worker({ supervisor: { status: "supervising", autoResumes: 1, nextAt: 0, startedAnnounced: true, seenRun: true } }) },
    liveByConv: { 7: {} },
    transcriptByConv: {
      7: [
        { role: "toolResult", text: "abc1234 feat: thing" },
        { role: "toolResult", text: "ok 12 - all tests passed" },
        { role: "assistant", text: "Verified: PASS (node --test)" },
      ],
    },
  });
  await w.sup.tick();
  await w.sup.tick();
  const done = w.lead.filter((l) => l.topic === "WORKER_DONE");
  assert.equal(done.length, 1);
  assert.match(done[0].body, /commit: abc1234/);
  assert.match(done[0].body, /tests: /);
  assert.equal(w.state["w-1"].supervisor.status, "done");
});

test("7. final failure message carries errors; summary + failureKey helpers", async () => {
  const w = fakeWorld({
    workers: { "w-1": worker({ supervisor: { status: "supervising", autoResumes: 0, nextAt: 0, startedAnnounced: true } }) },
    liveByConv: { 7: { runFailure: { reason: "faulted", detail: "boom" } } },
    transcriptByConv: { 7: [{ role: "toolResult", text: "Error: ENOENT missing file" }] },
  });
  await w.sup.tick();
  const failed = w.lead.find((l) => l.topic === "SUPERVISOR_FAILED");
  assert.match(failed.body, /errors: Error: ENOENT/);
  assert.match(failed.body, /not retried/);

  const s = summarizeTranscript([{ text: "deadbeef1 chore: x\nok 3 - a\nError: bad" }]);
  assert.equal(s.commit, "deadbeef1 chore: x");
  assert.deepEqual(s.tests, ["ok 3 - a"]);
  assert.deepEqual(s.errors, ["Error: bad"]);
  assert.equal(failureKey({ reason: "turn_limit", detail: "40 turns" }), "turn_limit|40 turns");
  assert.match(resumeNotice({ goal: "g" }, { detail: "d" }, 2), /AUTO-RESUME 2\/3/);
});
