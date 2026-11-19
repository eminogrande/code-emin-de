// Strict image sniffing/decoding for chat attachments. No dependencies, no /tmp.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const MAX_IMAGES = 3;
export const MAX_BYTES = 4 * 1024 * 1024; // decoded per image
export const MAX_BODY_BYTES = 20 * 1024 * 1024; // whole /api/chat JSON body
export const MAX_SIDE = 16_000;
export const MAX_PIXELS = 40_000_000;

const MIME_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** Magic-byte sniff. Returns mime or null; never trusts the data-URL prefix. */
export function sniffMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38 &&
      (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61) return "image/gif";
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "image/webp";
  return null;
}

/** Header-only pixel dimensions; null when unparsable. */
export function dimensions(buf, mime) {
  try {
    if (mime === "image/png") return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (mime === "image/gif") return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    if (mime === "image/webp") {
      const kind = buf.toString("latin1", 12, 16);
      if (kind === "VP8X") return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
      if (kind === "VP8L") {
        const b = buf.readUInt32LE(21);
        return { w: 1 + (b & 0x3fff), h: 1 + ((b >> 14) & 0x3fff) };
      }
      if (kind === "VP8 ") return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
      return null;
    }
    if (mime === "image/jpeg") {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch {}
  return null;
}

/** Validate one `{dataUrl}` / `{data,mimeType}` item. Returns {buf,mimeType} or throws. */
export function decodeImage(item) {
  if (!item || typeof item !== "object") throw new Error("bad image item");
  let b64 = "";
  if (typeof item.dataUrl === "string") {
    const m = /^data:([\w/+.-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(item.dataUrl.trim());
    if (!m) throw new Error("bad data URL");
    b64 = m[2];
  } else if (typeof item.data === "string") {
    b64 = item.data;
  } else {
    throw new Error("bad data URL");
  }
  b64 = b64.replace(/\s+/g, "");
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new Error("bad base64");
  const buf = Buffer.from(b64, "base64");
  if (!buf.length) throw new Error("empty image");
  if (buf.length > MAX_BYTES) throw new Error("image too large (max 4MB)");
  const mimeType = sniffMime(buf);
  if (!mimeType) throw new Error("unsupported image type (png/jpeg/webp/gif only)");
  const dim = dimensions(buf, mimeType);
  if (dim && (dim.w > MAX_SIDE || dim.h > MAX_SIDE || dim.w * dim.h > MAX_PIXELS)) {
    throw new Error(`image dimensions too large (${dim.w}x${dim.h})`);
  }
  return { buf, mimeType };
}

export function imageId(buf) {
  return createHash("sha256").update(buf).digest("hex").slice(0, 32);
}

export const ID_RE = /^[a-f0-9]{32}$/;

/** Persist attachments, return [{id,mimeType}] safe to hand to the model/history. */
export async function storeImages(dataDir, items) {
  if (!Array.isArray(items) || items.length === 0) return [];
  if (items.length > MAX_IMAGES) throw new Error(`too many images (max ${MAX_IMAGES})`);
  const dir = join(dataDir, "images");
  await mkdir(dir, { recursive: true });
  const out = [];
  for (const item of items) {
    const { buf, mimeType } = decodeImage(item);
    const id = imageId(buf);
    await writeFile(join(dir, `${id}.${MIME_EXT[mimeType]}`), buf);
    out.push({ id, mimeType });
  }
  return out;
}
