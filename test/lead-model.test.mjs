import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startUnixSocketServer, unixRpc } from "../src/cli.mjs";
import { openSwarmDaemon } from "../src/daemon.mjs";
import { LEAD_MODEL_CHOICES, resolveLeadModelChoice, ROUTER_PAYMENTREQUIRED_MODELS } from "../src/models.mjs";
import { startWebServer } from "../src/web.mjs";

test("1. allowlist: only known verified provider/model pairs resolve", () => {
  assert.ok(LEAD_MODEL_CHOICES.length >= 4);
  assert.deepEqual(resolveLeadModelChoice("llmgateway", "kimi-k3.1-pro"), {
    provider: "llmgateway",
    modelId: "kimi-k3.1-pro",
  });
  assert.deepEqual(resolveLeadModelChoice("allmodels", "moonshotai/kimi-k3.1-pro-abliterated"), {
    provider: "allmodels",
    modelId: "moonshotai/kimi-k3.1-pro-abliterated",
  });
  assert.deepEqual(resolveLeadModelChoice("paymentrequired", "k3.1-pro"), {
    provider: "paymentrequired",
    modelId: "k3.1-pro",
  });
  assert.equal(resolveLeadModelChoice("paymentrequired", "gemini-3.7-flash-high"), null);
  // every router catalogue entry is selectable, and only under the router provider
  const routerIds = ROUTER_PAYMENTREQUIRED_MODELS.map((m) => m.id);
  assert.equal(routerIds.length, 23);
  for (const id of routerIds) {
    assert.ok(resolveLeadModelChoice("paymentrequired", id), id);
    assert.equal(resolveLeadModelChoice("llmgateway", id), null, id);
  }
  // wrong provider for a known model id, unknown provider, unknown model, empty
  assert.equal(resolveLeadModelChoice("allmodels", "kimi-k3.1-pro"), null);
  assert.equal(resolveLeadModelChoice("openrouter", "kimi-k3.1-pro"), null);
  assert.equal(resolveLeadModelChoice("llmgateway", "gpt-9"), null);
  assert.equal(resolveLeadModelChoice("", ""), null);
  assert.equal(resolveLeadModelChoice(undefined, undefined), null);
  // no secrets / OAuth artifacts in allowlist
  for (const c of LEAD_MODEL_CHOICES) {
    assert.deepEqual(Object.keys(c).sort(), ["modelId", "provider"]);
    assert.doesNotMatch(c.modelId, /key|token|secret/i);
  }
});

test("2. daemon: override validates, persists in SwarmDoc, and becomes the effective status model", async () => {
  const root = await mkdtemp(join(tmpdir(), "lead-model-"));
  try {
    const dataDir = join(root, "data");
    const daemon = await openSwarmDaemon({ dataDir, workspaceDir: join(root, "workspace") });
    try {
      const before = await daemon.status();
      assert.equal(before.lead.overridden, false);

      // invalid provider and invalid model are rejected, nothing changes
      const badProvider = await daemon.setLeadModel("openrouter", "kimi-k3.1-pro");
      assert.equal(badProvider.statusCode, 400);
      assert.match(badProvider.error, /allowlist/);
      const badModel = await daemon.setLeadModel("llmgateway", "totally-made-up");
      assert.equal(badModel.statusCode, 400);

      const ok = await daemon.setLeadModel("allmodels", "moonshotai/kimi-k3.1-pro-abliterated");
      assert.equal(ok.ok, true);
      assert.deepEqual(ok.active, { provider: "allmodels", modelId: "moonshotai/kimi-k3.1-pro-abliterated" });

      const after = await daemon.status();
      assert.equal(after.lead.provider, "allmodels");
      assert.equal(after.lead.model, "moonshotai/kimi-k3.1-pro-abliterated");
      assert.equal(after.lead.overridden, true);

      // durable: persisted in the session doc, and re-applied on restart
      const snap = await daemon.harness.snapshot((await import("../src/daemon.mjs")).SwarmDoc, (await import("@earendil-works/chord/context")).BACKGROUND_CONTEXT);
      assert.deepEqual(
        { provider: snap.leadModelOverride.provider, modelId: snap.leadModelOverride.modelId },
        { provider: "allmodels", modelId: "moonshotai/kimi-k3.1-pro-abliterated" },
      );
      await daemon.close();

      const restarted = await openSwarmDaemon({ dataDir, workspaceDir: join(root, "workspace") });
      try {
        const st = await restarted.status();
        assert.equal(st.lead.model, "moonshotai/kimi-k3.1-pro-abliterated");
        assert.equal(st.lead.overridden, true);
      } finally {
        await restarted.close();
      }
    } finally {
      await daemon.close().catch(() => {});
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("3. unix route + web endpoint: POST /model and POST /api/model require auth and validate", async () => {
  const root = await mkdtemp(join(tmpdir(), "lead-model-web-"));
  const sockPath = join(root, "swarm.sock");
  let calls = 0;
  const mockDaemon = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      calls += 1;
      const body = raw ? JSON.parse(raw) : {};
      if (req.url === "/model") {
        if (!body.provider || !body.modelId) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Unknown model (not in allowlist)" }));
          return;
        }
        res.end(JSON.stringify({ ok: true, active: { provider: body.provider, modelId: body.modelId } }));
        return;
      }
      res.end(JSON.stringify({ ok: true, lead: null }));
    });
  });
  await new Promise((r) => mockDaemon.listen(sockPath, r));

  let web = null;
  try {
    web = await startWebServer({
      port: 0,
      host: "127.0.0.1",
      sockPath,
      authDbPath: join(root, "auth.sqlite"),
      rpId: "localhost",
      origin: "http://localhost",
    });
    const port = web.server.address().port;

    const unauth = await fetch(`http://127.0.0.1:${port}/api/model`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "llmgateway", modelId: "glm-5.3" }),
    });
    assert.equal(unauth.status, 401);
    assert.equal(calls, 0);

    // forged session cookie is enough for the route (auth store verified separately in webauthn tests)
    web.auth.verifySession = () => true;
    const okRes = await fetch(`http://127.0.0.1:${port}/api/model`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "swarm_s=x" },
      body: JSON.stringify({ provider: "allmodels", modelId: "moonshotai/kimi-k3.1-pro-abliterated" }),
    });
    assert.equal(okRes.status, 200);
    assert.deepEqual(await okRes.json(), {
      ok: true,
      active: { provider: "allmodels", modelId: "moonshotai/kimi-k3.1-pro-abliterated" },
    });

    const badRes = await fetch(`http://127.0.0.1:${port}/api/model`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "swarm_s=x" },
      body: JSON.stringify({}),
    });
    assert.equal(badRes.status, 400);
  } finally {
    if (web) web.server.close();
    await new Promise((r) => mockDaemon.close(r));
    await rm(root, { recursive: true, force: true });
  }
});

test("4. unix socket server exposes POST /model (400 on invalid)", async () => {
  const root = await mkdtemp(join(tmpdir(), "lead-model-sock-"));
  const sockPath = join(root, "swarm.sock");
  const { daemon, server } = await startUnixSocketServer({
    sockPath,
    dataDir: join(root, "data"),
    workspaceDir: join(root, "workspace"),
  });
  try {
    const st0 = await unixRpc(sockPath, "GET", "/status");
    assert.equal(st0.lead.overridden, false);
    const r = await unixRpc(sockPath, "POST", "/model", { provider: "nope", modelId: "kimi-k3.1-pro" });
    assert.match(r.error, /allowlist/);
    const ok = await unixRpc(sockPath, "POST", "/model", { provider: "llmgateway", modelId: "glm-5.3" });
    assert.equal(ok.ok, true);
    const st1 = await unixRpc(sockPath, "GET", "/status");
    assert.equal(st1.lead.model, "glm-5.3");
    assert.equal(st1.lead.overridden, true);

    // Per-agent model override on named orchestrations (Opus 5.5 + GPT-OSS 120B)
    const created = await unixRpc(sockPath, "POST", "/orchestrations", {
      name: "opus-agent",
      preset: "repo",
      provider: "paymentrequired",
      modelId: "claude-opus-5-5-high",
    });
    assert.deepEqual(created.model, { provider: "paymentrequired", modelId: "claude-opus-5-5-high" });
    await unixRpc(sockPath, "POST", "/orchestration-update", {
      id: created.id,
      provider: "paymentrequired",
      modelId: "gpt-oss-120b-medium",
    });
    const list = await unixRpc(sockPath, "GET", "/orchestrations");
    assert.deepEqual(list.orchestrations.find((o) => o.id === created.id)?.model, {
      provider: "paymentrequired",
      modelId: "gpt-oss-120b-medium",
    });
  } finally {
    await new Promise((r) => server.close(r));
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
});
