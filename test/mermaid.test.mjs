import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { renderMarkdown } from "../src/markdown.mjs";

const CLIENT = readFileSync(new URL("../src/chat-client.js", import.meta.url), "utf8");

test("mermaid fence renders a toggleable block with escaped source, no raw HTML", () => {
  const html = renderMarkdown("```mermaid\ngraph TD\n  A[<b>x</b>] --> B\n```");
  assert.match(html, /<div class="mmd">/);
  assert.match(html, /<pre class="mermaid">graph TD/);
  assert.match(html, /A\[&lt;b&gt;x&lt;\/b&gt;\]/);
  assert.match(html, /class="mmd-toggle"/);
  assert.match(html, /<div class="mmd-out" hidden=""/);
  assert.doesNotMatch(html, /<script/i);
});

test("client upgrade draws SVG, keeps source toggle, and degrades on malformed input", async () => {
  const dom = new JSDOM(
    `<body><div class="mmd"><button class="mmd-toggle" type="button">source</button><pre class="mermaid">graph TD;A--&gt;B</pre><div class="mmd-out" hidden></div></div></body>`,
    { runScripts: "outside-only" },
  );
  const { window } = dom;
  window.mermaid = {
    initialize() {},
    render: async (id, src) => {
      if (src.includes("BROKEN")) throw new Error("Parse error on line 1");
      return { svg: `<svg id="${id}"><text>${src}</text></svg>` };
    },
  };
  window.eval(CLIENT);
  const div = window.document.querySelector(".mmd");
  const pre = div.querySelector("pre.mermaid");
  const out = div.querySelector(".mmd-out");
  const btn = div.querySelector(".mmd-toggle");

  window.chatRender(window.document);
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(div.dataset.mmdState, "ok");
  assert.match(out.innerHTML, /<svg id="mmd-1">/);
  assert.equal(pre.hidden, true);
  assert.equal(out.hidden, false);

  btn.click();
  assert.equal(pre.hidden, false);
  assert.equal(out.hidden, true);
  assert.equal(btn.textContent, "diagram");
  btn.click();
  assert.equal(pre.hidden, true);

  // malformed diagram: source stays visible, error surfaced, no throw
  const bad = window.document.createElement("div");
  bad.className = "mmd";
  bad.innerHTML = `<button class="mmd-toggle" type="button">source</button><pre class="mermaid">BROKEN</pre><div class="mmd-out" hidden></div>`;
  window.document.body.appendChild(bad);
  window.chatRender(window.document);
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(bad.dataset.mmdState, "error");
  assert.ok(bad.classList.contains("mmd-err"));
  assert.equal(bad.querySelector("pre.mermaid").hidden, false);
  assert.match(bad.querySelector(".mmd-msg").textContent, /Diagram error: Parse error/);
  // idempotent: no duplicate upgrade on re-render
  window.chatRender(window.document);
  assert.equal(bad.querySelectorAll(".mmd-msg").length, 1);
});

test("real vendored mermaid draws an SVG diagram from a fenced block (no scripts in output)", async () => {
  const dom = new JSDOM(`<body><div id="log"></div></body>`, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const { window } = dom;
  window.SVGElement.prototype.getBBox = () => ({ x: 0, y: 0, width: 100, height: 40 });
  window.SVGElement.prototype.getComputedTextLength = () => 50;
  const vendor = window.document.createElement("script");
  vendor.textContent = readFileSync(new URL("../node_modules/mermaid/dist/mermaid.min.js", import.meta.url), "utf8");
  window.document.head.appendChild(vendor);
  window.eval(CLIENT); // reuses window.mermaid already present, skips the network load

  const log = window.document.getElementById("log");
  log.innerHTML = renderMarkdown("```mermaid\ngraph TD\n  A --> B\n```");
  window.chatRender(log);
  for (let i = 0; i < 100 && log.querySelector(".mmd").dataset.mmdState !== "ok"; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }

  const div = log.querySelector(".mmd");
  assert.equal(div.dataset.mmdState, "ok");
  const svg = div.querySelector(".mmd-out svg");
  assert.ok(svg, "diagram svg rendered");
  assert.ok(svg.querySelector("text") || svg.textContent.trim().length, "diagram has content");
  assert.equal(div.querySelector("pre.mermaid").hidden, true, "source hidden by default, still present");
  assert.doesNotMatch(div.querySelector(".mmd-out").innerHTML, /<script/i);
});
