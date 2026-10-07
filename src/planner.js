// Planning pipeline v7.1 — deliver the engine's own ring, pinned by vias.
// A via at or past an impassable band makes the engine ride a there-and-back
// finger (measured on the Biedrusko probe: the loop S→A₀→B₀→S itself doubles
// its A→B section; a single via near the band lands on a dead-end road and
// renders as a nawrót). No anchor choice can predict the engine's approach.
// So: probe the loop, splice any doubled finger out of the probe geometry,
// then pin the spliced ring with vias every ~RING_VIA_STEP_KM (all cut from
// the geometry the engine itself rode) and re-route. The delivery follows the
// ring by construction; a plain-engine verify gate (same engine as preview —
// the flagged URL routes differently, measured 43.9 vs 44.3 km) rejects any
// doubled strands or gross length drift before the route is handed out.

import { LOOP_TIP_KM, ROAD_INFLATION, planAnchorsRadial } from './planning.js';
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
import {
  buildUrl,
  fetchRouteGeojson,
  trackLengthKm,
  extractCoords,
  buildPreviewUrl,
} from './api/brouter.js';

// Placeholder compass bearings until frontier selection (Etap B/C) exists.
const BEARINGS = Object.freeze({ n: 0, e: 90, s: 180, w: 270 });

// Twin-strand probe: a strand closer than TWIN_EPS_KM to another strand more
// than TWIN_WINDOW_KM of path away shares its road with a distant pass (a
// there-and-back finger).
const TWIN_WINDOW_KM = 1.0;
const TWIN_EPS_KM = 0.04;
// Spike probe: a strand nearly touching another strand 0.25–1.2 km of path
// away — up/down passes of a SHORT out-and-back (their Δpath at the base is
// < 1 km, invisible to the twin window; measured on the B-via delivery).
const SPIKE_MIN_PATH_KM = 0.25;
const SPIKE_MAX_PATH_KM = 1.2;
const SPIKE_EPS_KM = 0.15;
const TWIN_MIN_RUN_KM = 0.2;
// A finger's up- and down-passes merge across the turnaround arc.
const MERGE_GAP_KM = 3.0;
// Start/end approach may share roads — the loop leaves and returns via S.
// The shared stem grows with the route (measured D=80: 3.5 km out, 3.4 km
// back on the home street; 2.5 km was enough at D=50), so the exempt zone
// scales with the track length, capped so the gate keeps teeth on long routes.
const SAFE_END_KM = 2.5;
const SAFE_END_FRACTION = 0.06;
const SAFE_END_MAX_KM = 6;
// Ring pins: one via about every step of path, all on engine-ridden roads.
const RING_VIA_STEP_KM = 1.8;
// Via stubs: a via at the tip of a short dead-end branch makes the engine
// ride in and back out — two passes 0.3–3 km of path apart, same spot.
const STUB_MIN_PATH_KM = 0.3;
const STUB_MAX_PATH_KM = 3.0;
const STUB_EPS_KM = 0.12;
const STUB_VIA_MAX_KM = 0.3;
// Delivery length must track the ring (between-via shortcuts shave, spurs
// add; gross drift means the engine left the ring).
const PARITY_TOL_KM = 3;
// Small doubling residue is structural or a minor dead-end the engine
// insists on: the home approach past the safe-end zone, junction touches,
// or a short there-and-back between vias no via sits on (measured E@D=50:
// best candidate 1.89 km = 0.9 stem + 1.0 dead-end; the other bearings
// double 11–19 km). Gross corridor doubling stays fatal; accepted residue
// is reported in the route note.
const DOUBLED_TOL_KM = 2;
// A usable ring is at least half the target: a probe that mostly rides
// there-and-back collapses to a stub when spliced (measured D=80 W: 67 km
// probe, 62 km one doubled run → 5 km ring → a 3.7 km "route" the gate
// cannot see, it sits inside the safe-end zones).
const RING_MIN_FACTOR = 0.5;
// Frontier reach: a D-route can touch a frontier up to ~D/2 out (leg there
// still leaves room for the loop); 1.4× slack for the closing leg.
const FRONTIER_REACH = 1.4;

// Fetch budget: auto+quares probes 5 bearings then delivers up to 3 ranked
// rings (+1 stub retry each); manual/no-squares stays within the old 4.
const MAX_FETCHES = 9;

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

/**
 * Contiguous interior runs of doubled strands on the measured track:
 * [{ i0, i1, km }]. A point is doubled when the twin OR the spike probe fires
 * (union covers long fingers and short out-and-backs alike). End zones
 * (±SAFE_END_KM) are exempt — leaving/returning via S shares the approach.
 */
export function nubRuns(coords, start) {
  if (!coords || coords.length < 8) return [];
  const { P, cum } = planar(coords, start);
  const total = cum[cum.length - 1];
  const safeEnd = Math.max(SAFE_END_KM, Math.min(total * SAFE_END_FRACTION, SAFE_END_MAX_KM));
  const doubled = P.map((_, i) => {
    if (cum[i] < safeEnd || total - cum[i] < safeEnd) return false;
    let twin = Infinity, spike = Infinity;
    for (let j = 0; j < P.length; j++) {
      const dp = Math.abs(cum[j] - cum[i]);
      if (dp < SPIKE_MIN_PATH_KM) continue;
      const d = Math.hypot(P[i].x - P[j].x, P[i].y - P[j].y);
      if (dp > TWIN_WINDOW_KM && d < twin) twin = d;
      if (dp <= SPIKE_MAX_PATH_KM && d < spike) spike = d;
    }
    return twin < TWIN_EPS_KM || spike < SPIKE_EPS_KM;
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

/** Summed length of doubled interior runs — the verify gate on a delivery. */
export function interiorDoubledKm(coords, start) {
  return +nubRuns(coords, start).reduce((s, r) => s + r.km, 0).toFixed(2);
}

/**
 * Remove the doubled fingers from probe geometry: drop EVERY merged run and
 * reconnect each at its fork (~0 m away — run boundaries sit ON the
 * duplicated fork points, so both ends must be trimmed). A leftover run gets
 * vias pinned on it and the delivery rides the doubled strand (measured D=80:
 * a probe with 12.9 km of doubling spliced 11.9 left 1 km in the ring — the
 * gate rejected every candidate). Returns { coords, junctionIdx, nubKm } —
 * junctionIdx is the first fork's index in the NEW array, null when the
 * probe was clean.
 */
export function spliceNub(coords, start) {
  const runs = nubRuns(coords, start);
  if (runs.length === 0) return { coords, junctionIdx: null, nubKm: 0 };
  const { cum } = planar(coords, start);
  const next = [];
  let keep = 0;
  for (const r of runs) {
    for (let i = keep; i < r.i0; i++) next.push(coords[i]);
    keep = r.i1 + 1;
  }
  for (let i = keep; i < coords.length; i++) next.push(coords[i]);
  return {
    coords: next,
    junctionIdx: runs[0].i0 - 1,
    nubKm: +runs.reduce((s, r) => s + cum[r.i1] - cum[r.i0], 0).toFixed(2),
  };
}

/**
 * Pin vias for the delivery: ring indexes spaced ≥ stepKm of path apart, cut
 * from the geometry the engine itself rode (no interpolation, no floats).
 * First/last interior points stay ≥ stepKm from S — the approach is S's own.
 */
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

/** ringVias convenience wrapper returning points. */
export function ringVias(ringCoords, start, stepKm = RING_VIA_STEP_KM) {
  const { P, kx } = planar(ringCoords ?? [], start);
  return ringViasIdx(ringCoords, start, stepKm).map((i) => ({
    lon: start.lon + P[i].x / kx,
    lat: start.lat + P[i].y / KLAT,
  }));
}

/**
 * Via stubs: turn-around bases in the delivery — two passes 0.3–3 km of path
 * apart returning to the same spot (< STUB_EPS_KM). A via pinned on the tip
 * of a short dead-end branch the ring itself rode makes the engine ride in
 * and back out (measured micro-stubs at vias B and N). Vias whose index is
 * in `exempt` (inside the kept apex finger) are ignored. Returns the via
 * indexes (0-based, route order) sitting AT the stub tip.
 */
export function stubVias(deliveryCoords, vias, start, exempt = new Set()) {
  const coords = deliveryCoords ?? [];
  if (coords.length < 8 || vias.length === 0) return [];
  const { P, cum } = planar(coords, start);
  const total = cum[cum.length - 1];
  const safeEnd = Math.max(SAFE_END_KM, Math.min(total * SAFE_END_FRACTION, SAFE_END_MAX_KM));
  const tipIdx = new Set();
  for (let i = 0; i < P.length; i++) {
    if (cum[i] < safeEnd || total - cum[i] < safeEnd) continue;
    for (let j = i + 1; j < P.length; j++) {
      const dp = cum[j] - cum[i];
      if (dp > STUB_MAX_PATH_KM) break;
      if (dp < STUB_MIN_PATH_KM) continue;
      if (Math.hypot(P[i].x - P[j].x, P[i].y - P[j].y) < STUB_EPS_KM) {
        // The tip is the FARTHER pass; its via is the one nearest it.
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

/**
 * README B→C — bearing at the NEAREST frontier cell (A4.8): visited cells in
 * a local bbox around the start → frontier → nearest cell by air distance.
 * `sector` narrows the search to bearing ±45° — a manual N/E/S/W constraint
 * still aims at fresh squares, just inside its own quadrant (null = no
 * squares data, no frontier in the sector → the bearing itself decides).
 */
export function aimAtFrontier(start, polygons, targetKm, sector = null) {
  const bbox = bboxAroundKm(start, (targetKm / 2) * FRONTIER_REACH);
  const visited = visitedCellsInBbox(polygons, bbox);
  if (visited.size === 0) return null;
  let best = null;
  for (const key of computeFrontier(visited, bbox)) {
    const [i, j] = key.split(':').map(Number);
    const c = cellCenter(i, j);
    const d = distanceKm(start, c);
    if (sector != null) {
      let dev = Math.abs(((bearingDeg(start, c) - sector + 540) % 360) - 180);
      if (dev > 45) continue;
    }
    if (!best || d < best.dKm) best = { dKm: d, bearing: bearingDeg(start, c), cell: c };
  }
  return best && {
    dKm: +best.dKm.toFixed(1),
    bearingDeg: +(((best.bearing + 360) % 360)).toFixed(1),
    cell: best.cell,
  };
}

/**
 * A4.7/A4.9 anchors: A₀ = the nearest frontier cell itself, B₀ = the same
 * bearing deeper (chord tuned so legs+tip ≈ D) — the tip loop CROSSES the
 * unvisited ława. Radial lollipops cannot: the engine hugs already-ridden
 * roads (measured — 5 probes around the aim, all fresh=0).
 */
export function frontierAnchors(start, polygons, targetKm, sector = null) {
  const aim = aimAtFrontier(start, polygons, targetKm, sector);
  if (!aim) return null;
  const chordKm = Math.max(LOOP_TIP_KM, targetKm / (2 * ROAD_INFLATION) - aim.dKm);
  return {
    ...aim,
    chordKm: +chordKm.toFixed(1),
    anchors: [aim.cell, destination(aim.cell, aim.bearingDeg, chordKm)],
  };
}

export async function planRoutes(params) {
  const start = params.start;
  if (!start) throw new Error('no start — save the config YAML first');
  // B5: the riding profile (uploaded .brf) decides the roads — probe, ring and
  // delivery all optimize with the SAME cost function the user rides with;
  // stock gravel is only the upload-failure fallback.
  const profile = params.profile ?? PROFILE;
  const trackname = `gravel-D${params.targetKm}`;
  // A bearing (auto or manual) aims at the NEAREST frontier cell — auto in
  // the full circle, manual inside its ±45° quadrant; no squares → aim null
  // (auto falls back to N, README: same algorithm, visits just ignored).
  const squares = params.squares;
  const manual = params.bearingKey && params.bearingKey !== 'auto';
  const sector = manual ? BEARINGS[params.bearingKey] ?? BEARINGS.n : null;
  const hasSquares = !!squares?.polygons?.length;
  const aim = hasSquares
    ? aimAtFrontier(start, squares.polygons, params.targetKm, sector)
    : null;

  let fetches = 0;
  const fetchCounted = async (pts, opts = {}) => {
    if (++fetches > MAX_FETCHES) throw new Error('fetch budget exceeded (§0.4)');
    return fetchRouteGeojson(pts, { trackname, ...opts });
  };

  // Probe ONE bearing: the engine's own loop attempt (plain), spliced to the
  // clean ring. `targets` overrides the radial anchors (frontier lollipop,
  // A4.9). Radius rescaling does NOT calibrate ring length (measured D=50,
  // ×1.14: the nub grows faster than the ring and a second nub appears).
  const probeBearing = async (brg, targets = null) => {
    const anchors = targets ?? planAnchorsRadial(start, brg, params.targetKm);
    const probe = await fetchCounted([start, ...anchors, start], { plain: true, profile });
    const probeCoords = extractCoords(probe.geojson);
    const ring = spliceNub(probeCoords, start);
    const { cum: ringCum } = planar(ring.coords, start);
    const vias = ringViasIdx(ring.coords, start).map((i) => {
      const [lon, lat] = ring.coords[i];
      return { lon, lat };
    });
    return {
      brg,
      anchors,
      probe,
      probeKm: trackLengthKm(probe.geojson),
      ringCoords: ring.coords,
      splicedKm: ring.nubKm,
      ringKm: +ringCum[ringCum.length - 1].toFixed(2),
      vias,
      // Ranking signal: fresh cells on the spliced ring (A3 — max nowych);
      // fine-grid fresh is the tiebreak (coarse ties are common near the union).
      fresh: squares?.polygons?.length
        ? countNewCells(ring.coords, squares.polygons).fresh
        : null,
      freshInho: squares?.polygonsInho?.length
        ? countNewCells(ring.coords, squares.polygonsInho).fresh
        : null,
    };
  };

  const degenerate = (pre, extra) => ({ ok: false, result: {
    start,
    trackname,
    degenerate: true,
    probeKm: pre.probeKm,
    nubKm: pre.splicedKm,
    ...extra,
  } });

  // Deliver a probed ring: pin vias, verify no doubled strands and ring
  // parity; drop via stubs (dead-end tips) and retry once. ok=false = the
  // verify gate rejected it (the engine, not the map, decides rideability).
  const deliver = async (pre) => {

    if (pre.ringKm < params.targetKm * RING_MIN_FACTOR) {
      return degenerate(pre, { collapsedKm: pre.ringKm });
    }

    if (pre.vias.length === 0) {
      return degenerate(pre, {
        previewUrl: buildPreviewUrl([start, ...pre.anchors, start]),
        b1Url: pre.probe.url,
      });
    }

    // Delivery (plain = the preview engine's routing): verify no doubled
    // strands and ring parity; drop via stubs (dead-end tips) and retry once.
    let activeVias = pre.vias;
    let delivery = await fetchCounted([start, ...activeVias, start], { plain: true, profile });
    let deliveryCoords = extractCoords(delivery.geojson);
    let deliveryKm = trackLengthKm(delivery.geojson);
    const stubs = stubVias(deliveryCoords, activeVias, start, new Set());
    if (stubs.length > 0) {
      activeVias = pre.vias.filter((_, k) => !stubs.includes(k));
      delivery = await fetchCounted([start, ...activeVias, start], { plain: true, profile });
      deliveryCoords = extractCoords(delivery.geojson);
      deliveryKm = trackLengthKm(delivery.geojson);
      if (stubVias(deliveryCoords, activeVias, start, new Set()).length > 0) {
        return degenerate(pre, {
          stubs: stubs.length,
          previewUrl: buildPreviewUrl([start, ...activeVias, start]),
          b1Url: delivery.url,
        });
      }
    }
    const doubledKm = interiorDoubledKm(deliveryCoords, start);
    const driftKm = deliveryKm == null ? null : +(deliveryKm - pre.ringKm).toFixed(2);
    if (doubledKm > DOUBLED_TOL_KM || driftKm == null || Math.abs(driftKm) > PARITY_TOL_KM) {
      return degenerate(pre, {
        doubledKm,
        driftKm,
        previewUrl: buildPreviewUrl([start, ...activeVias, start]),
        b1Url: buildUrl([start, ...activeVias, start], { profile }),
      });
    }

    // Squares report (optional): coarse grid drives the aim, the fine grid
    // (squadratinhos) rides along in the report — a ring can pick zero new
    // squadrats yet still cut fresh squadratinhos (measured: 0 new / 12 inho).
    const cells = squares?.polygons?.length
      ? {
          ...countNewCells(deliveryCoords, squares.polygons),
          inho: squares.polygonsInho?.length
            ? countNewCells(deliveryCoords, squares.polygonsInho)
            : null,
        }
      : null;

    return { ok: true, result: {
      start,
      trackname,
      bearing: Math.round(((pre.brg % 360) + 360) % 360),
      measuredKm: deliveryKm,
      probeKm: pre.probeKm,
      ringKm: pre.ringKm,
      nubKm: pre.splicedKm,
      doubledKm,
      viaCount: activeVias.length,
      cells,
      aimedKm: aim ? aim.dKm : null,
      bearingDeviation: aim ? Math.round(pre.brg - aim.bearingDeg) : null,
      previewUrl: buildPreviewUrl([start, ...activeVias, start]),
      // Backend link with the B1.4 flags — built, not fetched (the flagged
      // engine routes differently than the preview; verified on plain above).
      b1Url: buildUrl([start, ...activeVias, start], { profile }),
    } };
  };

  // Frontier lollipop FIRST (A4.9: the leg goes straight to the frontier —
  // radial probes hug ridden roads, measured fresh=0); accepted when it
  // picks anything new. Fallback: radial probes (auto: around the aim or the
  // 4 compass points; manual: its ±45° sector; no squares manual: the plain
  // direction fan — a single shot fails the gate for 3 of 4 directions at
  // D=80, measured) ranked by fresh cells, delivered until the gate passes
  // one. Auto without squares = N only — same algorithm, visits ignored.
  const frontier = hasSquares
    ? frontierAnchors(start, squares.polygons, params.targetKm, sector)
    : null;
  let last = null;
  if (frontier) {
    const r = await deliver(await probeBearing(frontier.bearingDeg, frontier.anchors));
    if (r.ok && ((r.result.cells?.fresh ?? 0) > 0 || (r.result.cells?.inho?.fresh ?? 0) > 0)) return r.result;
    last = r;
  }
  const manualBrg = sector ?? BEARINGS.n;
  const bearings = manual
    ? [manualBrg, manualBrg - 45, manualBrg + 45]
    : frontier
      ? [aim.bearingDeg - 45, aim.bearingDeg + 45]
      : hasSquares
        ? [...new Set([aim ? aim.bearingDeg : null, 0, 90, 180, 270].filter((b) => b != null))]
        : [BEARINGS.n];
  const probed = [];
  for (const brg of bearings) probed.push(await probeBearing(brg));
  probed.sort(
    (a, b) => (b.fresh ?? 0) - (a.fresh ?? 0) || (b.freshInho ?? 0) - (a.freshInho ?? 0),
  );
  for (const pre of probed.slice(0, frontier ? 2 : 3)) {
    const r = await deliver(pre);
    if (r.ok) return r.result;
    last = r;
  }
  return last.result;
}
