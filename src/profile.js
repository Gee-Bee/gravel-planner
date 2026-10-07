// B5 — riding profile: CHAT_BROUTER_PROFILE.md (the user's delta of quaelnix's
// gravel.brf — Antilights, NOBRUSH, level crossing 150) is UPLOADED to
// brouter.de (POST /brouter/profile → {"profileid": "custom_..."}) and used
// for EVERY planner request. The probe and the delivered route are then
// optimized by the SAME cost function the user rides with (bikerouter
// my-gravel): the via pins hold the ring shape, the profile picks the roads.
// Custom profiles live in the server cache only — the cached id is verified
// with a header-only routing HEAD (200 = alive, 500 = evicted) before reuse,
// and re-uploaded when gone. Upload failure = fall back to stock gravel +
// URL flags (reported in the UI).

import { HttpError } from './api/brouter.js';

const PROFILE_MD = './CHAT_BROUTER_PROFILE.md';
const UPLOAD_URL = 'https://brouter.de/brouter/profile';
const CACHE_KEY = 'gravel-planner:brouter-profile-id';
// Fixed 2-point liveness probe — any short routable pair will do.
const CHECK_LONLATS = '16.91,52.41|16.92,52.42';

async function profileExists(id) {
  const url = `https://brouter.de/brouter?lonlats=${CHECK_LONLATS}&profile=${encodeURIComponent(id)}&format=geojson`;
  const res = await fetch(url, { method: 'HEAD' });
  return res.ok;
}

export async function getRidingProfileId() {
  const cached = sessionStorage.getItem(CACHE_KEY);
  if (cached) {
    try {
      if (await profileExists(cached)) return cached;
    } catch (err) {
      console.error(err);
      // Check unreachable (offline / flaky): trust the cache — a stale id
      // surfaces with its exact URL on the routing error (§0.3).
      return cached;
    }
    sessionStorage.removeItem(CACHE_KEY);
  }
  const brf = await (await fetch(PROFILE_MD)).text();
  const res = await fetch(UPLOAD_URL, { method: 'POST', body: brf });
  if (!res.ok) throw new HttpError(res.status, UPLOAD_URL);
  const { profileid, error } = await res.json();
  if (!profileid) throw new Error(error ?? 'profile upload failed');
  sessionStorage.setItem(CACHE_KEY, profileid);
  return profileid;
}
