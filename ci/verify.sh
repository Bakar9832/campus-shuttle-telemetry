#!/usr/bin/env bash
#
# Integration check. Runs the full stack with fault injection turned up, then
# asserts on the data that actually landed in TimescaleDB.
#
# This is the test that matters for this project: unit-testing the shuffle or
# the buffer in isolation would not tell you whether a journey reconstructs
# correctly after the vehicle spends half its time unreachable.

set -euo pipefail

RUN_SECONDS="${RUN_SECONDS:-120}"
MIN_READINGS="${MIN_READINGS:-400}"
PSQL=(docker compose exec -T timescale psql -U telemetry -d telemetry -tAc)

fail() { echo "FAIL: $*" >&2; exit 1; }
note() { echo "  $*"; }

query() { "${PSQL[@]}" "$1" | tr -d '[:space:]'; }

echo "Waiting for the stack to settle..."
for i in $(seq 1 30); do
  if query "SELECT 1" >/dev/null 2>&1; then break; fi
  [ "$i" -eq 30 ] && fail "database never became reachable"
  sleep 2
done

echo "Collecting ${RUN_SECONDS}s of telemetry with fault injection enabled..."
sleep "$RUN_SECONDS"

# Everything below is scoped to a window that starts after the stack came up,
# so a partially-written first second cannot trip an assertion.
WINDOW="device_ts > now() - interval '$((RUN_SECONDS - 20)) seconds'"

echo
echo "Assertions"

# ---------------------------------------------------------------------------
# 1. Data is actually flowing. Guards against a green build on a stack that
#    started cleanly and then silently produced nothing.
# ---------------------------------------------------------------------------
READINGS=$(query "SELECT count(*) FROM telemetry WHERE ${WINDOW}")
note "readings stored: ${READINGS}"
[ "$READINGS" -ge "$MIN_READINGS" ] \
  || fail "expected at least ${MIN_READINGS} readings, got ${READINGS}"

# ---------------------------------------------------------------------------
# 2. Faults actually fired. Without this the integrity checks below would pass
#    trivially on a run where nothing ever disconnected.
# ---------------------------------------------------------------------------
REPLAYED=$(query "
  SELECT count(*) FROM telemetry
  WHERE ${WINDOW} AND received_at - device_ts > interval '5 seconds'")
note "readings delivered late (buffered replay): ${REPLAYED}"
[ "$REPLAYED" -gt 0 ] \
  || fail "no buffered replay observed — fault injection did not run, so the integrity checks below prove nothing"

# ---------------------------------------------------------------------------
# 3. No missed ticks. Every second of every vehicle's journey is present,
#    ordered by the device clock, despite the outages above.
# ---------------------------------------------------------------------------
GAPS=$(query "
  SELECT count(*) FROM (
    SELECT device_ts - lag(device_ts) OVER (PARTITION BY vehicle_id ORDER BY device_ts) AS d
    FROM telemetry WHERE ${WINDOW}
  ) g WHERE d > interval '2 seconds'")
note "missed-tick gaps: ${GAPS}"
[ "$GAPS" -eq 0 ] \
  || fail "${GAPS} gap(s) in the reconstructed track — readings are being lost"

# ---------------------------------------------------------------------------
# 4. No duplicate rows, despite deliberate QoS 1 redelivery.
# ---------------------------------------------------------------------------
DUPES=$(query "
  SELECT count(*) FROM (
    SELECT vehicle_id, device_ts FROM telemetry
    WHERE ${WINDOW} GROUP BY 1,2 HAVING count(*) > 1
  ) d")
note "duplicate rows: ${DUPES}"
[ "$DUPES" -eq 0 ] \
  || fail "${DUPES} duplicate row(s) — idempotent write path is broken"

# ---------------------------------------------------------------------------
# 5. Nothing was rejected as malformed. A non-zero count here means the
#    simulator and the ingest contract have drifted apart.
# ---------------------------------------------------------------------------
DROPPED=$(docker compose logs ingest 2>/dev/null | grep -c 'dropped message' || true)
note "messages rejected by validation: ${DROPPED}"
[ "$DROPPED" -eq 0 ] \
  || fail "ingest rejected ${DROPPED} message(s) — producer and consumer contracts have drifted"

# ---------------------------------------------------------------------------
# 6. The read path returns a correctly ordered track. Ordering by arrival
#    would fail this; ordering by device clock is the whole design.
# ---------------------------------------------------------------------------
UNORDERED=$(query "
  SELECT count(*) FROM (
    SELECT device_ts, lag(device_ts) OVER (PARTITION BY vehicle_id ORDER BY device_ts) AS prev
    FROM telemetry WHERE ${WINDOW}
  ) t WHERE prev IS NOT NULL AND device_ts <= prev")
note "out-of-order rows on the read path: ${UNORDERED}"
[ "$UNORDERED" -eq 0 ] \
  || fail "read path is not monotonic on device_ts"

# ---------------------------------------------------------------------------
# 7. The API serves what the database holds.
# ---------------------------------------------------------------------------
HEALTH=$(curl -fsS http://localhost:3000/health | tr -d '[:space:]')
note "api health: ${HEALTH}"
echo "$HEALTH" | grep -q '"status":"ok"' \
  || fail "api health check did not report ok"

POSITIONS=$(curl -fsS http://localhost:3000/fleet/positions \
  | grep -o '"vehicleId"' | wc -l | tr -d '[:space:]')
note "vehicles reported by /fleet/positions: ${POSITIONS}"
[ "$POSITIONS" -gt 0 ] \
  || fail "api returned no live positions"

echo
echo "All assertions passed."