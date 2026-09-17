import pg from 'pg';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX ?? 4),
});

export async function loadZones() {
  const { rows } = await pool.query(
    `SELECT id, name, inside_allowed, polygon, speed_limit_kph FROM zone`,
  );
  return rows;
}

export async function getCursor() {
  const { rows } = await pool.query(
    `SELECT last_processed_ts FROM detector_cursor WHERE id = 'default'`,
  );
  return rows[0]?.last_processed_ts ?? new Date(0);
}

export async function setCursor(ts) {
  await pool.query(
    `UPDATE detector_cursor SET last_processed_ts = $1, updated_at = now() WHERE id = 'default'`,
    [ts],
  );
}

// Readings between the cursor and the watermark, in device-clock order.
// The watermark is what makes this correct: by only looking at readings older
// than now() - WATERMARK_SEC, everything around them has almost certainly
// arrived, so processing in device order is safe despite 84% of deliveries
// being out of order.
export async function readWindow(from, to, limit) {
  const { rows } = await pool.query(
    `SELECT vehicle_id, device_ts, lat, lon, speed_kph
       FROM telemetry
      WHERE device_ts > $1 AND device_ts <= $2
      ORDER BY device_ts ASC
      LIMIT $3`,
    [from, to, limit],
  );
  return rows;
}

export async function loadOpenAlerts() {
  const { rows } = await pool.query(
    `SELECT vehicle_id, alert_type, subject, opened_at, peak
       FROM alert
      WHERE closed_at IS NULL`,
  );
  return rows;
}

// Newest device_ts per vehicle inside the window, used to decide which open
// episodes have gone quiet long enough to time out.
export async function lastSeenPerVehicle(before) {
  const { rows } = await pool.query(
    `SELECT vehicle_id, max(device_ts) AS last_seen
       FROM telemetry
      WHERE device_ts <= $1 AND device_ts > $1 - interval '1 hour'
      GROUP BY vehicle_id`,
    [before],
  );
  return new Map(rows.map((r) => [r.vehicle_id, r.last_seen]));
}

// ON CONFLICT DO NOTHING is the second line of defence. reconcile() already
// refuses to open an episode it can see is open, but a crash between the
// insert and the cursor advance would replay the same window — and then this
// is what stops a duplicate row.
export async function openAlerts(episodes) {
  if (episodes.length === 0) return 0;

  const values = [];
  const tuples = episodes.map((e, i) => {
    const b = i * 8;
    values.push(
      e.vehicle_id, e.alert_type, e.subject, e.opened_at,
      e.lat, e.lon, e.peak, JSON.stringify(e.detail ?? {}),
    );
    return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`;
  });

  const res = await pool.query(
    `INSERT INTO alert (vehicle_id, alert_type, subject, opened_at, lat, lon, peak, detail)
     VALUES ${tuples.join(',')}
     ON CONFLICT (vehicle_id, alert_type, subject, opened_at) DO NOTHING`,
    values,
  );
  return res.rowCount;
}

export async function closeAlerts(closures) {
  let closed = 0;
  for (const { alert, closedAt, reason } of closures) {
    const res = await pool.query(
      `UPDATE alert
          SET closed_at = $5, close_reason = $6
        WHERE vehicle_id = $1 AND alert_type = $2 AND subject = $3
          AND opened_at = $4 AND closed_at IS NULL`,
      [alert.vehicle_id, alert.alert_type, alert.subject, alert.opened_at, closedAt, reason],
    );
    closed += res.rowCount;
  }
  return closed;
}

export async function updatePeaks(updates) {
  for (const { alert, peak } of updates) {
    await pool.query(
      `UPDATE alert SET peak = GREATEST(COALESCE(peak, $5), $5)
        WHERE vehicle_id = $1 AND alert_type = $2 AND subject = $3 AND opened_at = $4`,
      [alert.vehicle_id, alert.alert_type, alert.subject, alert.opened_at, peak],
    );
  }
}

// Vehicles whose last reading is older than the threshold. This is the one
// alert driven by absence rather than by evaluating a reading, so it reads
// vehicle_status rather than telemetry.
export async function findSilentVehicles(before, silentSec) {
  const { rows } = await pool.query(
    `SELECT vehicle_id, last_seen
       FROM vehicle_status
      WHERE last_seen IS NOT NULL
        AND last_seen < $1::timestamptz - make_interval(secs => $2)`,
    [before, silentSec],
  );
  return rows;
}

export async function findRecoveredVehicles(before, silentSec) {
  const { rows } = await pool.query(
    `SELECT a.vehicle_id, s.last_seen
       FROM alert a
       JOIN vehicle_status s ON s.vehicle_id = a.vehicle_id
      WHERE a.alert_type = 'offline'
        AND a.closed_at IS NULL
        AND s.last_seen >= $1::timestamptz - make_interval(secs => $2)`,
    [before, silentSec],
  );
  return rows;
}