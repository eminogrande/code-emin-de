const DECISIONS_URL = "https://api.llmgateway.io/v1/decisions";

/**
 * Call TypeSafe Jev (`jev-latest`) via LLMGateway `/v1/decisions`.
 * Strict validation + deterministic fail-open fallback so lack of network/credits never crashes the daemon.
 */
export async function askJevDecision(input, questions, { apiKey = process.env.LLMGATEWAY_API_KEY, timeoutMs = 3500 } = {}) {
  if (!apiKey) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(DECISIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "jev-latest", input: String(input).slice(0, 50_000), questions }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data?.answers)) return null;
    return { answers: data.answers, usage: data.usage ?? {} };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function fallbackWatcherTriage(kind, text) {
  const s = String(text || "");
  if (kind === "support" || kind === "social") {
    return s.trim().length > 0 ? { action: "draft_only", source: "deterministic" } : { action: "stay_silent", source: "deterministic" };
  }
  if (/\b(50[0234]|SQLITE_FULL|ENOSPC|OOM|panic|fatal|ECONNREFUSED|segfault|unauthorized root)\b/i.test(s)) {
    return { action: "page_immediately", source: "deterministic" };
  }
  if (/\b(error|exception|unhandled|failed)\b/i.test(s) && !/\b0\s+(new\s+)?(5xx|errors?)\b/i.test(s)) {
    return { action: "draft_only", source: "deterministic" };
  }
  return { action: "stay_silent", source: "deterministic" };
}

export async function triageWatcherEvent(kind, eventText, opts = {}) {
  if (!eventText || !String(eventText).trim()) {
    return { action: "stay_silent", confidence: 1, source: "empty", costUsd: 0 };
  }
  // Hard deterministic rule: support & social NEVER page_immediately or auto-send; they only stay_silent or draft_only
  if (kind === "support" || kind === "social") {
    const jev = await askJevDecision(
      `[${kind.toUpperCase()}]\n${eventText}`,
      [
        {
          id: "action",
          type: "choice",
          instructions: "stay_silent on spam/bounces/empty noise; draft_only when a real human message needs a 1-ticket/human draft.",
          choices: [
            { value: "stay_silent", description: "Automated bounce, spam, empty ping, or no reply needed." },
            { value: "draft_only", description: "Real human inquiry or post requiring a human-reviewed draft." },
          ],
        },
      ],
      opts,
    );
    const picked = jev?.answers?.[0]?.choice;
    if (picked === "stay_silent" || picked === "draft_only") {
      return { action: picked, confidence: jev.answers[0].confidence ?? 1, source: "jev", costUsd: jev.usage?.cost ?? 0 };
    }
    return { ...fallbackWatcherTriage(kind, eventText), confidence: 1, costUsd: 0 };
  }

  const jev = await askJevDecision(
    `[LOG_WATCHER]\n${eventText}`,
    [
      {
        id: "action",
        type: "choice",
        instructions:
          "Forever-agent minimum-human-attention rule: stay_silent on routine 404s, bot scans, or 0 errors; draft_only on non-urgent warnings/bugs; page_immediately ONLY on active outage, 5xx spike, disk full, or security breach.",
        choices: [
          { value: "stay_silent", description: "Routine noise, bot 404s, green healthchecks." },
          { value: "draft_only", description: "Non-urgent bug/warning worth a draft ticket." },
          { value: "page_immediately", description: "Critical outage, 5xx spike, disk full, security incident." },
        ],
      },
    ],
    opts,
  );
  const picked = jev?.answers?.[0]?.choice;
  if (picked === "stay_silent" || picked === "draft_only" || picked === "page_immediately") {
    return { action: picked, confidence: jev.answers[0].confidence ?? 1, source: "jev", costUsd: jev.usage?.cost ?? 0 };
  }
  return { ...fallbackWatcherTriage(kind, eventText), confidence: 1, costUsd: 0 };
}

export async function classifyUserPrompt(promptText, opts = {}) {
  const trimmed = String(promptText || "").trim();
  if (/^\/btw(?:\s+|$)/i.test(trimmed)) {
    return { route: "side_chat_readonly", cleanPrompt: trimmed.replace(/^\/btw\s*/i, ""), source: "prefix" };
  }
  const jev = await askJevDecision(
    trimmed,
    [
      {
        id: "route",
        type: "choice",
        instructions: "fanout_parallel ONLY if user message asks >=2 concrete, independent build/fix tasks to execute now; single_agent for questions, brainstorming, clarifications, or 1 task.",
        choices: [
          { value: "fanout_parallel", description: "2 or more concrete, unambiguous build/fix tasks that should spin into parallel background workers." },
          { value: "single_agent", description: "Questions, brainstorming, ambiguous ideas, 1 task, or tightly coupled follow-up." },
        ],
      },
    ],
    opts,
  );
  const picked = jev?.answers?.[0]?.choice;
  if (picked === "fanout_parallel" || picked === "single_agent") {
    return { route: picked, cleanPrompt: trimmed, confidence: jev.answers[0].confidence ?? 1, source: "jev" };
  }
  // Deterministic fallback: detect >=2 concrete actionable bulleted/numbered items (ignore pure question items ending with '?')
  const noCode = trimmed.replace(/```[\s\S]*?```/g, "");
  const items = (noCode.match(/^(?:\d+[.)]|[-*])\s+\S.*$/gm) || []).filter((line) => !/\?\s*$/.test(line.trim()));
  return { route: items.length >= 2 ? "fanout_parallel" : "single_agent", cleanPrompt: trimmed, source: "deterministic" };
}
