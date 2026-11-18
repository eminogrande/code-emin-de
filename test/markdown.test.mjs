import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown, safeUrl } from "../src/markdown.mjs";

test("markdown: basic formatting renders", () => {
  const html = renderMarkdown("# T\n\n**b** _i_ `c`");
  assert.match(html, /<h1[^>]*>T<\/h1>/);
  assert.match(html, /<strong>b<\/strong>/);
  assert.match(html, /<em>i<\/em>/);
  assert.match(html, /<code>c<\/code>/);
});

test("markdown: raw html is sanitized, scripts and handlers dropped", () => {
  const html = renderMarkdown('<p onclick="x()">hi</p><script>alert(1)</script><b>ok</b>');
  assert.match(html, /hi/);
  assert.match(html, /<b>ok<\/b>/);
  assert.ok(!/<script>/.test(html));
  assert.ok(!/onclick=/.test(html));
});

test("markdown: url policy keeps http(s)/mailto/relative only", () => {
  assert.equal(safeUrl("https://a.b/c"), "https://a.b/c");
  assert.equal(safeUrl("mailto:a@b"), "mailto:a@b");
  assert.equal(safeUrl("/rel"), "/rel");
  assert.equal(safeUrl("javascript:alert(1)"), "");
  assert.equal(safeUrl("data:text/html,x"), "");
  const html = renderMarkdown("[a](javascript:alert(1)) [b](https://x.y)");
  assert.match(html, /<a href="https:\/\/x\.y"[^>]*rel="noopener noreferrer"/);
  assert.ok(!/javascript:/.test(html));
});

test("markdown: fenced code escapes body and keeps a copy button", () => {
  const html = renderMarkdown("```js\nconst a = 1 < 2;\n```");
  assert.match(html, /class="copy"/);
  assert.match(html, /language-js/);
  assert.ok(html.includes("1</span> &lt; <span"));
});

test("markdown: mermaid fence keeps source plus hidden svg target for the toggle hook", () => {
  const html = renderMarkdown("```mermaid\ngraph TD;A-->B\n```");
  assert.match(html, /<div class="mmd">/);
  assert.match(html, /class="mmd-toggle"/);
  assert.match(html, /<pre class="mermaid">/);
  assert.match(html, /<div class="mmd-out" hidden/);
  assert.ok(html.includes("A--&gt;B"));
});
