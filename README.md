# Campus Shuttle Telemetry

A telemetry platform for a campus shuttle fleet: simulated vehicles publish position
and state over MQTT, an ingestion service writes to a TimescaleDB hypertable, and a
REST API serves live positions and historical tracks.

Built to answer a specific question — what does it actually take to keep a fleet's
worth of unreliable, intermittently-connected devices producing data you can trust
enough to put on a map and bill against.

**Status:** slice 2 — fault injection, verified against a running stack. See
[Fault injection](#fault-injection-slice-2) for the queries and their output, and
[Roadmap](#roadmap) for what is next.

---

## Architecture

```
┌──────────────┐   MQTT (QoS 1)   ┌────────────┐
│  simulator   │ ───────────────► │ mosquitto  │
│ N vehicles   │  fleet/{id}/…    │  broker    │
└──────────────┘                  └─────┬──────┘
                                        │  fleet/+/telemetry
                                        │  fleet/+/status
                                        ▼
                                 ┌────────────┐
                                 │  ingest    │  validate → buffer → batch insert
                                 └─────┬──────┘
                                       │
                                       ▼
                              ┌──────────────────┐
                              │   TimescaleDB    │  telemetry hypertable
                              └────────┬─────────┘
                                       │
                                       ▼
                                 ┌────────────┐
                                 │    api     │  REST + OpenAPI at /docs
                                 └────────────┘
```

Each simulated vehicle holds its own broker connection with its own last-will
message, because that is how the real units behave and it is what makes offline
detection work without a heartbeat table.

## Running it

```bash
cp .env.example .env
docker compose up --build
```

Then:

| What | Where |
|---|---|
| API docs (Swagger UI) | http://localhost:3000/docs |
| Live fleet positions | http://localhost:3000/fleet/positions |
| Health | http://localhost:3000/health |
| Ingest rate, last hour | http://localhost:3000/metrics/ingest |

Watch a vehicle move:

```bash
watch -n1 'curl -s localhost:3000/vehicles/shuttle-01/latest | jq'
```

Raise the fleet size with `FLEET_SIZE=50` in `.env` and restart the simulator.
Vehicles are spread evenly around the loop so they do not convoy.

To watch the failure modes rather than the happy path, turn up the fault injection
(`DROPOUT_CHANCE=0.5` and friends — see [Fault injection](#fault-injection-slice-2))
and follow the simulator log:

```bash
docker compose logs -f simulator | grep -E 'coverage|replaying|redelivered'
```

## Design notes

**Two clocks, deliberately.** Every reading stores `device_ts` (the clock on the
vehicle) and `received_at` (when we accepted it). They are not the same, and
conflating them is the bug that quietly ruins telematics data. A unit that buffers
through an underpass replays four minutes of readings at once: by arrival order the
track teleports, by device order it is correct. Every read path sorts on `device_ts`;
the gap between the two is itself a useful metric, exposed at `/metrics/ingest`.

**Idempotent writes.** MQTT QoS 1 is at-least-once, so duplicates are a matter of
when, not if. The primary key is `(vehicle_id, device_ts)` and inserts are
`ON CONFLICT DO NOTHING`. Replays and redeliveries are therefore free, which is what
lets the buffering behaviour in slice 2 be simple.

**Batched inserts.** Readings accumulate in memory and flush as a single multi-row
INSERT every 500 ms or 200 messages, whichever comes first. At one vehicle this is
pointless; at a few hundred it is the difference between a working ingest path and
a connection-starved one. A failed flush returns the batch to the buffer rather than
dropping it.

**Malformed input is data, not an outage.** Validation rejects and counts bad
readings per reason. One bad firmware build should not stop ingestion for the fleet.

**No geo library.** Campus loops are single-digit kilometres, so an equirectangular
projection about the route centroid is sub-metre accurate and the motion model stays
readable. At country scale this would be wrong and would need proper geodesics.

## Fault injection (slice 2)

Slice 1 proved the happy path. Slice 2 exists because the happy path is not the
interesting part: real units lose coverage under bridges and in parking structures,
buffer what they cannot send, then dump the backlog at the broker the moment the
link returns — out of order, and sometimes twice. The simulator now produces all of
that on purpose, and the claims below are queries run against the running stack.

Knobs, all in `.env`:

| Variable | Meaning | Value used below |
|---|---|---|
| `DROPOUT_CHANCE` | per-tick probability of losing coverage | `0.5` |
| `DROPOUT_MIN_SEC` / `DROPOUT_MAX_SEC` | outage length | `15` / `45` |
| `MAX_BUFFER` | readings held offline before the oldest is discarded | `3600` |
| `REPLAY_SHUFFLE` | replay the backlog out of order rather than oldest-first | `true` |
| `DUPLICATE_CHANCE` | per-reading chance of a QoS-1 redelivery | `0.02` |

Coverage loss is a real socket drop — `client.end(true)`, no DISCONNECT packet — so
the broker sees a dead client and publishes the vehicle's last will. Offline
detection is not simulated at a higher layer; it is the actual MQTT mechanism.

The run measured below is a single continuous 67-minute window of the fixed build,
captured 2026-09-14 11:43:21–12:50:00 UTC: **one vehicle at 1 Hz, 123 outages,
122 replays, 3835 readings replayed, 72 deliberate redeliveries.** Every query is
pinned to that window, so the output reproduces against the stored data rather than
drifting with the clock.

### The disconnect-tick bug

The first version of the dropout code decided whether to buffer by asking the
client:

```js
const reading = veh.tick(dt);
if (!client.connected) { buffer(reading); continue; }   // wrong
client.publish(telemetryTopic(veh.id), JSON.stringify(reading), { qos: 1 });
```

On the tick that *starts* an outage, `maybeDropout()` has already called
`client.end(true)`, but the socket teardown is asynchronous and `client.connected`
is still `true`. So that one reading took the publish path into a socket that was
already going away, and was neither delivered nor buffered. Exactly one reading
lost per outage — small enough to look like jitter, and invisible unless you query
for it.

The fix is to trust the state machine that made the decision, not the transport:

```js
const online = maybeDropout();
const reading = veh.tick(dt);
if (!online || !client.connected) { buffer(reading); continue; }
```

Both builds' data is still in the hypertable, so the comparison is a single query.
A gap is two consecutive readings more than one tick apart:

```sql
WITH win(build, lo, hi) AS (VALUES
  ('1. before fix', TIMESTAMPTZ '2026-09-14 11:03:22', TIMESTAMPTZ '2026-09-14 11:16:50'),
  ('2. after fix',  TIMESTAMPTZ '2026-09-14 11:43:21', TIMESTAMPTZ '2026-09-14 12:50:00')
), d AS (
  SELECT w.build, t.device_ts,
         t.device_ts - lag(t.device_ts) OVER (PARTITION BY w.build ORDER BY t.device_ts) AS gap
  FROM win w JOIN telemetry t
    ON t.vehicle_id = 'shuttle-01' AND t.device_ts >= w.lo AND t.device_ts < w.hi
)
SELECT build,
       round(extract(epoch FROM max(device_ts) - min(device_ts)) / 60) AS minutes,
       count(*) AS readings,
       count(*) FILTER (WHERE gap > interval '1.5 s') AS missed_tick_gaps
FROM d GROUP BY build ORDER BY build;
```

```
     build     | minutes | readings | missed_tick_gaps
---------------+---------+----------+------------------
 1. before fix |      13 |      789 |               16
 2. after fix  |      67 |     3995 |                0
(2 rows)
```

Every one of those 16 gaps was exactly `00:00:02.002` — a single missing tick,
one per outage, which is the bug's signature. After the fix, 67 minutes and 123
outages produce an unbroken 1 Hz series: 3995 readings, no gap wider than a tick.

### Duplicates are free

MQTT QoS 1 is at-least-once, so the simulator redelivers a fraction of replayed
readings deliberately. The primary key is `(vehicle_id, device_ts)` and every
insert is `ON CONFLICT DO NOTHING`, so redelivery is a no-op rather than a
correction job:

```sql
SELECT count(*)                                            AS rows_stored,
       count(DISTINCT (vehicle_id, device_ts))             AS distinct_keys,
       count(*) - count(DISTINCT (vehicle_id, device_ts))  AS duplicate_rows
FROM telemetry
WHERE vehicle_id = 'shuttle-01'
  AND device_ts >= TIMESTAMPTZ '2026-09-14 11:43:21'
  AND device_ts <  TIMESTAMPTZ '2026-09-14 12:50:00';
```

```
 rows_stored | distinct_keys | duplicate_rows
-------------+---------------+----------------
        3995 |          3995 |              0
(1 row)
```

72 redeliveries were published by the simulator over that window. None of them
reached the table as a row.

### Out-of-order arrival is the normal case

A reconnecting device does not politely send its backlog oldest-first, so the
simulator shuffles it. A reading counts as out of order if something with a later
`device_ts` had already been accepted before it arrived:

```sql
WITH t AS (
  SELECT device_ts, received_at,
         max(device_ts) OVER (ORDER BY received_at
                              ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS max_seen
  FROM telemetry
  WHERE vehicle_id = 'shuttle-01'
    AND device_ts >= TIMESTAMPTZ '2026-09-14 11:43:21'
    AND device_ts <  TIMESTAMPTZ '2026-09-14 12:50:00'
)
SELECT count(*) AS readings,
       count(*) FILTER (WHERE device_ts < max_seen) AS arrived_out_of_order,
       round(100.0 * count(*) FILTER (WHERE device_ts < max_seen) / count(*), 1) AS pct,
       max(received_at - device_ts) AS worst_lag
FROM t;
```

```
 readings | arrived_out_of_order | pct  |    worst_lag
----------+----------------------+------+-----------------
     3995 |                 3352 | 83.9 | 00:00:45.111514
(1 row)
```

84% of readings arrived after something newer. Worst lag is 45.1 s, which is exactly
`DROPOUT_MAX_SEC` — the backlog is bounded by the outage length, as it should be.

This is the payoff for storing two clocks. Ordered by arrival the track is
nonsense; ordered by `device_ts` it is correct, and the read path does the latter:

```bash
curl -s "localhost:3000/vehicles/shuttle-01/track?from=2026-09-14T12:00:00Z&to=2026-09-14T12:05:00Z"
```

```
count: 300
device_ts strictly increasing: True
received_at increasing      : False
```

300 readings for a 300-second window at 1 Hz: nothing lost, nothing duplicated,
and monotonic on the vehicle clock even though 84% of it arrived late and jumbled.

### Not done yet: clock skew

Every reading here carries a device clock that is merely *late*, never *wrong*.
Real units drift, and some come back from a cold boot in 1970 or a few hours off,
which breaks a `(vehicle_id, device_ts)` primary key in a way buffering does not —
two genuinely different readings can collide, and `ON CONFLICT DO NOTHING` would
silently discard the second. That needs a sequence-aware key or a skew correction
on ingest, so it is deliberately held back rather than half-implemented.

## Roadmap

- [x] **Slice 1** — simulator, broker, ingest, TimescaleDB, REST + OpenAPI, all in compose
- [x] **Slice 2** — fault injection: dropouts, reconnects with buffered replay, out-of-order
      and duplicate delivery. Measured: 0 lost readings and 0 duplicate rows across 123
      outages. Clock skew is deliberately deferred — see below.
- [ ] **Slice 3** — domain layer: routes, stops, schedules, driver assignment, geofences,
      speed thresholds, scheduled lock/unlock, alerting
- [ ] **Slice 4** — Grafana: geomap of live positions, ingestion rate, latency percentiles,
      offline devices, zone violations
- [ ] **Slice 5** — Kubernetes with horizontal autoscaling under simulated fleet load
- [ ] **Slice 6** — Terraform for the whole stack, remote state, dev/prod workspaces
- [ ] **Slice 7** — second vertical (hospital patient transport) on the same core, as proof
      the domain separation holds

## Repo layout

```
db/init/            schema, applied on first database start
mosquitto/          broker config
services/simulator/ vehicle motion model + MQTT publisher
services/ingest/    subscriber, validation, batched writes
services/api/       read API and OpenAPI spec
```
