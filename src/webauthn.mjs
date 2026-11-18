import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export function b64uEncode(buf) {
  return Buffer.from(buf).toString("base64url");
}

export function b64uDecode(str) {
  return Buffer.from(String(str || ""), "base64url");
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest();
}

// Minimal deterministic CBOR decoder (RFC 8949 subset sufficient for WebAuthn attestationObject & COSE_Key)
export function decodeCborFirst(buf, offset = 0) {
  if (offset >= buf.length) throw new Error("CBOR unexpected EOF");
  const first = buf[offset++];
  const major = first >> 5;
  const info = first & 0x1f;

  let len = 0;
  if (info < 24) {
    len = info;
  } else if (info === 24) {
    len = buf[offset++];
  } else if (info === 25) {
    len = buf.readUInt16BE(offset);
    offset += 2;
  } else if (info === 26) {
    len = buf.readUInt32BE(offset);
    offset += 4;
  } else if (info === 27) {
    const hi = buf.readUInt32BE(offset);
    const lo = buf.readUInt32BE(offset + 4);
    len = hi * 0x100000000 + lo;
    offset += 8;
  } else {
    throw new Error(`CBOR unsupported length info: ${info}`);
  }

  switch (major) {
    case 0:
      return [len, offset];
    case 1:
      return [-1 - len, offset];
    case 2:
      return [buf.subarray(offset, offset + len), offset + len];
    case 3:
      return [buf.subarray(offset, offset + len).toString("utf8"), offset + len];
    case 4: {
      const arr = [];
      for (let i = 0; i < len; i++) {
        const [v, next] = decodeCborFirst(buf, offset);
        arr.push(v);
        offset = next;
      }
      return [arr, offset];
    }
    case 5: {
      const map = new Map();
      for (let i = 0; i < len; i++) {
        const [k, kNext] = decodeCborFirst(buf, offset);
        const [v, vNext] = decodeCborFirst(buf, kNext);
        map.set(k, v);
        offset = vNext;
      }
      return [map, offset];
    }
    case 7: {
      if (info === 20) return [false, offset];
      if (info === 21) return [true, offset];
      if (info === 22) return [null, offset];
      throw new Error(`CBOR unsupported simple value: ${info}`);
    }
    default:
      throw new Error(`CBOR unsupported major type: ${major}`);
  }
}

function parseAuthenticatorData(authData, { requireCredData = false } = {}) {
  if (authData.length < 37) throw new Error("authenticatorData too short");
  const rpIdHash = authData.subarray(0, 32);
  const flags = authData[32];
  const userPresent = (flags & 0x01) !== 0;
  const userVerified = (flags & 0x04) !== 0;
  const attestedCredData = (flags & 0x40) !== 0;
  const signCount = authData.readUInt32BE(33);

  if (!requireCredData) {
    return { rpIdHash, flags, userPresent, userVerified, signCount };
  }
  if (!attestedCredData || authData.length < 55) {
    throw new Error("Missing attestedCredentialData");
  }
  const aaguid = authData.subarray(37, 53);
  const credIdLen = authData.readUInt16BE(53);
  const credStart = 55;
  const credEnd = credStart + credIdLen;
  if (authData.length <= credEnd) throw new Error("Truncated credentialId");
  const credentialId = authData.subarray(credStart, credEnd);
  const [coseKey] = decodeCborFirst(authData, credEnd);
  return { rpIdHash, flags, userPresent, userVerified, signCount, aaguid, credentialId, coseKey };
}

function coseToPublicKeySpki(coseMap) {
  const kty = coseMap.get(1);
  const alg = coseMap.get(3);
  // EC2 ES256 (P-256): kty=2, alg=-7, crv=1
  if (kty === 2 && alg === -7) {
    const crv = coseMap.get(-1);
    const x = coseMap.get(-2);
    const y = coseMap.get(-3);
    if (crv !== 1 || !Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) {
      throw new Error("Invalid P-256 COSE key");
    }
    const keyObj = createPublicKey({
      key: { kty: "EC", crv: "P-256", x: b64uEncode(x), y: b64uEncode(y) },
      format: "jwk",
    });
    return { alg: -7, spki: keyObj.export({ type: "spki", format: "der" }) };
  }
  // OKP EdDSA (Ed25519): kty=1, alg=-8, crv=6
  if (kty === 1 && alg === -8) {
    const crv = coseMap.get(-1);
    const x = coseMap.get(-2);
    if (crv !== 6 || !Buffer.isBuffer(x) || x.length !== 32) {
      throw new Error("Invalid Ed25519 COSE key");
    }
    const keyObj = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: b64uEncode(x) },
      format: "jwk",
    });
    return { alg: -8, spki: keyObj.export({ type: "spki", format: "der" }) };
  }
  throw new Error(`Unsupported passkey COSE alg=${alg} kty=${kty}`);
}

export function openPasskeyStore(dbPath, { rpId = "code.emin.de", rpName = "code.emin.de", expectedOrigin = `https://${rpId}` } = {}) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS credentials (
      credential_id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      alg INTEGER NOT NULL,
      public_key BLOB NOT NULL,
      sign_count INTEGER NOT NULL DEFAULT 0,
      transports TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      last_used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash BLOB PRIMARY KEY,
      credential_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS enroll_tokens (
      token_hash BLOB PRIMARY KEY,
      label TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS challenges (
      challenge TEXT PRIMARY KEY,
      purpose TEXT NOT NULL,
      enroll_hash BLOB,
      label TEXT,
      expires_at INTEGER NOT NULL
    );
  `);

  const expectedRpHash = sha256(Buffer.from(rpId, "utf8"));

  function gc() {
    const now = Date.now();
    db.prepare("DELETE FROM challenges WHERE expires_at < ?").run(now);
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now);
    db.prepare("DELETE FROM enroll_tokens WHERE expires_at < ? AND used_at IS NULL").run(now - 86_400_000);
  }

  function createEnrollToken(label = "passkey", ttlMs = 10 * 60_000) {
    gc();
    const raw = b64uEncode(randomBytes(32));
    const hash = sha256(Buffer.from(raw, "utf8"));
    const expiresAt = Date.now() + ttlMs;
    db.prepare("INSERT INTO enroll_tokens (token_hash, label, expires_at) VALUES (?, ?, ?)").run(hash, label, expiresAt);
    return { token: raw, label, expiresAt };
  }

  function checkEnrollToken(rawToken) {
    gc();
    if (!rawToken || typeof rawToken !== "string") return null;
    const hash = sha256(Buffer.from(rawToken, "utf8"));
    const row = db
      .prepare("SELECT token_hash, label, expires_at, used_at FROM enroll_tokens WHERE token_hash = ?")
      .get(hash);
    if (!row || row.used_at !== null || row.expires_at < Date.now()) return null;
    return { hash, label: row.label };
  }

  function beginRegistration(rawEnrollToken) {
    const enroll = checkEnrollToken(rawEnrollToken);
    if (!enroll) throw new Error("Invalid or expired enrollment token");
    const challenge = b64uEncode(randomBytes(32));
    db.prepare("INSERT INTO challenges (challenge, purpose, enroll_hash, label, expires_at) VALUES (?, 'register', ?, ?, ?)").run(
      challenge,
      enroll.hash,
      enroll.label,
      Date.now() + 180_000,
    );
    const existing = db.prepare("SELECT credential_id, transports FROM credentials").all();
    return {
      rp: { id: rpId, name: rpName },
      user: { id: b64uEncode(Buffer.from("emin", "utf8")), name: "emin", displayName: "Emin" },
      challenge,
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -8 },
      ],
      timeout: 120_000,
      attestation: "none",
      authenticatorSelection: {
        userVerification: "preferred",
        residentKey: "preferred",
      },
      excludeCredentials: existing.map((c) => ({
        type: "public-key",
        id: c.credential_id,
        transports: JSON.parse(c.transports || "[]"),
      })),
    };
  }

  function finishRegistration(payload) {
    gc();
    const clientDataRaw = b64uDecode(payload?.response?.clientDataJSON);
    const clientData = JSON.parse(clientDataRaw.toString("utf8"));
    if (clientData.type !== "webauthn.create") throw new Error("Unexpected clientData.type");
    if (clientData.origin !== expectedOrigin) throw new Error(`Unexpected origin: ${clientData.origin}`);

    const chRow = db
      .prepare("SELECT challenge, purpose, enroll_hash, label, expires_at FROM challenges WHERE challenge = ?")
      .get(clientData.challenge);
    if (!chRow || chRow.purpose !== "register" || chRow.expires_at < Date.now()) {
      throw new Error("Invalid or expired registration challenge");
    }
    db.prepare("DELETE FROM challenges WHERE challenge = ?").run(clientData.challenge);

    // Ensure enrollment token is still unused right now
    const tokRow = db.prepare("SELECT used_at, expires_at FROM enroll_tokens WHERE token_hash = ?").get(chRow.enroll_hash);
    if (!tokRow || tokRow.used_at !== null || tokRow.expires_at < Date.now()) {
      throw new Error("Enrollment token already consumed or expired");
    }

    const attObjRaw = b64uDecode(payload?.response?.attestationObject);
    const [attMap] = decodeCborFirst(attObjRaw);
    const authData = attMap.get("authData");
    if (!Buffer.isBuffer(authData)) throw new Error("Missing authData in attestationObject");

    const parsed = parseAuthenticatorData(authData, { requireCredData: true });
    if (!timingSafeEqual(parsed.rpIdHash, expectedRpHash)) throw new Error("RP ID hash mismatch");
    if (!parsed.userPresent) throw new Error("User presence required");

    const credIdB64 = b64uEncode(parsed.credentialId);
    const { alg, spki } = coseToPublicKeySpki(parsed.coseKey);
    const transports = Array.isArray(payload?.response?.transports)
      ? payload.response.transports.filter((t) => typeof t === "string").slice(0, 6)
      : [];

    const now = Date.now();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE enroll_tokens SET used_at = ? WHERE token_hash = ?").run(now, chRow.enroll_hash);
      db.prepare(
        `INSERT INTO credentials (credential_id, label, alg, public_key, sign_count, transports, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(credIdB64, chRow.label || "passkey", alg, spki, parsed.signCount, JSON.stringify(transports), now, now);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }

    return { credentialId: credIdB64, label: chRow.label || "passkey", sessionToken: createSession(credIdB64) };
  }

  function beginAuthentication() {
    gc();
    const creds = db.prepare("SELECT credential_id, transports FROM credentials").all();
    if (creds.length === 0) throw new Error("No passkeys enrolled");
    const challenge = b64uEncode(randomBytes(32));
    db.prepare("INSERT INTO challenges (challenge, purpose, expires_at) VALUES (?, 'login', ?)").run(
      challenge,
      Date.now() + 180_000,
    );
    return {
      rpId,
      challenge,
      timeout: 120_000,
      userVerification: "preferred",
      allowCredentials: creds.map((c) => ({
        type: "public-key",
        id: c.credential_id,
        transports: JSON.parse(c.transports || "[]"),
      })),
    };
  }

  function finishAuthentication(payload) {
    gc();
    const credId = String(payload?.id || "");
    const cred = db
      .prepare("SELECT credential_id, alg, public_key, sign_count FROM credentials WHERE credential_id = ?")
      .get(credId);
    if (!cred) throw new Error("Unknown passkey");

    const clientDataRaw = b64uDecode(payload?.response?.clientDataJSON);
    const clientData = JSON.parse(clientDataRaw.toString("utf8"));
    if (clientData.type !== "webauthn.get") throw new Error("Unexpected clientData.type");
    if (clientData.origin !== expectedOrigin) throw new Error(`Unexpected origin: ${clientData.origin}`);

    const chRow = db
      .prepare("SELECT challenge, purpose, expires_at FROM challenges WHERE challenge = ?")
      .get(clientData.challenge);
    if (!chRow || chRow.purpose !== "login" || chRow.expires_at < Date.now()) {
      throw new Error("Invalid or expired login challenge");
    }
    db.prepare("DELETE FROM challenges WHERE challenge = ?").run(clientData.challenge);

    const authData = b64uDecode(payload?.response?.authenticatorData);
    const signature = b64uDecode(payload?.response?.signature);
    const parsed = parseAuthenticatorData(authData, { requireCredData: false });

    if (!timingSafeEqual(parsed.rpIdHash, expectedRpHash)) throw new Error("RP ID hash mismatch");
    if (!parsed.userPresent) throw new Error("User presence required");

    const signedData = Buffer.concat([authData, sha256(clientDataRaw)]);
    const pubKey = createPublicKey({ key: Buffer.from(cred.public_key), format: "der", type: "spki" });
    const ok =
      cred.alg === -8
        ? verify(null, signedData, pubKey, signature)
        : verify("sha256", signedData, pubKey, signature);
    if (!ok) throw new Error("Invalid passkey signature");

    if ((cred.sign_count > 0 || parsed.signCount > 0) && parsed.signCount <= cred.sign_count) {
      throw new Error("Passkey signCount replay detected");
    }

    const now = Date.now();
    db.prepare("UPDATE credentials SET sign_count = ?, last_used_at = ? WHERE credential_id = ?").run(
      parsed.signCount,
      now,
      credId,
    );

    return { credentialId: credId, sessionToken: createSession(credId) };
  }

  function createSession(credentialId, ttlMs = 14 * 86_400_000) {
    const raw = b64uEncode(randomBytes(32));
    const hash = sha256(Buffer.from(raw, "utf8"));
    const now = Date.now();
    db.prepare("INSERT INTO sessions (token_hash, credential_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
      hash,
      credentialId,
      now,
      now + ttlMs,
    );
    return raw;
  }

  function verifySession(rawToken) {
    if (!rawToken || typeof rawToken !== "string") return false;
    const hash = sha256(Buffer.from(rawToken, "utf8"));
    const row = db.prepare("SELECT expires_at FROM sessions WHERE token_hash = ?").get(hash);
    return !!row && row.expires_at > Date.now();
  }

  function revokeSession(rawToken) {
    if (!rawToken || typeof rawToken !== "string") return;
    const hash = sha256(Buffer.from(rawToken, "utf8"));
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash);
  }

  function listCredentials() {
    return db.prepare("SELECT credential_id, label, alg, sign_count, created_at, last_used_at FROM credentials").all();
  }

  return {
    createEnrollToken,
    checkEnrollToken,
    beginRegistration,
    finishRegistration,
    beginAuthentication,
    finishAuthentication,
    verifySession,
    revokeSession,
    listCredentials,
    close: () => db.close(),
  };
}
