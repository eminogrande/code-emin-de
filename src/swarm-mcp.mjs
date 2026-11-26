#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

export const DEFAULT_SOCKET = "/home/swarm/.pi-durable/swarm.sock";
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_TEXT_LENGTH = 32_768;

const STATUS_MARKER = "\n__SWARM_MCP_HTTP_STATUS__:";
const STATUS_WRITE_OUT = "\\n__SWARM_MCP_HTTP_STATUS__:%{http_code}";

function concise(value, max = 400) {
  const text = String(value || "Unknown error").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function quoteRemote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function responseError(status, raw) {
  let detail = "";
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.error === "string") detail = `: ${concise(parsed.error, 240)}`;
  } catch {}
  return new Error(`Swarm daemon HTTP ${status}${detail}`);
}

function abortError() {
  const error = new Error("Swarm request aborted");
  error.name = "AbortError";
  return error;
}

function closedError() {
  return new Error("SSH transport is closed");
}

export function createSshTransport({
  env = process.env,
  host = env.SWARM_MCP_SSH_HOST || "swarm-host",
  socket = env.SWARM_MCP_SOCKET || DEFAULT_SOCKET,
  spawnImpl = spawn,
  killImpl = process.kill,
  platform = process.platform,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be positive");
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new Error("maxResponseBytes must be a positive integer");
  }

  const active = new Set();
  let closed = false;
  const executor = {
    request(method, path, body, { signal } = {}) {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
      const curlArgs = [
        "curl",
        "--silent",
        "--show-error",
        "--unix-socket",
        socket,
        "--request",
        method,
        "--write-out",
        STATUS_WRITE_OUT,
        ...(payload
          ? ["--header", "Content-Type: application/json", "--data-binary", "@-"]
          : []),
        `http://localhost${path}`,
      ];

      return new Promise((resolve, reject) => {
        let child;
        let record;
        let timer;
        let settled = false;
        let stdoutLength = 0;
        let stderrLength = 0;
        const stdout = [];
        const stderr = [];

        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          active.delete(record);
          if (!child) return;
          child.stdout.off("data", onStdout);
          child.stderr.off("data", onStderr);
          child.stdin.off("error", onStdinError);
          child.off("error", onChildError);
          child.off("close", onClose);
        };
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (error) reject(error);
          else resolve(value);
        };
        const kill = () => {
          if (!child || child.exitCode != null || child.signalCode != null) return;
          if (platform !== "win32" && Number.isInteger(child.pid) && child.pid > 0) {
            try {
              killImpl(-child.pid, "SIGKILL");
              return;
            } catch {}
          }
          try {
            child.kill("SIGKILL");
          } catch {}
        };
        const stop = (error) => {
          if (settled) return;
          kill();
          child?.stdin.destroy();
          child?.stdout.destroy();
          child?.stderr.destroy();
          finish(error);
        };
        const onAbort = () => stop(abortError());
        const onStdout = (chunk) => {
          if (settled) return;
          stdoutLength += chunk.length;
          if (stdoutLength > maxResponseBytes) {
            stop(new Error(`Swarm response exceeded ${maxResponseBytes} bytes`));
            return;
          }
          stdout.push(chunk);
        };
        const onStderr = (chunk) => {
          if (settled || stderrLength >= 8192) return;
          const remaining = 8192 - stderrLength;
          stderr.push(chunk.subarray(0, remaining));
          stderrLength += Math.min(chunk.length, remaining);
        };
        const onChildError = (error) => stop(new Error(`SSH request failed: ${concise(error.message)}`));
        const onStdinError = (error) => stop(new Error(`Failed to send SSH request: ${concise(error.message)}`));
        const onClose = (code, exitSignal) => {
          if (settled) return;
          if (code !== 0) {
            const detail = concise(Buffer.concat(stderr).toString("utf8"), 240);
            const exit = exitSignal ? `signal ${exitSignal}` : `code ${code}`;
            finish(new Error(`SSH/curl exited with ${exit}${detail ? `: ${detail}` : ""}`));
            return;
          }

          const raw = Buffer.concat(stdout).toString("utf8");
          const markerAt = raw.lastIndexOf(STATUS_MARKER);
          if (markerAt < 0) {
            finish(new Error("SSH/curl response did not include an HTTP status"));
            return;
          }
          const statusText = raw.slice(markerAt + STATUS_MARKER.length).trim();
          const status = Number(statusText);
          const responseText = raw.slice(0, markerAt);
          if (!/^\d{3}$/.test(statusText) || !Number.isInteger(status)) {
            finish(new Error("SSH/curl returned an invalid HTTP status"));
            return;
          }
          if (status < 200 || status >= 300) {
            finish(responseError(status, responseText));
            return;
          }
          try {
            finish(null, JSON.parse(responseText));
          } catch {
            finish(new Error(`Swarm daemon returned invalid JSON (HTTP ${status})`));
          }
        };

        try {
          child = spawnImpl("ssh", [host, curlArgs.map(quoteRemote).join(" ")], {
            shell: false,
            detached: platform !== "win32",
            stdio: ["pipe", "pipe", "pipe"],
          });
        } catch (error) {
          finish(new Error(`SSH request failed: ${concise(error.message)}`));
          return;
        }
        record = { stop };
        active.add(record);
        child.stdout.on("data", onStdout);
        child.stderr.on("data", onStderr);
        child.stdin.on("error", onStdinError);
        child.once("error", onChildError);
        child.once("close", onClose);
        signal?.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => stop(new Error(`Swarm request timed out after ${timeoutMs}ms`)), timeoutMs);
        if (closed) {
          stop(closedError());
          return;
        }
        if (signal?.aborted) {
          stop(abortError());
          return;
        }
        try {
          child.stdin.end(payload);
        } catch (error) {
          onStdinError(error);
        }
      });
    },
  };

  let queue = Promise.resolve();
  return {
    request(method, path, body, { signal } = {}) {
      if (signal?.aborted) return Promise.reject(abortError());
      if (closed) return Promise.reject(closedError());
      let onAbort;
      const cancellation = new Promise((_, reject) => {
        onAbort = () => reject(abortError());
        signal?.addEventListener("abort", onAbort, { once: true });
      });
      const operation = queue.then(() => {
        if (signal?.aborted) throw abortError();
        if (closed) throw closedError();
        return executor.request(method, path, body, { signal });
      });
      queue = operation.catch(() => {});
      return Promise.race([operation, cancellation]).finally(() => {
        signal?.removeEventListener("abort", onAbort);
      });
    },
    close() {
      if (closed) return;
      closed = true;
      for (const record of [...active]) record.stop(closedError());
    },
  };
}

function success(value) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") > DEFAULT_MAX_RESPONSE_BYTES) {
    return {
      isError: true,
      content: [{ type: "text", text: `Tool result exceeds ${DEFAULT_MAX_RESPONSE_BYTES}-byte limit` }],
    };
  }
  return {
    content: [{ type: "text", text }],
    structuredContent: value,
  };
}

function failure(tool, error) {
  return {
    isError: true,
    content: [{ type: "text", text: `${tool} failed: ${concise(error?.message || error)}` }],
  };
}

function objectResponse(value, endpoint) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${endpoint} returned a non-object JSON response`);
  }
  return value;
}

function arrayResponse(value, key, endpoint) {
  if (!Array.isArray(value?.[key])) throw new Error(`${endpoint} returned no ${key} array`);
  return value[key];
}

const textSchema = z.string().max(MAX_TEXT_LENGTH).refine((value) => value.trim().length > 0, {
  message: "text must not be empty",
});
const targetSchema = z.string().trim().min(1).max(256);
const normalizeTarget = (target) => target === "orchestration:general" ? "lead" : target;
const readOnly = { readOnlyHint: true, openWorldHint: true, idempotentHint: true };
const write = { readOnlyHint: false, openWorldHint: true, idempotentHint: false };

export function createSwarmMcpServer({ transport = createSshTransport() } = {}) {
  const request = transport.request.bind(transport);
  const server = new McpServer({ name: "emin-swarm", version: "1.0.0" });
  server.server.onclose = () => transport.close?.();

  server.registerTool("swarm_list", {
    title: "List swarm state",
    description: "Read lead status, orchestrations, and workers including live reasoning and tool activity.",
    inputSchema: { orchestrationId: z.string().trim().min(1).max(256).optional() },
    annotations: readOnly,
  }, async ({ orchestrationId }, { signal }) => {
    try {
      const status = objectResponse(await request("GET", "/status", undefined, { signal }), "/status");
      const [rawWorkers, rawOrchestrations] = await Promise.all([
        request("GET", "/workers", undefined, { signal }),
        request("GET", "/orchestrations", undefined, { signal }),
      ]);
      const workers = arrayResponse(rawWorkers, "workers", "/workers");
      const orchestrations = arrayResponse(rawOrchestrations, "orchestrations", "/orchestrations");
      return success({
        status: {
          lead: status.lead ?? null,
          liveTasks: status.liveTasks ?? 0,
          pendingSubmissions: status.pendingSubmissions ?? 0,
          usage: status.usage ?? null,
        },
        orchestrations: orchestrationId
          ? orchestrations.filter((item) => item?.id === orchestrationId)
          : orchestrations,
        workers: orchestrationId
          ? workers.filter((item) => (item?.orchestrationId || "general") === orchestrationId)
          : workers,
      });
    } catch (error) {
      return failure("swarm_list", error);
    }
  });

  server.registerTool("swarm_read", {
    title: "Read swarm transcript",
    description: "Read transcript entries and live chain-of-thought, including text, thinking, and tool activity.",
    inputSchema: {
      conversationId: z.number().int().positive().default(1),
      max: z.number().int().min(1).max(200).default(40),
    },
    annotations: readOnly,
  }, async ({ conversationId, max }, { signal }) => {
    try {
      const raw = objectResponse(
        await request("GET", `/transcript?convId=${conversationId}&max=${max}`, undefined, { signal }),
        "/transcript",
      );
      if (!Array.isArray(raw.entries)) throw new Error("/transcript returned no entries array");
      return success({
        conversationId: raw.conversationId ?? conversationId,
        entries: raw.entries,
        live: raw.live ?? null,
      });
    } catch (error) {
      return failure("swarm_read", error);
    }
  });

  server.registerTool("swarm_prompt", {
    title: "Prompt swarm",
    description: "Submit a non-blocking prompt to lead, orchestration:<id>, or a worker; poll progress with swarm_read.",
    inputSchema: {
      text: textSchema,
      target: targetSchema.default("lead"),
    },
    annotations: write,
  }, async ({ text, target }, { signal }) => {
    try {
      const raw = await request("POST", "/chat", {
        text,
        steer: false,
        targetWorkerId: normalizeTarget(target),
        wait: false,
      }, { signal });
      return success(objectResponse(raw, "/chat"));
    } catch (error) {
      return failure("swarm_prompt", error);
    }
  });

  server.registerTool("swarm_steer", {
    title: "Steer swarm",
    description: "Inject non-blocking guidance into lead, orchestration:<id>, or a worker.",
    inputSchema: { text: textSchema, target: targetSchema },
    annotations: write,
  }, async ({ text, target }, { signal }) => {
    try {
      const raw = await request("POST", "/chat", {
        text,
        steer: true,
        wait: false,
        targetWorkerId: normalizeTarget(target),
      }, { signal });
      return success(objectResponse(raw, "/chat"));
    } catch (error) {
      return failure("swarm_steer", error);
    }
  });

  server.registerTool("memory_wake", {
    title: "Read OptMem wake summary",
    description: "Read shared cross-session OptMem summary from code.emin.de.",
    inputSchema: {},
    annotations: readOnly,
  }, async (_args, { signal }) => {
    try {
      return success(objectResponse(await request("GET", "/memory/wake", undefined, { signal }), "/memory/wake"));
    } catch (error) {
      return failure("memory_wake", error);
    }
  });

  server.registerTool("memory_recall", {
    title: "Search OptMem history",
    description: "Regex search every raw OptMem memory recorded on code.emin.de.",
    inputSchema: { pattern: z.string().trim().min(1).max(256) },
    annotations: readOnly,
  }, async ({ pattern }, { signal }) => {
    try {
      const path = `/memory/recall?pattern=${encodeURIComponent(pattern)}`;
      return success(objectResponse(await request("GET", path, undefined, { signal }), "/memory/recall"));
    } catch (error) {
      return failure("memory_recall", error);
    }
  });

  server.registerTool("memory_note", {
    title: "Save OptMem memory",
    description: "Record one permanent cross-session memory (<=275 chars) on code.emin.de.",
    inputSchema: { note: z.string().trim().min(1).max(275) },
    annotations: write,
  }, async ({ note }, { signal }) => {
    try {
      return success(objectResponse(await request("POST", "/memory/note", { note }, { signal }), "/memory/note"));
    } catch (error) {
      return failure("memory_note", error);
    }
  });

  return server;
}

export async function startSwarmMcpServer(options = {}) {
  const server = createSwarmMcpServer(options);
  await server.connect(new StdioServerTransport());
  return server;
}

const isDirectMain = process.argv[1]
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (isDirectMain) {
  startSwarmMcpServer().catch((error) => {
    console.error(`swarm-mcp: ${concise(error?.message || error)}`);
    process.exitCode = 1;
  });
}
