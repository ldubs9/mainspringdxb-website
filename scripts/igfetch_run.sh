#!/usr/bin/env bash
# igfetch_run.sh — loop wrapper for igfetch_fetch.py (mainspring.dxb defaults)

INTERVAL_HOURS=${INTERVAL_HOURS:-24}
USERNAME=${USERNAME:-mainspring.dxb}
COUNT=${COUNT:-6}

echo "Starting igfetch loop: username=$USERNAME count=$COUNT interval=${INTERVAL_HOURS}h"

while true; do
  echo "$(date -u +'%Y-%m-%d %H:%M:%S UTC') - Running igfetch..."
  python3 scripts/igfetch_fetch.py --username "$USERNAME" --count "$COUNT"
  sleep_seconds=$(awk "BEGIN{print $INTERVAL_HOURS*3600}")
  echo "Sleeping for ${INTERVAL_HOURS} hour(s) (${sleep_seconds} seconds)..."
  sleep $sleep_seconds
done
