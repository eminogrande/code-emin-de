import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWebServer } from "../src/web.mjs";
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

test("HTTP WebServer E2E: Passkey cookie -> /api/history + /api/chat over Unix socket", async () => {
  const dir = mkdtempSync(join(tmpdir(), "web-http-e2e-"));
  const sockPath = join(dir, "mock-swarm.sock");
  const authDbPath = join(dir, "auth.sqlite");

  // Mock swarmd Unix socket returning exact daemon shapes (`{ status: 'done', text: '...' }`)
  const mockDaemon = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url?.startsWith("/transcript")) {
      res.end(JSON.stringify({ conversationId: 1, entries: [{ id: 1, role: "assistant", text: "Ready." }] }));
    } else if (req.url === "/chat") {
      res.end(JSON.stringify({ route: "single_agent", conversationId: 1, status: "done", text: "Hello Emin." }));
    } else {
      res.end(JSON.stringify({ ok: true }));
    }
  });
  await new Promise((r) => mockDaemon.listen(sockPath, r));

  let web = null;
  try {
    web = await startWebServer({
      port: 0,
      host: "127.0.0.1",
      sockPath,
      authDbPath,
      rpId: "localhost",
      origin: "http://localhost",
    });
    const port = web.server.address().port;

    // 1. Unauthenticated /api/chat MUST return 401
    const rUnauth = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    assert.equal(rUnauth.status, 401);

    // 2. Enroll passkey via HTTP & obtain session cookie
    const { token } = web.auth.createEnrollToken("e2e-key");
    const rOpt = await fetch(`http://127.0.0.1:${port}/auth/register/options`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const regOpts = await rOpt.json();
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    const credId = Buffer.from("http-e2e-cred", "utf8");
    const coseKey = cborMap([
      [cborInt(1), cborInt(2)],
      [cborInt(3), cborInt(-7)],
      [cborInt(-1), cborInt(1)],
      [cborInt(-2), cborBytes(b64uDecode(jwk.x))],
      [cborInt(-3), cborBytes(b64uDecode(jwk.y))],
    ]);
    const rpHash = sha256(Buffer.from("localhost", "utf8"));
    const signCount1 = Buffer.alloc(4);
    signCount1.writeUInt32BE(1, 0);
    const credLen = Buffer.alloc(2);
    credLen.writeUInt16BE(credId.length, 0);
    const authData = Buffer.concat([rpHash, Buffer.from([0x45]), signCount1, Buffer.alloc(16, 0), credLen, credId, coseKey]);
    const attObj = cborMap([
      [cborText("fmt"), cborText("none")],
      [cborText("authData"), cborBytes(authData)],
    ]);
    const clientData = Buffer.from(
      JSON.stringify({ type: "webauthn.create", challenge: regOpts.challenge, origin: "http://localhost" }),
      "utf8",
    );

    const rVer = await fetch(`http://127.0.0.1:${port}/auth/register/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: b64uEncode(credId),
        type: "public-key",
        response: { clientDataJSON: b64uEncode(clientData), attestationObject: b64uEncode(attObj) },
      }),
    });
    assert.equal(rVer.status, 200);
    const cookie = rVer.headers.get("set-cookie").split(";")[0];

    // 3. Authenticated /api/history MUST return HTTP 200 + entries
    const rHist = await fetch(`http://127.0.0.1:${port}/api/history`, { headers: { Cookie: cookie } });
    assert.equal(rHist.status, 200);
    const histBody = await rHist.json();
    assert.equal(histBody.entries[0].text, "Ready.");

    // 4. Authenticated /api/chat MUST return HTTP 200 + text (NOT 'Invalid status code: done'!)
    const rChat = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ text: "hi" }),
    });
    assert.equal(rChat.status, 200);
    const chatBody = await rChat.json();
    assert.equal(chatBody.status, "done");
    assert.equal(chatBody.text, "Hello Emin.");

    // 5. Click-to-Sign SSH Bridge E2E: internal helper request blocks until browser resolves!
    const signReqPromise = fetch(`http://127.0.0.1:${port}/internal/ssh-sign/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Bridge-Secret": web.bridgeSecret },
      body: JSON.stringify({
        application: "ssh:",
        dataHex: "deadbeef",
        keyHandleHex: "cafebabe",
        flags: 1,
        sshCommand: "ssh nuri.com uptime",
      }),
    });

    await new Promise((r) => setTimeout(r, 25));
    const rPend = await fetch(`http://127.0.0.1:${port}/api/ssh-sign/pending`, { headers: { Cookie: cookie } });
    const pendBody = await rPend.json();
    assert.equal(pendBody.pending.length, 1);
    assert.equal(pendBody.pending[0].sshCommand, "ssh nuri.com uptime");

    const rRes = await fetch(`http://127.0.0.1:${port}/api/ssh-sign/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        id: pendBody.pending[0].id,
        approve: true,
        flags: "01",
        counter: 42,
        sigR: "1122",
        sigS: "3344",
      }),
    });
    assert.equal(rRes.status, 200);

    const signOut = await (await signReqPromise).json();
    assert.equal(signOut.ok, true);
    assert.equal(signOut.counter, 42);
    assert.equal(signOut.sigR, "1122");
  } finally {
    if (web) {
      web.server.close();
      web.auth.close();
    }
    mockDaemon.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
