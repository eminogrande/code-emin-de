FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git openssh-server python3 tmux tini \
    && rm -rf /var/lib/apt/lists/* \
    && userdel -r node \
    && useradd --uid 1000 --create-home --shell /bin/bash agent \
    && mkdir -p /run/sshd /workspace /etc/pi-ssh /home/agent/.pi/agent /home/agent/.pi-durable /home/agent/.optmem \
    && chown -R agent:agent /workspace /home/agent

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

COPY src/ /app/src/
COPY config/settings.json /etc/pi-default-settings.json
COPY config/APPEND_SYSTEM.md /etc/pi-append-system.md
COPY config/sshd_config /etc/ssh/sshd_config.d/pi.conf
COPY --chmod=755 src/entrypoint.sh /usr/local/bin/entrypoint

RUN chmod 755 /app/src/cli.mjs /app/src/durable-smoke.mjs /app/src/memo \
    && ln -sf /app/node_modules/.bin/pi /usr/local/bin/pi \
    && ln -sf /app/src/cli.mjs /usr/local/bin/swarm \
    && ln -sf /app/src/durable-smoke.mjs /usr/local/bin/durable-smoke \
    && ln -sf /app/src/memo /usr/local/bin/memo \
    && ln -sf /app/src/memo /home/agent/.optmem/memo

ENV PI_CODING_AGENT_DIR=/home/agent/.pi/agent \
    SWARM_DATA_DIR=/home/agent/.pi-durable \
    SWARM_WORKSPACE=/workspace \
    SWARM_SOCK=/home/agent/.pi-durable/swarm.sock

WORKDIR /workspace
EXPOSE 22
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint"]
