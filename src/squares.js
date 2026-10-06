// Trophy GeoJSON (A4.1) → visited-area polygons (A4.2).
// Feature "squadrats" is a MultiPolygon built from the visited-cell union:
// ring[0] = OUTER boundary of the visited area, rings[1..] = HOLES
// (unvisited pockets inside the union — frontier/ława source, A4.6–A4.7).

import { cellIndex, cellKey, cellCenter } from './geometry.js';
import { DLON } from './constants.js';

/**
 * A4.2 — visited polygons from the trophy FeatureCollection (any grid
 * feature: "squadrats" 3 km, "squadratinhos" 1 km). Returns { polygons,
 * declaredSize } with polygons as { outer, holes } in [lon, lat]; null when
 * the feature is missing or not a MultiPolygon.
 */
export function parseVisitedPolygons(geojson, featureName = 'squadrats') {
  const feature = (geojson?.features ?? []).find(
    (f) => f?.properties?.name === featureName,
  );
  if (feature?.geometry?.type !== 'MultiPolygon') return null;
  const polygons = feature.geometry.coordinates.map((rings) => ({
    outer: rings[0],
    holes: rings.slice(1),
    bbox: ringBbox(rings[0]),
  }));
  return { polygons, declaredSize: feature.properties.size ?? null };
}

function ringBbox(ring) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [lon, lat] of ring) {
    if (lon < b[0]) b[0] = lon;
    if (lat < b[1]) b[1] = lat;
    if (lon > b[2]) b[2] = lon;
    if (lat > b[3]) b[3] = lat;
  }
  return b;
}

/** True when [lon, lat] lies inside the ring (ray cast; O(n), no bbox). */
export function pointInRing([lon, lat], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Visited test: inside some outer ring, outside all its holes. */
export function isVisited(polygons, lon, lat) {
  return polygons.some(
    ({ outer, holes, bbox }) =>
      inBbox(bbox, lon, lat) &&
      pointInRing([lon, lat], outer) &&
      !holes.some((h) => pointInRing([lon, lat], h)),
  );
}

// Bbox pre-filter: a delivery has ~4k points × 80 union polygons.
function inBbox(bbox, lon, lat) {
  if (!bbox) return true;
  const [w, s, e, n] = bbox;
  return lon >= w && lat >= s && lon <= e && lat <= n;
}

/**
 * New-squares estimate from the delivery geometry (A6.2/A6.3): cells touched
 * by track points where NO point sits in the visited union. Squadrats rule —
 * any touch claims the square; cellIndex is the planner's own grid (A4.4).
 */
export function countNewCells(coords, polygons) {
  const visitedCell = new Map();
  for (const [lon, lat] of coords) {
    const key = cellKey(cellIndex(lon, lat).i, cellIndex(lon, lat).j);
    if (isVisited(polygons, lon, lat)) visitedCell.set(key, true);
    else if (!visitedCell.has(key)) visitedCell.set(key, false);
  }
  let visited = 0;
  for (const v of visitedCell.values()) if (v) visited++;
  return { touched: visitedCell.size, visited, fresh: visitedCell.size - visited };
}

/**
 * Visited cells (keys) whose CENTER lies in the visited union — sampled over
 * the local bbox only, no global grid reconstruction (anti-pattern §E).
 */
export function visitedCellsInBbox(polygons, { w, s, e, n }) {
  const visited = new Set();
  const i0 = Math.floor((w + 180) / DLON);
  const i1 = Math.floor((e + 180) / DLON);
  const jTop = cellIndex(0, n).j;
  const jBot = cellIndex(0, s).j;
  for (let i = i0; i <= i1; i++) {
    for (let j = jTop; j <= jBot; j++) {
      const c = cellCenter(i, j);
      if (isVisited(polygons, c.lon, c.lat)) visited.add(cellKey(i, j));
    }
  }
  return visited;
}
