# Gravel Route Planner

Gravel route planning from a requested distance D, with GPX export (stages A–D land one by one per atomic instruction v6.1). Vanilla JS + ES modules, no npm/bundler — dependencies via importmap (esm.sh); currently only the lucide route icon.

## Structure

```
├── index.html          # form: D [km] + start (from config) + bearing (auto = frontier-aimed); uid + Fetch squares; Configuration (YAML); status line
├── AGENTS.md           # rules for AI assistants
├── README.md
├── CHAT_PLANNER.md     # atomic instruction v6.1 — source spec
├── CHAT_BROUTER_PROFILE.md # riding profile delta (B5, outside the planner)
├── test.html           # static tests (no npm): serve + open — planner + squares parsing
├── src/
│   ├── main.js         # entry: config bootstrap, form → planner, honest error reporting
│   ├── planner.js      # v7.1: frontier-aimed bearing → loop probe (plain) → splice finger → ring vias → verify → new-squares estimate
│   ├── planning.js     # Etap C step 1 — radial lollipop anchors, A5.3/A5.5 spur snap
│   ├── config.js       # private start points: 2-level YAML parser + localStorage (nothing private in the repo)
│   ├── constants.js    # A4.1 Squadrats API, A4.3 grid, B1.4 profile
│   ├── geometry.js     # A4.3/A4.4 grid math (mercY, cellIndex/cellCenter, frontier, bearing)
│   ├── squares.js      # A4.2 — trophy GeoJSON → visited polygons (outer + holes), cell hits, visited cells in bbox
│   ├── storage.js      # uid + start-config keys (localStorage)
│   ├── gpx.js          # GPX download stub (stage D)
│   └── api/
│       ├── brouter.js  # B1 fetch (gravel + 4 flags), B3 preview link, HttpError
│       ├── squadrats.js# A4.1 — trophy GeoJSON (2 GETs, no auth), session cache, HttpError
│       └── wikipedia.js# B2 geosearch stub (Overpass retired)
```

## Run locally

```bash
nix run nixpkgs#darkhttpd -- . --port 8080 --header 'Cache-Control: no-cache'
```

Open http://localhost:8080/ (ES modules require HTTP — not `file://`). The
no-cache header is required: without it the browser serves STALE modules
(heuristic freshness) after code edits — mixed old/new module set breaks
imports (measured: "does not provide an export named 'cellCenter'").

## Configuration (private)

Start points (home, work, …) are **not in the repo** — the app is public and
the coordinates must stay private. Paste them once in the app: **Configuration
→ start points (YAML)** at the bottom of the page, then **Save config**. The
blob lives only in this browser's localStorage (`gravel-planner:config`); each
device/browser needs its own paste. Format (standard YAML via the `yaml`
package, importmap/esm.sh like the other deps; `#` comments; the key is the
start id, `label` shows in the select; optional top-level `squares_uid`
prefills the Squadrats uid):

```yaml
squares_uid: your-squadrats-uid   # optional — prefills the Squadrats uid
dom:
  label: Home
  lon: 16.0   # decimal degrees, -180..180
  lat: 52.0   # decimal degrees, -90..90
praca:
  label: Work
  lon: 16.1
  lat: 52.1
```

Without a saved config the planner stays disabled and asks for the paste.
The Squadrats uid is per-browser too: typed in the form or taken once from
`squares_uid` (clearing the field then sticks — no account id in the repo).

## Deploy (GitHub Pages)

The app is fully static (ES modules, no build step), so branch deployment is
enough: **Settings → Pages → Deploy from a branch → `main` / `/ (root)` →
Save**. Every push to `main` republishes in ~1–2 min at
`https://<user>.github.io/<repo>/`.

Pages serves modules with ~10 min caching — after a deploy, hard-refresh
(Ctrl+Shift+R) if anything looks stale.

## Pipeline (v6.1)

- **Squares (optional)** — a non-empty uid enables them: trophy GeoJSON via 2 unauthenticated GETs (A4.1), visited polygons = ring[0] outer + rings[1..] holes (A4.2); fetched eagerly on load, refreshed on button/uid change, cached per session. Both grids parse: **squadrats** (16384², aiming + report) and **squadratinhos** (131072², report + tiebreak) — the browser overlay in the screenshot is the Squadrats extension, not a bikerouter layer.
- **A** — visited polygons ready (Squadrats API, A4.1).
- **B** — visited cells (cell centers vs the visited union, local bbox around the start only) → frontier = unvisited cells 4-adjacent to visited ones (A4.6).
- **C** — bearing at the NEAREST frontier cell (bearing "Auto (new squares)", default) → radial lollipop anchors ≈ D; manual N/E/S/W is a constraint, not an override — it aims at the nearest frontier within its ±45° quadrant (fallback: its own ±45° fan); without squares the algorithm runs the same, just ignores visits (auto → N, manual = plain direction fan).
- **D** — BRouter GeoJSON (gravel + 4 flags in URL, B1.4; named via, B1.2) with the verify gate (no doubled strands, ring parity ≤3 km), bikerouter link; new-squares estimate from the delivery geometry on BOTH grids (cells touched where no point is visited).
- HTTP 4xx/429/5xx → exact URL in the UI, no retry (§0.3).
- **Dev map** (`map.html`) — the Squadrats browser extension cannot be installed in the embedded preview (UA-gated Web Store, no chrome://extensions), so this page replicates it: visited unions (both grids), frontier, and any bikerouter link pasted into the bar with fresh touched cells highlighted; reuses the app modules, so it shows exactly what the planner counts.
