// Squadrats trophies (A4.1) — 2 GETs, no auth; both endpoints send ACAO *
// (CORS verified 2026-10). The API always returns the CURRENT trophy URL,
// so the timestamped CDN file can never be read stale.

import { SQUADRATS_API } from '../constants.js';

const CACHE_PREFIX = 'gravel-planner:squadrats:';
const TTL_MS = 24 * 60 * 60 * 1000; // manual refresh bypasses; cache only spares re-downloads

/** Thrown for any HTTP 4xx/429/5xx; carries the exact URL for the UI (§0.3). */
export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} — ${url}`);
    this.status = status;
    this.url = url;
    this.name = 'HttpError';
  }
}

async function getJson(url) {
  let res;
  try {
    res = await fetch(url);
  } catch {
    throw new HttpError(0, url);
  }
  if (!res.ok) throw new HttpError(res.status, url);
  return res.json();
}

// Cache entry {ts, timestamp, geojson}; sessionStorage survives reloads in a tab.
function readCache(uid) {
  try {
    const hit = JSON.parse(sessionStorage.getItem(CACHE_PREFIX + uid));
    if (hit && Date.now() - hit.ts < TTL_MS) return hit;
  } catch {
    // private mode / quota — just refetch
  }
  return null;
}

function writeCache(uid, geojson, timestamp) {
  try {
    sessionStorage.setItem(CACHE_PREFIX + uid, JSON.stringify({ ts: Date.now(), timestamp, geojson }));
  } catch {
    // cache is best-effort
  }
}

/**
 * A4.1 — GET {api}/{uid}/geojson → {url, timestamp}; GET url → trophy
 * FeatureCollection (~1.3 MB). fresh = bypass the session cache. Returns
 * the trophy timestamp too — the UI shows the data age (squadrats regenerates
 * the trophy after activity sync; a stale bikerouter layer can disagree).
 */
export async function fetchSquadratsGeojson(uid, { fresh = false } = {}) {
  const cached = !fresh && readCache(uid);
  if (cached) return { geojson: cached.geojson, timestamp: cached.timestamp ?? null };
  const ticket = await getJson(`${SQUADRATS_API}/${uid}/geojson`);
  const geojson = await getJson(ticket.url);
  writeCache(uid, geojson, ticket.timestamp ?? null);
  return { geojson, timestamp: ticket.timestamp ?? null };
}
