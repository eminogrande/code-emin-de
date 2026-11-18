#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const dir = await mkdtemp(join(tmpdir(), "pi-durable-"));
const options = { models: createModels(), registry: createRegistry() };
try {
  const storage = await openNodeSqliteStorage(join(dir, "smoke.sqlite"));
  const harness = await Harness.open(storage, options, BACKGROUND_CONTEXT);
  await harness.root(BACKGROUND_CONTEXT);
  await harness.close(BACKGROUND_CONTEXT);
  const reopened = await Harness.open(await openNodeSqliteStorage(join(dir, "smoke.sqlite")), options, BACKGROUND_CONTEXT);
  await reopened.root(BACKGROUND_CONTEXT);
  await reopened.close(BACKGROUND_CONTEXT);
  console.log("PI_DURABLE_SQLITE_OK");
} finally {
  await rm(dir, { recursive: true, force: true });
}
