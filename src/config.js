// Private start points (home etc.) never live in the repo: the user edits a
// form in the app (Configuration section); it is kept in this browser's
// localStorage and parsed here on load. The YAML textarea mirrors the form.

import { parse, stringify } from 'yaml';
import { CONFIG_KEY } from './storage.js';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

// Template shown in the textarea until a real config is saved (public POI + dummy coords).
export const EXAMPLE_YAML = [
  '#squares_uid: your-squadrats-uid  # optional — prefills the Squadrats uid',
  'pois:',
  '  - label: Plac Wolności',
  '    lon: 16.9190',
  '    lat: 52.4080',
  '  - label: Work',
  '    lon: 16.1',
  '    lat: 52.1',
  '    enabled: false  # unchecked: stays in the config, ignored by planning',
].join('\n');

// Coordinates typed into the form: "lon, lat" → { lon, lat } | null.
// Separator: , ; or whitespace. A pasted Google-style "lat, lon" pair is
// auto-detected (one value only fits the other axis, or the larger absolute
// value first — the common case around Poznań).
export function parseCoordsText(text) {
  const m = String(text ?? '').trim().match(/^(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  let a = Number(m[1]);
  let b = Number(m[2]);
  if (Math.abs(a) > 90) {
    if (Math.abs(b) > 90) return null; // both out of lat range → unusable
  } else if (Math.abs(b) > 90 || Math.abs(a) > Math.abs(b)) {
    [a, b] = [b, a]; // first value must be the latitude
  }
  return Math.abs(a) <= 180 && Math.abs(b) <= 90 ? { lon: a, lat: b } : null;
}

export function loadConfigRaw() {
  return localStorage.getItem(CONFIG_KEY) ?? '';
}

// Top-level keys: `pois:` (ORDERED list of points) and the optional scalar
// `squares_uid` — anything else is a typo, rejected with a hint. A legacy
// `name:` mapping still loads (insertion order, every point enabled).
export function parseConfigYaml(text) {
  let doc;
  try {
    doc = parse(String(text ?? ''));
  } catch (err) {
    throw new ConfigError(String(err.message).split('\n')[0]);
  }
  if (doc == null) return { starts: [], uid: '' };
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    throw new ConfigError('config must be a mapping: "pois:" list + optional "squares_uid"');
  }
  for (const key of Object.keys(doc)) {
    if (key !== 'pois' && key !== 'squares_uid') {
      throw new ConfigError(`unknown top-level key "${key}" — start points live under "pois:"`);
    }
  }
  const uid = ['string', 'number'].includes(typeof doc.squares_uid)
    ? String(doc.squares_uid).trim()
    : '';
  const starts = [];
  const pois = doc.pois;
  if (pois != null) {
    if (typeof pois !== 'object') {
      throw new ConfigError('"pois:" must be a list of points (label/lon/lat each)');
    }
    const entries = Array.isArray(pois)
      ? pois.map((v, i) => [null, v, i])
      : Object.entries(pois).map(([k, v], i) => [k, v, i]);
    for (const [key, v, i] of entries) {
      const name = key != null ? `"${key}"` : `pois[${i}]`;
      if (v == null || typeof v !== 'object' || Array.isArray(v)) {
        throw new ConfigError(`${name}: expected "label/lon/lat" fields`);
      }
      const lon = Number(v.lon);
      const lat = Number(v.lat);
      // Number(null)/Number('') are 0 and Number(true) is 1 — reject non-numeric
      // scalars explicitly so a forgotten value can't silently become 0°.
      const bad = (x) => x == null || x === '' || typeof x === 'boolean';
      if (bad(v.lon) || bad(v.lat) ||
          !Number.isFinite(lon) || !Number.isFinite(lat) ||
          Math.abs(lon) > 180 || Math.abs(lat) > 90) {
        throw new ConfigError(`${name}: lon/lat must be decimal degrees (lon -180..180, lat -90..90)`);
      }
      if (v.enabled != null && typeof v.enabled !== 'boolean') {
        throw new ConfigError(`${name}: enabled must be true or false`);
      }
      const label = key != null
        ? String(v.label ?? key)
        : (v.label == null || v.label === '' ? `Punkt ${i + 1}` : String(v.label));
      starts.push({ label, lon, lat, enabled: v.enabled !== false });
    }
  }
  return { starts, uid };
}

// Form → YAML mirror (canonical list format): squares_uid only when set,
// enabled only when false, label only when non-empty — the parser's defaults
// cover the rest, keeping the stored blob small and stable.
export function serializeConfigYaml({ uid = '', points = [] }) {
  const doc = {};
  if (uid) doc.squares_uid = uid;
  doc.pois = points.map((p) => ({
    ...(p.label ? { label: String(p.label) } : {}),
    lon: p.lon,
    lat: p.lat,
    ...(p.enabled === false ? { enabled: false } : {}),
  }));
  return stringify(doc, { lineWidth: 0 });
}

// Tolerant read: a broken stored config must not blank the whole app —
// the raw YAML stays in the textarea for fixing (the form rebuilds from it).
export function getConfig() {
  const raw = loadConfigRaw();
  if (!raw) return { starts: [], uid: '' };
  try {
    return parseConfigYaml(raw);
  } catch {
    return { starts: [], uid: '' };
  }
}

export function getStarts() {
  return getConfig().starts;
}

// Validates before storing — localStorage only ever holds a parseable config.
export function saveConfigYaml(text) {
  const cfg = parseConfigYaml(text);
  if (!cfg.starts.length) throw new ConfigError('config is empty — add at least one start');
  localStorage.setItem(CONFIG_KEY, text.trim());
  return cfg;
}
