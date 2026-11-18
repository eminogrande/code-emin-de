import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { openSwarmDaemon } from "./src/daemon.mjs";
const root = await mkdtemp(join(tmpdir(), "dbg-"));
const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
const models = createModels(); models.setProvider(faux.provider);
const ref = { provider: faux.models[0].provider, modelId: faux.models[0].id };
const roleModels = { lead: ref, coder: ref, reviewer: ref, btw: ref };
faux.appendResponses([
  fauxAssistantMessage(fauxToolCall("spawn_worker", { workerId: "w-t", role: "coder", brief: "GOAL-ALPHA" })),
  fauxAssistantMessage("spawned w-t"),
  ...Array.from({ length: 40 }, () => fauxAssistantMessage(fauxToolCall("bash", { command: "true" }))),
  fauxAssistantMessage("done Verified: PASS (true)"),
]);
const d = await openSwarmDaemon({ dataDir: join(root,"data"), workspaceDir: join(root,"ws"), models, roleModels, supervisor: { maxAutoResumes: 1, backoffMs: 10, intervalMs: 50 } });
d.harness.resume();
const r = await d.chat("spawn one worker", { wait: true });
console.log("CHAT", JSON.stringify(r).slice(0,600));
console.log("W", JSON.stringify((await d.status()).swarm.workers).slice(0,600));
for (let i=0;i<20;i++){ await new Promise(r=>setTimeout(r,300)); console.log(i, JSON.stringify((await d.status()).swarm.workers["w-t"]?.supervisor)); }
await d.close(); process.exit(0);
