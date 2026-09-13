import pg from 'pg';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX ?? 8),
});

const COLUMNS = [
  'vehicle_id', 'device_ts', 'seq', 'lat', 'lon', 'speed_kph',
  'heading_deg', 'battery_pct', 'ignition', 'doors_locked', 'odometer_km',
];

// One multi-row INSERT per flush rather than a statement per message.
// ON CONFLICT DO NOTHING makes the write idempotent, which is what makes
// MQTT QoS 1 (at-least-once) safe and lets a buffered device replay old
// readings without creating duplicates.
export async function insertBatch(rows) {
  if (rows.length === 0) return 0;

  const values = [];
  const tuples = rows.map((r, i) => {
    const base = i * COLUMNS.length;
    values.push(
      r.vehicleId, r.deviceTs, r.seq, r.lat, r.lon, r.speedKph,
      r.headingDeg, r.batteryPct, r.ignition, r.doorsLocked, r.odometerKm,
    );
    return `(${COLUMNS.map((_, c) => `$${base + c + 1}`).join(',')})`;
  });

  const sql =
    `INSERT INTO telemetry (${COLUMNS.join(',')}) VALUES ${tuples.join(',')} ` +
    `ON CONFLICT (vehicle_id, device_ts) DO NOTHING`;

  const res = await pool.query(sql, values);
  return res.rowCount;
}

export async function registerVehicle(vehicleId) {
  await pool.query(
    `INSERT INTO vehicle (id, label) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
    [vehicleId, vehicleId],
  );
  await pool.query(
    `INSERT INTO vehicle_status (vehicle_id) VALUES ($1) ON CONFLICT (vehicle_id) DO NOTHING`,
    [vehicleId],
  );
}

export async function setOnline(vehicleId, online) {
  await pool.query(
    `UPDATE vehicle_status
        SET online = $2, changed_at = now()
      WHERE vehicle_id = $1 AND online IS DISTINCT FROM $2`,
    [vehicleId, online],
  );
}

export async function touchLastSeen(vehicleId, deviceTs) {
  await pool.query(
    `UPDATE vehicle_status
        SET last_seen = GREATEST(COALESCE(last_seen, $2), $2)
      WHERE vehicle_id = $1`,
    [vehicleId, deviceTs],
  );
}
