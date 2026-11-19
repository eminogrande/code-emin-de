import assert from "node:assert/strict";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { attachOpenWeightsFailover, createOpenModels, isFailoverEligibleError, LLMGATEWAY_TO_ALLMODELS_MAP } from "../src/models.mjs";

test("1. isFailoverEligibleError matches HTTP 402 billing/credit errors and 5xx outages", () => {
  assert.equal(isFailoverEligibleError('HTTP 402: {"error":{"code":"billing_error","message":"organization has insufficient credits"}}'), true);
  assert.equal(isFailoverEligibleError("Provider is not configured: llmgateway"), true);
  assert.equal(isFailoverEligibleError("HTTP 503 Service Unavailable"), true);
  assert.equal(isFailoverEligibleError("Invalid JSON schema in tool parameter"), false);
});

test("2. attachOpenWeightsFailover transparently retries on allmodels when llmgateway hits HTTP 402 and trips circuit breaker", async () => {
  const prevAll = process.env.ALLMODELS_API_KEY;
  const prevLlm = process.env.LLMGATEWAY_API_KEY;
  process.env.ALLMODELS_API_KEY = "test-allmodels-key";
  process.env.LLMGATEWAY_API_KEY = "test-llmgateway-key";

  try {
    let llmCalls = 0;
    const llmFaux = fauxProvider({ provider: "llmgateway", models: [{ id: "kimi-k3.1-pro" }] });
    llmFaux.setResponses([
      () => {
        llmCalls += 1;
        return fauxAssistantMessage([], {
          stopReason: "error",
          errorMessage: '402 {"error":{"message":"No API key set for provider and organization has insufficient credits","code":"billing_error"}}',
        });
      },
      () => {
        llmCalls += 1;
        return fauxAssistantMessage([fauxText("should-be-skipped-by-circuit-breaker")]);
      },
    ]);

    const mappedId = LLMGATEWAY_TO_ALLMODELS_MAP["kimi-k3.1-pro"];
    const allFaux = fauxProvider({ provider: "allmodels", models: [{ id: mappedId }] });
    allFaux.setResponses([
      fauxAssistantMessage([fauxText("FAILOVER_OK_1")]),
      fauxAssistantMessage([fauxText("FAILOVER_OK_2")]),
    ]);

    const models = createModels();
    models.setProvider(llmFaux.provider);
    models.setProvider(allFaux.provider);
    attachOpenWeightsFailover(models, { cooldownMs: 60_000 });

    const primaryModel = models.getModel("llmgateway", "kimi-k3.1-pro");
    const msg1 = await models.completeSimple(primaryModel, { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] });
    assert.equal(msg1.stopReason, "stop");
    assert.equal(msg1.provider, "allmodels");
    assert.equal(msg1.model, mappedId);
    assert.equal(msg1.content[0].text, "FAILOVER_OK_1");
    assert.equal(llmCalls, 1);

    // Second call within cooldown skips dead llmgateway hop directly!
    const msg2 = await models.completeSimple(primaryModel, { messages: [{ role: "user", content: "hi again", timestamp: Date.now() }] });
    assert.equal(msg2.provider, "allmodels");
    assert.equal(msg2.content[0].text, "FAILOVER_OK_2");
    assert.equal(llmCalls, 1);
  } finally {
    if (prevAll === undefined) delete process.env.ALLMODELS_API_KEY;
    else process.env.ALLMODELS_API_KEY = prevAll;
    if (prevLlm === undefined) delete process.env.LLMGATEWAY_API_KEY;
    else process.env.LLMGATEWAY_API_KEY = prevLlm;
  }
});

test("3. attachOpenWeightsFailover downgrades to cheaper allmodels open-weights model on 402 insufficient_balance", async () => {
  const prevAll = process.env.ALLMODELS_API_KEY;
  const prevLlm = process.env.LLMGATEWAY_API_KEY;
  process.env.ALLMODELS_API_KEY = "test-allmodels-key";
  delete process.env.LLMGATEWAY_API_KEY;
  try {
    const mappedId = LLMGATEWAY_TO_ALLMODELS_MAP["kimi-k3.1-pro"];
    const llmFaux = fauxProvider({ provider: "llmgateway", models: [{ id: "kimi-k3.1-pro" }] });
    const allFaux = fauxProvider({
      provider: "allmodels",
      models: [{ id: mappedId }, { id: "z-ai/glm-5.3-abliterated" }],
    });
    allFaux.setResponses([
      () =>
        fauxAssistantMessage([], {
          stopReason: "error",
          errorMessage: '402: {"message":"The organization\'s balance cannot cover this request. Add credits, or lower max_tokens.","code":"insufficient_balance"}',
        }),
      fauxAssistantMessage([fauxText("GLM_DOWNGRADE_OK")]),
    ]);
    const models = createModels();
    models.setProvider(llmFaux.provider);
    models.setProvider(allFaux.provider);
    attachOpenWeightsFailover(models);

    const msg = await models.completeSimple(models.getModel("llmgateway", "kimi-k3.1-pro"), {
      messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
    });
    assert.equal(msg.stopReason, "stop");
    assert.equal(msg.model, "z-ai/glm-5.3-abliterated");
    assert.equal(msg.content[0].text, "GLM_DOWNGRADE_OK");
  } finally {
    if (prevAll === undefined) delete process.env.ALLMODELS_API_KEY;
    else process.env.ALLMODELS_API_KEY = prevAll;
    if (prevLlm === undefined) delete process.env.LLMGATEWAY_API_KEY;
    else process.env.LLMGATEWAY_API_KEY = prevLlm;
  }
});

test("4. attachOpenWeightsFailover falls over to Tier-3 local-llama with explicit warning banner when all cloud providers fail", async () => {
  const prevAll = process.env.ALLMODELS_API_KEY;
  const prevLlm = process.env.LLMGATEWAY_API_KEY;
  process.env.ALLMODELS_API_KEY = "test-allmodels-key";
  process.env.LLMGATEWAY_API_KEY = "test-llmgateway-key";
  try {
    const mappedId = LLMGATEWAY_TO_ALLMODELS_MAP["kimi-k3.1-pro"];
    const llmFaux = fauxProvider({ provider: "llmgateway", models: [{ id: "kimi-k3.1-pro" }] });
    llmFaux.setResponses([
      () =>
        fauxAssistantMessage([], {
          stopReason: "error",
          errorMessage: "402 billing_error: insufficient credits",
        }),
    ]);

    const allFaux = fauxProvider({
      provider: "allmodels",
      models: [
        { id: mappedId },
        { id: "z-ai/glm-5.3-abliterated" },
        { id: "deepseek/deepseek-v4.1-flash-abliterated" },
      ],
    });
    allFaux.setResponses([
      () => fauxAssistantMessage([], { stopReason: "error", errorMessage: "402 insufficient_balance" }),
      () => fauxAssistantMessage([], { stopReason: "error", errorMessage: "402 insufficient_balance" }),
      () => fauxAssistantMessage([], { stopReason: "error", errorMessage: "402 insufficient_balance" }),
    ]);

    const localFaux = fauxProvider({ provider: "local-llama", models: [{ id: "LFM3-1.7B-Q4_K_M" }] });
    localFaux.setResponses([
      () => fauxAssistantMessage([fauxText("I am the local failsafe agent; cloud credits ran out.")]),
    ]);

    const models = createModels();
    models.setProvider(llmFaux.provider);
    models.setProvider(allFaux.provider);
    models.setProvider(localFaux.provider);
    const seenContexts = [];
    const origLocalStream = models.streamSimple.bind(models);
    models.streamSimple = (m, ctx, opts) => {
      if (m?.provider === "local-llama") seenContexts.push(String(ctx?.systemPrompt || ""));
      return origLocalStream(m, ctx, opts);
    };
    attachOpenWeightsFailover(models, { localModelId: "LFM3-1.7B-Q4_K_M" });

    const msg = await models.completeSimple(models.getModel("llmgateway", "kimi-k3.1-pro"), {
      systemPrompt: "Base prompt",
      messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
    });
    assert.equal(msg.stopReason, "stop");
    assert.equal(msg.provider, "local-llama");
    assert.equal(msg.model, "LFM3-1.7B-Q4_K_M");
    assert.match(msg.content[0].text, /LOCAL FAILSAFE ACTIVE: `local-llama\/LFM3-1\.7B-Q4_K_M`/);
    assert.match(msg.content[0].text, /402 billing_error/);
    assert.match(msg.content[0].text, /I am the local failsafe agent/);
    assert.equal(seenContexts.length, 1);
    assert.match(seenContexts[0], /EMERGENCY FAILSAFE MODE/);
  } finally {
    if (prevAll === undefined) delete process.env.ALLMODELS_API_KEY;
    else process.env.ALLMODELS_API_KEY = prevAll;
    if (prevLlm === undefined) delete process.env.LLMGATEWAY_API_KEY;
    else process.env.LLMGATEWAY_API_KEY = prevLlm;
  }
});

test("paymentrequired: registered free provider, zero costs, no cross-provider fallback", async () => {
  const prevRouter = process.env.ROUTER_PAYMENTREQUIRED_API_KEY;
  const prevAll = process.env.ALLMODELS_API_KEY;
  process.env.ROUTER_PAYMENTREQUIRED_API_KEY = "test-router-key";
  try {
    const models = createOpenModels({ enableFailover: false });
    const m = models.getModel("paymentrequired", "k3.1-pro");
    assert.ok(m, "model registered");
    assert.equal(m.provider, "paymentrequired");
    assert.equal(m.api, "openai-completions");
    assert.equal(m.baseUrl, "https://router.paymentrequired.com/v1/internal");
    assert.match(m.name, /free|OAuth/i);
    assert.deepEqual(m.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.equal(m.compat.maxTokensField, "max_tokens");

    // Free endpoint errors must surface directly (no fallback hop even with allmodels key present).
    process.env.ALLMODELS_API_KEY = "test-allmodels-key";
    let routerCalls = 0;
    const routerFaux = fauxProvider({ provider: "paymentrequired", models: [{ id: "k3.1-pro" }] });
    routerFaux.setResponses([
      () => {
        routerCalls += 1;
        return fauxAssistantMessage([], { stopReason: "error", errorMessage: "HTTP 429 quota exceeded" });
      },
    ]);
    const allFaux = fauxProvider({ provider: "allmodels", models: [{ id: "moonshotai/kimi-k3.1-pro-abliterated" }] });
    allFaux.setResponses([fauxAssistantMessage([fauxText("SHOULD_NOT_RUN")])]);

    const wrapped = createModels();
    wrapped.setProvider(routerFaux.provider);
    wrapped.setProvider(allFaux.provider);
    attachOpenWeightsFailover(wrapped);
    const msg = await wrapped.completeSimple(
      wrapped.getModel("paymentrequired", "k3.1-pro"),
      { messages: [{ role: "user", content: "hi" }] },
      {},
    );
    assert.equal(msg.stopReason, "error");
    assert.match(String(msg.errorMessage), /quota/i);
    assert.equal(routerCalls, 1);
    assert.doesNotMatch(JSON.stringify(msg), /SHOULD_NOT_RUN/);
  } finally {
    if (prevRouter === undefined) delete process.env.ROUTER_PAYMENTREQUIRED_API_KEY;
    else process.env.ROUTER_PAYMENTREQUIRED_API_KEY = prevRouter;
    if (prevAll === undefined) delete process.env.ALLMODELS_API_KEY;
    else process.env.ALLMODELS_API_KEY = prevAll;
  }
});
