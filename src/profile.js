// B5 — riding profile: CHAT_BROUTER_PROFILE.md (the user's delta of quaelnix's
// gravel.brf — Antilights, NOBRUSH, level crossing 150) is UPLOADED per session
// to brouter.de (POST /brouter/profile → {"profileid": "custom_..."}) and used
// for EVERY planner request. The probe and the delivered route are then
// optimized by the SAME cost function the user rides with (bikerouter
// my-gravel): the via pins hold the ring shape, the profile picks the roads.
// Upload failure = fall back to stock gravel + URL flags (reported in the UI).

import { HttpError } from './api/brouter.js';

const PROFILE_MD = './CHAT_BROUTER_PROFILE.md';
const UPLOAD_URL = 'https://brouter.de/brouter/profile';
const CACHE_KEY = 'gravel-planner:brouter-profile-id';

export async function getRidingProfileId() {
  const cached = sessionStorage.getItem(CACHE_KEY);
  if (cached) return cached;
  const brf = await (await fetch(PROFILE_MD)).text();
  const res = await fetch(UPLOAD_URL, { method: 'POST', body: brf });
  if (!res.ok) throw new HttpError(res.status, UPLOAD_URL);
  const { profileid, error } = await res.json();
  if (!profileid) throw new Error(error ?? 'profile upload failed');
  sessionStorage.setItem(CACHE_KEY, profileid);
  return profileid;
}
