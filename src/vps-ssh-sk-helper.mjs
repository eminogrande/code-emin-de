#!/usr/bin/env -S node --no-warnings
// OpenSSH SecurityKeyProvider helper for VPS `swarm` user.
// Never sees or holds any private key: posts the exact SSH_MSG_USERAUTH_REQUEST
// challenge to swarm-web (127.0.0.1:3001) and blocks until Emin clicks
// [Sign with Smartcard] in https://code.emin.de.

import { readFileSync } from "node:fs";

function parseArgs(argv) {
  const out = { cmd: argv[2] };
  for (let i = 3; i < argv.length; i += 2) {
    const k = (argv[i] || "").replace(/^--/, "");
    out[k] = argv[i + 1];
  }
  return out;
}

function parentSshCommand() {
  try {
    // Walk /proc/<ppid>/cmdline to show the exact target host & command in browser UI!
    let pid = process.ppid;
    for (let depth = 0; depth < 3 && pid > 1; depth++) {
      const raw = readFileSync(`/proc/${pid}/cmdline`);
      const parts = raw.toString("utf8").split("\0").filter(Boolean);
      if (parts[0]?.endsWith("ssh") || parts.includes("ssh")) {
        return parts.join(" ").slice(0, 240);
      }
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const m = stat.match(/^\d+\s+\([^)]+\)\s+\S+\s+(\d+)/);
      pid = m ? Number(m[1]) : 0;
    }
  } catch {}
  return "ssh (remote)";
}

const args = parseArgs(process.argv);
if (args.cmd !== "sign") {
  console.log("status=ERR\nerror=UNSUPPORTED\nmessage=Only sign is supported on VPS");
  process.exit(1);
}

const webPort = process.env.SWARM_WEB_PORT || "3001";
const secret = (() => {
  try {
    return readFileSync("/home/swarm/.pi-durable/ssh-bridge.secret", "utf8").trim();
  } catch {
    return "";
  }
})();

try {
  const r = await fetch(`http://127.0.0.1:${webPort}/internal/ssh-sign/request`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Bridge-Secret": secret,
    },
    body: JSON.stringify({
      application: args.application || "ssh:",
      dataHex: args["data-hex"],
      keyHandleHex: args["key-handle-hex"],
      flags: Number(args.flags || "1"),
      sshCommand: parentSshCommand(),
    }),
    signal: AbortSignal.timeout(95_000),
  });
  const body = await r.json();
  if (!r.ok || !body.ok) {
    console.log(`status=ERR\nerror=GENERAL\nmessage=${String(body.error || "Denied").replace(/\s+/g, " ")}`);
    process.exit(1);
  }
  console.log(`status=OK\nflags=${body.flags}\ncounter=${body.counter}\nsig_r=${body.sigR}\nsig_s=${body.sigS}`);
} catch (err) {
  console.log(`status=ERR\nerror=GENERAL\nmessage=${String(err?.message || err).replace(/\s+/g, " ")}`);
  process.exit(1);
}
