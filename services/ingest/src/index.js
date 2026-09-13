import mqtt from 'mqtt';
import { parseReading } from './reading.js';
import { insertBatch, registerVehicle, setOnline, touchLastSeen, pool } from './db.js';

const MQTT_URL     = process.env.MQTT_URL ?? 'mqtt://localhost:1883';
const FLUSH_MS     = Number(process.env.FLUSH_MS ?? 500);
const MAX_BATCH    = Number(process.env.MAX_BATCH ?? 200);
const STATS_MS     = Number(process.env.STATS_MS ?? 10000);

const buffer = [];
const known = new Set();
const stats = { received: 0, written: 0, dropped: 0, errors: 0 };

const client = mqtt.connect(MQTT_URL, {
  clientId: `ingest-${Math.random().toString(16).slice(2, 8)}`,
  reconnectPeriod: 2000,
});

client.on('connect', () => {
  console.log('[ingest] connected to broker');
  client.subscribe(['fleet/+/telemetry', 'fleet/+/status'], { qos: 1 }, (err) => {
    if (err) console.error('[ingest] subscribe failed:', err.message);
    else console.log('[ingest] subscribed to fleet/+/telemetry and fleet/+/status');
  });
});

client.on('error', (err) => console.error('[ingest] mqtt error:', err.message));

client.on('message', async (topic, payload) => {
  const [, vehicleId, kind] = topic.split('/');
  if (!vehicleId) return;

  if (kind === 'status') {
    try {
      const { online } = JSON.parse(payload.toString());
      await ensureKnown(vehicleId);
      await setOnline(vehicleId, Boolean(online));
      console.log(`[ingest] ${vehicleId} ${online ? 'online' : 'offline'}`);
    } catch (err) {
      stats.errors += 1;
      console.error(`[ingest] status handling failed for ${vehicleId}:`, err.message);
    }
    return;
  }

  if (kind !== 'telemetry') return;

  stats.received += 1;
  const result = parseReading(vehicleId, payload.toString());
  if (!result.ok) {
    stats.dropped += 1;
    console.warn(`[ingest] dropped message from ${vehicleId}: ${result.reason}`);
    return;
  }

  buffer.push(result.reading);
  if (buffer.length >= MAX_BATCH) await flush();
});

// Devices are provisioned on first sighting. A production deployment would
// check an allow-list here instead; the row still has to exist before the
// telemetry FK will accept a write.
async function ensureKnown(vehicleId) {
  if (known.has(vehicleId)) return;
  await registerVehicle(vehicleId);
  known.add(vehicleId);
}

let flushing = false;
async function flush() {
  if (flushing || buffer.length === 0) return;
  flushing = true;
  const batch = buffer.splice(0, buffer.length);

  try {
    for (const id of new Set(batch.map((r) => r.vehicleId))) await ensureKnown(id);
    const written = await insertBatch(batch);
    stats.written += written;

    // last_seen tracks the newest device clock we have accepted per vehicle
    const newest = new Map();
    for (const r of batch) {
      const cur = newest.get(r.vehicleId);
      if (!cur || r.deviceTs > cur) newest.set(r.vehicleId, r.deviceTs);
    }
    for (const [id, ts] of newest) await touchLastSeen(id, ts);
  } catch (err) {
    stats.errors += 1;
    console.error('[ingest] flush failed:', err.message);
    // Put the batch back so a transient DB blip does not lose readings.
    buffer.unshift(...batch);
  } finally {
    flushing = false;
  }
}

const flushTimer = setInterval(flush, FLUSH_MS);
const statsTimer = setInterval(() => {
  console.log(
    `[ingest] received=${stats.received} written=${stats.written} ` +
    `dropped=${stats.dropped} errors=${stats.errors} buffered=${buffer.length}`,
  );
}, STATS_MS);

async function shutdown() {
  clearInterval(flushTimer);
  clearInterval(statsTimer);
  await flush();
  client.end(true);
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
