import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startUnixSocketServer, unixRpc } from "../src/cli.mjs";
import { createOptMem, defaultCompressPair } from "../src/optmem.mjs";

test("defaultCompressPair deduplicates and preserves both halves within 275 chars", () => {
  const longA = "A".repeat(210);
  const longB = "B".repeat(210);
  const block = `#0 2026-11-26 ${longA}\n#1 2026-11-26 ${longB}\n#2 2026-11-26 ${longA}`;
  const out = defaultCompressPair(block, "0-1");
  assert.ok(out.length <= 275);
  assert.ok(out.includes("AAA"));
  assert.ok(out.includes("BBB"));
  assert.equal(out.split(" | ").length, 2);
});

test("createOptMem detects external writes via refreshVersion and reports stats", async () => {
  const dir = await mkdtemp(join(tmpdir(), "optmem-ext-"));
  const a = createOptMem({ memoryDir: dir, wakeLines: 12 });
  const b = createOptMem({ memoryDir: dir, wakeLines: 12 });
  try {
    await a.init();
    await a.note("[local] initial memory");
    const v1 = await a.refreshVersion();
    await b.note("[remote] external write from second client");
    const v2 = await a.refreshVersion();
    assert.ok(v2 > v1);
    const st = await a.stats();
    assert.equal(st.wakeLines, 12);
    assert.ok(st.logBytes > 0 && st.wakeChars > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Unix socket exposes /memory/wake, /memory/recall, and /memory/note", async () => {
  const root = await mkdtemp(join(tmpdir(), "optmem-sock-"));
  const srv = await startUnixSocketServer({
    sockPath: join(root, "swarm.sock"),
    dataDir: join(root, "data"),
    workspaceDir: join(root, "ws"),
  });
  try {
    const saved = await unixRpc(srv.sockPath, "POST", "/memory/note", { note: "[vps] smoke rule verified" });
    assert.equal(saved.recorded, "[vps] smoke rule verified");
    const woke = await unixRpc(srv.sockPath, "GET", "/memory/wake");
    assert.match(woke.wake, /smoke rule verified/);
    assert.equal(woke.wakeLines, 24);
    const rec = await unixRpc(srv.sockPath, "GET", "/memory/recall?pattern=smoke%20rule");
    assert.match(rec.matches, /smoke rule verified/);
  } finally {
    await new Promise((r) => srv.server.close(r));
    await srv.daemon.close();
    await rm(root, { recursive: true, force: true });
  }
});
