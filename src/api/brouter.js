// BRouter backend (B1) and bikerouter preview link (B3).
// HTTP 4xx/429/5xx → HttpError with the exact URL; the UI shows it, no retry (§0.3).

import { PROFILE, PROFILE_PARAMS } from '../constants.js';

// bikerouter's own engine — ONE backend for planning, the uploaded riding
// profile (custom_ ids live HERE, see profile.js) and the preview link.
const BROUTER_BASE = 'https://bikerouter.de/brouter-engine/brouter';

/** Thrown for any HTTP 4xx/429/5xx; carries the exact URL for the UI (§0.3). */
export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} — ${url}`);
    this.status = status;
    this.url = url;
    this.name = 'HttpError';
  }
}

/**
 * B1 request URL — gravel + 4 flags always explicit (B1.4), named via
 * "lon,lat,NAME" (B1.2). opts.plain = omit the via-correction flags to
 * simulate a preview engine (bikerouter ignores them, B3).
 */
export function buildUrl(points, opts = {}) {
  const lonlats = points.map((p) => `${p.lon},${p.lat}`).join('|');
  const flags = opts.plain
    ? Object.fromEntries(Object.entries(PROFILE_PARAMS).filter(([k]) => !k.startsWith('profile:correctMisplaced')))
    : PROFILE_PARAMS;
  const params = new URLSearchParams({
    lonlats,
    profile: opts.profile ?? PROFILE,
    ...flags,
    format: opts.format ?? 'geojson',
    alternativeidx: String(opts.alternativeidx ?? 0),
  });
  if (opts.exportWaypoints) params.set('exportWaypoints', '1');
  if (opts.trackname) params.set('trackname', opts.trackname);
  return `${BROUTER_BASE}?${params.toString()}`;
}

/** B1 route as GeoJSON; network failure = HttpError 0, URL reported, no retry (§0.3). */
export async function fetchRouteGeojson(points, opts = {}) {
  const url = buildUrl(points, opts);
  let res;
  try {
    res = await fetch(url);
  } catch {
    throw new HttpError(0, url);
  }
  if (!res.ok) throw new HttpError(res.status, url);
  return { geojson: await res.json(), url };
}

/** All route coordinates ([lon, lat, ele?]) from a BRouter GeoJSON. */
export function extractCoords(geojson) {
  const coords = [];
  for (const f of geojson.features ?? []) {
    const geom = f?.geometry;
    if (geom?.type === 'LineString') coords.push(...geom.coordinates);
    else if (geom?.type === 'MultiLineString')
      for (const line of geom.coordinates) coords.push(...line);
  }
  return coords;
}

/** Track length in km from the "track-length" feature property. */
export function trackLengthKm(geojson) {
  const prop = geojson.features?.find((f) => f.properties?.['track-length'])?.properties;
  return prop ? Number(prop['track-length']) / 1000 : null;
}

/**
 * B3 — preview link: ;-separated lonlats, /standard layer, profile + the two
 * routing flags in the URL (bikerouter parses `profile:*` from the hash and
 * forwards them to its engine — verified). opts.profile should be the custom
 * id uploaded to bikerouter's own engine (see profile.js): the link then
 * opens routed with the riding profile, no manual upload/selection; without
 * it stock gravel is forced (bikerouter otherwise reuses the last profile —
 * often road bike).
 */
export function buildPreviewUrl(points, opts = {}) {
  const lonlats = points.map((p) => `${p.lon},${p.lat}`).join(';');
  const zoom = opts.zoom ?? 11;
  const first = points[0];
  const params = new URLSearchParams({
    profile: opts.profile ?? 'gravel',
    'profile:prefer_unpaved_paths': '1',
    'profile:avoid_noise': '1',
  });
  return (
    `https://bikerouter.de/#map=${zoom}/${first.lat}/${first.lon}/standard` +
    `&lonlats=${lonlats}&${params.toString()}`
  );
}
