import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { renderMarkdown, safeUrl } from "../src/markdown.mjs";

test("plain user newlines render once under the actual pre-wrap CSS", () => {
  const web = readFileSync(new URL("../src/web.mjs", import.meta.url), "utf8");
  const css = web.match(/\.m\.u\{white-space:pre-wrap;[^}]*\}/)?.[0];
  assert.ok(css, "user message white-space rule must remain testable");

  const html = renderMarkdown("first line\nsecond line\n\nnext paragraph");
  const { window } = new JSDOM(`<style>${css}</style><div class="m u">${html}</div>`);
  const message = window.document.querySelector(".m.u");
  const paragraphs = message.querySelectorAll("p");
  assert.equal(window.getComputedStyle(message).whiteSpace, "pre-wrap");
  assert.equal(paragraphs.length, 2, "the intentional blank line remains a paragraph boundary");
  assert.equal(message.querySelectorAll("br").length, 0, "pre-wrap text must not also contain forced breaks");
  assert.equal(paragraphs[0].textContent, "first line\nsecond line");
  assert.equal(paragraphs[1].textContent, "next paragraph");
});

test("renders headings, lists, quotes, tables, emphasis", () => {
  const html = renderMarkdown("# H1\n\n- a\n- b\n\n> q\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n**b** *i*");
  assert.match(html, /<h1>H1<\/h1>/);
  assert.match(html, /<ul>\s*<li>a<\/li>/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /<table>/);
  assert.match(html, /<strong>b<\/strong>/);
  assert.match(html, /<em>i<\/em>/);
});

test("code fences: highlighted, escaped, copy button", () => {
  const html = renderMarkdown("```js\nlet a = 1 < 2\n```");
  assert.match(html, /<div class="cb"><button class="copy" type="button" data-copied="false" aria-label="Copy" title="Copy">Copy<\/button>/);
  assert.match(html, /<code class="language-js">/);
  assert.match(html, /hljs-keyword/);
  assert.match(html, /&lt;/);
});

test("mermaid fence keeps readable source plus toggle", () => {
  const html = renderMarkdown("```mermaid\ngraph TD;A-->B\n```");
  assert.match(html, /<div class="mmd">/);
  assert.match(html, /<pre class="mermaid">graph TD;A--&gt;B<\/pre>/);
  assert.match(html, /mmd-toggle/);
});

test("relative, http(s) and mailto links allowed; target=_blank hardened", () => {
  for (const [src, href] of [
    ["[r](/x)", "/x"],
    ["[r](rel/a.md)", "rel/a.md"],
    ["[r](https://e.de/p)", "https://e.de/p"],
    ["[r](mailto:a@b.c)", "mailto:a@b.c"],
  ]) {
    const html = renderMarkdown(src);
    assert.ok(html.includes(`href="${href}"`), `${src} -> ${html}`);
    assert.match(html, /rel="noopener noreferrer"/);
    assert.match(html, /target="_blank"/);
  }
});

test("raw HTML link gets noopener/noreferrer and URL policy", () => {
  const html = renderMarkdown('<a href="https://e.de">x</a>');
  assert.match(html, /href="https:\/\/e\.de"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /target="_blank"/);
  const js = renderMarkdown('<a href="javascript:alert(1)">j</a>');
  assert.doesNotMatch(js, /href="javascript/);
  assert.match(js, /j/);
});

test("javascript:/vbscript:/data: URLs are rejected", () => {
  assert.equal(safeUrl("javascript:alert(1)"), "");
  assert.equal(safeUrl("JAVASCRIPT:alert(1)"), "");
  assert.equal(safeUrl("vbscript:x"), "");
  assert.equal(safeUrl("data:text/html,<b>x</b>"), "");
  assert.equal(safeUrl("data:image/png;base64,AAA"), "");
  assert.equal(safeUrl(" https://e.de "), "https://e.de");
});

test("XSS payloads neutralised", () => {
  const html = renderMarkdown(
    '<img src=x onerror=alert(1)>\n\n<script>alert(2)</script>\n\n<div onclick="pwn()">d</div>\n\n<svg onload=alert(3)></svg>\n\n<iframe src="https://e.de"></iframe>',
  );
  assert.match(html, /<img src="x">/);
  assert.doesNotMatch(html, /onerror|onclick|onload/);
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /alert\(2\)/); // body surfaced as text
  assert.doesNotMatch(html, /<iframe/i);
  assert.match(html, /<div>d<\/div>/);
});

test("data: image src dropped, no bloat", () => {
  const html = renderMarkdown('<img src="data:image/png;base64,AAAAAAAA" alt="a">');
  assert.doesNotMatch(html, /data:image/);
});

test("failure/empty inputs render safely", () => {
  assert.equal(renderMarkdown(""), "");
  assert.match(renderMarkdown("plain < text"), /plain &lt; text/);
});

test("single-line user bubble emits one paragraph, no br, no edge newlines", () => {
  const html = renderMarkdown("how much context you have left");
  assert.equal(html, "<p>how much context you have left</p>");
  assert.doesNotMatch(html, /<br/);
  assert.doesNotMatch(html, /^\n|\n$/);
});

test("inter-block newlines are dropped but in-paragraph newlines survive", () => {
  // single \n stays a raw newline (pre-wrap renders it) -> never doubled by CSS margins
  assert.equal(renderMarkdown("a\nb"), "<p>a\nb</p>");
  // blank line -> two paragraphs, no newline between the tags
  assert.equal(renderMarkdown("a\n\nb"), "<p>a</p><p>b</p>");
  assert.equal(renderMarkdown("a\n\nb").includes("<br"), false);
  // void tags (<br>, <hr>) must not keep a trailing \n that pre-wrap doubles
  assert.equal(renderMarkdown("a  \nb"), "<p>a<br>b</p>");
  assert.equal(renderMarkdown("a\n\n---\n\nb"), "<p>a</p><hr><p>b</p>");
});

test("code blocks keep exact whitespace and no trailing newline", () => {
  const src = "```js\nlet a  =  1\n\n  indented\n```";
  const html = renderMarkdown(src);
  const { window } = new JSDOM(`<div class="m u">${html}</div>`);
  assert.equal(window.document.querySelector("code").textContent, "let a  =  1\n\n  indented");
  assert.doesNotMatch(html, /\n$/);
});

test("stripped prefix tags leave no leading blank line", () => {
  const clean = "[ROUTER_HINT: fanout_parallel — x]\nhello".replace(/^\[ROUTER_HINT:[^\]]+\]\n/, "");
  assert.equal(renderMarkdown(clean), "<p>hello</p>");
  assert.equal(renderMarkdown("[GIT_CONTEXT: repo=x | branch=y]\nhello"), "<p>[GIT_CONTEXT: repo=x | branch=y]\nhello</p>");
});

test("assistant blocks stay compact with no spurious br", () => {
  const html = renderMarkdown("para\n\n- a\n- b\n\n> q\n\n```js\nx\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |");
  assert.doesNotMatch(html, /<br/);
  assert.doesNotMatch(html, />\n/);
  assert.match(html, /<ul><li>a<\/li>/);
  assert.match(html, /<blockquote><p>q<\/p><\/blockquote>/);
  assert.match(html, /<pre><code class="language-js">x<\/code><\/pre>/);
});
