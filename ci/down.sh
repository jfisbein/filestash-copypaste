#!/bin/bash
# Stops the integration environment and removes its state.
cd "$(dirname "$0")"
# Filestash writes state/ as its own user (uid 1000), so what it wrote is removed from inside
# its image, as root, or a CI runner with another uid could not delete it.
if [ -d state ]; then
    docker compose run --rm --no-deps --user 0 --entrypoint sh filestash \
        -c 'rm -rf /app/data/state/* /app/data/state/.[!.]*'
fi
docker compose down --volumes --remove-orphans
rm -rf state
