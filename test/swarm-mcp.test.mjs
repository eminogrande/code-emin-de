import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createSshTransport,
  createSwarmMcpServer,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_SOCKET,
  MAX_TEXT_LENGTH,
} from "../src/swarm-mcp.mjs";

const execFileAsync = promisify(execFile);
const STATUS_MARKER = "\n__SWARM_MCP_HTTP_STATUS__:";

async function backendFixture(t, transport) {
  const server = createSwarmMcpServer({ transport });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "swarm-test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
  });
  return { client, server };
}

async function mcpFixture(t, handler) {
  const calls = [];
  const signals = [];
  const transport = {
    async request(method, path, body, options) {
      calls.push({ method, path, body });
      signals.push(options?.signal);
      return handler(method, path, body);
    },
  };
  const { client, server } = await backendFixture(t, transport);
  return { client, server, calls, signals };
}

function routes(values) {
  return async (method, path, body) => {
    const value = values[`${method} ${path}`];
    if (typeof value === "function") return value(body);
    if (value instanceof Error) throw value;
    if (value === undefined) throw new Error(`Unexpected request: ${method} ${path}`);
    return value;
  };
}

function fakeSpawn({ status = 200, response = { ok: true }, closeCode = 0, stderr = "" } = {}) {
  const state = { calls: [], input: "", children: [] };
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = (signal) => {
      child.killed = true;
      child.killSignal = signal;
      return true;
    };
    state.calls.push({ command, args, options, child });
    state.children.push(child);
    child.stdin.on("data", (chunk) => {
      state.input += chunk.toString("utf8");
    });
    child.stdin.on("end", () => {
      queueMicrotask(() => {
        if (response !== null) {
          child.stdout.end(`${typeof response === "string" ? response : JSON.stringify(response)}${STATUS_MARKER}${status}`);
        }
        child.stderr.end(stderr);
        queueMicrotask(() => child.emit("close", closeCode, null));
      });
    });
    return child;
  };
  return { state, spawnImpl };
}

function stubChild(pid) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.kill = (signal) => {
    child.killed = true;
    child.killSignal = signal;
    return true;
  };
  return child;
}

function succeedChild(child, response = { ok: true }) {
  child.stdout.write(`${JSON.stringify(response)}${STATUS_MARKER}200`);
  child.exitCode = 0;
  child.emit("close", 0, null);
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function expectedCurl({ method, path, body = false, socket = DEFAULT_SOCKET }) {
  const quote = (value) => `'${String(value).replaceAll("'", `'"'"'`)}'`;
  return [
    "curl",
    "--silent",
    "--show-error",
    "--unix-socket",
    socket,
    "--request",
    method,
    "--write-out",
    "\\n__SWARM_MCP_HTTP_STATUS__:%{http_code}",
    ...(body ? ["--header", "Content-Type: application/json", "--data-binary", "@-"] : []),
    `http://localhost${path}`,
  ].map(quote).join(" ");
}

test("1. real MCP initialize/list/call exposes exactly four annotated tools and shaped list data", async (t) => {
  const status = {
    swarm: { workers: { secret: true } },
    hooks: [{ name: "not-in-projection" }],
    lead: { model: "test-model", busy: true },
    liveTasks: 3,
    pendingSubmissions: 2,
    usage: { totalTokens: 91, costUsd: 0.25, byModel: { test: { totalTokens: 91 } } },
  };
  const workers = [
    {
      id: "w-research",
      orchestrationId: "research",
      live: {
        running: true,
        text: "partial",
        thinking: "reasoning",
        toolCalls: ["read_file"],
        tools: [{ name: "read_file", status: "running" }],
      },
      lastThinking: "older reasoning",
    },
    { id: "w-general", live: { thinking: "general CoT" } },
    { id: "w-other", orchestrationId: "other" },
  ];
  const orchestrations = [
    { id: "general", name: "General", conversationId: 1, live: { thinking: "lead CoT" } },
    { id: "research", name: "Research", conversationId: 8, state: "running" },
    { id: "other", name: "Other", conversationId: 9 },
  ];
  const { client, calls, signals } = await mcpFixture(t, routes({
    "GET /status": status,
    "GET /workers": { workers, status: { ignored: true } },
    "GET /orchestrations": { orchestrations },
  }));

  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
    "memory_note",
    "memory_recall",
    "memory_wake",
    "swarm_list",
    "swarm_prompt",
    "swarm_read",
    "swarm_steer",
  ]);
  for (const name of ["swarm_list", "swarm_read"]) {
    const tool = listed.tools.find((item) => item.name === name);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.openWorldHint, true);
  }
  for (const name of ["swarm_prompt", "swarm_steer"]) {
    const tool = listed.tools.find((item) => item.name === name);
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.equal(tool.annotations.openWorldHint, true);
  }
  assert.equal(listed.tools.find((tool) => tool.name === "swarm_prompt").inputSchema.properties.wait, undefined);

  const result = await client.callTool({ name: "swarm_list", arguments: {} });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    status: {
      lead: status.lead,
      liveTasks: 3,
      pendingSubmissions: 2,
      usage: status.usage,
    },
    orchestrations,
    workers,
  });
  assert.equal("swarm" in result.structuredContent.status, false);
  assert.equal("hooks" in result.structuredContent.status, false);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.deepEqual(result.structuredContent.workers[0].live, workers[0].live);
  assert.deepEqual(calls.map(({ method, path }) => ({ method, path })).sort((a, b) => a.path.localeCompare(b.path)), [
    { method: "GET", path: "/orchestrations" },
    { method: "GET", path: "/status" },
    { method: "GET", path: "/workers" },
  ]);
  assert.equal(signals.length, 3);
  assert.ok(signals.every((signal) => signal instanceof AbortSignal));
  assert.equal(new Set(signals).size, 1);
});

test("2. swarm_list filters orchestrations and workers without dropping live activity", async (t) => {
  const workers = [
    { id: "w-general", live: { thinking: "general" } },
    { id: "w-research", orchestrationId: "research", live: { tools: [{ name: "bash", status: "done" }] } },
    { id: "w-other", orchestrationId: "other" },
  ];
  const orchestrations = [
    { id: "general", conversationId: 1 },
    { id: "research", conversationId: 7, live: { toolCalls: ["spawn_worker"] } },
  ];
  const { client } = await mcpFixture(t, routes({
    "GET /status": { lead: null, liveTasks: 0, pendingSubmissions: 0, usage: null, swarm: {} },
    "GET /workers": { workers },
    "GET /orchestrations": { orchestrations },
  }));
  const research = await client.callTool({ name: "swarm_list", arguments: { orchestrationId: "research" } });
  assert.deepEqual(research.structuredContent.orchestrations, [orchestrations[1]]);
  assert.deepEqual(research.structuredContent.workers, [workers[1]]);

  const general = await client.callTool({ name: "swarm_list", arguments: { orchestrationId: "general" } });
  assert.deepEqual(general.structuredContent.orchestrations, [orchestrations[0]]);
  assert.deepEqual(general.structuredContent.workers, [workers[0]]);
});

test("3. swarm_read applies defaults, bounds the query, and passes transcript/live CoT through", async (t) => {
  const entries = [{
    id: 4,
    role: "assistant",
    text: "answer",
    thinking: "entry reasoning",
    toolCalls: ["read_file"],
    tools: [{ name: "read_file", status: "done", output: "entry tool output" }],
  }];
  const live = {
    running: true,
    text: "partial answer",
    thinking: "live reasoning",
    toolCalls: ["bash"],
    tools: [{ name: "bash", status: "running", output: "live tool output" }],
  };
  const { client, calls } = await mcpFixture(t, routes({
    "GET /transcript?convId=1&max=40": { conversationId: 1, entries, live },
    "GET /transcript?convId=17&max=200": { conversationId: 17, entries: [], live: null },
  }));

  const first = await client.callTool({ name: "swarm_read", arguments: {} });
  assert.deepEqual(first.structuredContent, { conversationId: 1, entries, live });
  assert.deepEqual(JSON.parse(first.content[0].text).live, live);
  const second = await client.callTool({ name: "swarm_read", arguments: { conversationId: 17, max: 200 } });
  assert.deepEqual(second.structuredContent, { conversationId: 17, entries: [], live: null });
  assert.deepEqual(calls.map((call) => call.path), [
    "/transcript?convId=1&max=40",
    "/transcript?convId=17&max=200",
  ]);
});

test("4. swarm_prompt always submits non-blocking lead, worker, and orchestration prompts", async (t) => {
  const replies = [];
  const { client, calls } = await mcpFixture(t, async (method, path, body) => {
    assert.equal(method, "POST");
    assert.equal(path, "/chat");
    const reply = { route: "queued", submissionId: `sub-${replies.length + 1}`, conversationId: replies.length + 1 };
    replies.push(reply);
    return reply;
  });

  const lead = await client.callTool({ name: "swarm_prompt", arguments: { text: "hello lead" } });
  const worker = await client.callTool({
    name: "swarm_prompt",
    arguments: { text: "worker task", target: "w-123" },
  });
  const orchestration = await client.callTool({
    name: "swarm_prompt",
    arguments: { text: "orchestration task", target: "orchestration:research" },
  });
  const general = await client.callTool({
    name: "swarm_prompt",
    arguments: { text: "general task", target: "orchestration:general" },
  });
  assert.deepEqual(calls.map((call) => call.body), [
    { text: "hello lead", steer: false, targetWorkerId: "lead", wait: false },
    { text: "worker task", steer: false, targetWorkerId: "w-123", wait: false },
    { text: "orchestration task", steer: false, targetWorkerId: "orchestration:research", wait: false },
    { text: "general task", steer: false, targetWorkerId: "lead", wait: false },
  ]);
  assert.deepEqual(lead.structuredContent, replies[0]);
  assert.deepEqual(worker.structuredContent, replies[1]);
  assert.deepEqual(orchestration.structuredContent, replies[2]);
  assert.deepEqual(general.structuredContent, replies[3]);
});

test("5. swarm_steer always submits non-blocking steering to the required target", async (t) => {
  const daemonReply = { route: "fanout_parallel", submissionId: "sub-steer", conversationId: 22 };
  const { client, calls } = await mcpFixture(t, routes({ "POST /chat": daemonReply }));
  const result = await client.callTool({
    name: "swarm_steer",
    arguments: { text: "focus on tests", target: "orchestration:research" },
  });
  assert.deepEqual(result.structuredContent, daemonReply);
  const general = await client.callTool({
    name: "swarm_steer",
    arguments: { text: "general guidance", target: "orchestration:general" },
  });
  assert.deepEqual(general.structuredContent, daemonReply);
  assert.deepEqual(calls, [{
    method: "POST",
    path: "/chat",
    body: { text: "focus on tests", steer: true, wait: false, targetWorkerId: "orchestration:research" },
  }, {
    method: "POST",
    path: "/chat",
    body: { text: "general guidance", steer: true, wait: false, targetWorkerId: "lead" },
  }]);
});

test("6. invalid tool input returns MCP errors without calling the backend", async (t) => {
  const { client, calls } = await mcpFixture(t, async () => ({ ok: true }));
  const invalid = [
    ["swarm_read", { conversationId: 0 }],
    ["swarm_read", { conversationId: 1.5 }],
    ["swarm_read", { max: 0 }],
    ["swarm_read", { max: 201 }],
    ["swarm_prompt", { text: "  \n" }],
    ["swarm_prompt", { text: "x".repeat(MAX_TEXT_LENGTH + 1) }],
    ["swarm_prompt", { text: "valid", target: "" }],
    ["swarm_steer", { text: "missing target" }],
  ];
  for (const [name, args] of invalid) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, `${name} ${JSON.stringify(args).slice(0, 100)}`);
    assert.equal(typeof result.content[0].text, "string");
  }
  assert.equal(calls.length, 0);
});

test("7. transport failures become concise tool errors and POST is not retried", async (t) => {
  let attempts = 0;
  const { client } = await mcpFixture(t, async () => {
    attempts += 1;
    throw new Error("ssh unavailable\nwith a stack-like second line");
  });
  const result = await client.callTool({ name: "swarm_prompt", arguments: { text: "do not retry" } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /^swarm_prompt failed: ssh unavailable with a stack-like second line$/);
  assert.equal(result.structuredContent, undefined);
  assert.equal(attempts, 1);
});

test("8. SSH/curl uses no local shell, quotes the URL, and streams only the JSON POST body", async () => {
  const { state, spawnImpl } = fakeSpawn({ response: { route: "queued", submissionId: "s1" } });
  const transport = createSshTransport({ host: "example-host", spawnImpl });
  const body = { text: "hello \"remote\"", steer: false, targetWorkerId: "lead", wait: false };
  const result = await transport.request("POST", "/chat", body);
  assert.deepEqual(result, { route: "queued", submissionId: "s1" });
  assert.equal(state.calls.length, 1);
  const [{ command, args, options, child }] = state.calls;
  assert.equal(command, "ssh");
  assert.deepEqual(args, ["example-host", expectedCurl({ method: "POST", path: "/chat", body: true })]);
  assert.deepEqual(options, {
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  assert.equal(state.input, JSON.stringify(body));
  assert.equal(child.stdin.writableEnded, true);

  const querySpawn = fakeSpawn({ response: { conversationId: 3, entries: [] } });
  const queryTransport = createSshTransport({ host: "example-host", spawnImpl: querySpawn.spawnImpl });
  await queryTransport.request("GET", "/transcript?convId=3&max=40");
  assert.deepEqual(querySpawn.state.calls[0].args, [
    "example-host",
    expectedCurl({ method: "GET", path: "/transcript?convId=3&max=40" }),
  ]);
  assert.match(querySpawn.state.calls[0].args[1], /'http:\/\/localhost\/transcript\?convId=3&max=40'/);
  assert.equal(querySpawn.state.input, "");
});

test("9. SSH transport reports HTTP and process errors without retrying POST", async () => {
  const http = fakeSpawn({ status: 500, response: { error: "daemon exploded" } });
  const httpTransport = createSshTransport({ spawnImpl: http.spawnImpl });
  await assert.rejects(httpTransport.request("POST", "/chat", { text: "once" }), /HTTP 500: daemon exploded/);
  assert.equal(http.state.calls.length, 1);

  const processFailure = fakeSpawn({ closeCode: 255, response: null, stderr: "connection refused" });
  const processTransport = createSshTransport({ spawnImpl: processFailure.spawnImpl });
  await assert.rejects(processTransport.request("POST", "/chat", { text: "once" }), /code 255: connection refused/);
  assert.equal(processFailure.state.calls.length, 1);
});

test("10. SSH transport enforces response size and request timeout", async () => {
  const oversized = fakeSpawn({ response: "x".repeat(100) });
  const limited = createSshTransport({ spawnImpl: oversized.spawnImpl, maxResponseBytes: 32 });
  await assert.rejects(limited.request("GET", "/status"), /response exceeded 32 bytes/);
  assert.equal(oversized.state.children[0].killed, true);
  assert.equal(oversized.state.children[0].killSignal, "SIGKILL");
  assert.equal(oversized.state.calls.length, 1);

  const hanging = new EventEmitter();
  hanging.stdin = new PassThrough();
  hanging.stdout = new PassThrough();
  hanging.stderr = new PassThrough();
  hanging.killed = false;
  hanging.kill = () => {
    hanging.killed = true;
    return true;
  };
  const timed = createSshTransport({ spawnImpl: () => hanging, timeoutMs: 20 });
  await assert.rejects(timed.request("GET", "/status"), /timed out after 20ms/);
  assert.equal(hanging.killed, true);
});

test("11. environment defaults select SSH host and socket without contacting a real host", async () => {
  const { state, spawnImpl } = fakeSpawn();
  const transport = createSshTransport({
    env: { SWARM_MCP_SSH_HOST: "env-host", SWARM_MCP_SOCKET: "/tmp/test swarm.sock" },
    spawnImpl,
  });
  await transport.request("GET", "/status");
  assert.equal(state.calls[0].args[0], "env-host");
  assert.deepEqual(state.calls[0].args[1], expectedCurl({
    method: "GET",
    path: "/status",
    socket: "/tmp/test swarm.sock",
  }));
});

test("12. SSH transport serializes concurrent requests and continues once after a failure", async () => {
  let active = 0;
  let maxActive = 0;
  const children = [];
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    child.sequence = children.length + 1;
    children.push(child);
    active += 1;
    maxActive = Math.max(maxActive, active);
    return child;
  };
  const transport = createSshTransport({ spawnImpl, timeoutMs: 1000 });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const succeed = async (child) => {
    child.stdout.write(`${JSON.stringify({ sequence: child.sequence })}${STATUS_MARKER}200`);
    active -= 1;
    child.emit("close", 0, null);
    await flush();
  };

  const requests = [
    transport.request("POST", "/chat", { text: "fail once" }),
    transport.request("POST", "/chat", { text: "queued post" }),
    transport.request("GET", "/status"),
    transport.request("GET", "/workers"),
  ];
  await flush();
  assert.equal(children.length, 1);
  assert.equal(active, 1);

  children[0].stderr.write("first failed");
  active -= 1;
  children[0].emit("close", 255, null);
  await assert.rejects(requests[0], /code 255: first failed/);
  await flush();
  assert.equal(children.length, 2);
  assert.equal(active, 1);

  await succeed(children[1]);
  assert.deepEqual(await requests[1], { sequence: 2 });
  assert.equal(children.length, 3);
  assert.equal(active, 1);

  await succeed(children[2]);
  assert.deepEqual(await requests[2], { sequence: 3 });
  assert.equal(children.length, 4);
  assert.equal(active, 1);

  await succeed(children[3]);
  assert.deepEqual(await requests[3], { sequence: 4 });
  assert.equal(children.length, 4);
  assert.equal(active, 0);
  assert.equal(maxActive, 1);
});

test("13. swarm_list awaits status before starting workers and orchestrations together", async (t) => {
  const resolvers = {};
  const { client, calls } = await mcpFixture(t, async (method, path) => new Promise((resolve) => {
    resolvers[path] = resolve;
  }));
  const pending = client.callTool({ name: "swarm_list", arguments: {} });
  await flush();
  assert.deepEqual(calls.map((call) => call.path), ["/status"]);

  resolvers["/status"]({ lead: null, liveTasks: 0, pendingSubmissions: 0, usage: null });
  await flush();
  assert.deepEqual(calls.map((call) => call.path), ["/status", "/workers", "/orchestrations"]);
  resolvers["/workers"]({ workers: [] });
  resolvers["/orchestrations"]({ orchestrations: [] });
  const result = await pending;
  assert.equal(result.isError, undefined);
});

test("14. cold status failure makes only one SSH attempt", async (t) => {
  const ssh = fakeSpawn({ status: 401, response: { error: "authentication required" } });
  const transport = createSshTransport({ spawnImpl: ssh.spawnImpl });
  const { client } = await backendFixture(t, transport);
  const result = await client.callTool({ name: "swarm_list", arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /HTTP 401: authentication required/);
  assert.equal(ssh.state.calls.length, 1);
});

test("15. aborted queued requests never spawn and do not block later calls", async () => {
  const children = [];
  const transport = createSshTransport({
    spawnImpl: () => {
      const child = stubChild();
      children.push(child);
      return child;
    },
    timeoutMs: 1000,
  });
  const first = transport.request("GET", "/status");
  await flush();
  assert.equal(children.length, 1);

  const controller = new AbortController();
  const cancelled = transport.request("GET", "/workers", undefined, { signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(
    transport.request("GET", "/orchestrations", undefined, { signal: alreadyAborted.signal }),
    { name: "AbortError" },
  );
  succeedChild(children[0], { lead: null });
  assert.deepEqual(await first, { lead: null });
  await flush();
  assert.equal(children.length, 1);

  const next = transport.request("GET", "/orchestrations");
  await flush();
  assert.equal(children.length, 2);
  succeedChild(children[1], { orchestrations: [] });
  assert.deepEqual(await next, { orchestrations: [] });
  transport.close();
});

test("16. aborting an active request kills it, cleans listeners, and preserves the queue", async () => {
  const children = [];
  const transport = createSshTransport({
    spawnImpl: () => {
      const child = stubChild();
      children.push(child);
      return child;
    },
    timeoutMs: 1000,
  });
  const controller = new AbortController();
  const active = transport.request("POST", "/chat", { text: "once" }, { signal: controller.signal });
  await flush();
  controller.abort();
  await assert.rejects(active, { name: "AbortError" });
  assert.equal(children.length, 1);
  assert.equal(children[0].killed, true);
  assert.equal(children[0].killSignal, "SIGKILL");
  assert.equal(children[0].listenerCount("close"), 0);
  assert.equal(children[0].listenerCount("error"), 0);
  assert.equal(children[0].stdout.listenerCount("data"), 0);
  assert.equal(children[0].stderr.listenerCount("data"), 0);
  assert.equal(children[0].stdin.listenerCount("error"), 0);

  const next = transport.request("GET", "/status");
  await flush();
  assert.equal(children.length, 2);
  succeedChild(children[1], { ok: true });
  assert.deepEqual(await next, { ok: true });
  transport.close();
});

test("17. MCP server close aborts active work and closes the SSH transport", async (t) => {
  const child = stubChild();
  const transport = createSshTransport({ spawnImpl: () => child, timeoutMs: 1000 });
  const { client, server } = await backendFixture(t, transport);
  const pending = client.callTool({ name: "swarm_read", arguments: {} });
  const rejection = assert.rejects(pending, /closed/i);
  await flush();
  await server.close();
  await rejection;
  assert.equal(child.killed, true);
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.stdout.listenerCount("data"), 0);
  await assert.rejects(transport.request("GET", "/status"), /SSH transport is closed/);
});

test("18. POSIX uses per-child process groups with fallback and Windows child kill", async () => {
  const groupKills = [];
  const posixChild = stubChild(7101);
  let posixOptions;
  const posix = createSshTransport({
    platform: "linux",
    spawnImpl: (command, args, options) => {
      posixOptions = options;
      return posixChild;
    },
    killImpl: (pid, signal) => groupKills.push([pid, signal]),
    timeoutMs: 1000,
  });
  const controller = new AbortController();
  const active = posix.request("GET", "/status", undefined, { signal: controller.signal });
  await flush();
  controller.abort();
  await assert.rejects(active, { name: "AbortError" });
  assert.equal(posixOptions.detached, true);
  assert.deepEqual(groupKills, [[-7101, "SIGKILL"]]);
  assert.equal(posixChild.killed, false);

  const fallbackChild = stubChild(7102);
  const fallback = createSshTransport({
    platform: "linux",
    spawnImpl: () => fallbackChild,
    killImpl: () => { throw new Error("missing group"); },
    timeoutMs: 1000,
  });
  const fallbackRequest = fallback.request("GET", "/status");
  await flush();
  fallback.close();
  await assert.rejects(fallbackRequest, /SSH transport is closed/);
  assert.equal(fallbackChild.killed, true);

  const windowsChild = stubChild(7103);
  let windowsOptions;
  const windows = createSshTransport({
    platform: "win32",
    spawnImpl: (command, args, options) => {
      windowsOptions = options;
      return windowsChild;
    },
    killImpl: (pid, signal) => groupKills.push([pid, signal]),
    timeoutMs: 1000,
  });
  const windowsRequest = windows.request("GET", "/status");
  await flush();
  windows.close();
  await assert.rejects(windowsRequest, /SSH transport is closed/);
  assert.equal(windowsOptions.detached, false);
  assert.equal(windowsChild.killed, true);
  assert.deepEqual(groupKills, [[-7101, "SIGKILL"]]);
});

test("19. final tool JSON is compact and capped at 4 MiB", async (t) => {
  const value = (text) => ({ conversationId: 1, entries: [{ text }], live: null });
  const overhead = Buffer.byteLength(JSON.stringify(value("")), "utf8");
  const exact = value("x".repeat(DEFAULT_MAX_RESPONSE_BYTES - overhead));
  const oversized = value("x".repeat(DEFAULT_MAX_RESPONSE_BYTES - overhead + 1));
  const { client } = await mcpFixture(t, routes({
    "GET /transcript?convId=1&max=1": exact,
    "GET /transcript?convId=1&max=2": oversized,
  }));

  const atLimit = await client.callTool({ name: "swarm_read", arguments: { max: 1 } });
  assert.equal(atLimit.isError, undefined);
  assert.equal(atLimit.content[0].text, JSON.stringify(exact));
  assert.equal(Buffer.byteLength(atLimit.content[0].text, "utf8"), DEFAULT_MAX_RESPONSE_BYTES);
  assert.deepEqual(atLimit.structuredContent, exact);

  const overLimit = await client.callTool({ name: "swarm_read", arguments: { max: 2 } });
  assert.equal(overLimit.isError, true);
  assert.equal(overLimit.structuredContent, undefined);
  assert.match(overLimit.content[0].text, /^Tool result exceeds 4194304-byte limit$/);
  assert.ok(overLimit.content[0].text.length < 100);
});

test("20. stdin failure terminates the spawned SSH process", async () => {
  const { state, spawnImpl } = fakeSpawn({ response: null });
  const transport = createSshTransport({ spawnImpl });
  const pending = transport.request("POST", "/chat", { text: "broken stdin" });
  await Promise.resolve();
  const child = state.children[0];
  assert.ok(child);
  child.stdin.emit("error", new Error("broken pipe"));
  await assert.rejects(pending, /Failed to send SSH request: broken pipe/);
  assert.equal(child.killed, true);
  transport.close();
});

test("21. importing the module does not start stdio or block the process", async () => {
  const moduleUrl = new URL("../src/swarm-mcp.mjs", import.meta.url).href;
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module",
    "--eval",
    `await import(${JSON.stringify(moduleUrl)}); console.log("import-safe");`,
  ], { timeout: 5000 });
  assert.equal(stdout.trim(), "import-safe");
  assert.equal(stderr, "");
});

test("22. memory_wake, memory_recall, and memory_note route cleanly over SSH transport", async (t) => {
  const { client, calls } = await mcpFixture(t, routes({
    "GET /memory/wake": { wake: "#0 2026-11-26 [vps] ready", version: 2, wakeLines: 24 },
    "GET /memory/recall?pattern=ready%20check": { pattern: "ready check", matches: "#0 ready check" },
    "POST /memory/note": (body) => ({ recorded: body.note, napsDrained: 0, version: 3 }),
  }));
  const woke = await client.callTool({ name: "memory_wake", arguments: {} });
  assert.match(woke.structuredContent.wake, /ready/);
  const rec = await client.callTool({ name: "memory_recall", arguments: { pattern: "ready check" } });
  assert.match(rec.structuredContent.matches, /ready check/);
  const noted = await client.callTool({ name: "memory_note", arguments: { note: "save cross-session fact" } });
  assert.equal(noted.structuredContent.recorded, "save cross-session fact");
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
    "GET /memory/wake",
    "GET /memory/recall?pattern=ready%20check",
    "POST /memory/note",
  ]);
});
