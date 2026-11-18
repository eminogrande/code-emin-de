import hljs from "highlight.js";
import { marked, Renderer } from "marked";

const esc = (s = "") =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const SAFE_URL = /^(?:https?:\/\/|mailto:|data:image\/(?:png|jpe?g|gif|webp);base64,|\/|#|\.{0,2}\/)/i;

function safeUrl(raw) {
  const u = String(raw || "").trim().replace(/[\u0000-\u001f\s]/g, "");
  if (!u || /^[a-z][a-z0-9+.-]*:/i.test(u)) return SAFE_URL.test(u) ? u : "";
  // scheme-less relative paths are fine
  return u.startsWith("//") ? u : u;
}

// --- sanitizer: allowlist only, by construction nothing else survives ---
const TAGS = new Set([
  "a","p","br","hr","strong","em","del","code","pre","span","div","button","img",
  "ul","ol","li","blockquote","h1","h2","h3","h4","h5","h6","section",
  "table","thead","tbody","tr","th","td",
]);
const ATTRS = {
  a: ["href", "title", "target", "rel"],
  img: ["src", "alt", "title", "width", "height"],
  pre: ["class", "data-src"],
  code: ["class"],
  span: ["class"],
  div: ["class"],
  button: ["class", "type", "data-code"],
  ul: ["start"],
  ol: ["start"],
  th: ["align", "colspan", "rowspan"],
  td: ["align", "colspan", "rowspan"],
  h1: ["id"], h2: ["id"], h3: ["id"], h4: ["id"], h5: ["id"], h6: ["id"],
};

function sanitize(html) {
  const out = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[!?][^>]*>/g, "")
    // script/style bodies are not markup for us: show them as text, escaped
    .replace(/<(script|style)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, body) => esc(body));
  return out.replace(/<(\/?)([a-zA-Z0-9]+)((?:\s+[^<>]*?)?)(\/?)>/g, (m, slash, rawName, attrStr, selfClose) => {
    const name = rawName.toLowerCase();
    if (!TAGS.has(name)) return "";
    if (slash) return `</${name}>`;
    const allowed = ATTRS[name] || [];
    let attrs = "";
    const re = /([a-zA-Z0-9:_-]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let a;
    while ((a = re.exec(attrStr))) {
      const key = a[1].toLowerCase();
      if (!allowed.includes(key)) continue;
      let val = a[3] ?? a[4] ?? a[5] ?? "";
      val = val.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
      if (key === "href" || key === "src") {
        val = safeUrl(val);
        if (!val) continue;
      } else if (val.length > 20000) {
        val = val.slice(0, 20000);
      }
      attrs += ` ${key}="${esc(val)}"`;
    }
    if (name === "a" && /\shref=/.test(attrs)) {
      if (!/\srel=/.test(attrs)) attrs += ' rel="noopener noreferrer"';
      if (!/\starget=/.test(attrs)) attrs += ' target="_blank"';
    }
    if (name === "img" && !/\ssrc=/.test(attrs)) return "";
    return `<${name}${attrs}${selfClose}>`;
  });
}

function makeRenderer() {
  const r = new Renderer();
  // raw HTML from the model: escaped unless it is a simple allowed tag (sanitizer checks anyway)
  r.html = ({ text }) => sanitize(text);
  r.code = ({ text, lang }) => {
    const tag = String(lang || "").trim().split(/\s+/)[0].toLowerCase();
    if (tag === "mermaid") {
      return `<div class="mmd"><pre class="mermaid" data-src="${esc(text)}">${esc(text)}</pre><div class="mmd-out" hidden></div></div>\n`;
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
    return `<div class="cb"><button class="copy" type="button" data-code="${esc(text)}">Copy</button><pre><code${cls}>${body}</code></pre></div>\n`;
  };
  r.link = ({ href, title, tokens }) => {
    const text = r.parser.parseInline(tokens);
    const url = safeUrl(href);
    if (!url) return text;
    return `<a href="${esc(url)}"${title ? ` title="${esc(title)}"` : ""} rel="noopener noreferrer" target="_blank">${text}</a>`;
  };
  return r;
}

let renderer = makeRenderer();
marked.setOptions({ gfm: true, breaks: true, headerIds: false, mangle: false });

export function renderMarkdown(src) {
  if (!src) return "";
  let html;
  try {
    html = marked.parse(String(src), { renderer, async: false });
  } catch {
    return `<p>${esc(src)}</p>`;
  }
  return sanitize(html);
}
