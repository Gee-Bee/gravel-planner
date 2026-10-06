// Grid math (A4.3/A4.4) and lollipop planning stubs (Etap C).

import { GRID_N, DLON } from './constants.js';

/** A4.3 — Mercator ordinate: merc_y = ln(tan(π/4 + φ/2)). */
export function mercY(lat) {
  return Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
}

/** A4.4 — grid cell index from lon/lat. */
export function cellIndex(lon, lat) {
  const i = Math.floor((lon + 180) / DLON);
  const j = Math.floor((GRID_N * (1 - mercY(lat) / Math.PI)) / 2);
  return { i, j };
}

/** Canonical cell key "i:j". */
export function cellKey(i, j) {
  return `${i}:${j}`;
}

/** Cell center — inverse of A4.4 (mercator row middle). */
export function cellCenter(i, j) {
  const lon = -180 + (i + 0.5) * DLON;
  const merc = (Math.PI * (GRID_N - 2 * j - 1)) / GRID_N;
  const lat = (2 * Math.atan(Math.exp(merc)) * 180) / Math.PI - 90;
  return { lon, lat };
}

/** Initial bearing S→P (0=N, 90=E; equirectangular — good locally). */
export function bearingDeg(a, b) {
  const dLon = (b.lon - a.lon) * 111.32 * Math.cos((a.lat * Math.PI) / 180);
  const dLat = (b.lat - a.lat) * 110.57;
  return (Math.atan2(dLon, dLat) * 180) / Math.PI;
}

/** Square work bbox around a point (km → deg, equirectangular). */
export function bboxAroundKm({ lon, lat }, rKm) {
  return {
    w: lon - rKm / (111.32 * Math.cos((lat * Math.PI) / 180)),
    e: lon + rKm / (111.32 * Math.cos((lat * Math.PI) / 180)),
    s: lat - rKm / 110.57,
    n: lat + rKm / 110.57,
  };
}

/**
 * Etap B — frontier: unvisited cells 4-adjacent to visited ones (A4.6).
 * workBbox = {w,s,e,n} keeps the scan local (anti-pattern §E): a neighbour
 * whose CENTER falls outside the bbox is not frontier material.
 */
export function computeFrontier(visitedCells, workBbox) {
  const frontier = new Set();
  for (const key of visitedCells) {
    const [i, j] = key.split(':').map(Number);
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = cellKey(i + di, j + dj);
      if (visitedCells.has(k) || frontier.has(k)) continue;
      const c = cellCenter(i + di, j + dj);
      if (c.lon < workBbox.w || c.lon > workBbox.e || c.lat < workBbox.s || c.lat > workBbox.n) {
        continue;
      }
      frontier.add(k);
    }
  }
  return frontier;
}

/**
 * Approximate geodesic distance in km (spherical, equirectangular) — good to
 * a few hundred meters at these scales; used for anchor placement. 111.32/
 * 110.57 are km per DEGREE — no π/180 here (double conversion measured as a
 * ×57 shrink in aimAtFrontier).
 */
export function distanceKm(a, b) {
  const dLon = (b.lon - a.lon) * 111.32 * Math.cos((a.lat * Math.PI) / 180);
  const dLat = (b.lat - a.lat) * 110.57;
  return Math.sqrt(dLon * dLon + dLat * dLat);
}

/** Destination point given start, bearing (deg) and distance (km). */
export function destination(start, bearingDeg, distKm) {
  const rad = (bearingDeg * Math.PI) / 180;
  const dLat = (distKm * Math.cos(rad)) / 110.57;
  const dLon =
    (distKm * Math.sin(rad)) /
    (111.32 * Math.cos((start.lat * Math.PI) / 180) || 1);
  return { lon: start.lon + dLon, lat: start.lat + dLat };
}

