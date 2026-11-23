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

async function bootPage(chatReply = () => ({ ok: true, text: "done" })) {
  const root = await mkdtemp(join(tmpdir(), "imge2e-"));
  const sockPath = join(root, "swarm.sock");
  const seen = [];
  const daemon = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ path: req.url, body: raw ? JSON.parse(raw) : {} });
      if (String(req.url).startsWith("/transcript")) return res.end(JSON.stringify({ conversationId: 1, entries: seen.history || [] }));
      Promise.resolve(chatReply(seen)).then((reply) => {
        res.end(typeof reply === "string" ? reply : JSON.stringify(reply));
      });
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
  const revoked = [];
  w.URL.createObjectURL = (f) => "blob:" + (f.name || "x");
  w.URL.revokeObjectURL = (u) => revoked.push(u);
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
    revoked,
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

// Composer clearing contract: the pending deck empties (and revokes its object URLs)
// as soon as the server ACCEPTS the message — for every accepted response shape —
// while the sent message keeps its own history thumbnails. Failures keep the deck.
const deck = (t) => t.w.document.getElementById("pending-images");
const composerEmpty = (t) => {
  assert.equal(t.w.chatImages.count(), 0, "pending deck empty");
  assert.equal(deck(t).hidden, true, "deck hidden");
  assert.equal(deck(t).querySelectorAll("figure").length, 0, "no thumbnails or filenames left");
  assert.equal(t.w.document.getElementById("attach-status").textContent, "", "attachment count cleared");
  assert.equal(t.revoked.length, 1, "object URL revoked exactly once");
  assert.equal(t.revoked[0], "blob:Screenshot.png");
};
async function pasteAndSend(t, text = "look at this") {
  paste(t.w, [new t.w.File([png(2, 2)], "Screenshot.png", { type: "image/png" })]);
  await flush(150);
  assert.equal(t.w.chatImages.count(), 1);
  t.w.document.getElementById("q").value = text;
  enter(t.w);
  await flush(800);
}

for (const [name, reply] of [
  ["text", () => ({ ok: true, text: "done" })],
  ["html", () => ({ ok: true, text: "done", html: "<p>done</p>" })],
  ["images", () => ({ ok: true, text: "done", images: ["a".repeat(32)] })],
  ["202 pending", () => ({ status: "pending" })],
]) {
  test(`accepted ${name} response clears the composer deck once and keeps history thumbnails`, async () => {
    const t = await bootPage(reply);
    try {
      await pasteAndSend(t);
      const chat = t.seen.find((s) => s.path === "/chat");
      assert.ok(chat, "chat request reached the daemon");
      assert.equal(chat.body.images.length, 1, "image was sent");
      composerEmpty(t);
      // Sent message keeps its own thumbnail: the optimistic node is not the composer deck.
      const sent = t.w.document.querySelectorAll("#log .himages img");
      assert.ok(sent.length >= 1, "sent message still shows its thumbnail");
      assert.match(sent[0].getAttribute("src"), /^data:image\/png;base64,/);
      assert.deepEqual(t.errors, []);
    } finally {
      await t.close();
    }
  });
}

test("composer form submit clears the real deck as soon as pending send is accepted", async () => {
  let release;
  const accepted = new Promise((resolve) => { release = resolve; });
  const t = await bootPage(() => accepted);
  try {
    paste(t.w, [new t.w.File([png(2, 2)], "Screenshot.png", { type: "image/png" })]);
    await flush(150);
    t.w.document.getElementById("q").value = "look at this";
    const form = t.w.document.getElementById("f");
    const submitted = form.dispatchEvent(new t.w.Event("submit", { bubbles: true, cancelable: true }));
    assert.equal(submitted, false, "composer handler prevents native form navigation");
    for (let i = 0; i < 30 && !t.seen.some((s) => s.path === "/chat"); i++) await flush(20);
    assert.ok(t.seen.some((s) => s.path === "/chat"), "current composer form sends through send()");

    // Hold the model response open: acceptance, not response completion, owns cleanup.
    composerEmpty(t);
    const sent = t.w.document.querySelectorAll("#log .himages img");
    assert.equal(sent.length, 1, "sent history thumbnail remains while reply is pending");
    assert.match(sent[0].getAttribute("src"), /^data:image\/png;base64,/);
    release({ status: "pending" });
    await flush(100);
    assert.deepEqual(t.errors, []);
  } finally {
    release({ status: "pending" });
    await t.close();
  }
});

test("HTTP 500 keeps the attachments so the user can retry", async () => {
  const t = await bootPage(() => ({ error: "model rejected image" }));
  try {
    await pasteAndSend(t);
    assert.equal(t.w.chatImages.count(), 1, "deck preserved on failure");
    assert.equal(deck(t).hidden, false, "deck still visible");
    assert.equal(deck(t).querySelectorAll("figure").length, 1, "thumbnail still there");
    assert.equal(t.revoked.length, 0, "object URL not revoked");
    assert.match(t.w.document.getElementById("attach-status").textContent, /1 image attached/);
    assert.deepEqual(t.errors, []);
  } finally {
    await t.close();
  }
});

test("malformed (non-JSON) accepted response still clears the composer deck", async () => {
  const t = await bootPage(() => "<html>oops</html>");
  try {
    await pasteAndSend(t);
    composerEmpty(t);
    assert.deepEqual(t.errors, []);
  } finally {
    await t.close();
  }
});

test("413 keeps the attachments so the user can retry", async () => {
  const t = await bootPage(() => ({ error: "Payload too large" }));
  try {
    await pasteAndSend(t);
    assert.equal(t.w.chatImages.count(), 1, "deck preserved on 413");
    assert.equal(t.revoked.length, 0);
    assert.deepEqual(t.errors, []);
  } finally {
    await t.close();
  }
});

test("accepted send still clears the deck when reply rendering throws", async () => {
  // Regression: cleanup used to sit after the render branches inside try, so a throw
  // (markdown/CoT render) skipped it and stale thumbnails stayed in the composer.
  const t = await bootPage(() => ({ ok: true, text: "done", html: "<p>done</p>" }));
  try {
    let armed = false;
    const inner = t.w.fetch;
    t.w.fetch = (u, o) => { if (String(u).startsWith("/api/chat")) armed = true; return inner(u, o); };
    t.w.chatRender = (node) => { if (armed && node && node.classList.contains("a")) throw new Error("render boom"); };
    paste(t.w, [new t.w.File([png(2, 2)], "Screenshot.png", { type: "image/png" })]);
    await flush(150);
    assert.equal(t.w.chatImages.count(), 1);
    t.w.document.getElementById("q").value = "look at this";
    await t.w.eval("send(false)"); // the deliberate render throw is caught by send()
    assert.ok(t.seen.find((s) => s.path === "/chat"), "chat request reached the daemon");
    composerEmpty(t);
  } finally {
    await t.close();
  }
});
