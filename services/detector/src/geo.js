export function pointInPolygon(lat, lon, ring) {
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [latI, lonI] = ring[i];
    const [latJ, lonJ] = ring[j];

    const straddles = (latI > lat) !== (latJ > lat);
    if (!straddles) continue;

    const crossingLon = lonI + ((lat - latI) / (latJ - latI)) * (lonJ - lonI);

    if (lon < crossingLon) inside = !inside;
  }

  return inside;
} 