// Composer attachment behaviour (paste, caps, remove, clear-on-send) in jsdom.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const script = readFileSync(new URL("../src/chat-images.js", import.meta.url), "utf8");

function boot() {
  const dom = new JSDOM(
    `<!doctype html><body><main><div id="log"></div><form id="f"><div id="pending-images" hidden></div><div id="composer-row"><button id="attach-btn" type="button"></button><input id="attach-input" type="file" hidden><textarea id="q"></textarea></div><p id="attach-status"></p></form></main></body>`,
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
  w.document.getElementById("attach-btn").focus();
  const ev = paste(w, [png("c.png")]);
  assert.equal(ev.defaultPrevented, true);
  assert.equal(w.chatImages.count(), 1);
  assert.equal(w.document.getElementById("q").value, "");
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
  w.document.getElementById("attach-btn").focus();
  paste(w, [png("a.png")]);
  const snap = w.chatImages.take();
  assert.equal(snap.length, 1);
  assert.equal(snap[0].name, "a.png");
  assert.equal(deck.querySelectorAll("img").length, 1, "deck survives until cleared");
  w.chatImages.clear();
  assert.equal(deck.querySelectorAll("img").length, 0);
  assert.equal(w.document.getElementById("attach-status").textContent, "");
});
