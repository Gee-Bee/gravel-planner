// POI source: pl.wikipedia geosearch only — Overpass is retired (B2).

// B2 — attraction vs noise in geosearch titles.
const KEEP = /Jezioro|Park|Rezerwat|Zamek|Dwór|Pałac|Kościół|Klasztor|Muzeum|Pomnik|Wzgórze/;
const DROP = /Osiedle|Szkoła|Wydział|Stadion|Ulica|Firma/;

// Measured: pl.wikipedia rejects a geosearch bbox whose center→corner
// distance exceeds ~10 km ({code:"toobig"}), so a planning-area bbox is tiled
// into 9 km squares with a margin.
const TILE_KM = 9;
const API = 'https://pl.wikipedia.org/w/api.php?action=query&list=geosearch&format=json&origin=*&gsnamespace=0&gsprimary=primary&gslimit=50&gsbbox={box}';

/**
 * B2 geosearch inside a bbox; "toobig" error → caller must shrink the bbox.
 * B2.1 — POIs ≤800 m from the route only; none → zero POI, never forced.
 */
export async function searchPois(bbox) {
  // {w,s,e,n} → TILE_KM × TILE_KM tiles in degrees ({last tile smaller}; the
  // GeoData tile math mirrors geometry.js: 110.57 km/° lat, 111.32·cos km/° lon).
  const tiles = [];
  for (let s = bbox.s; s < bbox.n - 1e-9; s += TILE_KM / 110.57) {
    const n = Math.min(s + TILE_KM / 110.57, bbox.n);
    const kmLonDeg = TILE_KM / (111.32 * Math.cos((s * Math.PI) / 180));
    for (let w = bbox.w; w < bbox.e - 1e-9; w += kmLonDeg) {
      tiles.push({ s, n, w, e: Math.min(w + kmLonDeg, bbox.e) });
    }
  }

  // Dedupe by pageid: adjacent tiles are inclusive on their shared edges, so a
  // hit exactly on a border can arrive twice.
  const merged = new Map();
  const tileResults = await Promise.all(tiles.map(async (t) => {
    const url = API.replace(
      '{box}',
      `${t.n.toFixed(4)}|${t.w.toFixed(4)}|${t.s.toFixed(4)}|${t.e.toFixed(4)}`,
    );
    let res;
    try {
      res = await fetch(url);
    } catch {
      return null; // best effort: a failed tile loses only its POIs, never the plan
    }
    if (!res.ok) return null;
    let json;
    try {
      json = await res.json();
    } catch {
      return null;
    }
    if (json.error?.code === 'toobig') throw new Error(`wikipedia geosearch "toobig" for ${url} — shrink the bbox`);
    return json.query?.geosearch ?? [];
  }));
  for (const hits of tileResults) {
    if (!hits) continue;
    for (const hit of hits) {
      if (merged.has(hit.pageid)) continue;
      merged.set(hit.pageid, { name: hit.title, lon: hit.lon, lat: hit.lat });
    }
  }

  return [...merged.values()].filter((p) => KEEP.test(p.name) && !DROP.test(p.name));
}
