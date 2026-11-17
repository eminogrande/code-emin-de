#!/bin/sh
set -eu
docker compose exec -T -u agent swarm pi --version
docker compose exec -T -u agent swarm node /usr/local/bin/durable-smoke
docker compose exec -T -u agent -e MEMORY_DIR=/home/agent/.pi-durable/optmem swarm memo config >/dev/null
docker compose exec -T -u agent swarm node -e '
  const fs = require("fs");
  const s = JSON.parse(fs.readFileSync(process.env.HOME + "/.pi/agent/settings.json", "utf8"));
  if (s.defaultThinkingLevel !== "max" || s.enableSkills !== false) process.exit(1);
  const a = fs.readFileSync(process.env.HOME + "/.pi/agent/APPEND_SYSTEM.md", "utf8");
  if (!a.startsWith("CAVEMAN + ADHD MODE.")) process.exit(1);
'
docker compose exec -T -u agent swarm swarm status | grep -q '"liveTasks"'
ssh -i "$HOME/.ssh/pi-durable-local-ed25519" -p 2222 \
  -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
  -o UserKnownHostsFile="$HOME/.ssh/pi-durable-local-known_hosts" \
  agent@127.0.0.1 'printf "SSH_OK "; pi --version; swarm status | head -c 120; echo'
