# Campus Shuttle Telemetry

![CI](https://github.com/Bakar9832/campus-shuttle-telemetry/actions/workflows/ci.yml/badge.svg)

A telemetry platform for a campus shuttle fleet: simulated vehicles publish position
and state over MQTT, an ingestion service writes to a TimescaleDB hypertable, and a
REST API serves live positions and historical tracks.

Built to answer a specific question — what does it actually take to keep a fleet's
worth of unreliable, intermittently-connected devices producing data you can trust
enough to put on a map and bill against.

**Headline result:** over a 67-minute run the vehicle was unreachable for roughly
92% of the time, across 123 separate outages. Zero readings lost, zero duplicate
rows. The [queries and their output](#fault-injection-slice-2) are below.

**Status:** slices 1, 2, 4 and 5 complete. Runs under Docker Compose or Kubernetes.
See [Roadmap](#roadmap) for what is next.

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
                              └───┬──────────┬───┘
                                  │          │
                                  ▼          ▼
                          ┌────────────┐  ┌────────────┐
                          │    api     │  │  grafana   │
                          │ REST +     │  │ provisioned│
                          │ OpenAPI    │  │ dashboards │
                          └────────────┘  └────────────┘
```

Each simulated vehicle holds its own broker connection with its own last-will
message, because that is how the real units behave and it is what makes offline
detection work without a heartbeat table.

![Fleet Overview dashboard](docs/dashboard.png)

The readings-per-minute panel is the design in one picture. During an outage the
*by arrival* line collapses and then spikes as the backlog lands, while the
*by device clock* line stays flat at the true sample rate — the journey was never
interrupted, only its delivery. The gap and duplicate tiles are the integrity
queries from [below](#fault-injection-slice-2), running live; they turn red if
either stops being zero.

## Running it

```bash
cp .env.example .env
docker compose up --build
```

Then:

| What | Where |
|---|---|
| Grafana dashboards | http://localhost:3001 |
| API docs (Swagger UI) | http://localhost:3000/docs |
| Live fleet positions | http://localhost:3000/fleet/positions |
| Health | http://localhost:3000/health |
| Ingest rate, last hour | http://localhost:3000/metrics/ingest |

Grafana is provisioned from `grafana/provisioning/` — datasource and dashboard both
come from the repo, and anonymous viewers get read access, so there is nothing to
click together after a clone.

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

## CI

Every push stands up the whole stack on a clean runner, runs it for two minutes with
fault injection turned up, and then asserts against what actually reached the
database:

- readings are being written at all
- buffered replay was observed
- zero missed ticks in the reconstructed track
- zero duplicate rows
- zero messages rejected by validation
- read path monotonic on `device_ts`
- API healthy and serving live positions

The second assertion is the one that matters most. Without it the integrity checks
would pass trivially on a run where nothing ever disconnected, and a test that can
pass without exercising the thing it tests is worse than no test at all. The checks
live in [`ci/verify.sh`](ci/verify.sh) rather than inside the workflow YAML, so they
are readable and runnable locally.

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

**Drop oldest, not newest.** A device buffering offline has finite storage. When the
buffer fills, the oldest readings are discarded and counted. This is an operational
tool: a dispatcher asking where a vehicle is now needs the newest reading, and a
reading from forty minutes ago is worth almost nothing by comparison. A tachograph or
a billing-by-distance system would make the opposite choice, because there a gap is a
compliance failure.

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
122 replays, 3835 readings replayed, 72 deliberate redeliveries.** At an average
outage of roughly 30 seconds, that leaves under three seconds of connectivity
between outages — the vehicle spent about 92% of the run unreachable. Every query is
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
one per outage, which is the bug's signature. A stall would produce gaps of varying
length; sixteen identical two-second holes is this bug and nothing else. After the
fix, 67 minutes and 123 outages produce an unbroken 1 Hz series: 3995 readings, no
gap wider than a tick.

Worth stating plainly: nobody would have found this by reading the code. It only
surfaced because the verification query counted something that could be wrong.

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

This is a deliberate trade. QoS 2 would guarantee exactly-once delivery, but it
costs a four-step handshake per message, and at a few hundred vehicles on cellular
data that is not worth paying for. Taking the cheaper at-least-once guarantee and
absorbing the consequence in the schema is the better deal — and it costs no
application code at all.

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

84% of readings arrived after something newer. That is not an edge case handled
defensively — it is the dominant condition, and any system that assumed arrival
order would be wrong most of the time. Worst lag is 45.1 s, which is exactly
`DROPOUT_MAX_SEC`: the backlog is bounded by the outage length, which is how you
know the buffer is not leaking.

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
silently discard the second. The same mechanism that makes duplicates free makes
skew lossy. Fixing it properly means a sequence-aware key or a skew correction on
ingest, so it is deliberately held back rather than half-implemented.

## Kubernetes (slice 5)

The same stack runs on Kubernetes, in `k8s/`. Compose was the right tool for building
it; Kubernetes is where the stateful-versus-stateless distinction stops being
theoretical.

```bash
# images are local, so load them into the cluster's containerd store first
docker compose build
docker save campus-shuttle-telemetry-ingest:latest -o ingest.tar
docker cp ingest.tar <node>:/ingest.tar
docker exec <node> ctr -n k8s.io images import /ingest.tar
# …repeat for api and simulator

# the schema is generated from the file rather than duplicated in YAML
kubectl create configmap timescale-init --from-file=db/init/001_schema.sql

kubectl apply -f k8s/
kubectl port-forward service/api 3000:3000
```

**TimescaleDB is a StatefulSet, everything else is a Deployment.** A Deployment
treats pods as interchangeable — any one can be replaced by any other, in any order.
A database cannot work that way: it owns specific data on specific storage. The
StatefulSet gives it a stable identity (`timescale-0`) and a `volumeClaimTemplate`
that binds it to its own volume permanently. The API only reads, so it runs two
replicas behind a Service and scales by changing one number.

**The readiness probe replaces the Compose healthcheck.** `pg_isready` for Timescale,
`GET /health` for the API. Kubernetes will not route traffic to a pod until its probe
passes — the same ordering guarantee `depends_on: service_healthy` gave in Compose,
except it also applies continuously, so an API pod that loses its database connection
is removed from the load balancer instead of serving errors.

**`imagePullPolicy: Never`** on the three local images. Without it Kubernetes tries to
pull `:latest` from a registry, finds nothing, and fails despite the image being
present on the node.

### Rolling updates fail safely

Deploying a broken image and watching what happens is more informative than reading
about it:

```bash
kubectl set image deployment/api api=campus-shuttle-telemetry-api:broken
kubectl get pods
```

```
api-57bbd7f777-hbchp   0/1   ErrImageNeverPull   0   5s
api-57bbd7f777-nczdb   0/1   ErrImageNeverPull   0   5s
api-57bbd7f777-tqkfn   0/1   ErrImageNeverPull   0   4s
api-57fcd47f75-4xmbb   1/1   Running             0   6m14s
api-57fcd47f75-7hmsd   1/1   Running             0   17m
api-57fcd47f75-dch5m   1/1   Running             0   17m
api-57fcd47f75-sh5kc   1/1   Running             0   6m14s
```

Three new pods stuck, four old pods still serving. `kubectl rollout status` hangs at
"3 out of 5 new replicas have been updated" and would wait indefinitely. The default
rolling update strategy will not remove a working pod until its replacement is ready,
so a bad deploy stalls rather than causing an outage. `kubectl rollout undo` restores
the previous revision — though in a real workflow the fix is to correct the manifest
and re-apply, so git stays the source of truth.

### Load test

100 vehicles at 1 Hz through a single ingest pod:

```
[ingest] received=26446 written=26169 dropped=0 errors=0 buffered=110
[ingest] received=27608 written=27324 dropped=0 errors=0 buffered=106
[ingest] received=28827 written=28545 dropped=0 errors=0 buffered=95
```

```
 readings | vehicles | per_second
----------+----------+------------
     5264 |      100 |         88
```

88 writes/sec sustained, nothing dropped. `buffered` oscillates between 80 and 110
rather than climbing — that is one flush cycle's worth of messages in flight at any
moment, which is what a 500 ms flush window at this rate should look like. A leaking
buffer would march past 500, then 1000, and keep going.

Scaling the producer to four pods pushed it to 280 writes/sec with `buffered` stable
in the 200–400 band, so the ceiling is somewhere above that.

Note that scaling *ingest* horizontally would not help. MQTT delivers each message to
every subscriber, so two ingest pods would each write everything — double the database
load for no extra throughput. Fixing that properly needs shared subscriptions or
partitioning by vehicle, not more replicas.

### What the load test accidentally proved

Those four simulator replicas all used the same `FLEET_SIZE`, so all four published as
`shuttle-01` … `shuttle-100`. They started milliseconds apart, so their `device_ts`
values differed and every reading was stored as a distinct row:

```
         device_ts          |    lat    |    lon
----------------------------+-----------+------------
 2026-09-17 10:34:48.183+00 | 40.002763 | -83.022779
 2026-09-17 10:34:48.153+00 | 40.002763 | -83.022779
 2026-09-17 10:34:48.035+00 | 40.000931 | -83.032545
```

Two readings 30 ms apart at the same coordinates, and a third nearly a kilometre away
120 ms later — all claiming to be the same vehicle.

**Every integrity assertion still passed.** No gaps, no duplicate keys, monotonic on
`device_ts`, nothing rejected by validation. The readings are individually well-formed
and uniquely keyed; the track they describe is physically impossible.

Delivery correctness and identity correctness are different properties, and only the
first is currently tested. A speed-plausibility check between consecutive readings
would catch it — 900 metres in 120 ms is 27,000 km/h — and that is the obvious next
assertion. It is also why auto-registering a device on first sighting is a shortcut:
real fleets provision device identities rather than trusting whatever an unknown
publisher claims to be.

### Not done yet

Horizontal pod autoscaling and an Ingress. Scaling here is manual
(`kubectl scale deployment api --replicas=5`), and external access is via
`kubectl port-forward` rather than a routed hostname.

## Roadmap

- [x] **Slice 1** — simulator, broker, ingest, TimescaleDB, REST + OpenAPI, all in compose
- [x] **Slice 2** — fault injection: dropouts, reconnects with buffered replay, out-of-order
      and duplicate delivery. Measured: 0 lost readings and 0 duplicate rows across 123
      outages. Clock skew deliberately deferred — see above.
- [x] **Slice 4** — Grafana, provisioned from the repo: geomap of live positions, readings
      per minute by device clock vs arrival, delivery lag percentiles, and gap and
      duplicate tiles that go red if either stops being zero
- [x] **CI** — full stack stood up on every push, fault injection enabled, build fails if a
      single reading is lost or duplicated
- [x] **Slice 5** — Kubernetes: StatefulSet for the database, Deployments for the rest,
      readiness probes, rolling update and rollback, load tested to 280 writes/sec.
      HPA and Ingress deferred — see above.
- [ ] **Slice 3** — domain layer: routes, stops, schedules, driver assignment, geofences,
      speed thresholds, scheduled lock/unlock, alerting
- [ ] **Slice 6** — Terraform for the whole stack, remote state, dev/prod workspaces
- [ ] **Slice 7** — second vertical (hospital patient transport) on the same core, as proof
      the domain separation holds

## Repo layout

```
.github/workflows/  CI pipeline
ci/verify.sh        integration assertions, runnable locally
db/init/            schema, applied on first database start
k8s/                Kubernetes manifests
mosquitto/          broker config
grafana/            provisioned datasource and dashboard
services/simulator/ vehicle motion model + MQTT publisher
services/ingest/    subscriber, validation, batched writes
services/api/       read API and OpenAPI spec
```