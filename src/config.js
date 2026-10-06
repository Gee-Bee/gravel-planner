// Private start points (home etc.) never live in the repo: the user pastes a
// small YAML blob in the app (Configuration section), it is kept in this
// browser's localStorage and parsed here on load.

import { CONFIG_KEY } from './storage.js';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

// Template shown in the textarea until a real config is saved (dummy coordinates).
export const EXAMPLE_YAML = [
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

// Minimal 2-level YAML: `name:` blocks with `label/lon/lat` scalars — enough
// for start points, no dependency on a YAML library. `#` starts a comment.
export function parseConfigYaml(text) {
  const starts = {};
  let current = null;
  for (const [i, raw] of String(text ?? '').split('\n').entries()) {
    const line = raw.replace(/#.*$/, '').trimEnd();
    if (!line.trim()) continue;
    if (/^\S/.test(line)) {
      const key = line.trim().replace(/:$/, '');
      if (!key) throw new ConfigError(`line ${i + 1}: empty start name`);
      current = key;
      starts[key] = {};
    } else {
      if (!current) throw new ConfigError(`line ${i + 1}: indented entry before any "name:"`);
      const m = line.trim().match(/^([A-Za-z_-]+)\s*:\s*(\S.*)$/);
      if (!m) throw new ConfigError(`line ${i + 1}: expected "key: value"`);
      starts[current][m[1]] = m[2].trim();
    }
  }
  for (const [key, v] of Object.entries(starts)) {
    const lon = Number(v.lon);
    const lat = Number(v.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) {
      throw new ConfigError(`"${key}": lon/lat must be decimal degrees (lon -180..180, lat -90..90)`);
    }
    starts[key] = { label: String(v.label ?? key), lon, lat };
  }
  return starts;
}

export function getStarts() {
  const raw = loadConfigRaw();
  return raw ? parseConfigYaml(raw) : {};
}

// Validates before storing — localStorage only ever holds a parseable config.
export function saveConfigYaml(text) {
  const starts = parseConfigYaml(text);
  if (!Object.keys(starts).length) throw new ConfigError('config is empty — add at least one start');
  localStorage.setItem(CONFIG_KEY, text.trim());
  return starts;
}
