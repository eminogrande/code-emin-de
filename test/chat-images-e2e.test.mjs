// Full-page browser boot: real served HTML + real client scripts in document order,
// paste a PNG through the composer and send it. Guards the regression where defer'd
// client scripts ran after the inline boot script (hydrate/send saw no window.chatImages,
// so pasted screenshots were silently dropped and nothing was persisted).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { JSDOM, VirtualConsole } from "jsdom";
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

async function bootPage() {
  const root = await mkdtemp(join(tmpdir(), "imge2e-"));
  const sockPath = join(root, "swarm.sock");
  const seen = [];
  const daemon = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ path: req.url, body: raw ? JSON.parse(raw) : {} });
      if (String(req.url).startsWith("/transcript")) return res.end(JSON.stringify({ conversationId: 1, entries: seen.history || [] }));
      res.end(JSON.stringify({ ok: true, text: "done" }));
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
  web.auth.verifySession = () => true;
  const base = `http://127.0.0.1:${web.server.address().port}`;
  const get = (p) => fetch(base + p, { headers: { Cookie: "swarm_s=x" } });

  const html = await (await get("/")).text();
  const clientScript = await (await get("/chat-client.js")).text();
  const imagesScript = await (await get("/chat-images.js")).text();

  const vc = new VirtualConsole();
  const errors = [];
  vc.on("jsdomError", (e) => errors.push("jsdom: " + e.message));
  const dom = new JSDOM(html, { url: base + "/", runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  w.URL.createObjectURL = (f) => "blob:" + (f.name || "x");
  w.URL.revokeObjectURL = () => {};
  w.addEventListener("error", (e) => errors.push("pageerror: " + e.message));
  w.addEventListener("unhandledrejection", (e) => errors.push("rejection: " + String(e.reason)));
  // jsdom has no fetch: proxy to the live server, keeping the page's relative URLs.
  w.fetch = (u, o = {}) => fetch(base + String(u), { ...o, headers: { ...(o.headers || {}), Cookie: "swarm_s=x" } });

  // Real browser order: a defer'd script runs only after the parser has passed the
  // inline boot script, a plain one right before it. Reproduce whichever the page ships.
  const deferred = /<script src="\/chat-client\.js" defer>/.test(html);
  const staticScripts = [clientScript, imagesScript];
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).pop();
  if (deferred) {
    w.eval(inline);
    for (const s of staticScripts) w.eval(s);
  } else {
    for (const s of staticScripts) w.eval(s);
    w.eval(inline);
  }
  w.document.dispatchEvent(new w.Event("DOMContentLoaded"));
  await new Promise((r) => setTimeout(r, 300));

  return {
    w,
    html,
    errors,
    seen,
    root,
    async close() {
      w.close();
      web.server.close();
      await new Promise((r) => daemon.close(r));
      await rm(root, { recursive: true, force: true });
    },
  };
}

function paste(w, files, text = "") {
  const ev = new w.Event("paste", { bubbles: true, cancelable: true });
  ev.clipboardData = { items: files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })), getData: () => text };
  const q = w.document.getElementById("q");
  q.focus();
  q.dispatchEvent(ev);
  return ev;
}
const enter = (w) => w.document.getElementById("q").dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
const flush = (ms = 400) => new Promise((r) => setTimeout(r, ms));

test("inline boot script parses, and static scripts are not deferred", async () => {
  const t = await bootPage();
  try {
    const inline = [...t.html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.equal(inline.length, 1);
    const file = join(mkdtempSync(join(tmpdir(), "chk-")), "inline.js");
    writeFileSync(file, inline[0]);
    execFileSync(process.execPath, ["--check", file]); // SyntaxError would throw
    assert.match(t.html, /<script src="\/chat-client\.js"><\/script>/);
    assert.match(t.html, /<script src="\/chat-images\.js"><\/script>/);
    assert.doesNotMatch(t.html, /<script src="\/chat-(client|images)\.js" defer>/);
  } finally {
    await t.close();
  }
});

test("page boots without fatal errors and exposes both hooks before the inline script", async () => {
  const t = await bootPage();
  try {
    assert.equal(typeof t.w.chatImages, "object");
    assert.equal(typeof t.w.chatRender, "function");
    assert.deepEqual(t.errors, []);
  } finally {
    await t.close();
  }
});

test("pasted screenshot survives to /api/chat as an image block and is persisted", async () => {
  const t = await bootPage();
  try {
    const bytes = png(2, 2);
    const ev = paste(t.w, [new t.w.File([bytes], "Screenshot.png", { type: "image/png" })]);
    await flush(150);
    assert.equal(ev.defaultPrevented, true);
    assert.equal(t.w.chatImages.count(), 1);
    assert.match(t.w.document.getElementById("attach-status").textContent, /1 image attached/);

    t.w.document.getElementById("q").value = "look at this";
    enter(t.w);
    await flush(800);

    const chat = t.seen.find((s) => s.path === "/chat");
    assert.ok(chat, "chat request reached the daemon");
    assert.equal(chat.body.text, "look at this");
    assert.equal(chat.body.images.length, 1);
    assert.equal(chat.body.images[0].mimeType, "image/png");
    assert.deepEqual(Buffer.from(chat.body.images[0].data, "base64"), bytes);
    assert.equal((await readdir(join(t.root, "images"))).length, 1, "image persisted server-side");
    assert.equal(t.w.document.getElementById("pending-images").hidden, true, "deck cleared after send");
    assert.match(t.w.document.getElementById("log").innerHTML, /himages/);
    assert.deepEqual(t.errors, []);
  } finally {
    await t.close();
  }
});

test("wrong mime paste is rejected client-side and the text still sends", async () => {
  const t = await bootPage();
  try {
    const ev = paste(t.w, [new t.w.File(["%PDF-1.4"], "a.pdf", { type: "application/pdf" })]);
    await flush(150);
    assert.equal(ev.defaultPrevented, true);
    assert.equal(t.w.chatImages.count(), 0);
    assert.match(t.w.document.getElementById("attach-status").textContent, /unsupported type/);

    t.w.document.getElementById("q").value = "no picture";
    enter(t.w);
    await flush(500);
    const chat = t.seen.find((s) => s.path === "/chat");
    assert.ok(chat);
    assert.equal(chat.body.images, undefined);
    assert.deepEqual(t.errors, []);
  } finally {
    await t.close();
  }
});
