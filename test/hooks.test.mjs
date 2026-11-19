import assert from "node:assert/strict";
import test from "node:test";
import { createBuiltinGuardHooks, HookRegistry, validateHookManifest } from "../src/hooks.mjs";

test("1. validateHookManifest enforces strict id, description, priority, and lifecycle handlers", () => {
  assert.throws(() => validateHookManifest(null), /must be an object/);
  assert.throws(() => validateHookManifest({ id: "bad id!", description: "x", beforeTool() {} }), /Invalid hook id/);
  assert.throws(() => validateHookManifest({ id: "ok-id", description: "", beforeTool() {} }), /non-empty description/);
  assert.throws(() => validateHookManifest({ id: "ok-id", description: "missing handlers" }), /at least one lifecycle/);
  assert.throws(
    () => validateHookManifest({ id: "ok-id", description: "unknown event", events: ["bogus"], beforeTool() {} }),
    /unknown event/,
  );

  const m = validateHookManifest({
    id: "custom.guard-1",
    description: "Custom guard",
    priority: 15,
    beforeTool() {},
  });
  assert.equal(m.id, "custom.guard-1");
  assert.equal(m.priority, 15);
  assert.equal(m.enabled, true);
  assert.deepEqual(m.events, ["beforeTool"]);
});

test("2. Built-in guardrails enforce read-only, OptMem single-writer, destructive bash, deploy, and draft-only invariants", async () => {
  const reg = new HookRegistry(createBuiltinGuardHooks());

  // Read-only roles cannot write/edit; /btw cannot bash
  const ro = await reg.runBeforeTool({ name: "write", arguments: { path: "a.js" } }, { meta: { role: "reviewer" } });
  assert.match(ro?.block || "", /strictly read-only/);
  assert.equal(ro?.blockedBy, "readonly-role-guard");

  const btwBash = await reg.runBeforeTool({ name: "bash", arguments: { command: "ls" } }, { meta: { role: "btw" } });
  assert.match(btwBash?.block || "", /Side-chat/);
  assert.equal(btwBash?.blockedBy, "readonly-role-guard");

  // Subagent cannot write OptMem
  const opt = await reg.runBeforeTool({ name: "memory_note", arguments: { text: "hi" } }, { meta: { role: "coder" } });
  assert.match(opt?.block || "", /OptMem invariant/);
  assert.equal(opt?.blockedBy, "optmem-lead-only-guard");

  // Lead CAN write OptMem
  const leadOpt = await reg.runBeforeTool({ name: "memory_note", arguments: { text: "hi" } }, { meta: { role: "lead" } });
  assert.equal(leadOpt, undefined);

  // Destructive bash blocked even for Lead (including rm -rf / and rm -fr /)
  const rmRoot = await reg.runBeforeTool(
    { name: "bash", arguments: { command: "rm -rf / && echo oops" } },
    { meta: { role: "lead" } },
  );
  assert.match(rmRoot?.block || "", /Blocked destructive command/);
  assert.equal(rmRoot?.blockedBy, "destructive-bash-guard");

  const rmRootBare = await reg.runBeforeTool(
    { name: "bash", arguments: { command: "rm -fr /" } },
    { meta: { role: "lead" } },
  );
  assert.equal(rmRootBare?.blockedBy, "destructive-bash-guard");

  const forcePush = await reg.runBeforeTool(
    { name: "bash", arguments: { command: "git push origin +main" } },
    { meta: { role: "lead" } },
  );
  assert.equal(forcePush?.blockedBy, "destructive-bash-guard");

  const safeRm = await reg.runBeforeTool(
    { name: "bash", arguments: { command: "rm -rf /tmp/build-cache" } },
    { meta: { role: "lead" } },
  );
  assert.equal(safeRm, undefined);

  // Subagent cannot git push or swarm-ctl apply, but Lead can
  const subPush = await reg.runBeforeTool(
    { name: "bash", arguments: { command: "git push origin main" } },
    { meta: { role: "coder" } },
  );
  assert.equal(subPush?.blockedBy, "subagent-deploy-guard");

  const leadPush = await reg.runBeforeTool(
    { name: "bash", arguments: { command: "git push origin main" } },
    { meta: { role: "lead" } },
  );
  assert.equal(leadPush, undefined);

  // Support/social cannot send outbound email/tweets
  const outSend = await reg.runBeforeTool(
    { name: "bash", arguments: { command: "curl -X POST https://api.resend.com/emails" } },
    { meta: { role: "support" } },
  );
  assert.equal(outSend?.blockedBy, "draft-only-outbound-guard");
});

test("3. Priority ordering, argument rewrite, afterTool transformation, and setEnabled toggle", async () => {
  const order = [];
  const reg = new HookRegistry([
    {
      id: "second",
      description: "Runs second",
      priority: 20,
      beforeTool(call) {
        order.push(`second:${call.arguments.flag}`);
        return { arguments: { ...call.arguments, second: true } };
      },
      afterTool(_call, result) {
        return { ...result, tagged: `${result.tagged}+second` };
      },
    },
    {
      id: "first",
      description: "Runs first",
      priority: 10,
      beforeTool(call) {
        order.push("first");
        return { arguments: { ...call.arguments, flag: "rewritten" } };
      },
      afterTool(_call, result) {
        return { ...result, tagged: "first" };
      },
    },
  ]);

  const res = await reg.runBeforeTool({ name: "bash", arguments: { flag: "orig" } }, {});
  assert.deepEqual(order, ["first", "second:rewritten"]);
  assert.deepEqual(res, { arguments: { flag: "rewritten", second: true } });

  const after = await reg.runAfterTool({ name: "bash" }, { ok: true }, {});
  assert.deepEqual(after, { ok: true, tagged: "first+second" });

  // Disabling a hook skips it cleanly
  assert.equal(reg.setEnabled("first", false), true);
  const afterDisabled = await reg.runAfterTool({ name: "bash" }, { ok: true, tagged: "base" }, {});
  assert.deepEqual(afterDisabled, { ok: true, tagged: "base+second" });
});

test("4. Security fail-closed on throwing beforeTool + isolated onError observers + onYield continuation", async () => {
  const observedErrors = [];
  const reg = new HookRegistry([
    {
      id: "error-observer",
      description: "Collects errors",
      priority: 1,
      onError(err, ctx) {
        observedErrors.push({ msg: err.message, hookId: ctx.hookId, phase: ctx.phase });
      },
    },
    {
      id: "broken-observer",
      description: "Throws inside onError without breaking others",
      priority: 2,
      onError() {
        throw new Error("observer failure should be swallowed");
      },
    },
    {
      id: "faulty-guard",
      description: "Throws inside beforeTool",
      priority: 10,
      beforeTool() {
        throw new Error("policy store unavailable");
      },
    },
    {
      id: "yield-gate",
      description: "Requests continuation when answer lacks marker",
      priority: 10,
      onYield(answer) {
        if (!String(answer).includes("PASS")) return { continue: "Please verify." };
      },
    },
  ]);

  const blocked = await reg.runBeforeTool({ name: "bash", arguments: { command: "ls" } }, {});
  assert.equal(blocked?.blockedBy, "faulty-guard");
  assert.match(blocked?.block || "", /failed closed: policy store unavailable/);
  assert.deepEqual(observedErrors, [{ msg: "policy store unavailable", hookId: "faulty-guard", phase: "beforeTool" }]);

  const cont = await reg.runOnYield("Done without running tests", {});
  assert.deepEqual(cont, { continue: "Please verify.", triggeredBy: "yield-gate" });

  const ok = await reg.runOnYield("Verified: PASS", {});
  assert.equal(ok, undefined);

  const list = reg.list();
  const faultyStats = list.find((h) => h.id === "faulty-guard")?.stats;
  assert.equal(faultyStats?.errors, 1);
  assert.equal(faultyStats?.invocations, 1);
});
