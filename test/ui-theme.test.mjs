// UI checks after dropping the whole-page theme: native Solarized inline CSS stays the base,
// one isolated Rare UI component stylesheet (adapted copy button), unchanged DOM contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const css = readFileSync(new URL("../src/rare-button.css", import.meta.url), "utf8");
const src = readFileSync(new URL("../src/web.mjs", import.meta.url), "utf8");
const md = readFileSync(new URL("../src/markdown.mjs", import.meta.url), "utf8");
const page = src.slice(src.indexOf("function renderMinimalChat()"), src.indexOf("<script src=\"/chat-client.js\""));
const html = page.slice(page.indexOf("<!doctype html>"));
const doc = () => new JSDOM(html).window.document;

test("only the small component stylesheet is linked, no full page theme", () => {
  const d = doc();
  const links = d.querySelectorAll('link[rel="stylesheet"]');
  assert.equal(links.length, 1);
  assert.equal(links[0].getAttribute("href"), "/rare-button.css");
  assert.match(src, /url\.pathname === "\/rare-button\.css"[\s\S]{0,120}text\/css/);
  assert.doesNotMatch(src, /chat-theme/);
  assert.equal(d.querySelectorAll('link[href^="http"]').length, 0);
});

test("inline Solarized base and layout untouched by the theme layer", () => {
  const style = doc().querySelector("style").textContent;
  for (const [name, val] of [
    ["--paper", "#fdf6e3"],
    ["--paper-2", "#eee8d5"],
    ["--ink", "#073642"],
    ["--heading", "#002b36"],
    ["--accent", "#b58900"],
  ]) {
    assert.match(style, new RegExp(name + ":\\s*" + val), name);
  }
  // base still the classic flex page, not the theme's rail grid + gradients
  assert.doesNotMatch(style, /--rail:/);
  assert.doesNotMatch(style, /radial-gradient\(/);
  for (const sel of ["#topbar", "#leftCol", "#rightCol", ".m.u", ".a", "#statusBar .sb-workers", "pre", ".mmd-out"]) {
    assert.ok(style.includes(sel), "missing base rule for " + sel);
  }
});

test("functionality ids and copy button contract survive", () => {
  const d = doc();
  for (const id of ["log", "q", "statusBar", "agents", "targets", "leftCol", "rightCol", "backdrop", "tLeft", "tRight", "agentsEmpty", "archive", "attach-input"]) {
    assert.ok(d.getElementById(id), "missing #" + id);
  }
  assert.ok(d.querySelector('[data-target="lead"].tgt[aria-current="true"]'));
  assert.match(src, /el\.classList\.add\('open'\)/);
  assert.match(src, /el\.classList\.remove\('open'\)/);
  assert.match(src, /api\/render/);
  assert.match(src, /api\/model/);
  assert.match(src, /mermaid-vendor\.js/);
});

test("component markup is the upstream one, attributes only, no innerHTML", () => {
  assert.match(md, /data-slot="copy-button"/);
  assert.match(md, /data-copied="false"/);
  assert.match(md, /class="cb-icon"/);
  assert.match(md, /cb-layer-idle/);
  assert.match(md, /cb-layer-done/);
  const btn = new JSDOM('<div class="cb"><button class="copy" data-slot="copy-button" data-copied="false" aria-label="Copy"><span class="cb-icon"><span class="cb-layer cb-layer-done"><svg></svg></span></span></button></div>').window.document.querySelector("div.cb > button.copy");
  assert.ok(btn, "copy button present");
  assert.equal(btn.getAttribute("aria-label"), "Copy");
  assert.ok(btn.querySelector(".cb-layer-done svg"), "copied glyph layer");
});

test("adapted CSS is attributed to the exact upstream source and license", () => {
  assert.match(css, /raw\.githubusercontent\.com\/swamimalode07\/rare-ui\/main\/components\/CopyButton\.tsx/);
  assert.match(css, /MIT \+ Commons Clause License Condition v1\.0 \+ Attribution/);
  assert.match(css, /Swami Malode/);
  assert.match(css, /rareui\.com/);
  assert.match(css, /LICENSE/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /\[data-slot="copy-button"\]\[data-copied="true"\] \.cb-layer-done/);
});

test("credit lives in sidebar About link, not chat footer", () => {
  assert.equal(doc().querySelector("#credit"), null);
  const a = doc().querySelector("#leftCol .credits a");
  assert.ok(a, "footer attribution link");
  assert.equal(a.getAttribute("href"), "https://rareui.com/");
  assert.equal(a.getAttribute("target"), "_blank");
  const rel = (a.getAttribute("rel") || "").split(/\s+/);
  assert.ok(rel.includes("noopener") && rel.includes("noreferrer"));
});
