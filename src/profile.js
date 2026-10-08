// B5 — riding profile: CHAT_BROUTER_PROFILE.md (the user's delta of quaelnix's
// gravel.brf — Antilights, NOBRUSH, level crossing 150) is UPLOADED to the
// bikerouter engine (POST {host}/brouter/profile → {"profileid": "custom_..."},
// CORS *) and used for EVERY planner request. Uploading THERE (not brouter.de)
// means the preview link can carry the custom id in its URL — bikerouter
// restores it as "user Defined" and routes with the riding profile, no manual
// upload or selection needed. Custom profiles live in the server cache only
// (no download/list endpoint — the id is the only handle), so the id is kept
// in localStorage and verified with a header-only routing HEAD (200 = alive,
// 500 = evicted) before EVERY reuse; evicted → one silent re-upload. The id
// therefore survives browser restarts, and a still-cached profile is never
// uploaded twice (measured: ids stay routable well beyond a session).
// Upload failure = fall back to stock gravel + URL flags (reported in the UI).

import { HttpError } from './api/brouter.js';

const PROFILE_MD = './CHAT_BROUTER_PROFILE.md';
// {host}/brouter/profile — same endpoint bikerouter's own UI uploads to.
const UPLOAD_URL = 'https://bikerouter.de/brouter-engine/brouter/profile';
const CACHE_KEY = 'gravel-planner:brouter-profile-id';
// Fixed 2-point liveness probe — any short routable pair will do.
const CHECK_LONLATS = '16.91,52.41|16.92,52.42';

async function profileExists(id) {
  const url = `https://bikerouter.de/brouter-engine/brouter?lonlats=${CHECK_LONLATS}&profile=${encodeURIComponent(id)}&format=geojson`;
  const res = await fetch(url, { method: 'HEAD' });
  return res.ok;
}

export async function getRidingProfileId() {
  const cached = localStorage.getItem(CACHE_KEY);
  if (cached) {
    try {
      if (await profileExists(cached)) return cached;
    } catch (err) {
      console.error(err);
      // Check unreachable (offline / flaky): trust the cache — a stale id
      // surfaces with its exact URL on the routing error (§0.3).
      return cached;
    }
    localStorage.removeItem(CACHE_KEY);
  }
  const brf = await (await fetch(PROFILE_MD)).text();
  const res = await fetch(UPLOAD_URL, { method: 'POST', body: brf });
  if (!res.ok) throw new HttpError(res.status, UPLOAD_URL);
  const { profileid, error } = await res.json();
  if (!profileid) throw new Error(error ?? 'profile upload failed');
  localStorage.setItem(CACHE_KEY, profileid);
  return profileid;
}
