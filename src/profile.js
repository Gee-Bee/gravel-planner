// B5 — riding profile: CHAT_BROUTER_PROFILE.md (the user's delta of quaelnix's
// gravel.brf — Antilights, NOBRUSH, level crossing 150) is UPLOADED to the
// bikerouter engine (POST {host}/brouter/profile → {"profileid": "custom_..."},
// CORS *) and used for EVERY planner request. Uploading THERE (not brouter.de)
// means the preview link can carry the custom id in its URL — bikerouter
// restores it as "user Defined" and routes with the riding profile, no manual
// upload or selection needed. Custom profiles live in the server cache only
// (no download/list endpoint — the id is the only handle), so the id is kept
// in localStorage TOGETHER with the fnv1a revision of the .brf it came from —
// a profile edit re-uploads automatically (a stale id keeps serving the OLD
// text while staying 200-alive on the HEAD) — and verified with a header-only
// routing HEAD (200 = alive, 500 = evicted) before EVERY reuse; evicted → one
// silent re-upload. The id therefore survives browser restarts, and a
// still-cached profile is never uploaded twice (measured: ids stay routable
// well beyond a session).
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

// fnv-1a (32-bit) over the .brf text — the stored cache revision.
function brfRevision(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export async function getRidingProfileId() {
  const brf = await (await fetch(PROFILE_MD)).text();
  const revision = brfRevision(brf);
  const stored = localStorage.getItem(CACHE_KEY) ?? '';
  const sep = stored.indexOf(':');
  const savedRev = sep < 0 ? '' : stored.slice(0, sep);
  const cached = sep < 0 ? '' : stored.slice(sep + 1);
  if (cached && savedRev === revision) {
    try {
      if (await profileExists(cached)) return cached;
    } catch (err) {
      console.error(err);
      // Check unreachable (offline / flaky): trust the cache — a stale id
      // surfaces with its exact URL on the routing error (§0.3).
      return cached;
    }
    // 500 = evicted server-side → fall through to a fresh upload.
  }
  const res = await fetch(UPLOAD_URL, { method: 'POST', body: brf });
  if (!res.ok) throw new HttpError(res.status, UPLOAD_URL);
  const { profileid, error } = await res.json();
  if (!profileid) throw new Error(error ?? 'profile upload failed');
  localStorage.setItem(CACHE_KEY, `${revision}:${profileid}`);
  return profileid;
}
