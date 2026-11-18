#!/usr/bin/env python3
"""Local loopback PC/SC CTAP2 signer for https://code.emin.de (127.0.0.1:4199).

Zero private keys ever leave the smartcard. Accepts CORS requests ONLY from
https://code.emin.de so the user's explicit browser button click signs:
  1) WebAuthn Passkey enroll/login on ACS ACR39U / OMNIKEY 5422 (bypassing macOS
     Safari's T=0 contact-reader quirk).
  2) Click-to-Sign SSH challenges (application="ssh:") when code.emin.de needs
     to SSH into nuri.com or another smartcard-protected server.
"""
import base64
import hashlib
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CARD_REPO = "/Users/eminmahrt/Developer/nuri-passkey-prf-smartcard"
sys.path.insert(0, os.path.join(CARD_REPO, "scripts"))
import nuri_pcsc  # noqa: E402

nuri_pcsc.patch_fido2()

from fido2.cose import ES256  # noqa: E402
from fido2.ctap2 import Ctap2  # noqa: E402
from fido2.pcsc import CtapPcscDevice  # noqa: E402

ALLOWED_ORIGIN = os.environ.get("SWARM_ORIGIN", "https://code.emin.de")
PORT = int(os.environ.get("CARD_BRIDGE_PORT", "4199"))
LOCK = threading.Lock()


def b64u_enc(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


def b64u_dec(s: str) -> bytes:
    s = str(s or "")
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def der_len(buf: bytes, off: int):
    n = buf[off]
    off += 1
    if n < 0x80:
        return n, off
    size = n & 0x7F
    return int.from_bytes(buf[off : off + size], "big"), off + size


def der_ecdsa_rs(sig: bytes):
    if sig[0] != 0x30:
        raise ValueError("bad DER signature")
    _, off = der_len(sig, 1)
    if sig[off] != 0x02:
        raise ValueError("bad DER r")
    r_len, off = der_len(sig, off + 1)
    r = sig[off : off + r_len].lstrip(b"\0") or b"\0"
    off += r_len
    if sig[off] != 0x02:
        raise ValueError("bad DER s")
    s_len, off = der_len(sig, off + 1)
    s = sig[off : off + s_len].lstrip(b"\0") or b"\0"
    return r, s


def cbor_bstr(b: bytes) -> bytes:
    n = len(b)
    if n < 24:
        hdr = bytes([0x40 | n])
    elif n < 256:
        hdr = bytes([0x58, n])
    else:
        hdr = bytes([0x59]) + n.to_bytes(2, "big")
    return hdr + b


def cbor_tstr(s: str) -> bytes:
    b = s.encode("utf-8")
    n = len(b)
    hdr = bytes([0x60 | n]) if n < 24 else bytes([0x78, n])
    return hdr + b


def encode_none_attestation_object(auth_data: bytes) -> bytes:
    # CBOR map(2): {"fmt": "none", "authData": bstr(auth_data)}
    return b"\xa2" + cbor_tstr("fmt") + cbor_tstr("none") + cbor_tstr("authData") + cbor_bstr(auth_data)


def list_fido_devices(preferred_substr: str = ""):
    devs = list(CtapPcscDevice.list_devices())
    if preferred_substr:
        p = preferred_substr.lower()
        devs.sort(key=lambda d: (0 if p in str(d).lower() else 1))
    else:
        # Prefer ACS ACR39U first (user's active SSH card), then OMNIKEY
        devs.sort(key=lambda d: (0 if "acr39" in str(d).lower() else 1))
    return devs


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("[card-bridge] " + (fmt % args) + "\n")

    def _cors_ok(self) -> bool:
        origin = self.headers.get("Origin", "")
        return origin == ALLOWED_ORIGIN

    def _send(self, code: int, obj: dict):
        raw = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", ALLOWED_ORIGIN)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self):
        if not self._cors_ok():
            self.send_response(403)
            self.end_headers()
            return
        self._send(200, {"ok": True})

    def do_GET(self):
        if self.path == "/healthz":
            with LOCK:
                readers = [str(d) for d in list_fido_devices()]
            return self._send(200, {"ok": True, "readers": readers})
        self._send(404, {"error": "not_found"})

    def do_POST(self):
        if not self._cors_ok():
            return self._send(403, {"error": "Origin forbidden"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > 32768:
                return self._send(413, {"error": "Payload too large"})
            body = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        except Exception as e:
            return self._send(400, {"error": str(e)})

        try:
            with LOCK:
                if self.path == "/ssh-sign":
                    return self._handle_ssh_sign(body)
                if self.path == "/webauthn-create":
                    return self._handle_webauthn_create(body)
                if self.path == "/webauthn-get":
                    return self._handle_webauthn_get(body)
            return self._send(404, {"error": "not_found"})
        except Exception as e:
            return self._send(500, {"error": str(e)})

    def _handle_ssh_sign(self, body: dict):
        app = str(body.get("application") or "ssh:")
        data_bytes = bytes.fromhex(body["dataHex"])
        kh_bytes = bytes.fromhex(body["keyHandleHex"])
        flags = int(body.get("flags", 1))
        opts = {"up": bool(flags & 0x01)}
        if flags & 0x04:
            opts["uv"] = True

        last_err = "No matching smartcard found"
        for dev in list_fido_devices(body.get("reader", "")):
            try:
                assertion = Ctap2(dev).get_assertion(
                    app,
                    hashlib.sha256(data_bytes).digest(),
                    [{"type": "public-key", "id": kh_bytes}],
                    options=opts,
                )
                r, s = der_ecdsa_rs(assertion.signature)
                return self._send(
                    200,
                    {
                        "ok": True,
                        "reader": str(dev),
                        "flags": f"{int(assertion.auth_data.flags) & 0xFF:02x}",
                        "counter": int(assertion.auth_data.counter),
                        "sigR": r.hex(),
                        "sigS": s.hex(),
                    },
                )
            except Exception as e:
                last_err = str(e)
            finally:
                try:
                    dev.close()
                except Exception:
                    pass
        return self._send(400, {"error": last_err})

    def _handle_webauthn_create(self, body: dict):
        opt = body["options"]
        rp_id = opt["rp"]["id"]
        if rp_id != "code.emin.de":
            raise ValueError(f"Refusing unexpected rp.id: {rp_id}")
        client_data = json.dumps(
            {"type": "webauthn.create", "challenge": opt["challenge"], "origin": ALLOWED_ORIGIN},
            separators=(",", ":"),
        ).encode("utf-8")
        cd_hash = hashlib.sha256(client_data).digest()
        devs = list_fido_devices(body.get("reader", "ACR39"))
        if not devs:
            raise RuntimeError("No FIDO2 smartcard reader found")
        dev = devs[0]
        try:
            att = Ctap2(dev).make_credential(
                cd_hash,
                {"id": rp_id, "name": opt["rp"].get("name", rp_id)},
                {"id": b64u_dec(opt["user"]["id"]), "name": opt["user"]["name"], "displayName": opt["user"]["displayName"]},
                [{"type": "public-key", "alg": ES256.ALGORITHM}],
                options={"up": True},
            )
            cred_id = b64u_enc(att.auth_data.credential_data.credential_id)
            att_obj = encode_none_attestation_object(bytes(att.auth_data))
            return self._send(
                200,
                {
                    "id": cred_id,
                    "type": "public-key",
                    "reader": str(dev),
                    "response": {
                        "clientDataJSON": b64u_enc(client_data),
                        "attestationObject": b64u_enc(att_obj),
                        "transports": ["usb", "smart-card"],
                    },
                },
            )
        finally:
            try:
                dev.close()
            except Exception:
                pass

    def _handle_webauthn_get(self, body: dict):
        opt = body["options"]
        rp_id = opt.get("rpId") or "code.emin.de"
        if rp_id != "code.emin.de":
            raise ValueError(f"Refusing unexpected rpId: {rp_id}")
        client_data = json.dumps(
            {"type": "webauthn.get", "challenge": opt["challenge"], "origin": ALLOWED_ORIGIN},
            separators=(",", ":"),
        ).encode("utf-8")
        cd_hash = hashlib.sha256(client_data).digest()
        allow_list = [{"type": "public-key", "id": b64u_dec(c["id"])} for c in opt.get("allowCredentials", [])]

        last_err = "No matching passkey on connected smartcards"
        for dev in list_fido_devices(body.get("reader", "ACR39")):
            try:
                assertion = Ctap2(dev).get_assertion(rp_id, cd_hash, allow_list, options={"up": True})
                used_id = assertion.credential["id"] if assertion.credential and "id" in assertion.credential else allow_list[0]["id"]
                return self._send(
                    200,
                    {
                        "id": b64u_enc(used_id),
                        "type": "public-key",
                        "reader": str(dev),
                        "response": {
                            "clientDataJSON": b64u_enc(client_data),
                            "authenticatorData": b64u_enc(bytes(assertion.auth_data)),
                            "signature": b64u_enc(assertion.signature),
                        },
                    },
                )
            except Exception as e:
                last_err = str(e)
            finally:
                try:
                    dev.close()
                except Exception:
                    pass
        return self._send(400, {"error": last_err})


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    sys.stderr.write(f"[card-bridge] listening on http://127.0.0.1:{PORT} (allowed origin={ALLOWED_ORIGIN})\n")
    srv.serve_forever()
