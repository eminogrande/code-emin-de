// Image attachment validation: strict magic-byte sniffing, caps, storage and auth-gated serving.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deflateSync } from "node:zlib";
import {
  decodeImage,
  dimensions,
  ID_RE,
  imageId,
  MAX_BYTES,
  sanitizeCorruptDurableImages,
  sniffMime,
  storeImages,
  VALID_1X1_PNG_BASE64,
} from "../src/image-util.mjs";

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function tinyPng(w = 1, h = 1) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const dataUrl = (buf, mime = "image/png") => `data:${mime};base64,${buf.toString("base64")}`;

test("sniffs the four allowed formats by magic bytes only", () => {
  assert.equal(sniffMime(tinyPng()), "image/png");
  assert.equal(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8])), "image/jpeg");
  assert.equal(sniffMime(Buffer.from("GIF89a" + "\0".repeat(8), "latin1")), "image/gif");
  assert.equal(sniffMime(Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1")), "image/webp");
  // svg/html look like text and must not pass
  assert.equal(sniffMime(Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>")), null);
});

test("jpg/png dimensions are read from headers, not trusted metadata", () => {
  assert.deepEqual(dimensions(tinyPng(7, 5), "image/png"), { w: 7, h: 5 });
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x40, 0x03, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(dimensions(jpg, "image/jpeg"), { w: 64, h: 32 });
});

test("decodeImage rejects mismatch data-URL prefixes, svg and oversize payloads", () => {
  const png = tinyPng();
  const ok = decodeImage({ dataUrl: dataUrl(png, "image/gif") }); // lying prefix still sniffs to png
  assert.equal(ok.mimeType, "image/png");
  assert.throws(() => decodeImage({ dataUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" }), /unsupported/);
  assert.throws(() => decodeImage({ dataUrl: "not a data url" }), /bad data URL/);
  const big = Buffer.concat([tinyPng(), Buffer.alloc(MAX_BYTES)]);
  assert.throws(() => decodeImage({ dataUrl: dataUrl(big) }), /too large/);
});

test("storeImages persists content-addressed files and caps the count", async () => {
  const dir = await mkdtemp(join(tmpdir(), "img-"));
  try {
    const png = tinyPng(3, 3);
    const out = await storeImages(dir, [{ dataUrl: dataUrl(png) }]);
    assert.equal(out.length, 1);
    assert.match(out[0].id, ID_RE);
    assert.equal(out[0].id, imageId(png));
    assert.deepEqual(await readFile(join(dir, "images", `${out[0].id}.png`)), png);
    await assert.rejects(() => storeImages(dir, [{ dataUrl: dataUrl(tinyPng()) }, { dataUrl: dataUrl(tinyPng()) }, { dataUrl: dataUrl(tinyPng()) }, { dataUrl: dataUrl(tinyPng()) }]), /too many/);
    assert.deepEqual(await storeImages(dir, []), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("decodeImage rejects malformed PNGs with invalid IDAT chunk length and sanitizeCorruptDurableImages repairs poisoned sqlite entries", async () => {
  // Exact 67-byte corrupt PNG from entry 6231 (IDAT header declares 13 bytes for a 10-byte zlib stream)
  const corruptB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==";
  assert.throws(() => decodeImage({ data: corruptB64, mimeType: "image/png" }), /corrupt PNG/);
  assert.doesNotThrow(() => decodeImage({ data: VALID_1X1_PNG_BASE64, mimeType: "image/png" }));

  const dir = await mkdtemp(join(tmpdir(), "img-repair-"));
  const dbPath = join(dir, "durable.sqlite");
  try {
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE entries (
        id INTEGER PRIMARY KEY,
        conversation_id INTEGER NOT NULL,
        head INTEGER,
        commit_seq INTEGER NOT NULL,
        record TEXT NOT NULL
      ) STRICT
    `);
    const poisonedRecord = JSON.stringify({
      model: [
        {
          role: "user",
          content: [
            { type: "text", text: "e2e image probe" },
            { type: "image", data: corruptB64, mimeType: "image/png" },
          ],
          timestamp: 1795093334009,
        },
      ],
      kind: "pi.user",
      id: 6231,
      conversationId: 1,
    });
    const validRecord = JSON.stringify({
      model: [
        {
          role: "user",
          content: [
            { type: "text", text: "real screenshot" },
            { type: "image", data: VALID_1X1_PNG_BASE64, mimeType: "image/png" },
          ],
          timestamp: 1795093335000,
        },
      ],
      kind: "pi.user",
      id: 6358,
      conversationId: 1,
    });
    db.prepare("INSERT INTO entries (id, conversation_id, head, commit_seq, record) VALUES (?, ?, ?, ?, ?)").run(
      6231,
      1,
      null,
      1,
      poisonedRecord,
    );
    db.prepare("INSERT INTO entries (id, conversation_id, head, commit_seq, record) VALUES (?, ?, ?, ?, ?)").run(
      6358,
      1,
      null,
      2,
      validRecord,
    );
    db.close();

    assert.equal(sanitizeCorruptDurableImages(dbPath), 1);
    assert.equal(sanitizeCorruptDurableImages(dbPath), 0);

    const db2 = new DatabaseSync(dbPath);
    const repaired = JSON.parse(db2.prepare("SELECT record FROM entries WHERE id = 6231").get().record);
    assert.equal(repaired.model[0].content[1].data, VALID_1X1_PNG_BASE64);
    db2.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
