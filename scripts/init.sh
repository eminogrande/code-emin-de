#!/bin/sh
set -eu
mkdir -p .ssh workspace
chmod 700 .ssh
[ -f .env ] && chmod 600 .env
: > .ssh/authorized_keys.tmp
for k in \
  "$HOME/.ssh/id_nuri_card_57274221.pub" \
  "$HOME/.ssh/id_nuri_pcsc_sk_v2.pub" \
  "$HOME/.ssh/yubikey5c.pub" \
  "$HOME/.ssh/pi-durable-local-ed25519.pub"; do
  [ -s "$k" ] && cat "$k" >> .ssh/authorized_keys.tmp
done
if [ ! -s .ssh/authorized_keys.tmp ] && [ ! -s .ssh/authorized_keys ]; then
  rm -f .ssh/authorized_keys.tmp
  echo "Place your smartcard SSH public key in .ssh/authorized_keys" >&2
  exit 1
fi
[ -s .ssh/authorized_keys.tmp ] && mv .ssh/authorized_keys.tmp .ssh/authorized_keys
chmod 600 .ssh/authorized_keys
