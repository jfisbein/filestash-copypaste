#!/bin/bash
# Stops the integration environment and removes its state.
cd "$(dirname "$0")"
docker compose down --volumes --remove-orphans
rm -rf state
