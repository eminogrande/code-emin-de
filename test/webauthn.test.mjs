import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { b64uDecode, b64uEncode, openPasskeyStore } from "../src/webauthn.mjs";

function sha256(b) {
  return createHash("sha256").update(b).digest();
}

// Minimal CBOR encoder for synthetic WebAuthn test vectors
function cborUint(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  const b = Buffer.alloc(3);
  b[0] = (major << 5) | 25;
  b.writeUInt16BE(n, 1);
  return b;
}
function cborInt(n) {
  return n >= 0 ? cborUint(0, n) : cborUint(1, -1 - n);
}
function cborBytes(buf) {
  return Buffer.concat([cborUint(2, buf.length), buf]);
}
function cborText(str) {
  const b = Buffer.from(str, "utf8");
  return Buffer.concat([cborUint(3, b.length), b]);
}
function cborMap(entries) {
  const parts = [cborUint(5, entries.length)];
  for (const [k, v] of entries) parts.push(k, v);
  return Buffer.concat(parts);
}

test("WebAuthn Passkey store: one-time enrollment, ES256 verify, replay & unauth rejection", () => {
  const dir = mkdtempSync(join(tmpdir(), "webauthn-test-"));
  try {
    const store = openPasskeyStore(join(dir, "auth.sqlite"), {
      rpId: "code.emin.de",
      expectedOrigin: "https://code.emin.de",
    });

    // 1. Public registration without SSH token MUST fail
    assert.throws(() => store.beginRegistration("fake-token"), /Invalid or expired/);

    // 2. Generate SSH-bootstrapped single-use token & synthetic hardware P-256 keypair
    const { token } = store.createEnrollToken("nuri-smartcard");
    const regOpts = store.beginRegistration(token);
    assert.equal(regOpts.rp.id, "code.emin.de");

    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    const x = b64uDecode(jwk.x);
    const y = b64uDecode(jwk.y);
    const credId = Buffer.from("nuri-smartcard-cred-01", "utf8");

    const coseKey = cborMap([
      [cborInt(1), cborInt(2)], // kty: EC2
      [cborInt(3), cborInt(-7)], // alg: ES256
      [cborInt(-1), cborInt(1)], // crv: P-256
      [cborInt(-2), cborBytes(x)],
      [cborInt(-3), cborBytes(y)],
    ]);

    const rpHash = sha256(Buffer.from("code.emin.de", "utf8"));
    const flags = Buffer.from([0x45]); // UP + UV + AT
    const signCount1 = Buffer.alloc(4);
    signCount1.writeUInt32BE(1, 0);
    const aaguid = Buffer.alloc(16, 0);
    const credLen = Buffer.alloc(2);
    credLen.writeUInt16BE(credId.length, 0);
    const authDataReg = Buffer.concat([rpHash, flags, signCount1, aaguid, credLen, credId, coseKey]);
    const attObj = cborMap([
      [cborText("fmt"), cborText("none")],
      [cborText("authData"), cborBytes(authDataReg)],
    ]);

    const clientDataReg = Buffer.from(
      JSON.stringify({
        type: "webauthn.create",
        challenge: regOpts.challenge,
        origin: "https://code.emin.de",
      }),
      "utf8",
    );

    const enrolled = store.finishRegistration({
      id: b64uEncode(credId),
      type: "public-key",
      response: {
        clientDataJSON: b64uEncode(clientDataReg),
        attestationObject: b64uEncode(attObj),
        transports: ["usb", "nfc"],
      },
    });
    assert.equal(enrolled.label, "nuri-smartcard");
    assert.equal(store.verifySession(enrolled.sessionToken), true);

    // 3. Reusing the same enrollment token MUST fail immediately
    assert.equal(store.checkEnrollToken(token), null);
    assert.throws(() => store.beginRegistration(token), /Invalid or expired/);

    // 4. Authenticate with valid ES256 hardware assertion
    const loginOpts = store.beginAuthentication();
    const clientDataLogin = Buffer.from(
      JSON.stringify({
        type: "webauthn.get",
        challenge: loginOpts.challenge,
        origin: "https://code.emin.de",
      }),
      "utf8",
    );
    const signCount2 = Buffer.alloc(4);
    signCount2.writeUInt32BE(2, 0);
    const authDataLogin = Buffer.concat([rpHash, Buffer.from([0x05]), signCount2]);
    const sig = sign("sha256", Buffer.concat([authDataLogin, sha256(clientDataLogin)]), privateKey);

    const loggedIn = store.finishAuthentication({
      id: b64uEncode(credId),
      type: "public-key",
      response: {
        clientDataJSON: b64uEncode(clientDataLogin),
        authenticatorData: b64uEncode(authDataLogin),
        signature: b64uEncode(sig),
      },
    });
    assert.equal(store.verifySession(loggedIn.sessionToken), true);

    // 5. signCount replay (signCount <= 2) MUST be rejected
    const loginOptsReplay = store.beginAuthentication();
    const clientDataReplay = Buffer.from(
      JSON.stringify({
        type: "webauthn.get",
        challenge: loginOptsReplay.challenge,
        origin: "https://code.emin.de",
      }),
      "utf8",
    );
    const sigReplay = sign("sha256", Buffer.concat([authDataLogin, sha256(clientDataReplay)]), privateKey);
    assert.throws(
      () =>
        store.finishAuthentication({
          id: b64uEncode(credId),
          type: "public-key",
          response: {
            clientDataJSON: b64uEncode(clientDataReplay),
            authenticatorData: b64uEncode(authDataLogin),
            signature: b64uEncode(sigReplay),
          },
        }),
      /signCount replay/,
    );

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
