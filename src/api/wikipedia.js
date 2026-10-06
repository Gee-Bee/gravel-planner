// POI source: pl.wikipedia geosearch only — Overpass is retired (B2).

// B2 — attraction vs noise in geosearch titles.
const KEEP = /Jezioro|Park|Rezerwat|Zamek|Dwór|Pałac|Kościół|Klasztor|Muzeum|Pomnik|Wzgórze/;
const DROP = /Osiedle|Szkoła|Wydział|Stadion|Ulica|Firma/;

/**
 * B2 geosearch inside a bbox; "toobig" error → caller must shrink the bbox.
 * B2.1 — POIs ≤800 m from the route only; none → zero POI, never forced.
 */
export async function searchPois(bbox) {
  // Etap D: fetch pl.wikipedia geosearch (gsbbox top|left|bottom|right,
  // gslimit=50), filter titles by KEEP/DROP, map to {title, lat, lon}.
  void KEEP;
  void DROP;
  void bbox;
  return [];
}
