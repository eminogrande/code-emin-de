import { createModels, createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
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
  { id: "moonshotai/kimi-k3.1-pro-abliterated", name: "Kimi K3.1 Pro Abliterated (open-weights)", contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text", "image"], cost: { input: 2.0, output: 10.0, cacheRead: 0.2, cacheWrite: 0 } },
];

// Empirically proven open-weights winners per role (Rounds 1, 2A, 2B)
export const ROLE_MODELS = {
  lead: { provider: "llmgateway", modelId: process.env.MODEL_LEAD || "kimi-k3.1-pro" },
  planner: { provider: "llmgateway", modelId: process.env.MODEL_PLANNER || "glm-5.3" },
  coder: { provider: "llmgateway", modelId: process.env.MODEL_CODER || "deepseek-v4.1-flash-uncensored" },
  coderFast: { provider: "llmgateway", modelId: process.env.MODEL_CODER_FAST || "deepseek-v4.1-flash-1017" },
  reviewer: { provider: "llmgateway", modelId: process.env.MODEL_REVIEWER || "glm-5.3" },
  reviewerDeep: { provider: "llmgateway", modelId: process.env.MODEL_REVIEWER_DEEP || "deepseek-v4-pro" },
  support: { provider: "llmgateway", modelId: process.env.MODEL_SUPPORT || "glm-5.3" },
  social: { provider: "llmgateway", modelId: process.env.MODEL_SOCIAL || "kimi-k3.1-pro" },
  watcher: { provider: "llmgateway", modelId: process.env.MODEL_WATCHER || "glm-5.3" },
  btw: { provider: "llmgateway", modelId: process.env.MODEL_BTW || "deepseek-v4.1-flash-1017" },
};

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

export function createOpenModels() {
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

  return models;
}
