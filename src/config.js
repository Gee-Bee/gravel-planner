// Private start points (home etc.) never live in the repo: the user pastes a
// small YAML blob in the app (Configuration section), it is kept in this
// browser's localStorage and parsed here on load.

import { parse } from 'yaml';
import { CONFIG_KEY } from './storage.js';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

// Template shown in the textarea until a real config is saved (dummy coordinates).
export const EXAMPLE_YAML = [
  '#squares_uid: your-squadrats-uid  # optional — prefills the Squadrats uid',
  'dom:',
  '  label: Home',
  '  lon: 16.0',
  '  lat: 52.0',
  'praca:',
  '  label: Work',
  '  lon: 16.1',
  '  lat: 52.1',
].join('\n');

export function loadConfigRaw() {
  return localStorage.getItem(CONFIG_KEY) ?? '';
}

// `squares_uid` is a reserved top-level key (optional scalar) — it prefills
// the Squadrats uid; every other top-level key is a start point.
export function parseConfigYaml(text) {
  let doc;
  try {
    doc = parse(String(text ?? ''));
  } catch (err) {
    throw new ConfigError(String(err.message).split('\n')[0]);
  }
  if (doc == null) return { starts: {}, uid: '' };
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    throw new ConfigError('config must be a mapping: "name:" with label/lon/lat fields');
  }
  const uid = ['string', 'number'].includes(typeof doc.squares_uid)
    ? String(doc.squares_uid).trim()
    : '';
  // Number(null)/Number('') are 0 and Number(true) is 1 — reject non-numeric
  // scalars explicitly so a forgotten value can't silently become 0°.
  const bad = (x) => x == null || x === '' || typeof x === 'boolean';
  const starts = {};
  for (const [key, v] of Object.entries(doc)) {
    if (key === 'squares_uid') continue;
    if (v == null || typeof v !== 'object' || Array.isArray(v)) {
      throw new ConfigError(`"${key}": expected "label/lon/lat" fields`);
    }
    const lon = Number(v.lon);
    const lat = Number(v.lat);
    if (bad(v.lon) || bad(v.lat) ||
        !Number.isFinite(lon) || !Number.isFinite(lat) ||
        Math.abs(lon) > 180 || Math.abs(lat) > 90) {
      throw new ConfigError(`"${key}": lon/lat must be decimal degrees (lon -180..180, lat -90..90)`);
    }
    starts[key] = { label: String(v.label ?? key), lon, lat };
  }
  return { starts, uid };
}

// Tolerant read: a broken stored config must not blank the whole app —
// the raw YAML stays in the textarea for fixing (saving reports the error).
export function getConfig() {
  const raw = loadConfigRaw();
  if (!raw) return { starts: {}, uid: '' };
  try {
    return parseConfigYaml(raw);
  } catch {
    return { starts: {}, uid: '' };
  }
}

export function getStarts() {
  return getConfig().starts;
}

// Validates before storing — localStorage only ever holds a parseable config.
export function saveConfigYaml(text) {
  const cfg = parseConfigYaml(text);
  if (!Object.keys(cfg.starts).length) throw new ConfigError('config is empty — add at least one start');
  localStorage.setItem(CONFIG_KEY, text.trim());
  return cfg;
}
