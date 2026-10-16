// Planning pipeline v7.3 — unified exploration, robust gates, scenic POIs
// (Wikipedia geosearch, B2 — Overpass is retired).
// Route model: the checked points in list order ARE the route — first = start,
// the rest are stops in visit order; a stop back at the start (a single point,
// or the first row duplicated last) closes the loop, anything else is one-way.

import { LOOP_TIP_KM, ROAD_INFLATION, planAnchorsRadial } from './route-analyzer.js';
import { PROFILE } from './constants.js';
import {
  bboxAroundKm,
  bearingDeg,
  cellCenter,
  computeFrontier,
  destination,
  distanceKm,
} from './geometry.js';
import { countNewCells, visitedCellsInBbox } from './squares.js';
import { searchPois } from './api/wikipedia.js';
import {
  buildUrl,
  fetchRouteGeojson,
  trackLengthKm,
  extractCoords,
  buildPreviewUrl,
} from './api/brouter.js';

const BEARINGS = Object.freeze({ n: 0, e: 90, s: 180, w: 270 });

const TWIN_WINDOW_KM = 1.0;
const TWIN_EPS_KM = 0.04;
const SPIKE_MIN_PATH_KM = 0.25;
const SPIKE_MAX_PATH_KM = 1.2;
const SPIKE_EPS_KM = 0.15;
const TWIN_MIN_RUN_KM = 0.2;
const MERGE_GAP_KM = 3.0;

const SAFE_END_KM = 2.5;
const SAFE_END_FRACTION = 0.06;
const SAFE_END_MAX_KM = 6;

const RING_VIA_STEP_KM = 1.8;
const RING_VIA_SPARSE_STEP_KM = 5.4;
const LOOP_CLOSE_KM = 0.1;

const STUB_MIN_PATH_KM = 0.3;
const STUB_MAX_PATH_KM = 3.0;
const STUB_EPS_KM = 0.12;
const STUB_VIA_MAX_KM = 0.3;

const PARITY_TOL_KM = 3;
const DOUBLED_TOL_KM = 2;
// A usable ring must retain most of its target distance after splicing dead ends.
const RING_MIN_FACTOR = 0.75;
const FRONTIER_REACH = 1.4;
const SCENIC_REACH_KM = 1.5;

const MAX_FETCHES = 22;

const KLAT = 110.57;
const kxAt = (lat) => 111.32 * Math.cos((lat * Math.PI) / 180);

// Equirectangular planar projection in km around the start + cumulative path.
function planar(coords, start) {
  const kx = kxAt(start.lat);
  const P = coords.map(([lon, lat]) => ({
    x: (lon - start.lon) * kx,
    y: (lat - start.lat) * KLAT,
  }));
  const cum = [0];
  for (let i = 1; i < P.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y));
  }
  return { P, cum, kx };
}

// --- Geometry & Routing Helpers ---

export function nubRuns(coords, start) {
  if (!coords || coords.length < 8) return [];
  const { P, cum } = planar(coords, start);
  const total = cum[cum.length - 1];
  const safeEnd = Math.max(SAFE_END_KM, Math.min(total * SAFE_END_FRACTION, SAFE_END_MAX_KM));

  const doubled = P.map((_, i) => {
    const inStart = cum[i] < safeEnd;
    const inEnd = total - cum[i] < safeEnd;
    let isBad = false;
    for (let j = 0; j < P.length; j++) {
      const dp = Math.abs(cum[j] - cum[i]);
      if (dp < SPIKE_MIN_PATH_KM) continue;

      const jInStart = cum[j] < safeEnd;
      const jInEnd = total - cum[j] < safeEnd;

      // Exempt shared stem (outgoing matches incoming at the ends of the loop)
      if ((inStart && jInEnd) || (inEnd && jInStart)) continue;

      const d = Math.hypot(P[i].x - P[j].x, P[i].y - P[j].y);
      if (dp > TWIN_WINDOW_KM && d < TWIN_EPS_KM) isBad = true;
      if (dp <= SPIKE_MAX_PATH_KM && d < SPIKE_EPS_KM) isBad = true;
    }
    return isBad;
  });

  const runs = [];
  let s = -1;
  for (let i = 0; i <= doubled.length; i++) {
    const bad = i < doubled.length && doubled[i];
    if (bad && s < 0) s = i;
    if (!bad && s >= 0) {
      if (cum[i - 1] - cum[s] >= TWIN_MIN_RUN_KM) runs.push({ i0: s, i1: i - 1 });
      s = -1;
    }
  }
  const merged = [];
  for (const r of runs) {
    const prev = merged[merged.length - 1];
    if (prev && cum[r.i0] - cum[prev.i1] < MERGE_GAP_KM) prev.i1 = r.i1;
    else merged.push({ ...r });
  }
  return merged.map((r) => ({ ...r, km: +(cum[r.i1] - cum[r.i0]).toFixed(2) }));
}

export function interiorDoubledKm(coords, start) {
  return +nubRuns(coords, start).reduce((s, r) => s + r.km, 0).toFixed(2);
}

export function spliceNub(coords, start) {
  const runs = nubRuns(coords, start);
  if (runs.length === 0) {
    return { coords, keepIdx: coords.map((_, i) => i), junctionIdx: null, nubKm: 0 };
  }
  const { cum } = planar(coords, start);
  const next = [];
  const keepIdx = [];
  let keep = 0;
  const push = (i) => { next.push(coords[i]); keepIdx.push(i); };
  for (const r of runs) {
    for (let i = keep; i < r.i0; i++) push(i);
    keep = r.i1 + 1;
  }
  for (let i = keep; i < coords.length; i++) push(i);
  return {
    coords: next,
    keepIdx,
    junctionIdx: runs[0].i0 - 1,
    nubKm: +runs.reduce((s, r) => s + cum[r.i1] - cum[r.i0], 0).toFixed(2),
  };
}

export function legThroughSplice(spliced, cutOnProbe) {
  return spliced.coords.filter((_, k) => spliced.keepIdx[k] <= cutOnProbe);
}

export function ringViasIdx(ringCoords, start, stepKm = RING_VIA_STEP_KM) {
  if (!ringCoords || ringCoords.length < 8) return [];
  const { cum } = planar(ringCoords, start);
  const total = cum[cum.length - 1];
  const idx = [];
  let nextKm = stepKm;
  for (let i = 1; i < cum.length - 1; i++) {
    if (cum[i] >= nextKm && total - cum[i] >= stepKm) {
      idx.push(i);
      nextKm += stepKm;
    }
  }
  return idx;
}

export function ringVias(ringCoords, start, stepKm = RING_VIA_STEP_KM) {
  const { P, kx } = planar(ringCoords ?? [], start);
  return ringViasIdx(ringCoords, start, stepKm).map((i) => ({
    lon: start.lon + P[i].x / kx,
    lat: start.lat + P[i].y / KLAT,
  }));
}

export function routeStops(route) {
  if (!route?.length) return [];
  return route.length > 1 ? route.slice(1) : [route[0]];
}

export function isLoopRoute(route) {
  if (!route?.length) return false;
  return route.length === 1 || distanceKm(route[0], route[route.length - 1]) < LOOP_CLOSE_KM;
}

export function chainHopKm(stops) {
  let km = 0;
  for (let i = 0; i + 1 < stops.length; i++) {
    km += distanceKm(stops[i], stops[i + 1]) * ROAD_INFLATION;
  }
  return +km.toFixed(2);
}

export function outboundCut(ringCoords, start, firstStop) {
  const { P, kx } = planar(ringCoords ?? [], start);
  const qx = (firstStop.lon - start.lon) * kx;
  const qy = (firstStop.lat - start.lat) * KLAT;
  let cut = -1;
  let nearest = 0;
  let best = Infinity;
  for (let i = 0; i < P.length; i++) {
    const d = Math.hypot(P[i].x - qx, P[i].y - qy);
    if (d < LOOP_CLOSE_KM) cut = i;
    if (d < best) { best = d; nearest = i; }
  }
  return cut >= 0 ? cut : nearest;
}

export function stubVias(deliveryCoords, vias, start, exempt = new Set()) {
  const coords = deliveryCoords ?? [];
  if (coords.length < 8 || vias.length === 0) return [];
  const { P, cum } = planar(coords, start);
  const tipIdx = new Set();

  for (let i = 0; i < P.length; i++) {
    for (let j = i + 1; j < P.length; j++) {
      const dp = cum[j] - cum[i];
      if (dp > STUB_MAX_PATH_KM) break;
      if (dp < STUB_MIN_PATH_KM) continue;

      if (Math.hypot(P[i].x - P[j].x, P[i].y - P[j].y) < STUB_EPS_KM) {
        let bi = -1, bd = Infinity;
        vias.forEach((v, k) => {
          const kx = kxAt(start.lat);
          const vx = (v.lon - start.lon) * kx, vy = (v.lat - start.lat) * KLAT;
          const d = Math.hypot(vx - P[j].x, vy - P[j].y);
          if (d < bd) { bd = d; bi = k; }
        });
        if (bi >= 0 && bd < STUB_VIA_MAX_KM && !exempt.has(bi)) tipIdx.add(bi);
        break;
      }
    }
  }
  return [...tipIdx].sort((a, b) => a - b);
}

// --- POI & Scenic Helpers ---

function getScenicScore(coords, start, scenicSpots) {
  if (!scenicSpots?.length) return 0;
  const { P } = planar(coords, start);
  const kx = kxAt(start.lat);
  let spots = 0;
  for (const s of scenicSpots) {
    const sx = (s.lon - start.lon) * kx;
    const sy = (s.lat - start.lat) * KLAT;
    let best = Infinity;
    for (let i = 0; i < P.length; i++) {
      const d = Math.hypot(P[i].x - sx, P[i].y - sy);
      if (d < best) { best = d; if (best <= SCENIC_REACH_KM) break; }
    }
    if (best <= SCENIC_REACH_KM) spots++;
  }
  return spots;
}

function getScenicBearing(start, targetKm, scenicSpots) {
  if (!scenicSpots?.length) return null;
  const buckets = new Array(16).fill(0);
  for (const s of scenicSpots) {
    if (distanceKm(start, s) > targetKm) continue;
    const deg = ((bearingDeg(start, s) % 360) + 360) % 360;
    buckets[Math.round(deg / 22.5) % 16]++;
  }
  let best = 0;
  for (let i = 1; i < buckets.length; i++) if (buckets[i] > buckets[best]) best = i;
  return buckets[best] > 0 ? best * 22.5 : null;
}

// B2.1 — only POIs the ≤800 m snap (B1.1) can absorb become named vias: each
// rides the leg at the km of its nearest route point, a lattice pin within
// PIN_YIELD_KM yields its slot to the POI, nothing is glued onto the route.
const SCENIC_SNAP_KM = 0.8;
const PIN_YIELD_KM = 1.2;
const SCENIC_MIN_KM = 1.0; // nothing named right at the start approach (A5.4)

/**
 * Named wiki POIs ordered with the generic lattice pins along leg-1; one via
 * per ≤PIN_YIELD cluster, lattices (first match wins) or POIs, by km.
 */
function viasThruScenic(legCoords, start, scenicSpots, stepKm) {
  if (!legCoords || legCoords.length < 8) return [];
  const { P, cum, kx } = planar(legCoords, start);
  const nearest = (lon, lat) => {
    const qx = (lon - start.lon) * kx, qy = (lat - start.lat) * KLAT;
    let best = { km: 0, d: Infinity };
    for (let i = 0; i < P.length; i++) {
      const d = Math.hypot(P[i].x - qx, P[i].y - qy);
      if (d < best.d) best = { km: cum[i], d };
    }
    return best;
  };
  const named = (scenicSpots ?? [])
    .map((s) => ({ lon: s.lon, lat: s.lat, name: s.name, ...nearest(s.lon, s.lat) }))
    .filter((s) => s.d <= SCENIC_SNAP_KM && s.km >= SCENIC_MIN_KM)
    .sort((a, b) => a.km - b.km);
  const lattice = ringViasIdx(legCoords, start, stepKm).map((i) => ({
    lon: start.lon + P[i].x / kx,
    lat: start.lat + P[i].y / KLAT,
    km: cum[i], d: 0,
  }));
  const kept = [];
  for (const v of [...lattice, ...named].sort((a, b) => a.km - b.km)) {
    const prev = kept[kept.length - 1];
    if (prev && v.km - prev.km < PIN_YIELD_KM) {
      if (v.name && !prev.name) kept[kept.length - 1] = v; // POI replaces the pin
      continue; // second POI of a cluster or a pin inside its shadow
    }
    kept.push(v);
  }
  return kept.map(({ lon, lat, name }) => (name ? { lon, lat, name } : { lon, lat }));
}

// D5 — named via CPs at km positions measured along the DELIVERY geometry.
function poiKmList(coords, start, vias) {
  const named = vias?.filter((v) => v.name) ?? [];
  if (!named.length || !coords?.length) return [];
  const { P, cum, kx } = planar(coords, start);
  return named
    .map((v) => ({ name: v.name, km: nearestKm(P, cum, start, kx, v.lon, v.lat).km }))
    .sort((a, b) => a.km - b.km)
    .map(({ name, km }) => ({ name, km: +km.toFixed(1) }));
}

function nearestKm(P, cum, start, kx, lon, lat) {
  const qx = (lon - start.lon) * kx, qy = (lat - start.lat) * KLAT;
  let best = { km: 0, d: Infinity };
  for (let i = 0; i < P.length; i++) {
    const d = Math.hypot(P[i].x - qx, P[i].y - qy);
    if (d < best.d) best = { km: cum[i], d };
  }
  return best;
}

// --- Frontier Aiming ---

/**
 * Returns an array of visually distinct frontier cells (separated by at least 25 deg).
 * This prevents all exploratory probes from hitting the same blocked terrain.
 */
export function getDiverseFrontiers(start, polygons, targetKm, sector = null) {
  if (!polygons) return [];
  const bbox = bboxAroundKm(start, (targetKm / 2) * FRONTIER_REACH);
  const visited = visitedCellsInBbox(polygons, bbox);
  if (visited.size === 0) return [];

  const inReach = [];
  for (const key of computeFrontier(visited, bbox)) {
    const [i, j] = key.split(':').map(Number);
    const c = cellCenter(i, j);
    const d = distanceKm(start, c);
    const b = bearingDeg(start, c);
    if (sector != null) {
      if (Math.abs(((b - sector + 540) % 360) - 180) > 45) continue;
    }
    inReach.push({ dKm: d, bearingDeg: ((b % 360) + 360) % 360, cell: c });
  }
  if (inReach.length === 0) return [];

  inReach.sort((a, b) => a.dKm - b.dKm);
  const pool = inReach.slice(0, 15);

  // Shuffle the pool to ensure different clicks yield different exploration routes
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  const selected = [];
  for (const f of pool) {
    if (!selected.some(s => Math.abs(((s.bearingDeg - f.bearingDeg + 540) % 360) - 180) < 25)) {
      selected.push(f);
      if (selected.length >= 3) break;
    }
  }
  return selected;
}

export function buildFrontierAnchors(start, aim, targetKm) {
  if (!aim) return null;
  // Deep loop penetration offset laterally by LOOP_TIP_KM
  const maxDepthKm = Math.max(aim.dKm + 3, (targetKm / ROAD_INFLATION) * 0.52);
  const alphaDeg = Math.min(30, Math.max(15, (LOOP_TIP_KM / maxDepthKm) * (180 / Math.PI)));
  const b0 = destination(start, ((aim.bearingDeg + alphaDeg) % 360 + 360) % 360, maxDepthKm);
  return [aim.cell, b0];
}

// --- Main Planning Function ---

export async function planRoutes(params) {
  const route = params.route ?? [];
  const start = route[0];
  if (!start) throw new Error('no start — tick a point in the config first');

  const stops = routeStops(route);
  const hopKm = chainHopKm(stops);
  const leg1Km = params.targetKm - hopKm;

  const minKm = Math.ceil(distanceKm(start, stops[0]) * ROAD_INFLATION + hopKm + 2 * LOOP_TIP_KM);
  if (params.targetKm < minKm) {
    throw new Error(`D too small — this route needs D ≈ ${minKm} km (legs by air ×${ROAD_INFLATION} + tip loop)`);
  }

  const wanderKm = leg1Km - distanceKm(start, stops[0]) * ROAD_INFLATION;
  const profile = params.profile ?? PROFILE;
  const trackname = `gravel-D${params.targetKm}`;
  const squares = params.squares;
  const hasSquares = !!squares?.polygons?.length;

  const manual = !!params.bearingKey && params.bearingKey !== 'auto';
  const deg = Number(params.bearingDeg);
  const sector = params.bearingKey === 'deg'
    ? (Number.isFinite(deg) ? ((deg % 360) + 360) % 360 : 0)
    : manual ? BEARINGS[params.bearingKey] ?? BEARINGS.n : null;

  const scenicSpots = await searchPois(bboxAroundKm(start, params.targetKm));
  let fetches = 0;

  const fetchCounted = async (pts, opts = {}) => {
    if (++fetches > MAX_FETCHES) throw new Error('fetch budget exceeded (§0.4)');
    return fetchRouteGeojson(pts, { trackname, ...opts });
  };

  const probeBearing = async (brg, targets = null) => {
    const anchors = targets ?? planAnchorsRadial(start, brg, wanderKm);
    const probe = await fetchCounted([start, ...anchors, ...stops], { plain: true, profile });
    const probeCoords = extractCoords(probe.geojson);
    const ring = spliceNub(probeCoords, start);
    const { cum: ringCum } = planar(ring.coords, start);
    const leg1 = legThroughSplice(ring, outboundCut(probeCoords, start, stops[0]));

    const fresh = hasSquares ? countNewCells(ring.coords, squares.polygons).fresh : 0;
    const freshInho = squares?.polygonsInho?.length ? countNewCells(ring.coords, squares.polygonsInho).fresh : 0;
    const scenic = getScenicScore(ring.coords, start, scenicSpots);

    return {
      brg, anchors, probe,
      probeKm: trackLengthKm(probe.geojson),
      ringCoords: ring.coords,
      splicedKm: ring.nubKm,
      ringKm: +ringCum[ringCum.length - 1].toFixed(2),
      // B2.1 — named wiki POIs ride the leg; the lattice keeps the corridor
      vias: viasThruScenic(leg1, start, scenicSpots, RING_VIA_STEP_KM),
      sparseVias: viasThruScenic(leg1, start, scenicSpots, RING_VIA_SPARSE_STEP_KM),
      fresh, freshInho, scenic,
      score: fresh * 10000 + freshInho * 10 + scenic * 100
    };
  };

  const gateFails = (doubledKm, driftKm) =>
    doubledKm > DOUBLED_TOL_KM || driftKm == null || Math.abs(driftKm) > PARITY_TOL_KM;
  const pointsOf = (vias) => [start, ...vias, ...stops];
  const degenerate = (pre, extra) => ({
    ok: false, result: { start, trackname, degenerate: true, probeKm: pre.probeKm, nubKm: pre.splicedKm, ...extra }
  });

  const deliver = async (pre, acceptAny = false) => {
    // Reject severely collapsed routes (they must retain most of their distance)
    if (!acceptAny && pre.ringKm < params.targetKm * RING_MIN_FACTOR) {
      return degenerate(pre, { collapsedKm: pre.ringKm });
    }
    if (pre.vias.length === 0) {
      return degenerate(pre, { previewUrl: buildPreviewUrl(pointsOf(pre.anchors), { profile }), b1Url: pre.probe.url });
    }

    const attempt = async (vias) => {
      let activeVias = vias;
      let delivery = await fetchCounted(pointsOf(activeVias), { plain: true, profile });
      let deliveryCoords = extractCoords(delivery.geojson);
      let deliveryKm = trackLengthKm(delivery.geojson);

      const stubs = stubVias(deliveryCoords, activeVias, start, new Set());
      if (stubs.length > 0) {
        activeVias = vias.filter((_, k) => !stubs.includes(k));
        delivery = await fetchCounted(pointsOf(activeVias), { plain: true, profile });
        deliveryCoords = extractCoords(delivery.geojson);
        deliveryKm = trackLengthKm(delivery.geojson);
        if (stubVias(deliveryCoords, activeVias, start, new Set()).length > 0) {
          return { ok: acceptAny, fail: { stubs: stubs.length }, activeVias, delivery, deliveryCoords, deliveryKm };
        }
      }

      const doubledKm = interiorDoubledKm(deliveryCoords, start);
      const driftKm = deliveryKm == null ? null : +(deliveryKm - pre.ringKm).toFixed(2);
      return {
        ok: acceptAny || !gateFails(doubledKm, driftKm),
        fail: { doubledKm, driftKm },
        activeVias, delivery, deliveryCoords, deliveryKm, doubledKm, driftKm,
      };
    };

    const useSparse = pre.sparseVias?.length > 0 && pre.sparseVias.length < pre.vias.length;
    const tries = useSparse ? [[pre.sparseVias, 'sparse'], [pre.vias, 'dense']] : [[pre.vias, 'dense']];
    let failed = null;

    for (const [vias, mode] of tries) {
      const att = await attempt(vias);
      if (att.ok) {
        const cells = hasSquares ? {
          ...countNewCells(att.deliveryCoords, squares.polygons),
          inho: squares.polygonsInho?.length ? countNewCells(att.deliveryCoords, squares.polygonsInho) : null,
        } : null;

        return { ok: true, result: {
          start, trackname,
          bearing: Math.round(((pre.brg % 360) + 360) % 360),
          measuredKm: att.deliveryKm,
          probeKm: pre.probeKm,
          ringKm: pre.ringKm,
          nubKm: pre.splicedKm,
          pois: poiKmList(att.deliveryCoords, start, att.activeVias),
          doubledKm: att.doubledKm,
          viaCount: att.activeVias.length,
          scenic: pre.scenic,
          pinMode: useSparse && mode === 'dense' ? 'dense-fallback' : mode,
          cells,
          aimedKm: null,
          bearingDeviation: null,
          previewUrl: buildPreviewUrl(pointsOf(att.activeVias), { profile }),
          b1Url: buildUrl(pointsOf(att.activeVias), { profile }),
          ...(gateFails(att.doubledKm, att.driftKm) ? { relaxed: true } : {}),
        }};
      }
      failed = att;
    }
    return degenerate(pre, {
      ...failed.fail,
      previewUrl: buildPreviewUrl(pointsOf(failed.activeVias), { profile }),
      b1Url: buildUrl(pointsOf(failed.activeVias), { profile }),
    });
  };

  // --- Pipeline Execution ---

  // 1. Determine distinct targets to test to avoid hitting the same barrier
  const targetsToTest = [];
  if (sector != null) {
    const fronts = hasSquares ? getDiverseFrontiers(start, squares.polygons, wanderKm, sector) : [];
    if (fronts.length > 0) {
      targetsToTest.push({ brg: fronts[0].bearingDeg, anchors: buildFrontierAnchors(start, fronts[0], wanderKm) });
    } else {
      targetsToTest.push({ brg: sector, anchors: null });
    }
    targetsToTest.push({ brg: ((sector - 30) % 360 + 360) % 360, anchors: null });
    targetsToTest.push({ brg: ((sector + 30) % 360 + 360) % 360, anchors: null });
  } else {
    const fronts = hasSquares ? getDiverseFrontiers(start, squares.polygons, wanderKm) : [];
    for (const f of fronts) {
      targetsToTest.push({ brg: f.bearingDeg, anchors: buildFrontierAnchors(start, f, wanderKm) });
    }
    // Pad to 3 if needed
    let base = fronts.length > 0 ? fronts[0].bearingDeg : (getScenicBearing(start, params.targetKm, scenicSpots) ?? BEARINGS.n);
    while (targetsToTest.length < 3) {
      base = (base + 120) % 360;
      targetsToTest.push({ brg: base, anchors: null });
    }
  }

  // 2. Probe and Score
  const probed = [];
  for (const t of targetsToTest.slice(0, 3)) {
    probed.push(await probeBearing(t.brg, t.anchors));
  }
  probed.sort((a, b) => b.score - a.score);

  // 3. Deliver best candidate
  let last = null;
  for (const pre of probed) {
    const r = await deliver(pre);
    if (r.ok) return r.result;
    last = r;
  }

  // 4. Relaxed Fallback
  const spare = probed.filter((c) => c.vias.length > 0).sort((a, b) => b.ringKm - a.ringKm);
  for (const pre of spare.slice(0, 2)) {
    const r = await deliver(pre, true);
    if (r.ok) return r.result;
    last = r;
  }
  return last.result;
}