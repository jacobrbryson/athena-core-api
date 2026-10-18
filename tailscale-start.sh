#!/bin/sh
set -eu

if [ -n "${TAILSCALE_AUTHKEY:-}" ]; then
  umask 077
  mkdir -p /tmp/athena-tailscale
  printf '%s' "$TAILSCALE_AUTHKEY" > /tmp/athena-tailscale/authkey
  unset TAILSCALE_AUTHKEY
  /usr/local/bin/tailscaled \
    --state=mem: \
    --socket=/tmp/athena-tailscale/tailscaled.sock \
    --tun=userspace-networking \
    --outbound-http-proxy-listen=127.0.0.1:1055 \
    >/dev/null 2>&1 &
  if ! /usr/local/bin/tailscale \
    --socket=/tmp/athena-tailscale/tailscaled.sock \
    up --auth-key=file:/tmp/athena-tailscale/authkey \
    --hostname=athena-core-eufy --accept-dns=false --accept-routes=false \
    --timeout=45s >/dev/null 2>&1; then
    echo 'Private security tunnel unavailable; Athena core will continue.' >&2
  fi
  rm -f /tmp/athena-tailscale/authkey
fi

exec npm start
