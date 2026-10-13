// Scenery overlay — BRouter's WayTags carry NO greenery or tourism at all
// (measured on real tracks: forest / landuse / natural / leisure / tourism
// absent), so "scenic" can only come from a separate source: an Overpass
// query over the route's bounding box. Best effort — a failed or slow query
// returns [] and the planner simply ranks without scenery (the overlay is
// optional, so it never surfaces as a §0.3 error).

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

// Attractions, viewpoints, parks, ruins, peaks and the settlements that make
// a gravel detour worthwhile; the `name` filter keeps the payload small.
const TAGS = [
  'node["tourism"~"^(attraction|viewpoint|artwork|information)$"]["name"]',
  'node["leisure"~"^(park|nature_reserve|garden|zoo)$"]["name"]',
  'node["natural"~"^(peak|waterfall|spring|cliff)$"]["name"]',
  'node["historic"~"^(castle|monument|memorial|ruins|archaeological_site)$"]["name"]',
  'node["place"~"^(town|village|hamlet)$"]["name"]',
  'way["tourism"~"^(attraction|viewpoint)$"]["name"]',
];
const LIMIT = 120;

/**
 * Named scenic spots inside `bbox` ({w,s,e,n}, geometry.js order) as
 * [{ lon, lat, name, kind }]. Ways are resolved to their center.
 */
export async function fetchScenicSpots(bbox) {
  const area = `(${bbox.s},${bbox.w},${bbox.n},${bbox.e})`;
  const query = `[out:json][timeout:20];(${TAGS.map((t) => `${t}${area}`).join(';')});out center ${LIMIT};`;
  let res;
  try {
    res = await fetch(OVERPASS_URL, { method: 'POST', body: new URLSearchParams({ data: query }) });
  } catch {
    return [];
  }
  if (!res.ok) return [];
  let json;
  try {
    json = await res.json();
  } catch {
    return [];
  }
  return (json.elements ?? [])
    .map((el) => ({
      lon: el.lon ?? el.center?.lon,
      lat: el.lat ?? el.center?.lat,
      name: el.tags?.name ?? '',
      kind: el.tags?.tourism ?? el.tags?.leisure ?? el.tags?.natural
        ?? el.tags?.historic ?? el.tags?.place ?? '',
    }))
    .filter((s) => Number.isFinite(s.lon) && Number.isFinite(s.lat));
}
