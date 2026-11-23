import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const DEFAULT_MEMO_BIN = fileURLToPath(new URL("./memo", import.meta.url));

function defaultCompressPair(promptBlock, rangeId) {
  const lines = promptBlock
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^#\d+/.test(l))
    .map((l) => l.replace(/^#\d+(?:-\d+)?\s+(?:\d{4}-\d{2}-\d{2}\s+)?/, ""));
  if (lines.length === 0) return `Merged #${rangeId}`;
  const joined = lines.join(" | ");
  return joined.length <= 275 ? joined : joined.slice(0, 272) + "...";
}

export function createOptMem({ memoryDir, memoBin = DEFAULT_MEMO_BIN, wakeLines = 48, summarizePair } = {}) {
  if (!memoryDir) throw new Error("createOptMem: memoryDir required");
  const env = { ...process.env, MEMORY_DIR: memoryDir };
  let queue = Promise.resolve();
  let version = 1;

  function serialize(fn) {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
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
      const safeLine = String(summary).replace(/\s+/g, " ").trim().slice(0, 275);
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
    init() {
      return serialize(async () => {
        const { stdout } = await run(["init"]);
        await run(["config", `WAKE_LINES=${wakeLines}`]);
        return stdout;
      });
    },
    wake() {
      return serialize(async () => {
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
        const clean = String(line).replace(/\s+/g, " ").trim().slice(0, 275);
        if (!clean) throw new Error("OptMem note must be non-empty");
        const { stdout } = await run(["note", clean]);
        const drained = await drainNaps(stdout);
        version += 1;
        return { recorded: clean, napsDrained: drained, version };
      });
    },
    recall(pattern) {
      return serialize(async () => {
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
  };
}
