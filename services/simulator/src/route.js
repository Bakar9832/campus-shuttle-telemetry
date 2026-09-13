// Polyline helpers for a closed shuttle loop.
//
// Campus-scale distances (single-digit km) so an equirectangular projection
// around the route centroid is accurate to well under a metre. No need for
// a geo library here — and being able to explain why is the point.

const R = 6371000;
const RAD = Math.PI / 180;

export function buildRoute(stops) {
  if (!Array.isArray(stops) || stops.length < 2) {
    throw new Error('route needs at least two stops');
  }

  const lat0 = stops.reduce((a, s) => a + s.lat, 0) / stops.length;
  const k = Math.cos(lat0 * RAD);

  const toXY = (p) => ({ x: R * p.lon * RAD * k, y: R * p.lat * RAD });
  const toLatLon = (p) => ({ lat: p.y / R / RAD, lon: p.x / (R * k) / RAD });

  const ring = [...stops, stops[0]];           // close the loop
  const xy = ring.map(toXY);

  const segments = [];
  let acc = 0;
  for (let i = 0; i < xy.length - 1; i++) {
    const a = xy[i];
    const dx = xy[i + 1].x - a.x;
    const dy = xy[i + 1].y - a.y;
    const len = Math.hypot(dx, dy);
    segments.push({
      a, dx, dy, len,
      start: acc,
      // bearing clockwise from north
      headingDeg: (Math.atan2(dx, dy) / RAD + 360) % 360,
    });
    acc += len;
  }

  const length = acc;
  const stopsAt = segments.map((s, i) => ({ ...stops[i], distance: s.start }));

  function positionAt(s) {
    const d = ((s % length) + length) % length;
    let seg = segments[segments.length - 1];
    for (const c of segments) {
      if (d < c.start + c.len) { seg = c; break; }
    }
    const t = seg.len === 0 ? 0 : (d - seg.start) / seg.len;
    const p = toLatLon({ x: seg.a.x + seg.dx * t, y: seg.a.y + seg.dy * t });
    return { lat: p.lat, lon: p.lon, headingDeg: seg.headingDeg };
  }

  // Distance ahead to the next stop, wrapping round the loop. A stop we are
  // sitting on (within half a metre) counts as behind us, not ahead.
  function distanceToNextStop(s) {
    let best = length;
    let next = stopsAt[0];
    for (const st of stopsAt) {
      let d = st.distance - (((s % length) + length) % length);
      if (d <= 0.5) d += length;
      if (d < best) { best = d; next = st; }
    }
    return { distance: best, stop: next };
  }

  return { length, stops: stopsAt, positionAt, distanceToNextStop };
}
