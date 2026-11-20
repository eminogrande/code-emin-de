// End-to-end: images become real model content blocks and history replays ids only.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { openSwarmDaemon } from "../src/daemon.mjs";
import { imageId } from "../src/image-util.mjs";

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=",
  "base64",
);
const DATA = PNG_1x1.toString("base64");

async function boot() {
  const root = await mkdtemp(join(tmpdir(), "swarm-img-"));
  const faux = fauxProvider({
    provider: "fauxvision",
    models: [{ id: "vision-1", input: ["text", "image"] }],
  });
  faux.appendResponses([fauxAssistantMessage([fauxText("saw it")])]);
  const models = createModels();
  models.setProvider(faux.provider);
  const ref = { provider: "fauxvision", modelId: "vision-1" };
  const daemon = await openSwarmDaemon({
    dataDir: join(root, "data"),
    workspaceDir: join(root, "workspace"),
    models,
    roleModels: Object.fromEntries(
      ["lead", "planner", "coder", "coderFast", "reviewer", "reviewerDeep", "support", "social", "watcher", "btw"].map((k) => [k, ref]),
    ),
  });
  return { root, daemon, faux };
}

test("pasted image reaches the provider as an image block and history keeps only ids", async () => {
  const { root, daemon } = await boot();
  try {
    const out = await daemon.chat("what is this", { images: [{ mimeType: "image/png", data: DATA }] });
    assert.ok(!out.error, out.error);

    const entries = await daemon.readTranscript(1, 10);
    const user = entries.find((e) => e.role === "user");
    assert.equal(user.text, "what is this");
    assert.deepEqual(user.images, [imageId(PNG_1x1)]);
    assert.ok(!JSON.stringify(user).includes(DATA.slice(0, 40)), "no base64 in history");

    const conv = await daemon.harness.conversation(1, { background: true });
    const ctx = await conv.context({ background: true });
    const userMsg = ctx.entries.map((e) => e.model?.[0]).find((m) => m?.role === "user" && !m.content?.startsWith?.("["));
    const blocks = userMsg.content;
    assert.ok(Array.isArray(blocks), "content is a block array");
    const img = blocks.find((b) => b.type === "image");
    assert.equal(img.mimeType, "image/png");
    assert.equal(img.data, DATA);
    assert.equal(blocks.find((b) => b.type === "text").text, "what is this");
  } finally {
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("image-only message stores no empty text block and text-only stays a plain string", async () => {
  const { root, daemon } = await boot();
  try {
    await daemon.chat("", { images: [{ mimeType: "image/png", data: DATA }] });
    assert.equal((await daemon.readTranscript(1, 10)).find((e) => e.role === "user").text, "");

    await daemon.chat("plain text", {});
    const conv = await daemon.harness.conversation(1, { background: true });
    const ctx = await conv.context({ background: true });
    const plain = ctx.entries.map((e) => e.model?.[0]).filter((m) => m?.role === "user").at(-1);
    assert.equal(typeof plain.content, "string");
  } finally {
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
});
