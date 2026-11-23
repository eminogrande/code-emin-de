// Native Solarized UI only: no third-party component theme or credit link.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const src = readFileSync(new URL("../src/web.mjs", import.meta.url), "utf8");
const md = readFileSync(new URL("../src/markdown.mjs", import.meta.url), "utf8");
const page = src.slice(src.indexOf("function renderMinimalChat()"), src.indexOf("<script src=\"/chat-client.js\""));
const html = page.slice(page.indexOf("<!doctype html>"));
const doc = () => new JSDOM(html).window.document;

test("user bubbles and assistant labels make authorship clear", () => {
  const style = doc().querySelector("style").textContent;
  assert.match(style, /\.m\.u\{[^}]*background:var\(--paper-2\)[^}]*border-left:3px solid var\(--accent\)/);
  assert.match(style, /\.m\.u::before\{content:"You";color:var\(--heading\)/);
  assert.match(style, /\.m\.a::before\{content:"Kimi"/);
  assert.match(style, /\.m\.a\.err::before\{content:"System"/);
});

test("tables use their own responsive scroller without splitting words", () => {
  const style = doc().querySelector("style").textContent;
  assert.match(style, /\.table-scroll\{[^}]*width:100%[^}]*max-width:100%[^}]*overflow-x:auto[^}]*-webkit-overflow-scrolling:touch/);
  assert.match(style, /\.a table\{[^}]*table-layout:auto[^}]*width:max-content[^}]*min-width:100%[^}]*max-width:none/);
  assert.match(style, /\.a th,\.a td\{[^}]*white-space:normal[^}]*word-break:normal[^}]*overflow-wrap:normal[^}]*hyphens:none/);
  assert.match(style, /\.a th:first-child,\.a td:first-child\{white-space:nowrap\}/);
});

test("rendered tables get an accessible, idempotent scroll wrapper", () => {
  const window = new JSDOM('<div id="m"><table><tbody><tr><td>Description</td><td>wide-unbroken-content-1234567890</td></tr></tbody></table></div>', { runScripts: "outside-only" }).window;
  const start = src.indexOf("function wrapTables(node)");
  const end = src.indexOf("\nfunction renderContent", start);
  assert.ok(start >= 0 && end > start);
  window.eval(src.slice(start, end));
  window.eval("wrapTables(document.getElementById('m')); wrapTables(document.getElementById('m'))");
  const wrappers = window.document.querySelectorAll(".table-scroll");
  assert.equal(wrappers.length, 1);
  assert.equal(wrappers[0].getAttribute("role"), "region");
  assert.equal(wrappers[0].getAttribute("aria-label"), "Scrollable table");
  assert.equal(wrappers[0].tabIndex, 0);
  assert.equal(wrappers[0].querySelector("td:first-child").textContent, "Description");
  assert.match(wrappers[0].querySelector("td:last-child").textContent, /^wide-unbroken-content/);
});

test("transparent thinking emoji favicon is embedded", () => {
  const icon = doc().querySelector('link[rel="icon"]');
  assert.equal(icon.getAttribute("type"), "image/svg+xml");
  assert.match(icon.getAttribute("href"), /^data:image\/svg\+xml,/);
  assert.match(icon.getAttribute("href"), /🤔/);
  assert.doesNotMatch(icon.getAttribute("href"), /rect/i, "no background rectangle");
  assert.equal((src.match(/rel="icon"/g) || []).length, 2, "login and chat");
});

test("no external component stylesheet or RareUI credit remains", () => {
  const d = doc();
  assert.equal(d.querySelectorAll('link[rel="stylesheet"]').length, 0);
  assert.equal(d.querySelector("#leftCol .credits"), null);
  assert.doesNotMatch(src, /rare-button|rareui\.com|chat-theme/i);
  assert.doesNotMatch(md, /rare ?ui|cb-layer|cb-icon|data-slot="copy-button"/i);
  assert.equal(d.querySelectorAll('link[href^="http"]').length, 0);
});

test("inline Solarized base and layout remain intact", () => {
  const style = doc().querySelector("style").textContent;
  for (const [name, val] of [
    ["--paper", "#fdf6e3"], ["--paper-2", "#eee8d5"], ["--ink", "#073642"],
    ["--heading", "#002b36"], ["--accent", "#b58900"],
  ]) assert.match(style, new RegExp(name + ":\\s*" + val), name);
  assert.doesNotMatch(style, /--rail:|radial-gradient\(/);
  for (const sel of ["#topbar", "#leftCol", "#rightCol", ".m.u", ".a", "#statusBar .sb-workers", "pre", ".mmd-out", ".cb .copy"]) {
    assert.ok(style.includes(sel), "missing base rule for " + sel);
  }
});

test("orchestration, chat, image and drawer contracts survive", () => {
  const d = doc();
  for (const id of ["log", "q", "statusBar", "agents", "targets", "leftCol", "rightCol", "backdrop", "tLeft", "tRight", "agentsEmpty", "archive", "pending-images", "new-orch", "new-worker"]) {
    assert.ok(d.getElementById(id), "missing #" + id);
  }
  const attach = d.getElementById("attach-btn");
  const input = d.getElementById("attach-input");
  assert.equal(attach.type, "button");
  assert.equal(attach.getAttribute("aria-controls"), "attach-input");
  assert.equal(input.hidden, true);
  assert.equal(input.multiple, true);
  assert.match(input.accept, /image\/png/);
  assert.match(input.accept, /image\/jpeg/);
  assert.match(src, /attachInput\.onchange[\s\S]*new DataTransfer\(\)[\s\S]*new DragEvent\('drop'/);
  assert.match(src, /images: payloadImages/);
  assert.ok(d.querySelector('[data-target="lead"].tgt[aria-current="true"]'));
  assert.match(src, /el\.classList\.add\('open'\)/);
  assert.match(src, /el\.classList\.remove\('open'\)/);
  assert.match(src, /api\/render/);
  assert.match(src, /api\/model/);
  assert.match(src, /mermaid-vendor\.js/);
});

test("native copy button is plain local markup", () => {
  assert.match(md, /<button class="copy" type="button" data-copied="false" aria-label="Copy" title="Copy">Copy<\/button>/);
  const btn = new JSDOM('<div class="cb"><button class="copy" data-copied="false" aria-label="Copy">Copy</button><pre><code>x</code></pre></div>').window.document.querySelector("div.cb > button.copy");
  assert.equal(btn.textContent, "Copy");
  assert.equal(btn.getAttribute("aria-label"), "Copy");
});
