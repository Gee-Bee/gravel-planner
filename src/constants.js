// Hard rules and data sources, atomic instruction v6.1.

// A0 — start points are private (home etc.): pasted as YAML in the app,
// kept in localStorage, parsed by src/config.js — nothing in the repo.

// A4.1 — Squadrats trophies: the API resolves {uid} to the current CDN file;
// the uid is per-browser (typed in the UI or squares_uid in the config YAML;
// localStorage) — no account id in the repo.
export const SQUADRATS_API = 'https://mainframe-api.squadrats.com/anonymous/squadrants';

// A4.4 — Web Mercator grid 16384²; latitude must NOT be indexed linearly in degrees.
export const GRID_N = 16384;
export const DLON = 360 / GRID_N; // 0.02197265625°

// B1.4 — backend serves stock "gravel"; the 4 flags always explicit in the URL
// (no saved my-gravel; riding profile lives outside the planner, B5).
export const PROFILE = 'gravel';
export const PROFILE_PARAMS = Object.freeze({
  'profile:prefer_unpaved_paths': '1',
  'profile:avoid_noise': '1',
  'profile:correctMisplacedViaPoints': '1',
  'profile:correctMisplacedViaPointsDistance': '800',
});

// A6.3 — report precision for the W/N/P cell estimate (stage D).
export const CELL_ESTIMATE_TOLERANCE = 2;
