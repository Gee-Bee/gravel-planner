// Etap C (first step): radial anchors for a lollipop ≈ D long (S→A→…→B→S).
// No frontier yet — straight radials from the start anchor (A4.8 approximation,
// frontier/ława selection lands later per A4.6–A4.8). Mechanized A5.3/A5.5 on
// the MEASURED geometry: spurs (there-and-back) re-anchor at their base,
// off-road anchors move onto the road actually ridden, and the wrap guard
// forces the tip loop around the FAR side of an impassable area — an inward
// dip of the tip means the router doubled the leg corridors (midline problem).

import { destination } from './geometry.js';

// Tip loop width: A–B chord, both anchors at the same radius (same level, so
// the router draws a loop — not an out-and-back spike with a nawrót at B).
export const LOOP_TIP_KM = 5;

// Road vs air inflation of a routed leg. Gravel-family samples (implied
// routed/air per leg): 1.39, 2.02, 1.51, 1.89 — no radius pattern, mostly
// routing noise; 1.7 is the sample mean. [HIPOTEZA] Stage D owns calibration:
// fetch → measure → adjust (D requested vs actual).
export const ROAD_INFLATION = 1.7;

// Spur detection: strands of a there-and-back ride the SAME road (< SPUR_EPS_KM
// apart); the anchor move itself is reported past SNAP_MAX_KM (echoes B1.4).
const SPUR_EPS_KM = 0.03;
const SPUR_WINDOW_KM = 0.15; // path-distance window excluded from self-distance
export const SNAP_MAX_KM = 0.8; // UI note threshold (echoes the B1.4 800 m flag)
const ON_ROUTE_KM = 0.05; // closer than this to the route = already on a road
// Via unambiguity (preview engines ignore the B1.4 flags and snap on their
// own): reject candidate vias with another route strand closer than this —
// parallel stubs are what preview routers jump onto, drawing a nawrót.
const AMBIGUOUS_KM = 0.12;
const AMBIGUITY_SEARCH_KM = 1.5; // how far along the track to look for a clean spot
// Wrap guard: the tip may approach the start to at most this fraction of the
// anchor radius (a clean chord sags ~2% at our α; a southern wrap dips far
// deeper — the router detoured around the obstacle's START-side end).
export const DIP_TOL_FACTOR = 0.75;
// Section probe (user-decided approach): a routed section much longer than its
// air line means the straight chord crosses an impassable area. Only sections
// of meaningful length are judged (short hops zigzag legitimately).
export const SECTION_RATIO_MAX = 1.5;
export const SECTION_MIN_AIR_KM = 2;

const KM_PER_DEG_LAT = 111.32;
const ANCHOR_LETTERS = 'ABCDEFGH';

/** Lollipop radius (air km) so routed legs ≈ r each and the total ≈ D. */
export function lollipopRadiusKm(targetKm) {
  return (targetKm - LOOP_TIP_KM) / (2 * ROAD_INFLATION);
}

/**
 * Anchors for S→A→B→S ≈ targetKm: legs r = lollipopRadiusKm(D), tip loop
 * between A and B at radius r, ±α around the bearing so the chord ≈
 * LOOP_TIP_KM (α ≤ 45° for tiny D). Radial approximation; the frontier cell
 * replaces A later (A4.8). Returns the anchors in route order.
 */
export function planAnchorsRadial(start, bearingDeg, targetKm) {
  const radiusKm = lollipopRadiusKm(targetKm);
  const halfChordKm = Math.min(LOOP_TIP_KM / 2, radiusKm * Math.SQRT1_2);
  const alphaDeg = (Math.asin(halfChordKm / radiusKm) * 180) / Math.PI;
  return [
    destination(start, bearingDeg - alphaDeg, radiusKm),
    destination(start, bearingDeg + alphaDeg, radiusKm),
  ];
}

// Equirectangular planar projection in km around a reference latitude — good
// to well under 1% at these distances.
function toPlanar(p, lat0) {
  const kx = KM_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
  return { x: p.lon * kx, y: p.lat * KM_PER_DEG_LAT };
}

function fromPlanar(q, kx) {
  return { lon: q.x / kx, lat: q.y / KM_PER_DEG_LAT };
}

// Polyline in planar km + cumulative path distance.
function measuredPath(routeCoords) {
  const coords = routeCoords ?? [];
  if (coords.length === 0) return null;
  const lat0 = coords[0][1];
  const kx = KM_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
  const pts = coords.map(([lon, lat]) => toPlanar({ lon, lat }, lat0));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  return { pts, cum, kx, lat0 };
}

function nearestIdx(path, q) {
  let tip = 0, tipD = Infinity;
  for (let i = 0; i < path.pts.length; i++) {
    const d = Math.hypot(path.pts[i].x - q.x, path.pts[i].y - q.y);
    if (d < tipD) { tipD = d; tip = i; }
  }
  return { tip, tipD };
}

// Nearest other-point distance outside the path window — the twin-strand
// probe. No index stride: out/return twins do not share parity, sampling
// every 2nd point skips them (measured on synthetic data).
function twinDistKm(path, i) {
  let best = Infinity;
  for (let j = 0; j < path.pts.length; j++) {
    if (Math.abs(path.cum[j] - path.cum[i]) < SPUR_WINDOW_KM) continue;
    const d = Math.hypot(path.pts[i].x - path.pts[j].x, path.pts[i].y - path.pts[j].y);
    if (d < best) best = d;
  }
  return best;
}

/**
 * A5.3/A5.5 mechanized — pure geometry on the measured route. An anchor whose
 * neighbourhood doubles back (spur) moves to the spur base; a spur-free anchor
 * off the road moves onto the road actually ridden (the B1.4 correction can
 * leave the via short of the road). Anchors are in route order; untouched
 * anchors keep identity. Returns { anchors, snapKm, despurred }.
 */
export function snapAnchorsToRoute(anchors, routeCoords) {
  const path = measuredPath(routeCoords);
  const out = { anchors: [...anchors], snapKm: 0, despurred: [] };
  if (!path || path.pts.length < 8) return out;

  const selfDist = path.pts.map((_, i) => twinDistKm(path, i));

  anchors.forEach((anchor, idx) => {
    const q = toPlanar(anchor, path.lat0);
    const { tip, tipD } = nearestIdx(path, q);
    // Spur = maximal run around the tip with a twin strand. NOTE: the spur tip
    // IS on the route (the router rides in and back out) — "distance to route
    // ≈ 0" cannot be read as "on a through road" before the spur check.
    let lo = tip, hi = tip;
    while (lo > 0 && selfDist[lo - 1] < SPUR_EPS_KM) lo--;
    while (hi < path.pts.length - 1 && selfDist[hi + 1] < SPUR_EPS_KM) hi++;
    if (hi - lo >= 4) {
      // Spur → anchor at its base (farthest run end); the corridor passes
      // there exactly once (A5.3).
      const endLo = Math.hypot(path.pts[lo].x - q.x, path.pts[lo].y - q.y);
      const endHi = Math.hypot(path.pts[hi].x - q.x, path.pts[hi].y - q.y);
      const baseIdx = endLo >= endHi ? lo : hi;
      out.anchors[idx] = fromPlanar(path.pts[baseIdx], path.kx);
      out.snapKm = Math.max(
        out.snapKm,
        Math.hypot(path.pts[baseIdx].x - q.x, path.pts[baseIdx].y - q.y),
      );
      out.despurred.push(ANCHOR_LETTERS[idx]);
      return;
    }
    if (tipD >= ON_ROUTE_KM) {
      out.anchors[idx] = fromPlanar(path.pts[tip], path.kx);
      out.snapKm = Math.max(out.snapKm, tipD);
    }
  });
  return out;
}

/**
 * C9 gate — twin-strand (there-and-back) probe at each anchor's nearest route
 * point. Returns the letters of anchors that still dead-end; empty = clean.
 */
export function spurAtAnchors(anchors, routeCoords) {
  const path = measuredPath(routeCoords);
  if (!path || path.pts.length < 8) return [];
  const out = [];
  anchors.forEach((anchor, idx) => {
    const q = toPlanar(anchor, path.lat0);
    const { tip } = nearestIdx(path, q);
    if (twinDistKm(path, tip) < SPUR_EPS_KM) out.push(ANCHOR_LETTERS[idx]);
  });
  return out;
}

/**
 * Wrap guard — how far the tip (route between the first and last anchor)
 * dips radially toward the start, in km beyond the tolerance; 0 = the tip
 * wraps AWAY from the start (clean). A deep dip means an impassable area
 * between the anchors pulled the connection to the START side, so the leg
 * corridors get ridden twice (A5.3 midline problem).
 */
export function tipWrapDip(anchors, routeCoords, start) {
  const path = measuredPath(routeCoords);
  if (!path || path.pts.length < 8 || anchors.length < 2) return 0;
  const sq = toPlanar(start, path.lat0);
  const radial = (p) => Math.hypot(p.x - sq.x, p.y - sq.y);
  const idxs = anchors.map((a) => nearestIdx(path, toPlanar(a, path.lat0)).tip);
  const lo = Math.min(...idxs), hi = Math.max(...idxs);
  const rRef = Math.min(...anchors.map((a) => radial(toPlanar(a, path.lat0))));
  let minTip = Infinity;
  for (let i = lo; i <= hi; i++) minTip = Math.min(minTip, radial(path.pts[i]));
  return Math.max(0, rRef * DIP_TOL_FACTOR - minTip);
}

/**
 * Section probe — routed/air ratio per stop-to-stop section of the measured
 * route (stops: S, then anchors in route order; section boundaries located by
 * nearest route point). A ratio > SECTION_RATIO_MAX on a long-enough section
 * means the straight chord crosses an impassable area (user-decided probe).
 * Returns { sections, blocked } with blocked as "X→Y" names.
 */
export function analyzeSections(anchors, routeCoords, start) {
  const path = measuredPath(routeCoords);
  if (!path || path.pts.length < 8) return { sections: [], blocked: [] };
  const names = ['S', ...anchors.map((_, i) => ANCHOR_LETTERS[i])];
  const stops = [toPlanar(start, path.lat0), ...anchors.map((a) => toPlanar(a, path.lat0))];
  const idxs = stops.map((q) => nearestIdx(path, q).tip);
  const sections = [];
  for (let k = 0; k < idxs.length - 1; k++) {
    const routedKm = path.cum[idxs[k + 1]] - path.cum[idxs[k]];
    const airKm = Math.hypot(stops[k + 1].x - stops[k].x, stops[k + 1].y - stops[k].y);
    sections.push({
      from: names[k],
      to: names[k + 1],
      routedKm,
      airKm,
      ratio: airKm > 0 ? routedKm / airKm : Infinity,
    });
  }
  const blocked = sections
    .filter((s) => s.airKm >= SECTION_MIN_AIR_KM && s.ratio > SECTION_RATIO_MAX)
    .map((s) => `${s.from}→${s.to}`);
  return { sections, blocked };
}

/**
 * Moves each anchor to the nearest UNAMBIGUOUS point of the measured route:
 * within ±AMBIGUITY_SEARCH_KM of path distance, the point whose neighbourhood
 * holds no other route strand. Preview engines (bikerouter, no B1.4 flags)
 * snap such vias without detours. Returns { anchors, moved }.
 */
export function unambiguousAnchors(anchors, routeCoords) {
  const path = measuredPath(routeCoords);
  const out = { anchors: [...anchors], moved: [] };
  if (!path || path.pts.length < 8) return out;
  const clean = (i) => twinDistKm(path, i) >= AMBIGUOUS_KM;
  anchors.forEach((anchor, idx) => {
    const q = toPlanar(anchor, path.lat0);
    const { tip } = nearestIdx(path, q);
    if (clean(tip)) return; // keep identity
    let best = null;
    for (let i = 0; i < path.pts.length; i++) {
      if (Math.abs(path.cum[i] - path.cum[tip]) > AMBIGUITY_SEARCH_KM) continue;
      const d = Math.hypot(path.pts[i].x - q.x, path.pts[i].y - q.y);
      const score = clean(i) ? -d : twinDistKm(path, i) - d / 10;
      if (!best || score > best.score) best = { i, score };
    }
    if (!best) return;
    out.anchors[idx] = fromPlanar(path.pts[best.i], path.kx);
    out.moved.push(ANCHOR_LETTERS[idx]);
  });
  return out;
}
