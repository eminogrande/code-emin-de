// Composer attachment behaviour (paste, caps, remove, clear-on-send) in jsdom.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const script = readFileSync(new URL("../src/chat-images.js", import.meta.url), "utf8");

function boot() {
  const dom = new JSDOM(
    `<!doctype html><body><main><div id="log"></div><form id="f"><div id="pending-images" hidden></div><div id="composer-row"><textarea id="q"></textarea></div><p id="attach-status"></p></form></main></body>`,
    { runScripts: "outside-only", pretendToBeVisual: true },
  );
  const w = dom.window;
  w.URL.createObjectURL = (f) => "blob:" + (f.name || "x");
  w.URL.revokeObjectURL = () => {};
  w.eval(script);
  // boot() waits for DOMContentLoaded in the page; fire it deterministically here.
  w.document.dispatchEvent(new w.Event("DOMContentLoaded"));
  return { w, deck: w.document.getElementById("pending-images"), status: w.document.getElementById("attach-status") };
}

const png = (name, size = 10) => new File([new Uint8Array(size)], name, { type: "image/png" });

function paste(w, files, text = "") {
  const ev = new w.Event("paste", { bubbles: true, cancelable: true });
  ev.clipboardData = {
    items: files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })),
    getData: () => text,
  };
  w.document.dispatchEvent(ev);
  return ev;
}

function drop(w, files) {
  const dt = {
    types: ["Files"],
    files,
    items: files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })),
  };
  const over = new w.Event("dragover", { bubbles: true, cancelable: true });
  over.dataTransfer = dt;
  w.document.dispatchEvent(over);
  const ev = new w.Event("drop", { bubbles: true, cancelable: true });
  ev.dataTransfer = dt;
  w.document.dispatchEvent(ev);
  return ev;
}

test("paste adds labelled thumbnails with a remove button each", () => {
  const { w, deck, status } = boot();
  const ev = paste(w, [png("a.png"), png("b.png")]);
  assert.equal(ev.defaultPrevented, true);
  assert.equal(deck.hidden, false);
  assert.equal(deck.querySelectorAll("img").length, 2);
  assert.equal(deck.querySelector("img").alt, "a.png");
  assert.match(status.textContent, /2 images attached/);
  deck.querySelector(".rm").click();
  assert.equal(w.chatImages.count(), 1);
  w.chatImages.clear();
  assert.equal(deck.hidden, true);
});

test("plain text paste is left untouched when no image is present", () => {
  const { w } = boot();
  const ev = paste(w, [], "hello");
  assert.equal(ev.defaultPrevented, false);
  assert.equal(w.chatImages.count(), 0);
});

test("image+text paste into focused composer keeps the text in place", () => {
  const { w } = boot();
  const q = w.document.getElementById("q");
  q.focus();
  q.value = "hi ";
  q.selectionStart = q.selectionEnd = 3;
  const ev = paste(w, [png("a.png")], "caption");
  assert.equal(ev.defaultPrevented, true);
  assert.equal(w.chatImages.count(), 1);
  assert.equal(q.value, "hi caption");
});

test("paste outside the composer still captures the image", () => {
  const { w } = boot();
  w.document.body.focus();
  const ev = paste(w, [png("c.png")]);
  assert.equal(ev.defaultPrevented, true);
  assert.equal(w.chatImages.count(), 1);
  assert.equal(w.document.getElementById("q").value, "");
});

test("drag-and-drop attaches both images and text/code files", async () => {
  const { w, deck, status } = boot();
  const mdFile = new File(["# Title\nhello"], "notes.md", { type: "text/markdown" });
  const ev = drop(w, [png("shot.png"), mdFile]);
  assert.equal(ev.defaultPrevented, true);
  assert.equal(w.chatImages.count(), 2);
  assert.match(status.textContent, /1 image \+ 1 file attached/);
  assert.equal(deck.querySelectorAll("figure").length, 2);
  const blocks = await w.chatImages.toTextBlocks(w.chatImages.take());
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].name, "notes.md");
  assert.equal(blocks[0].text, "# Title\nhello");
});

test("wrong type, oversize and more than three images are rejected with a reason", () => {
  const { w, deck } = boot();
  const pdf = new File([new Uint8Array(4)], "doc.pdf", { type: "application/pdf" });
  paste(w, [pdf]);
  assert.match(w.document.getElementById("attach-status").textContent, /unsupported type/);
  const big = new File([new Uint8Array(4 * 1024 * 1024 + 1)], "big.png", { type: "image/png" });
  paste(w, [big]);
  assert.match(w.document.getElementById("attach-status").textContent, /too large/);
  paste(w, [png("1.png"), png("2.png"), png("3.png")]);
  paste(w, [png("4.png")]);
  assert.match(w.document.getElementById("attach-status").textContent, /max 3 images/);
  assert.equal(deck.querySelectorAll("figure").length, 3);
});

test("history replay renders authenticated image links, not inline base64", () => {
  const { w } = boot();
  const node = w.document.createElement("div");
  w.chatImages.renderHistory(node, ["a".repeat(32)]);
  const img = node.querySelector("img");
  assert.equal(img.getAttribute("src"), "/api/image/" + "a".repeat(32));
  assert.equal(node.querySelector("a").getAttribute("href"), "/api/image/" + "a".repeat(32));
});

test("take() snapshots attachments and clear() drops them after a successful send", () => {
  const { w, deck } = boot();
  w.document.body.focus();
  paste(w, [png("a.png")]);
  const snap = w.chatImages.take();
  assert.equal(snap.length, 1);
  assert.equal(snap[0].name, "a.png");
  assert.equal(deck.querySelectorAll("img").length, 1, "deck survives until cleared");
  w.chatImages.clear();
  assert.equal(deck.querySelectorAll("img").length, 0);
  assert.equal(w.document.getElementById("attach-status").textContent, "");
});

// Provider (Moonshot) rejects WebP/odd MIME: normalizing re-encodes decoded bytes to PNG.
function mockCanvas(w, decode, encode) {
  w.createImageBitmap = decode;
  w.HTMLCanvasElement.prototype.toBlob = function (cb, mime, q) { cb(encode(mime, q, this.width, this.height)); };
  w.HTMLCanvasElement.prototype.getContext = function () {
    return { fillStyle: "", fillRect() {}, drawImage() {}, imageSmoothingQuality: "high" };
  };
}

function fileOf(name, type, bytes = 8) {
  const f = new File([new Uint8Array(bytes)], name, { type });
  return f;
}

const bytesPng = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("webp and gif pastes are decoded and forwarded as real PNG bytes", async () => {
  const { w } = boot();
  let decoded = 0;
  mockCanvas(w, async (f) => { decoded++; return { width: 40, height: 20, close() {} }; }, (mime) => new w.Blob([bytesPng], { type: mime }));
  paste(w, [fileOf("shot.webp", "image/webp"), fileOf("anim.gif", "image/gif")]);
  const out = await w.chatImages.toDataUrls(w.chatImages.take());
  assert.equal(decoded, 2);
  assert.equal(out.length, 2);
  for (const o of out) {
    assert.equal(o.mimeType, "image/png");
    assert.match(o.dataUrl, /^data:image\/png;base64,/);
    assert.deepEqual(new Uint8Array(Buffer.from(o.dataUrl.split(",")[1], "base64")), bytesPng);
  }
});

test("invalid bytes are caught at decode time", async () => {
  const { w } = boot();
  mockCanvas(w, async () => { throw new Error("nope"); }, (m) => new Blob([bytesPng], { type: m }));
  paste(w, [fileOf("junk.png", "image/png")]);
  await assert.rejects(() => w.chatImages.toDataUrls(w.chatImages.take()), /invalid or unsupported image format: junk.png/);
});

test("zero-dimension decode is rejected", async () => {
  const { w } = boot();
  mockCanvas(w, async () => ({ width: 0, height: 0 }), (m) => new Blob([bytesPng], { type: m }));
  paste(w, [fileOf("empty.png", "image/png")]);
  await assert.rejects(() => w.chatImages.toDataUrls(w.chatImages.take()), /invalid or unsupported/);
});

test("dimensions are bounded before encoding", async () => {
  const { w } = boot();
  mockCanvas(w, async () => ({ width: 10000, height: 5000, close() {} }), (m, q, cw, ch) =>
    new w.Blob([Uint8Array.from([cw >> 8 & 255, cw & 255, ch >> 8 & 255, ch & 255])], { type: m }));
  paste(w, [fileOf("wide.png", "image/png")]);
  const out = await w.chatImages.toDataUrls(w.chatImages.take());
  assert.equal(out[0].mimeType, "image/png");
  const b = Buffer.from(out[0].dataUrl.split(",")[1], "base64");
  assert.equal(b.readUInt16BE(0), 4096);
  assert.equal(b.readUInt16BE(2), 2048);
});

test("PNG output over 4MB falls back to JPEG, then refuses", async () => {
  const { w } = boot();
  const big = 4 * 1024 * 1024 + 1;
  mockCanvas(w, async () => ({ width: 10, height: 10, close() {} }), (mime) =>
    new w.Blob([new Uint8Array(mime === "image/png" ? big : 1000)], { type: mime }));
  paste(w, [fileOf("heavy.png", "image/png")]);
  const out = await w.chatImages.toDataUrls(w.chatImages.take());
  assert.equal(out[0].mimeType, "image/jpeg");
  assert.match(out[0].dataUrl, /^data:image\/jpeg;base64,/);

  const { w: w2 } = boot();
  mockCanvas(w2, async () => ({ width: 10, height: 10, close() {} }), (mime) => new w2.Blob([new Uint8Array(big)], { type: mime }));
  paste(w2, [fileOf("heavy2.png", "image/png")]);
  await assert.rejects(() => w2.chatImages.toDataUrls(w2.chatImages.take()), /reduce the screenshot/);
});
