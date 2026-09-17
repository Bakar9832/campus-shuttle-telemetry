import { pointInPolygon } from './geo.js';

// Each rule turns one reading into zero or more violations. A violation is
// just {type, subject, value} — the episode logic decides whether that means
// opening something new or continuing something already open.

export function evaluate(reading, zones, speedLimitKph) {
  const violations = [];

  if (reading.speed_kph > speedLimitKph) {
    violations.push({
      type: 'speeding',
      subject: '',
      value: reading.speed_kph,
      detail: { limitKph: speedLimitKph },
    });
  }

  for (const zone of zones) {
    const inside = pointInPolygon(reading.lat, reading.lon, zone.polygon);

    // inside_allowed collapses two opposite rules into one comparison:
    // a boundary is violated by being outside, a restricted area by being in.
    const violating = zone.inside_allowed ? !inside : inside;
    if (!violating) continue;

    violations.push({
      type: 'zone_violation',
      subject: zone.id,
      value: null,
      detail: { zoneName: zone.name, rule: zone.inside_allowed ? 'must_stay_inside' : 'must_stay_outside' },
    });

    // A zone may carry its own speed limit, which is a different violation
    // from the global one and is keyed to the zone.
    if (zone.speed_limit_kph != null && reading.speed_kph > zone.speed_limit_kph) {
      violations.push({
        type: 'speeding',
        subject: zone.id,
        value: reading.speed_kph,
        detail: { limitKph: zone.speed_limit_kph, zoneName: zone.name },
      });
    }
  }

  return violations;
}