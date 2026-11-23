#!/bin/sh
set -eu

BASE=/home/ubuntu/apps/qzss-proxy
CONTAINER=qzss-proxy
TMP=$(mktemp)
BACKUP=$(mktemp)
trap 'rm -f "$TMP" "$BACKUP"' EXIT

python3 "$BASE/render-jp-caddy.py" "$TMP" --template "$BASE/jp-access-Caddyfile.template"
docker cp "$TMP" "$CONTAINER:/tmp/qzss-JP-Caddyfile"
docker exec "$CONTAINER" caddy validate --config /tmp/qzss-JP-Caddyfile --adapter caddyfile
cp -p "$BASE/Caddyfile" "$BACKUP"
cat "$TMP" > "$BASE/Caddyfile"
if ! docker exec "$CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; then
    cat "$BACKUP" > "$BASE/Caddyfile"
    docker exec "$CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
    exit 1
fi
if [ "$(curl -ksS --max-time 8 -o /dev/null -w '%{http_code}' --resolve eq.shum10.com:443:127.0.0.1 https://eq.shum10.com/)" != 200 ]; then
    cat "$BACKUP" > "$BASE/Caddyfile"
    docker exec "$CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
    exit 1
fi
echo 'JP access ranges updated and local map health check passed'
