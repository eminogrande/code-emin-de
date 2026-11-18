import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
const dom = new JSDOM("<!doctype html><body></body>", { runScripts: "dangerously", pretendToBeVisual: true });
const w = dom.window;
const P = w.SVGElement.prototype;
P.getComputedTextLength = function () { return (this.textContent || "").length * 8; };
P.getBBox = function () { return { x: 0, y: 0, width: (this.textContent||"").length*8, height: 16 }; };
const el = w.document.createElement("script");
el.textContent = readFileSync("node_modules/mermaid/dist/mermaid.min.js", "utf8");
w.document.body.appendChild(el);
w.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", htmlLabels: false });
const r = await w.mermaid.render("x1", "graph TD;A[One]-->B[Two]");
console.log("svg:", r.svg.slice(0,80).replace(/\n/g," "));
console.log("len:", r.svg.length, "hasText:", /One/.test(r.svg));
try { await w.mermaid.render("x2", "graph TD; A-->"); } catch (e) { console.log("parseErr caught:", e.message.slice(0,60)); }
