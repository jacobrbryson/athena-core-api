#!/bin/sh
set -eu

# Opens Tailscale's userspace HTTP proxy on 127.0.0.1:1055, then runs the
# given command, or `npm start` (the API service) when given none. Jobs that
# need the tailnet (athena-nightly, for the desktop model's evals) run as
# `sh /app/tailscale-start.sh node src/jobs/<job>.js`; see cloudbuild.yaml.
# TAILSCALE_HOSTNAME names the node, so a job does not pose as the service.

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
    --hostname="${TAILSCALE_HOSTNAME:-athena-core-eufy}" --accept-dns=false --accept-routes=false \
    --timeout=45s >/dev/null 2>&1; then
    echo 'Private security tunnel unavailable; Athena core will continue.' >&2
  fi
  rm -f /tmp/athena-tailscale/authkey
fi

if [ "$#" -gt 0 ]; then
  exec "$@"
fi
exec npm start
