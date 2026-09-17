import { evaluate } from './rules.js';
import { reconcile, findTimedOut } from './episodes.js';
import {
  pool, loadZones, getCursor, setCursor, readWindow,
  loadOpenAlerts, lastSeenPerVehicle, openAlerts, closeAlerts, updatePeaks,
} from './db.js';

const POLL_MS         = Number(process.env.POLL_MS ?? 3000);
const WATERMARK_SEC   = Number(process.env.WATERMARK_SEC ?? 60);
const EPISODE_TIMEOUT_SEC = Number(process.env.EPISODE_TIMEOUT_SEC ?? 120);
const SPEED_LIMIT_KPH = Number(process.env.SPEED_LIMIT_KPH ?? 40);
const ZONE_TTL_MS     = Number(process.env.ZONE_TTL_MS ?? 60000);
const MAX_WINDOW      = Number(process.env.MAX_WINDOW ?? 5000);

let zones = [];
let zonesLoadedAt = 0;

// Cached with a TTL rather than reloaded per cycle or held until restart.
// Staleness is bounded by the TTL, which is shorter than the watermark the
// alerting latency already costs — so it is invisible — while a zone edit
// still takes effect without a redeploy.
async function getZones() {
  if (Date.now() - zonesLoadedAt < ZONE_TTL_MS) return zones;
  zones = await loadZones();
  zonesLoadedAt = Date.now();
  console.log(`[detector] loaded ${zones.length} zone(s)`);
  return zones;
}

const stats = { cycles: 0, readings: 0, opened: 0, closed: 0, timedOut: 0, errors: 0 };

async function cycle() {
  const activeZones = await getZones();

  // Only look at readings old enough that everything around them has almost
  // certainly arrived. This is what lets the detector process in device-clock
  // order despite most deliveries being out of order.
  const watermark = new Date(Date.now() - WATERMARK_SEC * 1000);
  const cursor = await getCursor();
  if (cursor >= watermark) return;

  const readings = await readWindow(cursor, watermark, MAX_WINDOW);
  const openBefore = await loadOpenAlerts();

  const { toOpen, toExtend, toClose, stillOpen } = reconcile({
    readings,
    openAlerts: openBefore,
    evaluateReading: (r) => evaluate(r, activeZones, SPEED_LIMIT_KPH),
  });

  const lastSeen = await lastSeenPerVehicle(watermark);
  const timedOut = findTimedOut({
    stillOpen,
    lastSeenByVehicle: lastSeen,
    watermark,
    timeoutMs: EPISODE_TIMEOUT_SEC * 1000,
  });

  // Order matters: open first, then close. A window that both opens and closes
  // an episode must have the row to update by the time the close runs.
  const opened = await openAlerts(toOpen);
  await updatePeaks(toExtend);
  const closed = await closeAlerts([...toClose, ...timedOut]);

  // Advance only as far as we actually read. If the window hit MAX_WINDOW the
  // remainder is picked up next cycle rather than skipped.
  const newCursor = readings.length === MAX_WINDOW
    ? readings[readings.length - 1].device_ts
    : watermark;
  await setCursor(newCursor);

  stats.cycles += 1;
  stats.readings += readings.length;
  stats.opened += opened;
  stats.closed += closed;
  stats.timedOut += timedOut.length;

  for (const e of toOpen) {
    console.log(`[detector] OPEN  ${e.alert_type}${e.subject ? '/' + e.subject : ''} ${e.vehicle_id} at ${e.opened_at.toISOString()}`);
  }
  for (const c of [...toClose, ...timedOut]) {
    console.log(`[detector] CLOSE ${c.alert.alert_type}${c.alert.subject ? '/' + c.alert.subject : ''} ${c.alert.vehicle_id} (${c.reason})`);
  }
}

console.log(
  `[detector] poll ${POLL_MS}ms · watermark ${WATERMARK_SEC}s · ` +
  `episode timeout ${EPISODE_TIMEOUT_SEC}s · speed limit ${SPEED_LIMIT_KPH} km/h`,
);

const timer = setInterval(() => {
  cycle().catch((err) => {
    stats.errors += 1;
    // The cursor is only advanced on success, so a failed cycle is retried
    // rather than skipped. Reprocessing is safe: reconcile() will not reopen
    // an episode it can see is open, and the insert is idempotent anyway.
    console.error('[detector] cycle failed:', err.message);
  });
}, POLL_MS);

const statsTimer = setInterval(() => {
  console.log(
    `[detector] cycles=${stats.cycles} readings=${stats.readings} ` +
    `opened=${stats.opened} closed=${stats.closed} timedOut=${stats.timedOut} errors=${stats.errors}`,
  );
}, 30000);

async function shutdown() {
  clearInterval(timer);
  clearInterval(statsTimer);
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);