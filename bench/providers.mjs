import { createModels, createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";

const LLMGATEWAY_MODELS = [
  // Open-weights verified
  { id: "mistral-large-4", name: "Mistral Large 4 (1.05T/A49B, open-weights)", contextWindow: 1000000, maxTokens: 65536, reasoning: false, input: ["text", "image"], cost: { input: 1.36, output: 4.18, cacheRead: 0.14, cacheWrite: 0 } },
  { id: "qwen3.8-2.4t-a95b", name: "Qwen3.8 2.4T A95B (open-weights)", contextWindow: 1000000, maxTokens: 65536, reasoning: true, input: ["text"], cost: { input: 2.0, output: 6.0, cacheRead: 0.25, cacheWrite: 0 } },
  { id: "qwen4-max", name: "Qwen4 Max (2026-11-16)", contextWindow: 983616, maxTokens: 65536, reasoning: true, input: ["text", "image"], cost: { input: 1.5, output: 4.5, cacheRead: 0.075, cacheWrite: 1.875 } },
  { id: "kimi-k3.1-pro", name: "Kimi K3.1 Pro", contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text", "image"], cost: { input: 2.0, output: 10.0, cacheRead: 0.2, cacheWrite: 0 } },
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", contextWindow: 1050000, maxTokens: 64000, reasoning: true, input: ["text"], cost: { input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0 } },
  { id: "deepseek-v4.1-flash-1017", name: "DeepSeek V4.1 Flash 1017", contextWindow: 1050000, maxTokens: 65536, reasoning: true, input: ["text", "image"], cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 } },
  { id: "deepseek-v4.1-flash-uncensored", name: "DeepSeek V4.1 Flash Uncensored", contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text", "image"], cost: { input: 0.18, output: 0.65, cacheRead: 0.005, cacheWrite: 0 } },
  { id: "deepseek-v4.1-flash-cyber", name: "DeepSeek V4.1 Flash Cyber (abliterated)", contextWindow: 1040000, maxTokens: 65536, reasoning: true, input: ["text", "image"], cost: { input: 0.3, output: 1.0, cacheRead: 0.007, cacheWrite: 0 } },
  { id: "glm-5.3", name: "GLM-5.3", contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text"], cost: { input: 0.77, output: 2.42, cacheRead: 0.143, cacheWrite: 0 } },
  { id: "muse-spark-open", name: "Meta Muse Spark Open (816B/A42B, open-weights)", contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text", "image"], cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 } },
  { id: "muse-wonder-1.0", name: "Meta Muse Wonder 1.0", contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text", "image"], cost: { input: 4.0, output: 20.0, cacheRead: 0.4, cacheWrite: 0 } },
  { id: "muse-ember-1.0", name: "Meta Muse Ember 1.0", contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text", "image"], cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0 } },
  { id: "beam-1.0-501b-a23b", name: "Reflection Beam 1.0 (501B/A23B, open-weights)", contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text"], cost: { input: 0.4, output: 1.2, cacheRead: 0.04, cacheWrite: 0 } },
  { id: "mimo-v2.6-pro", name: "Xiaomi MiMo V2.6 Pro", contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text", "image"], cost: { input: 0.435, output: 0.87, cacheRead: 0.0036, cacheWrite: 0 } },
  { id: "minimax-m3.1-flash", name: "MiniMax M3.1 Flash", contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text", "image"], cost: { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0 } },
  { id: "step-5-preview", name: "StepFun Step 5 Preview", contextWindow: 1000000, maxTokens: 65536, reasoning: true, input: ["text", "image"], cost: { input: 1.0, output: 2.7, cacheRead: 0.1, cacheWrite: 0 } },
  { id: "hy4-preview", name: "Tencent Hunyuan Hy4 Preview", contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text", "image"], cost: { input: 0.834, output: 2.501, cacheRead: 0.08, cacheWrite: 0 } },
  { id: "ling-3.0-flash", name: "InclusionAI Ling 3.0 Flash (124B/A5.1B, open-weights)", contextWindow: 262144, maxTokens: 65536, reasoning: true, input: ["text"], cost: { input: 0.06, output: 0.18, cacheRead: 0.01, cacheWrite: 0 } },
  { id: "fugu-max", name: "Sakana Fugu Max (orchestrator)", contextWindow: 1000000, maxTokens: 65536, reasoning: true, input: ["text"], cost: { input: 2.0, output: 6.0, cacheRead: 0.2, cacheWrite: 0 } },
];

const ALLMODELS_MODELS = [
  { id: "deepseek/deepseek-v4.1-flash-abliterated", name: "DeepSeek V4.1 Flash Abliterated (AllModels)", contextWindow: 1048576, maxTokens: 126976, reasoning: true, input: ["text", "image"], cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0 } },
  { id: "moonshotai/kimi-k3.1-pro-abliterated", name: "Kimi K3.1 Pro Abliterated (AllModels)", contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text", "image"], cost: { input: 2.0, output: 10.0, cacheRead: 0.2, cacheWrite: 0 } },
];

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

export function createFrontierModels() {
  const models = createModels();
  models.setProvider(deepseekProvider());

  models.setProvider(
    createProvider({
      id: "llmgateway",
      name: "LLMGateway",
      baseUrl: "https://api.llmgateway.io/v1",
      auth: { apiKey: envApiKeyAuth("LLMGateway API key", ["LLMGATEWAY_API_KEY"]) },
      models: LLMGATEWAY_MODELS.map((m) => ({
        ...m,
        api: "openai-completions",
        provider: "llmgateway",
        baseUrl: "https://api.llmgateway.io/v1",
        type: "chat",
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          maxTokensField: "max_tokens",
          ...(m.reasoning
            ? {
                thinkingFormat: "openrouter",
                requiresReasoningContentOnAssistantMessages: true,
              }
            : { supportsReasoningEffort: false }),
          supportsStrictMode: false,
        },
      })),
      api: wrapApiWithPayload((payload, model) => {
        if (payload && typeof payload === "object" && model.reasoning) {
          // Only inject reasoning: { effort: "high" } on models whose upstream accepts OpenRouter-style reasoning object
          const skipEffort = new Set(["ling-3.0-flash", "qwen3.8-2.4t-a95b", "mistral-large-4"]);
          if (!skipEffort.has(model.id)) {
            return { ...payload, reasoning: { effort: "high" } };
          }
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
      models: ALLMODELS_MODELS.map((m) => ({
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

export const FRONTIER_ROSTER = LLMGATEWAY_MODELS.map((m) => ({
  provider: "llmgateway",
  modelId: m.id,
  label: m.name,
})).concat(
  ALLMODELS_MODELS.map((m) => ({
    provider: "allmodels",
    modelId: m.id,
    label: m.name,
  })),
);
