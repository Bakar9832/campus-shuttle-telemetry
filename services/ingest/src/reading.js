// Hand-rolled validation. The device contract is small and fixed, and a
// malformed reading must be dropped and counted, never allowed to kill the
// subscriber — one bad firmware build should not stop ingestion for the fleet.

const num = (x) => typeof x === 'number' && Number.isFinite(x);

export function parseReading(topicVehicleId, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }

  const p = msg?.position;
  if (typeof msg?.vehicleId !== 'string') return { ok: false, reason: 'missing_vehicle_id' };
  if (msg.vehicleId !== topicVehicleId)    return { ok: false, reason: 'topic_id_mismatch' };
  if (typeof msg.ts !== 'string')          return { ok: false, reason: 'missing_ts' };

  const deviceTs = new Date(msg.ts);
  if (Number.isNaN(deviceTs.getTime()))    return { ok: false, reason: 'bad_ts' };

  if (!p || !num(p.lat) || !num(p.lon))    return { ok: false, reason: 'bad_position' };
  if (p.lat < -90 || p.lat > 90)           return { ok: false, reason: 'lat_out_of_range' };
  if (p.lon < -180 || p.lon > 180)         return { ok: false, reason: 'lon_out_of_range' };
  if (!num(msg.speedKph) || msg.speedKph < 0) return { ok: false, reason: 'bad_speed' };
  if (!num(msg.odometerKm))                return { ok: false, reason: 'bad_odometer' };

  return {
    ok: true,
    reading: {
      vehicleId: msg.vehicleId,
      deviceTs,
      seq: num(msg.seq) ? msg.seq : 0,
      lat: p.lat,
      lon: p.lon,
      speedKph: msg.speedKph,
      headingDeg: num(p.headingDeg) ? p.headingDeg : 0,
      batteryPct: num(msg.batteryPct) ? msg.batteryPct : null,
      ignition: Boolean(msg.ignition),
      doorsLocked: Boolean(msg.doorsLocked),
      odometerKm: msg.odometerKm,
    },
  };
}
