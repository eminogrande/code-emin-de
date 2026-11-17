#!/bin/sh
set -eu
[ -s /etc/pi-ssh/authorized_keys ] || { echo 'ERROR: Add SSH public key to .ssh/authorized_keys (zero bearer tokens)' >&2; exit 1; }

install -o agent -g agent -m 700 -d /home/agent/.ssh /home/agent/.pi /home/agent/.pi/agent /home/agent/.pi-durable /home/agent/.pi-durable/optmem
install -o agent -g agent -m 600 /etc/pi-default-settings.json /home/agent/.pi/agent/settings.json
install -o agent -g agent -m 600 /etc/pi-append-system.md /home/agent/.pi/agent/APPEND_SYSTEM.md
install -o agent -g agent -m 600 /etc/pi-ssh/authorized_keys /home/agent/.ssh/authorized_keys

: > /home/agent/.ssh/environment
for key in LLMGATEWAY_API_KEY ALLMODELS_API_KEY DEEPSEEK_API_KEY PI_CODING_AGENT_DIR SWARM_DATA_DIR SWARM_WORKSPACE SWARM_SOCK MODEL_LEAD MODEL_CODER MODEL_REVIEWER; do
  eval 'value=${'"$key"'-}'
  [ -z "$value" ] || printf '%s=%s\n' "$key" "$value" >> /home/agent/.ssh/environment
done
chown agent:agent /home/agent/.ssh/environment
chmod 600 /home/agent/.ssh/environment

cat > /usr/local/bin/run-swarmd <<'EOF'
#!/bin/sh
while true; do
  node --no-warnings /app/src/cli.mjs serve >> /home/agent/.pi-durable/swarmd.log 2>&1 || true
  sleep 1
done
EOF
chmod 755 /usr/local/bin/run-swarmd

grep -q 'alias pi=' /home/agent/.bashrc 2>/dev/null || printf '\nalias pi="pi --no-skills"\n' >> /home/agent/.bashrc
chown agent:agent /home/agent/.bashrc

ssh-keygen -A >/dev/null

su -s /bin/sh agent -c '/usr/local/bin/run-swarmd' &

exec /usr/sbin/sshd -D -e
