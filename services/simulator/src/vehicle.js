// Motion model for one simulated shuttle.
//
// Drives a distance-along-route scalar `s` with simple accelerate / coast /
// brake / dwell behaviour. Everything the device would report is derived from
// that, so the emitted stream is self-consistent: speed matches the distance
// actually covered, odometer is the integral of speed, position is on-route.

const CRUISE_MPS = 8.3;   // ~30 km/h, campus limit
const ACCEL_MPS2 = 1.1;
const DECEL_MPS2 = 1.4;
const CREEP_MPS  = 0.6;   // never fully stall between stops

export function createVehicle({ id, route, startOffset = 0 }) {
  let s = startOffset % route.length;
  let v = 0;
  let dwellRemaining = 0;
  let odometerM = 12000 + Math.random() * 8000;
  let batteryPct = 82 + Math.random() * 15;
  let seq = 0;

  function tick(dtSec) {
    if (dwellRemaining > 0) {
      dwellRemaining -= dtSec;
      v = 0;
    } else {
      const { distance, stop } = route.distanceToNextStop(s);
      const brakingDistance = (v * v) / (2 * DECEL_MPS2);

      if (distance <= brakingDistance + 1) {
        v = Math.max(0, v - DECEL_MPS2 * dtSec);
        if (distance > 1.5) v = Math.max(v, CREEP_MPS);
      } else {
        v = Math.min(CRUISE_MPS, v + ACCEL_MPS2 * dtSec);
      }

      const step = v * dtSec;
      if (distance <= Math.max(step, 1.5)) {
        s += distance;                 // snap onto the stop
        odometerM += distance;
        v = 0;
        dwellRemaining = stop.dwellSec ?? 25;
      } else {
        s += step;
        odometerM += step;
      }
      s %= route.length;
    }

    // Drain scales with movement; idling still costs something (doors, HVAC).
    batteryPct = Math.max(5, batteryPct - (0.00025 * v + 0.00005) * dtSec);
    seq += 1;

    const pos = route.positionAt(s);
    return {
      v: 1,
      vehicleId: id,
      seq,
      ts: new Date().toISOString(),
      position: {
        lat: round(pos.lat, 6),
        lon: round(pos.lon, 6),
        headingDeg: round(pos.headingDeg, 1),
      },
      speedKph: round(v * 3.6, 1),
      batteryPct: round(batteryPct, 1),
      ignition: true,
      doorsLocked: dwellRemaining <= 0,
      odometerKm: round(odometerM / 1000, 3),
    };
  }

  return { id, tick };
}

function round(n, places) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}
