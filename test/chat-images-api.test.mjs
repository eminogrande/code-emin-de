// Server side: /api/chat image extension, caps, auth-gated GET /api/image/:id.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { startWebServer } from "../src/web.mjs";

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(w = 1, h = 1) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.alloc((w * 4 + 1) * h))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const url64 = (b) => `data:image/png;base64,${b.toString("base64")}`;

async function boot() {
  const root = await mkdtemp(join(tmpdir(), "imgapi-"));
  const sockPath = join(root, "swarm.sock");
  const seen = [];
  const daemon = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ path: req.url, body });
      if (String(req.url).startsWith("/transcript")) {
        res.end(JSON.stringify({ conversationId: 1, entries: seen.history || [] }));
        return;
      }
      if (body.text !== "boom") res.end(JSON.stringify({ ok: true, text: "done" }));
      else res.end(JSON.stringify({ error: "model rejected image" }));
    });
  });
  await new Promise((r) => daemon.listen(sockPath, r));
  const web = await startWebServer({
    port: 0,
    host: "127.0.0.1",
    sockPath,
    authDbPath: join(root, "auth.sqlite"),
    rpId: "localhost",
    origin: "http://localhost",
  });
  const base = `http://127.0.0.1:${web.server.address().port}`;
  const post = (path, body, cookie = "swarm_s=x") =>
    fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    });
  return {
    root,
    seen,
    base,
    post,
    auth: web.auth,
    async close() {
      web.server.close();
      await new Promise((r) => daemon.close(r));
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("images reach the daemon as base64 blocks while plain text bodies stay unchanged", async () => {
  const t = await boot();
  t.auth.verifySession = () => true;
  try {
    const img = png(2, 2);
    const res = await t.post("/api/chat", { text: "look", images: [{ dataUrl: url64(img) }] });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.images.length, 1);
    const sent = t.seen.at(-1);
    assert.equal(sent.path, "/chat");
    assert.equal(sent.body.text, "look");
    assert.equal(sent.body.images.length, 1);
    assert.equal(sent.body.images[0].mimeType, "image/png");
    assert.deepEqual(Buffer.from(sent.body.images[0].data, "base64"), img);

    // image-only message is allowed
    const only = await t.post("/api/chat", { text: "", images: [{ dataUrl: url64(png()) }] });
    assert.equal(only.status, 200);

    // text-only keeps the old shape (no images key)
    await t.post("/api/chat", { text: "plain" });
    assert.equal(t.seen.at(-1).body.images, undefined);
  } finally {
    await t.close();
  }
});

test("bad payloads are rejected server-side before reaching the daemon", async () => {
  const t = await boot();
  t.auth.verifySession = () => true;
  try {
    const before = t.seen.length;
    const svg = "data:image/svg+xml;base64," + Buffer.from("<svg/>").toString("base64");
    const bad = await t.post("/api/chat", { text: "x", images: [{ dataUrl: svg }] });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /unsupported/);

    const notB64 = await t.post("/api/chat", { text: "x", images: [{ dataUrl: "data:image/png;base64,!!!!" }] });
    assert.equal(notB64.status, 400);

    const four = Array.from({ length: 4 }, () => ({ dataUrl: url64(png()) }));
    const tooMany = await t.post("/api/chat", { text: "x", images: four });
    assert.equal(tooMany.status, 400);
    assert.match((await tooMany.json()).error, /too many/);

    const empty = await t.post("/api/chat", { text: "  ", images: [] });
    assert.equal(empty.status, 400);

    assert.equal(t.seen.length, before, "daemon untouched by rejected payloads");
  } finally {
    await t.close();
  }
});

test("GET /api/image/:id requires auth, is content-typed and cannot traverse", async () => {
  const t = await boot();
  try {
    const img = png(3, 3);
    const unauth = await fetch(t.base + "/api/image/" + "a".repeat(32));
    assert.equal(unauth.status, 401);

    t.auth.verifySession = () => true;
    const sent = await t.post("/api/chat", { text: "x", images: [{ dataUrl: url64(img) }] });
    const id = (await sent.json()).images[0];

    const res = await fetch(t.base + "/api/image/" + id, { headers: { Cookie: "swarm_s=x" } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.match(res.headers.get("cache-control"), /immutable/);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), img);

    assert.equal((await fetch(t.base + "/api/image/../../etc/passwd", { headers: { Cookie: "swarm_s=x" } })).status, 404);
    assert.equal((await fetch(t.base + "/api/image/" + "b".repeat(32), { headers: { Cookie: "swarm_s=x" } })).status, 404);
  } finally {
    await t.close();
  }
});

test("history exposes attachment ids, and errors reach the client so the deck is not cleared", async () => {
  const t = await boot();
  t.auth.verifySession = () => true;
  try {
    const sent = await t.post("/api/chat", { text: "boom", images: [{ dataUrl: url64(png()) }] });
    assert.equal(sent.status, 500);
    assert.match((await sent.json()).error, /rejected/);

    t.seen.history = [
      { id: 1, role: "user", text: "look", images: ["c".repeat(32)] },
      { id: 2, role: "assistant", text: "ok" },
    ];
    const h = await (await fetch(t.base + "/api/history", { headers: { Cookie: "swarm_s=x" } })).json();
    assert.deepEqual(h.entries[0].images, ["c".repeat(32)]);
    assert.equal(h.entries[1].images, undefined);
  } finally {
    await t.close();
  }
});
