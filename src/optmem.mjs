import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const DEFAULT_MEMO_BIN = fileURLToPath(new URL("./memo", import.meta.url));
const MAX_ENTRY_CHARS = 275;

function clip(text, max) {
  if (text.length <= max) return text;
  return max > 3 ? text.slice(0, max - 3).trimEnd() + "..." : text.slice(0, max);
}

export function defaultCompressPair(promptBlock, rangeId) {
  const seen = new Set();
  const lines = [];
  for (const raw of String(promptBlock || "").split("\n")) {
    const t = raw.trim();
    if (!/^#\d+/.test(t)) continue;
    const body = t.replace(/^#\d+(?:-\d+)?\s+(?:\d{4}-\d{2}-\d{2}\s+)?/, "").replace(/\s+/g, " ").trim();
    if (body && !seen.has(body)) {
      seen.add(body);
      lines.push(body);
    }
  }
  if (lines.length === 0) return `Merged #${rangeId}`;
  const sep = " | ";
  const joined = lines.join(sep);
  if (joined.length <= MAX_ENTRY_CHARS) return joined;
  const per = Math.max(24, Math.floor((MAX_ENTRY_CHARS - sep.length * (lines.length - 1)) / lines.length));
  return clip(lines.map((l) => clip(l, per)).join(sep), MAX_ENTRY_CHARS);
}

export function createOptMem({ memoryDir, memoBin = DEFAULT_MEMO_BIN, wakeLines = 24, summarizePair } = {}) {
  if (!memoryDir) throw new Error("createOptMem: memoryDir required");
  const env = { ...process.env, MEMORY_DIR: memoryDir };
  const logPath = join(memoryDir, "LOG.txt");
  let queue = Promise.resolve();
  let version = 1;
  let lastStamp = "";

  function serialize(fn) {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  }

  async function syncStamp() {
    const st = await stat(logPath).catch(() => null);
    const stamp = st ? `${st.mtimeMs}:${st.size}` : "missing";
    if (lastStamp && stamp !== lastStamp) version += 1;
    lastStamp = stamp;
    return { stamp, logBytes: st ? st.size : 0 };
  }

  async function run(args) {
    await mkdir(memoryDir, { recursive: true });
    return execFileP("python3", [memoBin, ...args], { env, maxBuffer: 4 * 1024 * 1024 });
  }

  async function drainNaps(initialText) {
    let cur = initialText || "";
    let drained = 0;
    while (cur.includes(" nap ")) {
      const m = cur.match(/nap\s+(\d+-\d+)/);
      if (!m) break;
      const summary = summarizePair ? await summarizePair(cur, m[1]) : defaultCompressPair(cur, m[1]);
      const safeLine = String(summary).replace(/\s+/g, " ").trim().slice(0, MAX_ENTRY_CHARS);
      const r = await run(["nap", m[1], safeLine]);
      cur = r.stdout;
      drained++;
    }
    return drained;
  }

  return {
    memoryDir,
    getVersion() {
      return version;
    },
    refreshVersion() {
      return serialize(async () => {
        await syncStamp();
        return version;
      });
    },
    init() {
      return serialize(async () => {
        const { stdout } = await run(["init"]);
        await run(["config", `WAKE_LINES=${wakeLines}`]);
        await syncStamp();
        return stdout;
      });
    },
    wake() {
      return serialize(async () => {
        await syncStamp();
        try {
          const { stdout } = await run(["wake"]);
          return stdout.trim();
        } catch (err) {
          if (err?.stdout && err.stdout.includes(" nap ")) {
            await drainNaps(err.stdout);
            const { stdout } = await run(["wake"]);
            return stdout.trim();
          }
          throw err;
        }
      });
    },
    note(line) {
      return serialize(async () => {
        const clean = String(line).replace(/\s+/g, " ").trim().slice(0, MAX_ENTRY_CHARS);
        if (!clean) throw new Error("OptMem note must be non-empty");
        const { stdout } = await run(["note", clean]);
        const drained = await drainNaps(stdout);
        version += 1;
        const st = await stat(logPath).catch(() => null);
        lastStamp = st ? `${st.mtimeMs}:${st.size}` : lastStamp;
        return { recorded: clean, napsDrained: drained, version };
      });
    },
    recall(pattern) {
      return serialize(async () => {
        await syncStamp();
        const { stdout } = await run(["recall", String(pattern)]);
        return stdout.trim();
      });
    },
    zoom(range) {
      return serialize(async () => {
        const { stdout } = await run(["zoom", String(range)]);
        return stdout.trim();
      });
    },
    stats() {
      return serialize(async () => {
        const { logBytes } = await syncStamp();
        const wakeOut = await run(["wake"]).then((r) => r.stdout.trim(), () => "");
        return { memoryDir, version, wakeLines, logBytes, wakeChars: wakeOut.length };
      });
    },
  };
}
