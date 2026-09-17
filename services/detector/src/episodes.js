// Turns a stream of per-reading violations into open and closed episodes.
//
// The three cases, per vehicle:
//   violating now, not open   → open a new episode
//   violating now, already open → extend it (update peak)
//   open, but not violating in a reading we actually saw → close as resolved
//
// The last one is deliberately narrow. "Not violating" only counts when a
// reading from that vehicle proves it. Silence is not compliance — a bus that
// went dark mid-episode is handled by the timeout below, and the close_reason
// records which of the two happened.

const key = (vehicleId, type, subject) => `${vehicleId}\u0000${type}\u0000${subject}`;

export function reconcile({ readings, openAlerts, evaluateReading }) {
  const open = new Map();
  for (const a of openAlerts) {
    open.set(key(a.vehicle_id, a.alert_type, a.subject), a);
  }

  const toOpen = [];
  const toExtend = [];
  const toClose = [];

  for (const reading of readings) {
    const violations = evaluateReading(reading);
    const violatingNow = new Set(
      violations.map((v) => key(reading.vehicle_id, v.type, v.subject)),
    );

    // Close anything open for THIS vehicle that this reading contradicts.
    for (const [k, alert] of open) {
      if (alert.vehicle_id !== reading.vehicle_id) continue;
      if (violatingNow.has(k)) continue;
      toClose.push({ alert, closedAt: reading.device_ts, reason: 'resolved' });
      open.delete(k);
    }

    for (const v of violations) {
      const k = key(reading.vehicle_id, v.type, v.subject);
      const existing = open.get(k);

      if (!existing) {
        const episode = {
          vehicle_id: reading.vehicle_id,
          alert_type: v.type,
          subject: v.subject,
          opened_at: reading.device_ts,      // device clock: reprocessing is idempotent
          lat: reading.lat,
          lon: reading.lon,
          peak: v.value,
          detail: v.detail,
        };
        toOpen.push(episode);
        open.set(k, episode);
        continue;
      }

      // Already open — keep the worst value seen during the episode.
      if (v.value != null && (existing.peak == null || v.value > existing.peak)) {
        existing.peak = v.value;
        toExtend.push({ alert: existing, peak: v.value });
      }
    }
  }

  return { toOpen, toExtend, toClose, stillOpen: [...open.values()] };
}

// An episode whose vehicle has not reported for longer than the timeout is
// closed as timed_out rather than resolved. The two are different facts: one
// says the condition ended, the other says we stopped being able to tell.
//
// timeoutMs must exceed the worst expected outage plus the watermark, or a
// vehicle that buffers through a dropout gets its episode closed here and then
// finds a closing reading arriving afterwards.
export function findTimedOut({ stillOpen, lastSeenByVehicle, watermark, timeoutMs }) {
  const cutoff = new Date(watermark.getTime() - timeoutMs);
  const timedOut = [];

  for (const alert of stillOpen) {
    if (alert.alert_type === 'offline') continue;
    const lastSeen = lastSeenByVehicle.get(alert.vehicle_id);
    if (lastSeen && lastSeen > cutoff) continue;
    timedOut.push({
      alert,
      closedAt: lastSeen ?? alert.opened_at,
      reason: 'timed_out',
    });
  }

  return timedOut;
}