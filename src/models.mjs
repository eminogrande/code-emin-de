import { AssistantMessageEventStream, createModels, createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";

// Strict verified open-weights production roster on LLMGateway + AllModels
const LLMGATEWAY_OPEN_MODELS = [
  { id: "kimi-k3.1-pro", name: "Kimi K3.1 Pro (open-weights)", contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text", "image"], cost: { input: 2.0, output: 10.0, cacheRead: 0.2, cacheWrite: 0 } },
  { id: "glm-5.3", name: "GLM-5.3 (open-weights)", contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text"], cost: { input: 0.77, output: 2.42, cacheRead: 0.143, cacheWrite: 0 } },
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro (open-weights)", contextWindow: 1050000, maxTokens: 64000, reasoning: true, input: ["text"], cost: { input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0 } },
  { id: "deepseek-v4.1-flash-uncensored", name: "DeepSeek V4.1 Flash Uncensored (open-weights)", contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text", "image"], cost: { input: 0.18, output: 0.65, cacheRead: 0.005, cacheWrite: 0 } },
  { id: "deepseek-v4.1-flash-1017", name: "DeepSeek V4.1 Flash 1017 (open-weights)", contextWindow: 1050000, maxTokens: 65536, reasoning: true, input: ["text", "image"], cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 } },
  { id: "minimax-m3.1-flash", name: "MiniMax M3.1 Flash (open-weights)", contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text", "image"], cost: { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0 } },
  { id: "minimax-m3", name: "MiniMax M3 (open-weights)", contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text", "image"], cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0 } },
  { id: "glm-5.3-prime", name: "GLM-5.3 Prime (open-weights)", contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text"], cost: { input: 1.0, output: 3.2, cacheRead: 0.2, cacheWrite: 0 } },
  { id: "qwen4-max", name: "Qwen4 Max (open-weights)", contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text", "image"], cost: { input: 1.2, output: 4.8, cacheRead: 0.2, cacheWrite: 0 } },
  { id: "qwen3.8-2.4t-a95b", name: "Qwen3.8 2.4T-A95B (open-weights)", contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text", "image"], cost: { input: 0.9, output: 3.6, cacheRead: 0.15, cacheWrite: 0 } },
  { id: "nemotron-3-ultra-550b", name: "Nemotron 3 Ultra 550B (open-weights)", contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text"], cost: { input: 0.8, output: 2.8, cacheRead: 0.12, cacheWrite: 0 } },
  { id: "muse-spark-open", name: "Meta Muse Spark Open 816B/A42B (open-weights)", contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text", "image"], cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 } },
];

const ALLMODELS_OPEN_MODELS = [
  { id: "deepseek/deepseek-v4.1-flash-abliterated", name: "DeepSeek V4.1 Flash Abliterated (open-weights)", contextWindow: 1048576, maxTokens: 126976, reasoning: true, input: ["text", "image"], cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0 } },
  { id: "deepseek/deepseek-v4.1-flash-ultrafast", name: "DeepSeek V4.1 Flash Ultrafast (open-weights)", contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text", "image"], cost: { input: 0.18, output: 0.65, cacheRead: 0.01, cacheWrite: 0 } },
  { id: "moonshotai/kimi-k3.1-pro-abliterated", name: "Kimi K3.1 Pro Abliterated (open-weights)", contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text", "image"], cost: { input: 2.0, output: 10.0, cacheRead: 0.2, cacheWrite: 0 } },
  { id: "z-ai/glm-5.3-abliterated", name: "GLM-5.3 Abliterated (open-weights)", contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text"], cost: { input: 0.77, output: 2.42, cacheRead: 0.143, cacheWrite: 0 } },
  { id: "z-ai/glm-5.3-flash-abliterated", name: "GLM-5.3 Flash Abliterated (open-weights)", contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text"], cost: { input: 0.2, output: 0.7, cacheRead: 0.02, cacheWrite: 0 } },
  { id: "qwen/qwen3.8-27b-abliterated", name: "Qwen3.8 27B Abliterated (open-weights)", contextWindow: 262144, maxTokens: 65536, reasoning: true, input: ["text"], cost: { input: 0.2, output: 0.6, cacheRead: 0.02, cacheWrite: 0 } },
];

/**
 * Equivalent open-weights failover map from `llmgateway` -> `allmodels` when LLMGateway
 * hits HTTP 402 billing/credit exhaustion, missing key, or 5xx gateway outage.
 */
export const LLMGATEWAY_TO_ALLMODELS_MAP = {
  "kimi-k3.1-pro": "moonshotai/kimi-k3.1-pro-abliterated",
  "glm-5.3": "z-ai/glm-5.3-abliterated",
  "glm-5.3-prime": "z-ai/glm-5.3-abliterated",
  "deepseek-v4-pro": "z-ai/glm-5.3-abliterated",
  "deepseek-v4.1-flash-uncensored": "deepseek/deepseek-v4.1-flash-abliterated",
  "deepseek-v4.1-flash-1017": "deepseek/deepseek-v4.1-flash-ultrafast",
  "minimax-m3.1-flash": "deepseek/deepseek-v4.1-flash-ultrafast",
  "minimax-m3": "deepseek/deepseek-v4.1-flash-abliterated",
  "qwen4-max": "qwen/qwen3.8-27b-abliterated",
  "qwen3.8-2.4t-a95b": "qwen/qwen3.8-27b-abliterated",
  "nemotron-3-ultra-550b": "z-ai/glm-5.3-abliterated",
  "muse-spark-open": "moonshotai/kimi-k3.1-pro-abliterated",
};

// Empirically proven open-weights winners per role (Rounds 1, 2A, 2B)
export const ROLE_MODELS = {
  lead: { provider: process.env.PROVIDER_LEAD || "llmgateway", modelId: process.env.MODEL_LEAD || "kimi-k3.1-pro" },
  planner: { provider: process.env.PROVIDER_PLANNER || "llmgateway", modelId: process.env.MODEL_PLANNER || "glm-5.3" },
  coder: { provider: process.env.PROVIDER_CODER || "llmgateway", modelId: process.env.MODEL_CODER || "deepseek-v4.1-flash-uncensored" },
  coderFast: { provider: process.env.PROVIDER_CODER_FAST || "llmgateway", modelId: process.env.MODEL_CODER_FAST || "deepseek-v4.1-flash-1017" },
  reviewer: { provider: process.env.PROVIDER_REVIEWER || "llmgateway", modelId: process.env.MODEL_REVIEWER || "glm-5.3" },
  reviewerDeep: { provider: process.env.PROVIDER_REVIEWER_DEEP || "llmgateway", modelId: process.env.MODEL_REVIEWER_DEEP || "deepseek-v4-pro" },
  support: { provider: process.env.PROVIDER_SUPPORT || "llmgateway", modelId: process.env.MODEL_SUPPORT || "glm-5.3" },
  social: { provider: process.env.PROVIDER_SOCIAL || "llmgateway", modelId: process.env.MODEL_SOCIAL || "kimi-k3.1-pro" },
  watcher: { provider: process.env.PROVIDER_WATCHER || "llmgateway", modelId: process.env.MODEL_WATCHER || "glm-5.3" },
  btw: { provider: process.env.PROVIDER_BTW || "llmgateway", modelId: process.env.MODEL_BTW || "deepseek-v4.1-flash-1017" },
};

export function isFailoverEligibleError(errorMessage = "") {
  const s = String(errorMessage || "");
  return /402|billing_error|insufficient credits|Insufficient Balance|No API key set|Provider is not configured|401|502|503|504|fetch failed|ECONNRESET|ETIMEDOUT/i.test(s);
}

function wrapApiWithPayload(payloadPatch) {
  const base = openAICompletionsApi();
  return {
    ...base,
    streamSimple(model, context, options) {
      const prevOnPayload = options?.onPayload;
      return base.streamSimple(model, context, {
        ...options,
        onPayload(payload, m) {
          const p1 = payloadPatch(payload, m) ?? payload;
          return prevOnPayload ? prevOnPayload(p1, m) : p1;
        },
      });
    },
  };
}

/**
 * Wrap `models.streamSimple` + `models.completeSimple` with transparent open-weights
 * failover from `llmgateway` -> `allmodels` (with a 5-minute circuit-breaker cooldown once
 * `llmgateway` returns a billing/credit error so subsequent turns skip the dead hop).
 */
export function attachOpenWeightsFailover(models, { cooldownMs = 5 * 60_000 } = {}) {
  const origStreamSimple = models.streamSimple.bind(models);
  let llmgatewayTrippedUntil = 0;

  function resolveAllModelsFallback(model) {
    if (!model || model.provider !== "llmgateway") return null;
    if (!process.env.ALLMODELS_API_KEY) return null;
    const mappedId = LLMGATEWAY_TO_ALLMODELS_MAP[model.id] || "deepseek/deepseek-v4.1-flash-abliterated";
    return models.getModel("allmodels", mappedId) || null;
  }

  models.streamSimple = function streamSimpleWithFailover(model, context, options) {
    const fallbackModel = resolveAllModelsFallback(model);
    if (!fallbackModel) {
      return origStreamSimple(model, context, options);
    }
    if ( !process.env.LLMGATEWAY_API_KEY || Date.now() < llmgatewayTrippedUntil) {
      return origStreamSimple(fallbackModel, context, options);
    }

    const outer = new AssistantMessageEventStream();
    (async () => {
      const primary = origStreamSimple(model, context, options);
      const buffered = [];
      let emittedContent = false;
      let terminalError = null;
      let doneMessage = null;

      for await (const ev of primary) {
        if (ev.type === "error") {
          terminalError = ev.error;
          break;
        }
        if (ev.type === "done") {
          doneMessage = ev.message;
          buffered.push(ev);
          break;
        }
        if (ev.partial?.content?.length > 0) {
          emittedContent = true;
          while (buffered.length > 0) outer.push(buffered.shift());
          outer.push(ev);
        } else {
          buffered.push(ev);
        }
      }

      if (!emittedContent && terminalError && isFailoverEligibleError(terminalError.errorMessage) && !options?.signal?.aborted) {
        if (/402|billing_error|insufficient credits|Insufficient Balance|No API key set/i.test(terminalError.errorMessage || "")) {
          llmgatewayTrippedUntil = Date.now() + cooldownMs;
        }
        const secondary = origStreamSimple(fallbackModel, context, options);
        let finalMsg;
        for await (const ev2 of secondary) {
          outer.push(ev2);
          if (ev2.type === "done") finalMsg = ev2.message;
          else if (ev2.type === "error") finalMsg = ev2.error;
        }
        if (!finalMsg && typeof secondary.result === "function") finalMsg = await secondary.result();
        outer.end(finalMsg);
        return;
      }

      while (buffered.length > 0) outer.push(buffered.shift());
      if (terminalError) {
        outer.push({ type: "error", reason: options?.signal?.aborted ? "aborted" : "error", error: terminalError });
        outer.end(terminalError);
      } else {
        const res = doneMessage ?? (typeof primary.result === "function" ? await primary.result() : undefined);
        outer.end(res);
      }
    })().catch((err) => {
      const msg = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: options?.signal?.aborted ? "aborted" : "error",
        errorMessage: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
      };
      outer.push({ type: "error", reason: msg.stopReason, error: msg });
      outer.end(msg);
    });

    return outer;
  };

  models.completeSimple = async function completeSimpleWithFailover(model, context, options) {
    return models.streamSimple(model, context, options).result();
  };

  return models;
}

export function createOpenModels({ enableFailover = true } = {}) {
  const models = createModels();
  models.setProvider(deepseekProvider());

  models.setProvider(
    createProvider({
      id: "llmgateway",
      name: "LLMGateway",
      baseUrl: "https://api.llmgateway.io/v1",
      auth: { apiKey: envApiKeyAuth("LLMGateway API key", ["LLMGATEWAY_API_KEY"]) },
      models: LLMGATEWAY_OPEN_MODELS.map((m) => ({
        ...m,
        api: "openai-completions",
        provider: "llmgateway",
        baseUrl: "https://api.llmgateway.io/v1",
        type: "chat",
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          maxTokensField: "max_tokens",
          thinkingFormat: "openrouter",
          requiresReasoningContentOnAssistantMessages: true,
          supportsStrictMode: false,
        },
      })),
      api: wrapApiWithPayload((payload, model) => {
        if (payload && typeof payload === "object" && model.reasoning) {
          return { ...payload, reasoning: { effort: "high" } };
        }
        return payload;
      }),
    }),
  );

  models.setProvider(
    createProvider({
      id: "allmodels",
      name: "AllModels",
      baseUrl: "https://api.allmodels.io/oai",
      auth: { apiKey: envApiKeyAuth("AllModels API key", ["ALLMODELS_API_KEY"]) },
      models: ALLMODELS_OPEN_MODELS.map((m) => ({
        ...m,
        api: "openai-completions",
        provider: "allmodels",
        baseUrl: "https://api.allmodels.io/oai",
        type: "chat",
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          maxTokensField: "max_tokens",
          thinkingFormat: "openrouter",
          requiresReasoningContentOnAssistantMessages: true,
          supportsStrictMode: false,
        },
      })),
      api: wrapApiWithPayload((payload, model) => {
        if (payload && typeof payload === "object" && model.id === "deepseek/deepseek-v4.1-flash-abliterated") {
          return {
            ...payload,
            provider: { order: ["lyber", "hopper", "abliteration"], allow_fallbacks: true },
          };
        }
        return payload;
      }),
    }),
  );

  return enableFailover ? attachOpenWeightsFailover(models) : models;
}
