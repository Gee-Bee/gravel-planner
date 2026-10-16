# Gravel Route Planner

Gravel route planning from a requested distance D, with GPX export (stages A–D land one by one per atomic instruction v6.1). Vanilla JS + ES modules, no npm/bundler — dependencies via importmap (esm.sh); currently only the lucide route icon.

## Structure

```
├── index.html          # form: D slider + compass bearing wheel (auto = frontier-aimed) + route preview with stop positions and ⇄ reverse; uid + Fetch squares; Configuration (point list mirroring YAML) — config on the side at ≥900px, on top on narrow; status line
├── AGENTS.md           # rules for AI assistants
├── README.md
├── CHAT_PLANNER.md     # atomic instruction v6.1 — source spec
├── CHAT_BROUTER_PROFILE.md # riding profile delta (B5, outside the planner)
├── test.html           # static tests (no npm): serve + open — planner + squares parsing
├── src/
│   ├── main.js         # entry: config bootstrap, form → planner, honest error reporting
│   ├── planner.js      # v7.3: unified pipeline (Frontier/Scenic/Compass) -> 3 variants -> Probe -> Splice -> Score -> Delivery
│   ├── profile.js      # B5 — riding profile upload to bikerouter (custom_<id> cached with the .brf revision + HEAD liveness); stock gravel fallback
│   ├── route-analyzer.js # topology analysis, nubRuns, spliceNub, stubVias, loop geometry math
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
nix run nixpkgs#darkhttpd -- . --port 8123 --header 'Cache-Control: no-cache'
```

Open http://localhost:8080/ (ES modules require HTTP — not `file://`). The
no-cache header is required: without it the browser serves STALE modules
(heuristic freshness) after code edits — mixed old/new module set breaks
imports (measured: "does not provide an export named 'cellCenter'").

## Configuration (private)

Start points (home, work, …) are **not in the repo** — the app is public and
the coordinates must stay private. Edit them in the app: **Configuration →
start points** at the bottom of the page. The form is the editor: add/remove
points, drag ⠿ to reorder (the order is kept), uncheck a point to keep it in
the config but exclude it from planning, and fill coordinates by typing
`lon, lat` (a pasted Google-style `lat, lon` pair is auto-detected) or picking
them on the map (📍). Every change mirrors the YAML below the form and
auto-saves to this browser's localStorage (`gravel-planner:config`); each
device/browser needs its own setup. The YAML is the interchange format —
paste it on another device and use **Apply YAML** (a legacy `name:` mapping
loads too). Format (standard YAML via the `yaml` package, importmap/esm.sh
like the other deps; `#` comments):

```yaml
squares_uid: your-squadrats-uid   # optional — prefills the Squadrats uid
pois:
  - label: Plac Wolności
    lon: 16.9190   # decimal degrees, -180..180
    lat: 52.4080   # decimal degrees, -90..90
  - label: Work
    lon: 16.1
    lat: 52.1
    enabled: false  # unchecked: kept in the config, ignored by planning
```

**Route semantics** — the checked points form the route **in list order**:
the first is the start, the rest are the stops visited on the way, and the
bearing-aimed outbound leg (start → first stop) carries D minus the
stop-to-stop hops (air ×1.7, measured as the routing inflation). A last
point back at the start (duplicate the first row — or a single checked
point) closes the loop; any other last point plans a **one-way** route. If
the chain itself does not fit in D (every leg by air ×1.7 + the tip loop),
the planner reports the minimum D instead of planning (exact message, §0.3).

Without a checked point the planner stays disabled and asks for one.
The Squadrats uid is per-browser too: typed in the form or taken once from
`squares_uid` (clearing the field then sticks — no account id in the repo).

## Deploy (GitHub Pages)

The app is fully static (ES modules, no build step), so branch deployment is
enough: **Settings → Pages → Deploy from a branch → `main` / `/ (root)` →
Save**. Every push to `main` republishes in ~1–2 min at
`https://<user>.github.io/<repo>/`.

Pages serves modules with ~10 min caching — after a deploy, hard-refresh
(Ctrl+Shift+R) if anything looks stale.

## Pipeline (Unified v7.3)

1. **Celowanie i eksploracja:** Kierunek wyznaczany jest na podstawie frontu nieodwiedzonych kwadratów (lub koła kompasu / rejonu widokowego). Zawsze obecny jest kontrolowany dryf losowy (wybór z puli najbliższych komórek oraz fluktuacja kątowa ±8°), dzięki czemu ponowne planowanie proponuje inne warianty.
2. **Sondowanie i oczyszczanie (Probe & Splice):** Silnik BRouter bada 3 korytarze. Z geometrii próbnej automatycznie wycinane są zdublowane ślepe odnogi (`spliceNub`), tworząc czysty ring.
3. **Wspólny scoring:** Warianty oceniane są wspólną funkcją oceny łączącą nowe kwadraty (squadrats + squadratinhos) oraz zagęszczenie atrakcji turystycznych i punktów widokowych z OSM.
4. **Dociąganie do POI i punkty pośrednie:** Punkty via wyznaczane są na wyjeżdżonym ringu (początkowo rzadkie co ~5.4 km). Punkty w zasięgu ≤800 m od atrakcji OSM otrzymują ich nazwy jako Course Points. Wyklucza to nawroty w ślepych uliczkach, dociągając trasę do POI bez sakiewek.
5. **Bramka jakości (Verify Gate):** Trasa jest akceptowana tylko wtedy, gdy nie dubluje dróg, trzyma zadany dystans D i nie tworzy kikucików na nawrotach (`stubVias`).
- **Riding profile (B5)** — the planner routes EVERY request (probe, ring, delivery) with the user's riding profile: `CHAT_BROUTER_PROFILE.md` (delta of quaelnix's gravel.brf — Antilights, NOBRUSH, level-crossing 150, plus `prefer_unpaved_paths` + `avoid_noise` default TRUE so the preview link matches the planner) is uploaded to bikerouter's own engine (`POST /brouter-engine/brouter/profile` → `custom_<id>`, CORS-open — the endpoint bikerouter's own UI uses) and passed as `profile=`. The id is cached in localStorage **with the fnv1a revision of the .brf** (an edit re-uploads automatically) and re-verified with a routing HEAD before every reuse (200 alive / 500 evicted → re-upload). Routing URLs and the preview link carry NO `profile:*` params for a custom id — the profile text is the single source of truth (no duplication); the stock fallback keeps the B1.4 URL flags. The sparse pins hold the route shape (no U-turns), while the roads are picked by the SAME cost function the user rides with in bikerouter — the preview link carries the `custom_` id, so the opened route is computed with the riding profile, no manual upload/selection (bikerouter ignores `profile:*` URL params — measured — hence the flag defaults live in the profile itself). Upload failure → fallback to stock `gravel` + URL flags, reported in the route note.
- HTTP 4xx/429/5xx → exact URL in the UI, no retry (§0.3).
- **Dev map** (`map.html`) — the Squadrats browser extension cannot be installed in the embedded preview (UA-gated Web Store, no chrome://extensions), so this page replicates it: visited unions (both grids), frontier, and any bikerouter link pasted into the bar with fresh touched cells highlighted; reuses the app modules, so it shows exactly what the planner counts.
