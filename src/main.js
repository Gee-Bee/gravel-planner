// Entry: form (D [km] + start) → planner; errors shown verbatim (§0.3).
// Start points come from the private YAML config (localStorage, src/config.js).
// The Configuration section is a live editor of that config: an ordered point
// list (add / remove / drag to reorder / uncheck) that mirrors every change
// into the YAML textarea and auto-saves; hand-edited YAML applies on demand.
// Squares (optional): a non-empty uid enables them; "Fetch squares" pulls the
// trophy GeoJSON (A4.1) eagerly so the state is ready for planning.

import { planRoutes } from './planner.js';
import { fetchSquadratsGeojson } from './api/squadrats.js';
import { parseVisitedPolygons } from './squares.js';
import { loadUid, saveUid } from './storage.js';
import { getRidingProfileId } from './profile.js';
import { PROFILE } from './constants.js';
import {
  EXAMPLE_YAML,
  getConfig,
  loadConfigRaw,
  parseConfigYaml,
  parseCoordsText,
  saveConfigYaml,
  serializeConfigYaml,
} from './config.js';
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
const poisEditorEl = document.getElementById('pois-editor');
const addPoiBtn = document.getElementById('add-poi');
const poiRowTpl = document.getElementById('poi-row-tpl');

mountHeaderIcon(Route);

// Squares state — empty until a uid fetch succeeds; the planner reads it (Etap B/C).
// Both grids ride along: squadrats (coarse, aiming) + squadratinhos (fine report).
const squaresState = { uid: '', polygons: [], declaredSize: null, polygonsInho: [], declaredSizeInho: null };

// Start points + optional squares_uid — parsed from the private YAML
// (localStorage); never in the repo. Ordered list: order matters (drag).
const cfg = getConfig();
let points = cfg.starts;

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
renderRows();
applyStarts();

// Mirror the uid store into the YAML once (squares_uid) when they differ —
// e.g. the uid was typed before the first config was saved.
if (points.length && uidEl.value.trim() !== cfg.uid) syncFormToYaml();

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
  // squares_uid syncs into the YAML after it has been obtained/changed; an
  // empty field keeps the YAML's uid (clearing the field = squares off only).
  if (points.length) syncFormToYaml();
});

// Explicit click = force a fresh download (cache per uid, 24 h, only spares reloads).
fetchSquaresBtn.addEventListener('click', () => void fetchSquares(true));

function applyStarts() {
  const prev = startEl.value === '' ? null : points[+startEl.value];
  const enabled = points.map((p, i) => ({ p, i })).filter(({ p }) => p.enabled);
  startEl.replaceChildren(...enabled.map(({ p, i }) => new Option(p.label, String(i))));
  const sel = enabled.find(({ p }) => p === prev) ?? enabled[0];
  if (sel) startEl.value = String(sel.i);
  const none = !enabled.length;
  planBtn.disabled = none;
  configDetailsEl.open ||= none;
  if (none) {
    setStatus(points.length
      ? 'All points are unchecked — tick one in Configuration to plan.'
      : 'No start points yet — add one in Configuration below.', true);
  } else {
    setStatus('');
  }
}

// ---- Configuration form: the point list is the editor, the YAML mirrors it ----

function poiRowEl(p = {}) {
  const row = poiRowTpl.content.firstElementChild.cloneNode(true);
  row.querySelector('.poi-label').value = p.label ?? '';
  row.querySelector('.poi-coords').value = p.lon != null && p.lat != null ? `${p.lon}, ${p.lat}` : '';
  row.querySelector('.poi-enabled').checked = p.enabled !== false;
  row.classList.toggle('off', p.enabled === false);
  return row;
}

function renderRows() {
  poisEditorEl.replaceChildren(...points.map(poiRowEl));
}

function readPointsFromForm() {
  return [...poisEditorEl.querySelectorAll('.poi-row')].map((row) => {
    const coords = parseCoordsText(row.querySelector('.poi-coords').value);
    return {
      label: row.querySelector('.poi-label').value.trim(),
      lon: coords?.lon ?? null,
      lat: coords?.lat ?? null,
      enabled: row.querySelector('.poi-enabled').checked,
    };
  });
}

function yamlUid() {
  try {
    return parseConfigYaml(configYamlEl.value).uid;
  } catch {
    return '';
  }
}

// Form → YAML: serialize, auto-save, refresh the select. Incomplete rows skip
// the save (the old config stays put) and only report — the YAML textarea
// keeps mirroring valid states. A cleared uid field preserves the YAML's own
// squares_uid (clearing the field means squares off, not uid removal).
function syncFormToYaml() {
  const pts = readPointsFromForm();
  const valid = pts.length > 0 && pts.every((p) => p.lon != null && p.lat != null);
  if (!valid) {
    setConfigStatus(pts.length
      ? 'Incomplete coordinates (lon, lat) — the point is not saved yet.'
      : 'No points — add at least one; nothing saved.', true);
    return;
  }
  const yaml = serializeConfigYaml({ uid: uidEl.value.trim() || yamlUid(), points: pts });
  configYamlEl.value = yaml;
  try {
    saveConfigYaml(yaml);
    points = parseConfigYaml(yaml).starts;
    applyStarts();
    setConfigStatus(`Auto-saved: ${points.length} point(s), ${points.filter((p) => p.enabled).length} enabled.`);
  } catch (err) {
    setConfigStatus(err.message, true);
  }
}

poisEditorEl.addEventListener('input', (e) => {
  if (e.target.classList.contains('poi-coords')) {
    const bad = e.target.value.trim() !== '' && !parseCoordsText(e.target.value);
    e.target.classList.toggle('bad', bad);
  }
  syncFormToYaml();
});

poisEditorEl.addEventListener('change', (e) => {
  if (e.target.classList.contains('poi-enabled')) {
    e.target.closest('.poi-row').classList.toggle('off', !e.target.checked);
    syncFormToYaml();
  }
});

poisEditorEl.addEventListener('click', (e) => {
  const row = e.target.closest('.poi-row');
  if (!row) return;
  if (e.target.classList.contains('poi-remove')) {
    row.remove();
    syncFormToYaml();
  } else if (e.target.classList.contains('poi-pick')) {
    openMapPick(row);
  }
});

addPoiBtn.addEventListener('click', () => {
  poisEditorEl.append(poiRowEl());
  poisEditorEl.lastElementChild.querySelector('.poi-label').focus();
  syncFormToYaml();
});

// Drag to reorder: the row becomes draggable only while the handle is held
// (plain clicks keep text selection in the inputs working).
let dragRow = null;

poisEditorEl.addEventListener('mousedown', (e) => {
  const handle = e.target.closest('.poi-drag');
  if (handle) handle.closest('.poi-row').draggable = true;
});

document.addEventListener('mouseup', () => {
  if (!dragRow) {
    for (const row of poisEditorEl.querySelectorAll('.poi-row[draggable="true"]')) {
      row.draggable = false;
    }
  }
});

poisEditorEl.addEventListener('dragstart', (e) => {
  dragRow = e.target.closest('.poi-row');
  if (!dragRow) return;
  dragRow.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', '');
});

poisEditorEl.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (!dragRow) return;
  const after = dragAfter(poisEditorEl, e.clientY);
  if (after == null) poisEditorEl.append(dragRow);
  else poisEditorEl.insertBefore(dragRow, after);
});

poisEditorEl.addEventListener('drop', (e) => e.preventDefault());

poisEditorEl.addEventListener('dragend', () => {
  if (dragRow) {
    dragRow.classList.remove('dragging');
    dragRow.draggable = false;
  }
  dragRow = null;
  syncFormToYaml();
});

// Standard "insert before the row whose midpoint is below the cursor".
function dragAfter(container, y) {
  let closest = { offset: -Infinity, row: null };
  for (const row of container.querySelectorAll('.poi-row:not(.dragging)')) {
    const box = row.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) closest = { offset, row };
  }
  return closest.row;
}

// Pick on map: map.html?pick=<id> reports the clicked coordinates back here
// (same-origin postMessage) and the row's coords field updates like typing.
let pickSeq = 0;

function openMapPick(row) {
  pickSeq += 1;
  row.dataset.pickId = String(pickSeq);
  window.open(`map.html?pick=${pickSeq}`, 'planner-pick', 'width=960,height=720');
}

window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.data?.type !== 'poi-pick') return;
  const row = poisEditorEl.querySelector(`.poi-row[data-pick-id="${e.data.id}"]`);
  if (!row) return;
  const coordsEl = row.querySelector('.poi-coords');
  coordsEl.value = `${e.data.lon.toFixed(5)}, ${e.data.lat.toFixed(5)}`;
  coordsEl.classList.remove('bad');
  syncFormToYaml();
});

// YAML → form: parse, rebuild the rows, canonicalize the textarea (the form
// mirror embeds the current uid) and prefill the uid field if it is empty.
saveConfigBtn.addEventListener('click', () => {
  try {
    const cfg = saveConfigYaml(configYamlEl.value);
    points = cfg.starts;
    renderRows();
    applyStarts();
    if (cfg.uid && !uidEl.value.trim()) {
      uidEl.value = cfg.uid;
      saveUid(cfg.uid);
      void fetchSquares(false);
    }
    syncFormToYaml();
    setConfigStatus(`Saved: ${points.length} point(s) — ${points.map((s) => s.label).join(', ')}.`);
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
  const start = points[+startEl.value];
  const bearingKey = document.getElementById('bearing').value;

  setStatus('Planning…');
  planBtn.disabled = true;
  try {
    // B5: plan with the riding profile (the delta .brf uploaded to brouter.de
    // per session) so the pinned delivery matches what my-gravel rides;
    // stock gravel is the explicit fallback.
    let profile = PROFILE;
    let profileNote = 'profile gravel (stock fallback)';
    try {
      profile = await getRidingProfileId();
      profileNote = 'profile my-gravel';
    } catch (err) {
      console.error(err);
    }
    const result = await planRoutes({ targetKm, start, bearingKey, profile, squares: { ...squaresState } });
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
      profileNote,
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
