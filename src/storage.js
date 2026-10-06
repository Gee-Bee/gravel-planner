// localStorage keys — client state: the uid (squares on/off) and the private
// start-point YAML (src/config.js; never in the repo).

const UID_KEY = 'gravel-planner:uid';
export const CONFIG_KEY = 'gravel-planner:config';

export function loadUid() {
  return localStorage.getItem(UID_KEY) ?? '';
}

export function saveUid(uid) {
  if (uid) localStorage.setItem(UID_KEY, uid);
  else localStorage.removeItem(UID_KEY);
}
