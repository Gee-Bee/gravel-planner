// Entry: form (D [km] + start) → planner; errors shown verbatim (§0.3).
// Start points come from the private YAML config (localStorage, src/config.js);
// without it the app asks for a paste and planning stays disabled.
// Squares (optional): a non-empty uid enables them; "Fetch squares" pulls
// the trophy GeoJSON (A4.1) eagerly so the state is ready for planning.

import { planRoutes } from './planner.js';
import { fetchSquadratsGeojson } from './api/squadrats.js';
import { parseVisitedPolygons } from './squares.js';
import { loadUid, saveUid } from './storage.js';
import { EXAMPLE_YAML, getConfig, loadConfigRaw, saveConfigYaml } from './config.js';
// §0.3 note: a BRouter/Squadrats fetch reports its exact URL on error.
import Route from 'lucide/route';

const form = document.getElementById('planner-form');
const planBtn = document.getElementById('plan-btn');
const statusEl = document.getElementById('status');
const uidEl = document.getElementById('uid');
const fetchSquaresBtn = document.getElementById('fetch-squares');
const squaresInfoEl = document.getElementById('squares-info');
const startEl = document.getElementById('start');
const configDetailsEl = document.getElementById('config-details');
const configYamlEl = document.getElementById('config-yaml');
const saveConfigBtn = document.getElementById('save-config');
const configStatusEl = document.getElementById('config-status');

mountHeaderIcon(Route);

// Squares state — empty until a uid fetch succeeds; the planner reads it (Etap B/C).
// Both grids ride along: squadrats (coarse, aiming) + squadratinhos (fine report).
const squaresState = { uid: '', polygons: [], declaredSize: null, polygonsInho: [], declaredSizeInho: null };

// Start points + optional squares_uid — parsed from the private YAML
// (localStorage); never in the repo.
const cfg = getConfig();
let starts = cfg.starts;

// uid: the field (localStorage) wins; squares_uid from the YAML fills an empty
// store ONCE — afterwards the store rules (removing squares_uid from the YAML
// later doesn't log this browser out of its squares; clearing the field keeps
// squares off until the next reload, when the YAML prefills it again).
uidEl.value = loadUid();
if (!uidEl.value && cfg.uid) {
  uidEl.value = cfg.uid;
  saveUid(cfg.uid);
}
if (uidEl.value) void fetchSquares(false);

configYamlEl.value = loadConfigRaw() || EXAMPLE_YAML;
applyStarts();

uidEl.addEventListener('change', () => {
  saveUid(uidEl.value.trim());
  uidEl.value = uidEl.value.trim();
  if (squaresState.uid && squaresState.uid !== uidEl.value) {
    squaresState.uid = '';
    squaresState.polygons = [];
    squaresState.declaredSize = null;
    squaresState.polygonsInho = [];
    squaresState.declaredSizeInho = null;
    setSquaresInfo('');
  }
  if (uidEl.value) void fetchSquares(false);
});

// Explicit click = force a fresh download (cache per uid, 24 h, only spares reloads).
fetchSquaresBtn.addEventListener('click', () => void fetchSquares(true));

function applyStarts() {
  const prev = startEl.value;
  startEl.replaceChildren(
    ...Object.entries(starts).map(([key, s]) => new Option(s.label, key)),
  );
  if (starts[prev]) startEl.value = prev;
  const none = !startEl.options.length;
  planBtn.disabled = none;
  configDetailsEl.open ||= none;
  if (none) setStatus('No start points yet — paste the config YAML below and save it.', true);
  else setStatus('');
}

saveConfigBtn.addEventListener('click', () => {
  try {
    const cfg = saveConfigYaml(configYamlEl.value);
    starts = cfg.starts;
    applyStarts();
    if (cfg.uid && !uidEl.value.trim()) {
      uidEl.value = cfg.uid;
      saveUid(cfg.uid);
      void fetchSquares(false);
    }
    const names = Object.values(starts).map((s) => s.label).join(', ');
    setConfigStatus(`Saved: ${Object.keys(starts).length} start(s) — ${names}.`);
  } catch (err) {
    setConfigStatus(err.message, true);
  }
});

async function fetchSquares(fresh = false) {
  const uid = uidEl.value.trim();
  fetchSquaresBtn.disabled = true;
  setSquaresInfo('Fetching squares…');
  try {
    const { geojson, timestamp } = await fetchSquadratsGeojson(uid, { fresh });
    const parsed = parseVisitedPolygons(geojson);
    const parsedInho = parseVisitedPolygons(geojson, 'squadratinhos');
    if (!parsed) {
      setSquaresInfo('Trophy has no "squadrats" MultiPolygon — update the uid?', true);
      return;
    }
    Object.assign(squaresState, {
      uid,
      ...parsed,
      polygonsInho: parsedInho?.polygons ?? [],
      declaredSizeInho: parsedInho?.declaredSize ?? null,
    });
    const age = timestamp ? ` — data z ${new Date(timestamp).toLocaleDateString('pl-PL')}` : '';
    setSquaresInfo(
      `Squares loaded: ${parsed.declaredSize ?? '?'} squadrats` +
        (parsedInho ? ` + ${parsedInho.declaredSize ?? '?'} squadratinhos` : '') +
        `, ${parsed.polygons.length} polygons${age}.`,
    );
  } catch (err) {
    console.error(err);
    // HttpError carries the exact URL — shown as-is, no retry (§0.3).
    setSquaresInfo(err.name === 'HttpError' ? err.message : `Error: ${err.message}`, true);
  } finally {
    fetchSquaresBtn.disabled = false;
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const targetKm = Number(document.getElementById('target-km').value);
  const startKey = startEl.value;
  const bearingKey = document.getElementById('bearing').value;

  setStatus('Planning…');
  planBtn.disabled = true;
  try {
    const result = await planRoutes({ targetKm, start: starts[startKey], bearingKey, squares: { ...squaresState } });
    if (result.degenerate) {
      const why = result.collapsedKm != null
        ? `probe collapsed to a ${result.collapsedKm} km ring (mostly out-and-back) — pick another bearing`
        : result.doubledKm > 0
          ? `delivery doubles ${result.doubledKm} km of road — pick another bearing`
          : result.driftKm != null
            ? `delivery left the ring (${result.driftKm > 0 ? '+' : ''}${result.driftKm} km) — pick another bearing`
            : result.stubs
              ? `delivery keeps ${result.stubs} dead-end stub${result.stubs > 1 ? 's' : ''} — pick another bearing`
              : 'no usable ring from the probe — pick another bearing';
      setStatus(why, true);
      return;
    }
    const { trackname, measuredKm, nubKm, viaCount, cells, aimedKm, bearing, bearingDeviation, previewUrl } = result;
    const note = [
      nubKm > 0 ? `finger ${nubKm} km spliced` : 'clean probe',
      result.doubledKm > 0 ? `${result.doubledKm} km dead-end doubling kept` : null,
      `${viaCount} ring vias`,
      bearing != null ? `bearing ${bearing}°${bearingDeviation ? ` (${bearingDeviation > 0 ? '+' : ''}${bearingDeviation}° retry)` : ''}` : null,
      aimedKm != null ? `frontier ${aimedKm} km` : null,
      cells
        ? `squares ${cells.fresh} new / ${cells.touched} touched` +
          (cells.visited ? ` (${cells.visited} re-visited)` : '') +
          (cells.inho ? ` · squadratinhos ${cells.inho.fresh} new / ${cells.inho.touched} touched` : '')
        : null,
    ].filter(Boolean).join(', ');
    renderPreview(`${trackname} — ${measuredKm?.toFixed(1) ?? '?'} km [${note}]`, previewUrl);
  } catch (err) {
    console.error(err);
    // HttpError carries the exact URL — shown as-is, no retry (§0.3).
    setStatus(err.name === 'HttpError' ? err.message : `Error: ${err.message}`, true);
  } finally {
    planBtn.disabled = false;
  }
});

// Bikerouter link + dev squares map (route preloaded via hash) in the status
// line; both open in a new tab (B3).
function renderPreview(trackname, url) {
  statusEl.replaceChildren();
  statusEl.classList.remove('error');
  statusEl.append(`${trackname} — `);
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = 'open in bikerouter';
  statusEl.append(a);
  statusEl.append(' · ');
  const m = document.createElement('a');
  m.href = `map.html#${url}`;
  m.target = '_blank';
  m.rel = 'noopener noreferrer';
  m.textContent = 'squares map';
  statusEl.append(m);
}

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('error', isError);
}

function setSquaresInfo(msg, isError = false) {
  squaresInfoEl.textContent = msg;
  squaresInfoEl.classList.toggle('error', isError);
}

function setConfigStatus(msg, isError = false) {
  configStatusEl.textContent = msg;
  configStatusEl.classList.toggle('error', isError);
}

// lucide icon node → inline SVG; same shape as the static favicon in index.html.
function mountHeaderIcon(node) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const [tag, attrs] of node) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    svg.appendChild(el);
  }
  document.querySelector('header.app-header h1').prepend(svg);
}
