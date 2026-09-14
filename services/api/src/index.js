import express from 'express';
import swaggerUi from 'swagger-ui-express';
import { pool } from './db.js';
import { openapi } from './openapi.js';

const app = express();
const PORT = Number(process.env.API_PORT ?? 3000);

const READING_COLS = `
  vehicle_id  AS "vehicleId",
  device_ts   AS "deviceTs",
  received_at AS "receivedAt",
  seq,
  lat, lon,
  speed_kph   AS "speedKph",
  heading_deg AS "headingDeg",
  battery_pct AS "batteryPct",
  ignition,
  doors_locked AS "doorsLocked",
  odometer_km AS "odometerKm"
`;

const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error(`[api] ${req.method} ${req.path} failed:`, err.message);
  res.status(500).json({ error: 'internal_error' });
});

app.get('/health', wrap(async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch {
    res.status(503).json({ status: 'degraded', database: 'unreachable' });
  }
}));

app.get('/vehicles', wrap(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT v.id, v.label, v.fleet, v.vehicle_type AS "vehicleType",
           COALESCE(s.online, false) AS online,
           s.last_seen AS "lastSeen"
      FROM vehicle v
      LEFT JOIN vehicle_status s ON s.vehicle_id = v.id
     ORDER BY v.id
  `);
  res.json({ vehicles: rows });
}));

app.get('/vehicles/:id/latest', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ${READING_COLS} FROM telemetry
      WHERE vehicle_id = $1
      ORDER BY device_ts DESC
      LIMIT 1`,
    [req.params.id],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'no_readings' });
  res.json(rows[0]);
}));

app.get('/vehicles/:id/track', wrap(async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 1000) || 1000, 10000);
  const to = req.query.to ? new Date(req.query.to) : new Date();
  const from = req.query.from
    ? new Date(req.query.from)
    : new Date(to.getTime() - 60 * 60 * 1000);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
    return res.status(400).json({ error: 'bad_time_range' });
  }

  // Ordered by device clock, not arrival: a vehicle that buffered through a
  // dead zone writes late but belongs earlier in the track.
  const { rows } = await pool.query(
    `SELECT ${READING_COLS} FROM telemetry
      WHERE vehicle_id = $1 AND device_ts >= $2 AND device_ts <= $3
      ORDER BY device_ts ASC
      LIMIT $4`,
    [req.params.id, from, to, limit],
  );
  res.json({ vehicleId: req.params.id, from, to, count: rows.length, readings: rows });
}));

app.get('/fleet/positions', wrap(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (vehicle_id) ${READING_COLS}
      FROM telemetry
     WHERE device_ts > now() - INTERVAL '15 minutes'
     ORDER BY vehicle_id, device_ts DESC
  `);
  res.json({ count: rows.length, positions: rows });
}));

app.get('/metrics/ingest', wrap(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT time_bucket('1 minute', device_ts) AS bucket,
           count(*)::int AS readings,
           count(DISTINCT vehicle_id)::int AS vehicles,
           round(avg(EXTRACT(EPOCH FROM (received_at - device_ts)))::numeric, 3) AS "avgLagSec"
      FROM telemetry
     WHERE device_ts > now() - INTERVAL '1 hour'
     GROUP BY bucket
     ORDER BY bucket
  `);
  res.json({ buckets: rows });
}));

app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapi));
app.get('/openapi.json', (_req, res) => res.json(openapi));

const server = app.listen(PORT, () => {
  console.log(`[api] listening on :${PORT} — docs at /docs`);
});

function shutdown() {
  server.close(async () => { await pool.end(); process.exit(0); });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
