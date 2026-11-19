// Server-side Markdown renderer for the chat UI.
// Raw model HTML is allowed through a mature sanitizer (DOMPurify on jsdom) with an
// explicit tag/attr allowlist; URL policy is http(s)/mailto + relative only.
import { JSDOM } from "jsdom";
import createDOMPurify from "dompurify";
import hljs from "highlight.js";
import { marked, Renderer } from "marked";

const dom = new JSDOM("<!doctype html><body>");
const purify = createDOMPurify(dom.window);

const esc = (s = "") =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// Relative, "#frag", http(s): and mailto: only. Everything else (data:, javascript:, vbscript:) is dropped.
export function safeUrl(raw) {
  const u = String(raw || "").trim().replace(/[\u0000-\u0020]/g, "");
  if (!u) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return /^(?:https?:|mailto:)/i.test(u) ? u : "";
  return u; // relative path, /abs, ?query, #frag, //host
}

const TAGS = [
  "a", "p", "br", "hr", "strong", "em", "b", "i", "del", "code", "pre", "span", "div", "button", "img",
  "ul", "ol", "li", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "section",
  "table", "thead", "tbody", "tr", "th", "td", "kbd", "sub", "sup",
  "svg", "rect", "path", "g",
];
const ATTRS = [
  "href", "title", "target", "rel", "src", "alt", "width", "height", "class", "type",
  "data-code", "data-slot", "data-copied", "aria-label", "aria-hidden", "viewBox", "fill",
  "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "x", "y", "rx", "ry",
  "start", "align", "colspan", "rowspan", "aria-expanded", "hidden",
];

export function sanitize(html = "") {
  // marked hands inline raw HTML to the renderer token-by-token, so `<a href=x>` and `</a>`
  // arrive separately: parse inside a wrapper so dangling fragments survive jsdom.
  // <script>/<style> bodies are dropped by DOMPurify; surface them as visible text instead.
  const pre = String(html).replace(/<(script|style)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, body) => `\n${esc(body)}\n`);
  const clean = purify.sanitize(`<div>${pre}</div>`, {
    ALLOWED_TAGS: TAGS,
    ALLOWED_ATTR: ATTRS,
    ALLOW_DATA_ATTR: false,
    KEEP_CONTENT: true,
  });
  const root = dom.window.document.createElement("div");
  root.innerHTML = clean;
  for (const a of root.querySelectorAll("a")) {
    const url = safeUrl(a.getAttribute("href"));
    if (!url) {
      a.replaceWith(...a.childNodes); // no usable target -> plain text
      continue;
    }
    a.setAttribute("href", url);
    a.setAttribute("rel", "noopener noreferrer");
    a.setAttribute("target", "_blank");
  }
  for (const img of root.querySelectorAll("img")) {
    const url = safeUrl(img.getAttribute("src"));
    if (!url) img.remove(); // no src, or data: bloat
    else img.setAttribute("src", url);
  }
  const wrap = root.firstElementChild;
  return wrap ? wrap.innerHTML : root.innerHTML;
}

function makeRenderer() {
  const r = new Renderer();
  // Raw HTML passes through untouched; the whole document is sanitized once at the end so
  // balanced inline tags (<a>…</a>) survive instead of being split per fragment.
  r.html = ({ text }) => text;
  r.code = ({ text, lang }) => {
    const tag = String(lang || "").trim().split(/\s+/)[0].toLowerCase();
    if (tag === "mermaid") {
      // Source stays in the DOM (toggleable); src/mermaid-client.js upgrades it to SVG.
      return `<div class="mmd"><button class="mmd-toggle" type="button" aria-expanded="false">source</button><pre class="mermaid">${esc(text)}</pre><div class="mmd-out" hidden></div></div>\n`;
    }
    let body = esc(text);
    let cls = "";
    if (tag && hljs.getLanguage(tag)) {
      try {
        body = hljs.highlight(text, { language: tag, ignoreIllegals: true }).value;
        cls = ` class="language-${esc(tag)}"`;
      } catch {}
    } else if (tag) {
      cls = ` class="language-${esc(tag)}"`;
    }
    // CopyButton markup adapted from Rare UI (src/rare-button.css holds the styles).
    return `<div class="cb"><button class="copy" type="button" data-slot="copy-button" data-copied="false" data-code="${esc(text)}" aria-label="Copy" title="Copy"><span class="cb-icon" aria-hidden="true"><span class="cb-layer cb-layer-idle"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg></span><span class="cb-layer cb-layer-done"><svg viewBox="0 0 20 20" fill="none"><path d="M10 0a3 3 0 0 1 1.86.92 3 3 0 0 1 3.37 1.33 3 3 0 0 1 2.5 2.64 3 3 0 0 1 1.77 3.33 3 3 0 0 1 .5 1.78 3 3 0 0 1-.92 1.86 3 3 0 0 1-1.33 3.37 3 3 0 0 1-2.64 2.5 3 3 0 0 1-3.33 1.77A3 3 0 0 1 6.08 19.2a3 3 0 0 1-2.5-2.64 3 3 0 0 1-1.77-3.33A3 3 0 0 1 2 10.92a3 3 0 0 1 .92-1.86 3 3 0 0 1 1.33-3.37 3 3 0 0 1 2.64-2.5A3 3 0 0 1 10 0Z" fill="#FF5100"/><path d="M6 10.42 8.33 12.82 14 7" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span></span></button><pre><code${cls}>${body}</code></pre></div>\n`;
  };
  r.link = ({ href, title, tokens }) => {
    const text = r.parser.parseInline(tokens);
    const url = safeUrl(href);
    if (!url) return text;
    return `<a href="${esc(url)}"${title ? ` title="${esc(title)}"` : ""} rel="noopener noreferrer" target="_blank">${text}</a>`;
  };
  return r;
}

const renderer = makeRenderer();
marked.setOptions({ gfm: true, breaks: true, async: false });

export function renderMarkdown(src) {
  if (!src) return "";
  let html;
  try {
    html = marked.parse(String(src), { renderer });
  } catch {
    return `<p>${esc(src)}</p>`;
  }
  return sanitize(html);
}
