// UI-only checks for the chat theme: stylesheet is valid-ish, linked, Solarized vars kept,
// DOM/class contract unchanged, responsive + reduced-motion rules present.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const css = readFileSync(new URL("../src/chat-theme.css", import.meta.url), "utf8");
const src = readFileSync(new URL("../src/web.mjs", import.meta.url), "utf8");
const page = src.slice(src.indexOf("function renderMinimalChat()"), src.indexOf("<script src=\"/chat-client.js\""));
const html = page.slice(page.indexOf("<!doctype html>"));

function doc(htmlText) {
  return new JSDOM(htmlText).window.document;
}

test("stylesheet is linked after the inline style and served same-origin", () => {
  const d = doc(html);
  const link = d.querySelector('link[rel="stylesheet"]');
  assert.ok(link, "theme link present");
  assert.equal(link.getAttribute("href"), "/chat-theme.css");
  // link must come after the inline <style> so it can layer over it
  const style = d.querySelector("style");
  assert.ok(style.compareDocumentPosition(link) & 4 /* FOLLOWING */);
  assert.match(src, /url\.pathname === "\/chat-theme\.css"[\s\S]{0,120}text\/css/);
  // no remote stylesheet / font CDN
  assert.equal(d.querySelectorAll('link[href^="http"]').length, 0);
});

test("solarized palette is reused through :root custom properties", () => {
  const root = css.slice(css.indexOf(":root"), css.indexOf("}", css.indexOf(":root")));
  for (const [name, val] of [
    ["--paper", "#fdf6e3"],
    ["--paper-2", "#eee8d5"],
    ["--ink", "#073642"],
    ["--heading", "#002b36"],
    ["--accent", "#b58900"],
    ["--accent-warm", "#cb4b16"],
  ]) {
    assert.match(root, new RegExp(name + ":\\s*" + val), name + " keeps solarized value");
  }
  // no tacky gradients: only the warm wash + hairline grid (2 body + 2 grid lines)
  assert.ok((css.match(/linear-gradient\(/g) || []).length <= 4);
  assert.ok((css.match(/radial-gradient\(/g) || []).length <= 2);
});

test("javascript-relevant ids and classes survive in the DOM", () => {
  const d = doc(html);
  for (const id of ["log", "q", "statusBar", "agents", "targets", "leftCol", "rightCol", "backdrop", "tLeft", "tRight", "agentsEmpty", "archive"]) {
    assert.ok(d.getElementById(id), "missing #" + id);
  }
  assert.ok(d.querySelector('[data-target="lead"].tgt[aria-current="true"]'));
  assert.ok(d.querySelector("#leftCol.open, #leftCol")); // open class still applied by client script
  assert.match(src, /el\.classList\.add\('open'\)/);
  assert.match(src, /el\.classList\.remove\('open'\)/);
});

test("theme styles the existing class contract without renaming it", () => {
  for (const sel of [".m.u", ".m.a", ".wk", ".tgt[aria-current=\"true\"]", "#statusBar .sb-workers", "pre", ".cb .copy", ".mmd-out"]) {
    assert.ok(css.includes(sel), "missing rule for " + sel);
  }
  assert.ok(!/\.message-/.test(css), "no invented class names");
});

test("layout rails, responsive collapse and reduced motion", () => {
  assert.match(css, /--rail:\s*248px/);
  assert.match(css, /--rail-r:\s*280px/);
  assert.match(css, /@media \(max-width: 1100px\)/);
  assert.match(css, /@media \(max-width: 800px\)/);
  const q1100 = css.slice(css.indexOf("@media (max-width: 1100px)"), css.indexOf("@media (max-width: 800px)"));
  assert.match(q1100, /#leftCol[\s\S]*?position: fixed/);
  const q800 = css.slice(css.indexOf("@media (max-width: 800px)"), css.indexOf("prefers-reduced-motion"));
  assert.match(q800, /#rightCol[\s\S]*?position: fixed/);
  assert.match(q800, /#topbar[\s\S]*?sticky/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /#topbar button[\s\S]*?min-height: 40px/);
  assert.match(css, /form:focus-within/);
  assert.match(css, /:focus-visible/);
});

test("attribution: MIT/Commons-Clause header note and footer link with safe rel", () => {
  assert.match(css, /Rare UI inspiration/);
  assert.match(css, /MIT \+ Commons Clause \+ Attribution/);
  assert.match(css, /rareui|rareui\.com/);
  const a = doc(html).querySelector("#credit a");
  assert.ok(a, "footer attribution link");
  assert.equal(a.getAttribute("href"), "https://rareui.com/");
  assert.equal(a.getAttribute("target"), "_blank");
  const rel = (a.getAttribute("rel") || "").split(/\s+/);
  assert.ok(rel.includes("noopener") && rel.includes("noreferrer"));
  // attribution text must not be styled into invisibility
  assert.match(css, /#credit/);
});

test("theme does not touch functionality markers (markdown/mermaid/model/upload)", () => {
  assert.match(src, /api\/render/);
  assert.match(src, /mermaid-vendor\.js/);
  assert.match(src, /api\/model/);
  assert.match(css, /\.hljs-keyword/); // highlight.js classes still themed
});
