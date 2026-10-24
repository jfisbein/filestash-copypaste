#!/bin/bash
# Starts the integration environment on 127.0.0.1:${PORT:-8334} with dist/copypaste.zip
# (build it first) and waits until Filestash answers.
set -euo pipefail
cd "$(dirname "$0")"
PORT=${PORT:-8334}
export PORT
[ -f ../dist/copypaste.zip ] || { echo "build first: python3 -I build.py" >&2; exit 1; }
rm -rf state
mkdir -p state/config state/plugins
sed "s/__PORT__/$PORT/" config.json > state/config/config.json
cp ../dist/copypaste.zip state/plugins/copypaste.zip
chmod -R a+rwX state # the image runs as its own user
docker compose up -d --build --quiet-pull
for i in $(seq 1 60); do
    if curl -fsS -o /dev/null "http://localhost:$PORT/api/config"; then
        echo "Filestash is up on http://localhost:$PORT/ ($(docker compose ps filestash --format '{{.Image}}'))"
        exit 0
    fi
    sleep 2
done
docker compose logs
echo "Filestash did not come up" >&2
exit 1
