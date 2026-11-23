#!/usr/bin/env -S node --no-warnings
import { realpathSync } from "node:fs";
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { openSwarmDaemon } from "./daemon.mjs";

// Load .env if present (local/VPS env_file already populates process.env in Docker)
try {
  const envRaw = await readFile(new URL("../.env", import.meta.url), "utf8");
  for (const line of envRaw.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch {}

const DEFAULT_DATA_DIR = process.env.SWARM_DATA_DIR || join(homedir(), ".pi-durable");
const DEFAULT_WORKSPACE = process.env.SWARM_WORKSPACE || "/workspace";
const DEFAULT_SOCK = process.env.SWARM_SOCK || join(DEFAULT_DATA_DIR, "swarm.sock");

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

export async function startUnixSocketServer({
  sockPath = DEFAULT_SOCK,
  dataDir = DEFAULT_DATA_DIR,
  workspaceDir = DEFAULT_WORKSPACE,
} = {}) {
  await mkdir(dirname(sockPath), { recursive: true });
  await rm(sockPath, { force: true });

  const daemon = await openSwarmDaemon({ dataDir, workspaceDir });
  daemon.harness.resume();

  const server = createServer(async (req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    try {
      const url = new URL(req.url || "/", "http://unix");
      if (req.method === "GET" && url.pathname === "/healthz") {
        return send(200, { ok: true, pid: process.pid });
      }
      if (req.method === "GET" && url.pathname === "/status") {
        return send(200, await daemon.status());
      }
      if (req.method === "GET" && url.pathname === "/workers") {
        return send(200, { workers: await daemon.listWorkers() });
      }
      if (req.method === "GET" && url.pathname === "/orchestrations") {
        return send(200, { orchestrations: await daemon.listOrchestrations() });
      }
      if (req.method === "POST" && url.pathname === "/orchestrations") {
        const body = await readJsonBody(req);
        return send(201, await daemon.createOrchestration(body));
      }
      if (req.method === "POST" && url.pathname === "/orchestration-update") {
        const body = await readJsonBody(req);
        return send(200, await daemon.updateOrchestration(body.id, body));
      }
      if (req.method === "POST" && url.pathname === "/orchestration-workers") {
        const body = await readJsonBody(req);
        return send(201, await daemon.createOrchestrationWorker(body.orchestrationId, body));
      }
      if (req.method === "POST" && url.pathname === "/orchestration-worker") {
        const body = await readJsonBody(req);
        const out = body.action === "run"
          ? await daemon.triggerOrchestrationWorker(body.workerId)
          : await daemon.setOrchestrationWorkerEnabled(body.workerId, body.action === "resume");
        return send(200, out);
      }
      if (req.method === "GET" && url.pathname === "/hooks") {
        return send(200, { hooks: daemon.listHooks() });
      }
      if (req.method === "GET" && url.pathname === "/transcript") {
        const convId = Number(url.searchParams.get("convId") || "1");
        const max = Number(url.searchParams.get("max") || "30");
        const [entries, live] = await Promise.all([
          daemon.readTranscript(convId, max),
          daemon.readLiveConversation(convId),
        ]);
        return send(200, { conversationId: convId, entries, ...(live ? { live } : {}) });
      }
      if (req.method === "POST" && url.pathname === "/chat") {
        const body = await readJsonBody(req);
        const text = typeof body.text === "string" ? body.text : "";
        if (!text.trim() && !(Array.isArray(body.images) && body.images.length)) {
          return send(400, { error: "text is required" });
        }
        const reply = await daemon.chat(text, {
          steer: !!body.steer,
          targetWorkerId: body.targetWorkerId || "lead",
          wait: body.wait !== false,
          images: Array.isArray(body.images) ? body.images : [],
        });
        return send(200, reply);
      }
      if (req.method === "POST" && url.pathname === "/model") {
        const body = await readJsonBody(req);
        const out = await daemon.setLeadModel(body.provider, body.modelId);
        return send(out?.statusCode === 400 ? 400 : 200, out);
      }
      if (req.method === "POST" && url.pathname === "/cron") {
        const body = await readJsonBody(req);
        return send(200, await daemon.scheduleForever(body));
      }
      return send(404, { error: "not_found" });
    } catch (err) {
      return send(500, { error: err?.message || String(err) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(sockPath, resolve);
  });
  await chmod(sockPath, 0o600);

  const shutdown = async () => {
    server.close();
    await daemon.close();
    await rm(sockPath, { force: true });
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  return { daemon, server, sockPath };
}

export async function unixRpc(sockPath, method, path, body) {
  const payload = body ? Buffer.from(JSON.stringify(body), "utf8") : null;
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath: sockPath,
        method,
        path,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": payload.length }
          : undefined,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            resolve(JSON.parse(raw));
          } catch {
            resolve({ raw, statusCode: res.statusCode });
          }
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const isDirectMain =
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (isDirectMain) {
  const cmd = process.argv[2] || "repl";
  if (cmd === "serve") {
    const { sockPath } = await startUnixSocketServer();
    console.log(`swarmd listening on unix:${sockPath} (0600, zero bearer tokens)`);
  } else if (cmd === "status") {
    console.log(JSON.stringify(await unixRpc(DEFAULT_SOCK, "GET", "/status"), null, 2));
  } else if (cmd === "ask") {
    const text = process.argv.slice(3).join(" ");
    const res = await unixRpc(DEFAULT_SOCK, "POST", "/chat", { text });
    console.log(res.text || JSON.stringify(res));
  } else if (cmd === "steer") {
    const targetWorkerId = process.argv[3];
    const text = process.argv.slice(4).join(" ");
    const res = await unixRpc(DEFAULT_SOCK, "POST", "/chat", { text, steer: true, targetWorkerId, wait: false });
    console.log(JSON.stringify(res));
  } else if (cmd === "reinforce") {
    const sub = (process.argv[3] || "").trim().toLowerCase();
    if (sub === "harness") {
      const {
        runHarnessTournament,
        EPISODE_2_SUPERVISOR_AND_CLIENT_BUGFIX,
        EPISODE_3_STANDALONE_RETRY_CACHE,
        EPISODE_4_AGENTS_SIDEBAR_REPAIR,
      } = await import("./harness-bench.mjs");
      const epArg = (process.argv[4] || "ep2").trim().toLowerCase();
      const episode =
        epArg === "ep3"
          ? EPISODE_3_STANDALONE_RETRY_CACHE
          : epArg === "ep4"
            ? EPISODE_4_AGENTS_SIDEBAR_REPAIR
            : EPISODE_2_SUPERVISOR_AND_CLIENT_BUGFIX;
      const out = await runHarnessTournament({
        repoDir: process.env.SWARM_SELF_REPO || dirname(dirname(fileURLToPath(import.meta.url))),
        episode,
        routerKey: process.env.ROUTER_INTERNAL_KEY,
        reportPrefix: epArg,
      });
      console.log(out.markdown);
    } else if (sub === "local") {
      const {
        runLocalAdapterTournament,
        EPISODE_3_STANDALONE_RETRY_CACHE,
        EPISODE_4_AGENTS_SIDEBAR_REPAIR,
      } = await import("./harness-bench.mjs");
      const epArg = (process.argv[4] || "ep4").trim().toLowerCase();
      const episode = epArg === "ep3" ? EPISODE_3_STANDALONE_RETRY_CACHE : EPISODE_4_AGENTS_SIDEBAR_REPAIR;
      const out = await runLocalAdapterTournament({
        repoDir: process.env.SWARM_SELF_REPO || dirname(dirname(fileURLToPath(import.meta.url))),
        episode,
        modelPath: process.env.LOCAL_MODEL_PATH || join(homedir(), ".cache", "local-bench-models", "LFM3-1.7B-Q4_K_M.gguf"),
        loraPath: process.env.LOCAL_LORA_PATH || join(homedir(), ".cache", "local-bench-models", "LFM3-1.7B-harbor-pi-lora-F16.gguf"),
        modelLabel: process.env.LOCAL_MODEL_LABEL || "LFM3-1.7B-Q4_K_M",
        reportPrefix: epArg,
      });
      console.log(out.markdown);
    } else {
      const { runReinforceTournament, DEFAULT_CANDIDATES } = await import("./reinforce.mjs");
      const candidates =
        sub === "quick"
          ? DEFAULT_CANDIDATES.slice(0, 2)
          : sub
            ? DEFAULT_CANDIDATES.filter((c) => c.id.includes(sub) || c.leadModel.includes(sub) || c.coderModel.includes(sub))
            : DEFAULT_CANDIDATES;
      const out = await runReinforceTournament({
        repoDir: process.env.SWARM_SELF_REPO || "/opt/pi-durable-swarm",
        envFile: process.env.SWARM_ENV_FILE || "/opt/pi-durable-swarm/.env",
        optmemMirrorDir: join(DEFAULT_DATA_DIR, "optmem"),
        candidates: candidates.length ? candidates : DEFAULT_CANDIDATES,
      });
      console.log(out.markdown);
    }
  } else {
    // Interactive SSH REPL over Unix socket: supports Lead chat, `/btw ...`, `/status`, `/steer <workerId> <msg>`
    const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "swarm> " });
    console.log("Connected to swarmd (Unix socket). Commands: /btw <q>, /status, /steer <id> <msg>, /quit");
    rl.prompt();
    for await (const line of rl) {
      const s = line.trim();
      if (!s) {
        rl.prompt();
        continue;
      }
      if (s === "/quit" || s === "/exit") break;
      if (s === "/status") {
        console.log(JSON.stringify(await unixRpc(DEFAULT_SOCK, "GET", "/status"), null, 2));
      } else if (s.startsWith("/steer ")) {
        const [, wid, ...rest] = s.split(/\s+/);
        console.log(JSON.stringify(await unixRpc(DEFAULT_SOCK, "POST", "/chat", { text: rest.join(" "), steer: true, targetWorkerId: wid, wait: false })));
      } else {
        const r = await unixRpc(DEFAULT_SOCK, "POST", "/chat", { text: s });
        console.log(`\n[${r.route}] ${r.text || JSON.stringify(r)}\n`);
      }
      rl.prompt();
    }
    rl.close();
  }
}
