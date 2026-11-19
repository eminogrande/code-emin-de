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
  { id: "mistral-large-4-0", name: "Mistral Large 4 1T/A52B (open-weights)", contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text", "image"], cost: { input: 0.5, output: 1.5, cacheRead: 0.05, cacheWrite: 0 } },
  { id: "qwen4-max", name: "Qwen4 Max (API-only ref)", contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text", "image"], cost: { input: 1.2, output: 4.8, cacheRead: 0.2, cacheWrite: 0 } },
  { id: "qwen3.8-2.4t-a95b", name: "Qwen3.8 2.4T-A95B (open-weights)", contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text", "image"], cost: { input: 0.9, output: 3.6, cacheRead: 0.15, cacheWrite: 0 } },
  { id: "nemotron-3-ultra-550b", name: "Nemotron 3 Ultra 550B (open-weights)", contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text"], cost: { input: 0.8, output: 2.8, cacheRead: 0.12, cacheWrite: 0 } },
  { id: "muse-spark-open", name: "Meta Muse Spark Open 816B/A42B (open-weights)", contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text", "image"], cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 } },
];

const ALLMODELS_OPEN_MODELS = [
  { id: "deepseek/deepseek-v4.1-flash-abliterated", name: "DeepSeek V4.1 Flash Abliterated (open-weights)", contextWindow: 1048576, maxTokens: 8192, reasoning: true, input: ["text", "image"], cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0 } },
  { id: "deepseek/deepseek-v4.1-flash-ultrafast", name: "DeepSeek V4.1 Flash Ultrafast (open-weights)", contextWindow: 1048576, maxTokens: 8192, reasoning: true, input: ["text", "image"], cost: { input: 0.18, output: 0.65, cacheRead: 0.01, cacheWrite: 0 } },
  { id: "moonshotai/kimi-k3.1-pro-abliterated", name: "Kimi K3.1 Pro Abliterated (open-weights)", contextWindow: 1048576, maxTokens: 8192, reasoning: true, input: ["text", "image"], cost: { input: 2.0, output: 10.0, cacheRead: 0.2, cacheWrite: 0 } },
  { id: "z-ai/glm-5.3-abliterated", name: "GLM-5.3 Abliterated (open-weights)", contextWindow: 1048576, maxTokens: 8192, reasoning: true, input: ["text"], cost: { input: 0.77, output: 2.42, cacheRead: 0.143, cacheWrite: 0 } },
  { id: "z-ai/glm-5.3-flash-abliterated", name: "GLM-5.3 Flash Abliterated (open-weights)", contextWindow: 1048576, maxTokens: 8192, reasoning: true, input: ["text"], cost: { input: 0.2, output: 0.7, cacheRead: 0.02, cacheWrite: 0 } },
  { id: "qwen/qwen3.8-27b-abliterated", name: "Qwen3.8 27B Abliterated (open-weights)", contextWindow: 262144, maxTokens: 8192, reasoning: true, input: ["text"], cost: { input: 0.2, output: 0.6, cacheRead: 0.02, cacheWrite: 0 } },
];

/**
 * Safe, verified Lead model choices for the chat dropdown (`POST /api/model`).
 * Allowlist = exactly these registry-known provider/model pairs, so no arbitrary IDs
 * can be persisted. Every pair is provider-explicit (same model on both gateways),
 * so failover keeps working when the primary hop is out of credits.
 */
export const LEAD_MODEL_CHOICES = Object.freeze([
  { provider: "llmgateway", modelId: "kimi-k3.1-pro" },
  { provider: "allmodels", modelId: "moonshotai/kimi-k3.1-pro-abliterated" },
  { provider: "llmgateway", modelId: "deepseek-v4.1-flash-uncensored" },
  { provider: "allmodels", modelId: "deepseek/deepseek-v4.1-flash-abliterated" },
  { provider: "llmgateway", modelId: "glm-5.3" },
  { provider: "allmodels", modelId: "z-ai/glm-5.3-abliterated" },
]);

/** Return the allowlisted `{provider, modelId}` entry for a pair, or `null` when unknown. */
export function resolveLeadModelChoice(provider, modelId) {
  const p = String(provider || "").trim();
  const m = String(modelId || "").trim();
  if (!p || !m) return null;
  return LEAD_MODEL_CHOICES.find((c) => c.provider === p && c.modelId === m) ?? null;
}

export const DEFAULT_LOCAL_LLAMA_MODEL = process.env.LOCAL_LLAMA_MODEL || "local-failsafe";

/**
 * Format an explicit user-facing banner prepended to Tier-3 local failsafe replies
 * so cloud billing/API outages are never silent.
 */
export function formatLocalFailsafeBanner({ failedAttempts = [], localModelId = DEFAULT_LOCAL_LLAMA_MODEL } = {}) {
  const summary = failedAttempts.length
    ? failedAttempts
        .map((a) => `${a.provider}/${a.model}: ${String(a.error || "failed").replace(/\s+/g, " ").slice(0, 140)}`)
        .join(" | ")
    : "all cloud providers failed";
  return `⚠️ **[LOCAL FAILSAFE ACTIVE: \`local-llama/${localModelId}\`]** Cloud APIs unavailable (${summary}). Top up credits / check provider keys to restore full cloud frontier models.\n\n`;
}

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
  "mistral-large-4-0": "moonshotai/kimi-k3.1-pro-abliterated",
};

// Empirically proven open-weights winners per role (open-frontier-swe-bench R1-R3 + ep2/ep3)
export const ROLE_MODELS = {
  lead: { provider: process.env.PROVIDER_LEAD || "llmgateway", modelId: process.env.MODEL_LEAD || "kimi-k3.1-pro" },
  planner: { provider: process.env.PROVIDER_PLANNER || "llmgateway", modelId: process.env.MODEL_PLANNER || "kimi-k3.1-pro" },
  coder: { provider: process.env.PROVIDER_CODER || "llmgateway", modelId: process.env.MODEL_CODER || "deepseek-v4.1-flash-uncensored" },
  coderFast: { provider: process.env.PROVIDER_CODER_FAST || "llmgateway", modelId: process.env.MODEL_CODER_FAST || "deepseek-v4.1-flash-1017" },
  reviewer: { provider: process.env.PROVIDER_REVIEWER || "llmgateway", modelId: process.env.MODEL_REVIEWER || "kimi-k3.1-pro" },
  reviewerDeep: { provider: process.env.PROVIDER_REVIEWER_DEEP || "llmgateway", modelId: process.env.MODEL_REVIEWER_DEEP || "kimi-k3.1-pro" },
  support: { provider: process.env.PROVIDER_SUPPORT || "llmgateway", modelId: process.env.MODEL_SUPPORT || "glm-5.3" },
  social: { provider: process.env.PROVIDER_SOCIAL || "llmgateway", modelId: process.env.MODEL_SOCIAL || "kimi-k3.1-pro" },
  watcher: { provider: process.env.PROVIDER_WATCHER || "llmgateway", modelId: process.env.MODEL_WATCHER || "glm-5.3" },
  btw: { provider: process.env.PROVIDER_BTW || "llmgateway", modelId: process.env.MODEL_BTW || "deepseek-v4.1-flash-1017" },
};

export function isFailoverEligibleError(errorMessage = "") {
  const s = String(errorMessage || "");
  return /402|billing_error|insufficient_balance|insufficient_quota|insufficient credits|Insufficient Balance|lower max_tokens|No API key set|Provider is not configured|401|502|503|504|fetch failed|ECONNRESET|ETIMEDOUT/i.test(s);
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
export function attachOpenWeightsFailover(models, { cooldownMs = 5 * 60_000, localModelId = process.env.LOCAL_LLAMA_MODEL || DEFAULT_LOCAL_LLAMA_MODEL } = {}) {
  const origStreamSimple = models.streamSimple.bind(models);
  let llmgatewayTrippedUntil = 0;

  function prependBannerToMessage(msg, banner) {
    if (!msg || !banner) return msg;
    const content = Array.isArray(msg.content) ? msg.content.map((c) => ({ ...c })) : [];
    const textIdx = content.findIndex((c) => c && c.type === "text" && typeof c.text === "string");
    if (textIdx >= 0) {
      if (!content[textIdx].text.startsWith(banner)) {
        content[textIdx] = { ...content[textIdx], text: banner + content[textIdx].text };
      }
    } else {
      content.unshift({ type: "text", text: banner.trimEnd() });
    }
    return { ...msg, content };
  }

  function buildFailoverChain(model) {
    const chain = [];
    const seen = new Set();
    const push = (m) => {
      if (!m) return;
      const key = `${m.provider}:${m.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        chain.push(m);
      }
    };
    const skipPrimary =
      model?.provider === "llmgateway" &&
      Boolean(process.env.ALLMODELS_API_KEY) &&
      (!process.env.LLMGATEWAY_API_KEY || Date.now() < llmgatewayTrippedUntil);
    if (!skipPrimary) push(model);
    if (process.env.ALLMODELS_API_KEY) {
      if (model?.provider === "llmgateway") {
        const mappedId = LLMGATEWAY_TO_ALLMODELS_MAP[model.id] || "deepseek/deepseek-v4.1-flash-abliterated";
        push(models.getModel("allmodels", mappedId));
      }
      if (model?.provider === "llmgateway" || model?.provider === "allmodels") {
        push(models.getModel("allmodels", "z-ai/glm-5.3-abliterated"));
        push(models.getModel("allmodels", "deepseek/deepseek-v4.1-flash-abliterated"));
      }
    }
    // Tier-3 emergency local failsafe (`local-llama` via local llama-server)
    if (model?.provider !== "local-llama") {
      const localModel =
        models.getModel("local-llama", localModelId) ||
        models.getModel("local-llama", DEFAULT_LOCAL_LLAMA_MODEL);
      if (localModel) push(localModel);
    }
    return chain;
  }

  models.streamSimple = function streamSimpleWithFailover(model, context, options) {
    const chain = buildFailoverChain(model);
    if (chain.length <= 1) {
      return origStreamSimple(chain[0] || model, context, options);
    }

    const outer = new AssistantMessageEventStream();
    (async () => {
      let lastError = null;
      const failedAttempts = [];
      for (let idx = 0; idx < chain.length; idx++) {
        const candidate = chain[idx];
        const hasNext = idx < chain.length - 1;
        const isLocalFailsafeHop = candidate.provider === "local-llama" && failedAttempts.length > 0;
        const failsafeBanner = isLocalFailsafeHop
          ? formatLocalFailsafeBanner({ failedAttempts, localModelId: candidate.id })
          : "";
        const callContext = isLocalFailsafeHop
          ? {
              ...context,
              systemPrompt: `${context?.systemPrompt ? `${context.systemPrompt}\n\n` : ""}EMERGENCY FAILSAFE MODE: All cloud APIs just failed (${failedAttempts.map((a) => `${a.provider}: ${String(a.error || "").slice(0, 80)}`).join("; ")}). Tell the user clearly that you are the local failsafe agent, summarize the outage briefly, and help as best you can without pretending to be the cloud frontier model.`,
            }
          : context;
        const stream = origStreamSimple(candidate, callContext, options);
        const buffered = [];
        let emittedContent = false;
        let terminalError = null;
        let doneMessage = null;
        let bannerEmitted = false;

        const transformEvent = (ev) => {
          if (!failsafeBanner) return ev;
          if (ev.type === "done" && ev.message) {
            return { ...ev, message: prependBannerToMessage(ev.message, failsafeBanner) };
          }
          if (ev.type === "text_delta" && !bannerEmitted) {
            bannerEmitted = true;
            return {
              ...ev,
              delta: failsafeBanner + (ev.delta || ""),
              partial: ev.partial ? prependBannerToMessage(ev.partial, failsafeBanner) : ev.partial,
            };
          }
          if (ev.partial) {
            return { ...ev, partial: prependBannerToMessage(ev.partial, failsafeBanner) };
          }
          return ev;
        };

        for await (const rawEv of stream) {
          if (rawEv.type === "error") {
            terminalError = rawEv.error;
            break;
          }
          const ev = transformEvent(rawEv);
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

        if (!emittedContent && terminalError && hasNext && isFailoverEligibleError(terminalError.errorMessage) && !options?.signal?.aborted) {
          failedAttempts.push({
            provider: candidate.provider,
            model: candidate.id,
            error: terminalError.errorMessage || "error",
          });
          if (
            candidate.provider === "llmgateway" &&
            /402|billing_error|insufficient_balance|insufficient_quota|insufficient credits|Insufficient Balance|No API key set/i.test(
              terminalError.errorMessage || "",
            )
          ) {
            llmgatewayTrippedUntil = Date.now() + cooldownMs;
          }
          lastError = terminalError;
          continue;
        }

        while (buffered.length > 0) outer.push(buffered.shift());
        if (terminalError) {
          // If local failsafe ALSO failed after cloud failures, report the full chain so failure is never silent
          const enrichedError =
            failedAttempts.length > 0
              ? {
                  ...terminalError,
                  errorMessage: `All cloud + local failsafe models failed: ${failedAttempts
                    .map((a) => `${a.provider}/${a.model} (${String(a.error).slice(0, 90)})`)
                    .join("; ")}; ${candidate.provider}/${candidate.id} (${String(terminalError.errorMessage || "error").slice(0, 90)})`,
                }
              : terminalError;
          outer.push({ type: "error", reason: options?.signal?.aborted ? "aborted" : "error", error: enrichedError });
          outer.end(enrichedError);
        } else {
          let res = doneMessage ?? (typeof stream.result === "function" ? await stream.result() : undefined);
          if (failsafeBanner && res) res = prependBannerToMessage(res, failsafeBanner);
          outer.end(res);
        }
        return;
      }

      if (lastError) {
        outer.push({ type: "error", reason: "error", error: lastError });
        outer.end(lastError);
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
        if (!payload || typeof payload !== "object") return payload;
        const cap = model.maxTokens || 8192;
        const next = {
          ...payload,
          max_tokens: payload.max_tokens ? Math.min(Number(payload.max_tokens), cap) : cap,
        };
        if (model.id === "deepseek/deepseek-v4.1-flash-abliterated") {
          next.provider = { order: ["lyber", "hopper", "abliteration"], allow_fallbacks: true };
        }
        return next;
      }),
    }),
  );

  const localLlamaUrl = (process.env.LOCAL_LLAMA_URL || "").trim().replace(/\/+$/, "");
  if (localLlamaUrl) {
    const localModelId = (process.env.LOCAL_LLAMA_MODEL || DEFAULT_LOCAL_LLAMA_MODEL).trim();
    const localBaseUrl = localLlamaUrl.endsWith("/v1") ? localLlamaUrl : `${localLlamaUrl}/v1`;
    const localCtx = Number(process.env.LOCAL_LLAMA_CTX || 16384);
    models.setProvider(
      createProvider({
        id: "local-llama",
        name: "Local llama.cpp Failsafe",
        baseUrl: localBaseUrl,
        auth: {
          apiKey: {
            name: "Local llama-server key (optional)",
            login: async () => ({ type: "api_key", key: process.env.LOCAL_LLAMA_API_KEY || "local-failsafe" }),
            resolve: async () => ({
              auth: { apiKey: process.env.LOCAL_LLAMA_API_KEY || "local-failsafe" },
              source: "LOCAL_LLAMA_URL",
            }),
          },
        },
        models: [
          {
            id: localModelId,
            name: `${localModelId} (local CPU failsafe)`,
            api: "openai-completions",
            provider: "local-llama",
            baseUrl: localBaseUrl,
            type: "chat",
            contextWindow: localCtx,
            maxTokens: 2048,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            compat: {
              supportsStore: false,
              supportsDeveloperRole: false,
              maxTokensField: "max_tokens",
              supportsStrictMode: false,
            },
          },
        ],
        api: openAICompletionsApi(),
      }),
    );
  }

  return enableFailover ? attachOpenWeightsFailover(models) : models;
}
