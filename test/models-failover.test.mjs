import assert from "node:assert/strict";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { attachOpenWeightsFailover, isFailoverEligibleError, LLMGATEWAY_TO_ALLMODELS_MAP } from "../src/models.mjs";

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
