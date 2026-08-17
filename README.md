# Roadbook PWA — offline map for Dubai → Salalah → Dubai

Leaflet + Service Worker + Cache API. No build step, no framework, no state library.
Leaflet is vendored locally, so nothing is fetched from a CDN at runtime.

One page: the map, with the roadbook as a bottom sheet over it. The sheet has
three detents — peek (next stop, distance, ETA), half, and full — and tapping a
checkpoint flies the map to it and opens its popup, offset so the pin lands in
the part of the map the sheet is not covering.

## The one hard requirement

**Service workers do not run from `file://`.** They need HTTPS or `localhost`.
Opening `index.html` by double-clicking it will give you a working map online and
nothing offline. Serve it instead.

Local test:

    cd roadbook-pwa
    python3 -m http.server 8080
    # then open http://localhost:8080

On a phone, put it on any HTTPS host. GitHub Pages is the least effort:

    git init && git add . && git commit -m "roadbook"
    git remote add origin git@github.com:<you>/roadbook.git
    git push -u origin main
    # Settings → Pages → deploy from main / root

Then open the Pages URL on the phone and **Add to Home Screen**. It installs as a
standalone app and keeps its caches.

## Files

| File | Role |
|---|---|
| `index.html` | Shell, styles, service-worker registration |
| `sheet.js` | The roadbook — a three-detent bottom sheet over the map |
| `weather.js` | Per-stop forecast, read at your scheduled arrival hour |
| `route-data.js` | Stops, route polyline, tile sources, zoom limits. Edit the stops by hand; the polyline is generated |
| `tools/` | `route.config.json` + the two scripts that generate `ROUTE.line` from a router or a GPX |
| `app.js` | Part 1 — map init, bounds, markers, popups, GPS |
| `sw.js` | Part 2 — cache-first tile strategy, shell precache |
| `precache.js` | Part 3 — tile URL maths and the bulk downloader |
| `vendor/` | Leaflet 1.9.4, self-hosted |

## How the caching is split

Two caches, on purpose:

- `roadbook-shell-v2` — app code. Versioned, wiped on every deploy. Bump `VERSION`
  in `sw.js` when you change any shell file.
- `roadbook-tiles` — **unversioned and never wiped on activate.** Re-downloading
  several thousand tiles in the desert because you shipped a CSS fix is not a
  thing that should be able to happen. Cleared only when the user taps Clear.

## Why the precache is a corridor, not a bounding box

The Dubai→Salalah box is 3.8° × 8.3°. At z15 that is **280,952 tiles, about 4.8 GB.**

`precache.js` buffers the route polyline instead, tightening the buffer as zoom
rises:

| Tier | Zooms | Buffer | Tiles |
|---|---|---|---|
| Region overview | 6–9 | 40 km | 149 |
| Corridor | 10–11 | 15 km | 395 |
| Road detail | 12–13 | 6 km | 2,243 |
| Around stops | 14–15 | 2.5 km | 854 |

**3,641 unique tiles.** Doubled across the two basemaps that is 7,282 requests,
roughly 128 MB. Tune the tiers in `PLAN`.

## Where `ROUTE.line` comes from

It is generated, not hand-written. It was once 41 hand-placed vertices, which
drew straight chords between them — 1,196 km against a real road distance of
1,310 km, and a corridor buffered around ground the road does not cross.

    python3 tools/fetch-route.py          # route + simplify + write everything
    python3 tools/fetch-route.py --dry-run  # print the request URL only

`tools/route.config.json` holds the waypoints, router, profile, per-waypoint
snap radius and the simplify tolerance. To force the path onto a particular
road, insert a `via` waypoint there and re-run.

Two stages on purpose. `fetch-route.py` caches full-resolution router output to
`tools/route.raw.geojson`; `route-from-track.py` simplifies that to 12 m and
writes `route-data.js` plus the GPX and KML. Re-tuning the tolerance therefore
costs no HTTP request — run stage 2 on the cached raw file. Stage 2 also takes
a GPX/KML/GeoJSON directly, if you would rather supply a track you recorded
than trust a router.

Simplification is close to free at the corridor's resolution: 7,187 raw points
reduce to 1,421 and cost 94 extra tiles. Density is not what makes a precache
expensive — buffer radius and zoom ceiling are.

`MAX_ZOOM` is 15 — each extra level quadruples storage, and 15 is still enough to
read a fuel station forecourt.

## Places and legs

The return drives the same road backwards, so every place is visited twice.
A flat list of stops would put two markers on each coordinate and label the
borders wrongly — Mezyad is the UAE **exit** going out and the UAE **entry**
coming home. So the data splits in two:

- `ROUTE.stops` — the 13 physical places. Name, position, marker type. One
  marker each. This is also what `precache.js` buffers and what `weather.js`
  asks the forecast about.
- `ROUTE.days[n].legs` — one visit to one place on one day: `at` (index into
  `stops`), `sub`, `km`, `drive`, `stay`, `fuel`, `svc`, `note`, `lm`. Notes and
  landmarks are per leg because they are direction-dependent; Bahla's fort is on
  your right going south and your left coming back.

A stop is identified by `"<day>:<legIndex>"`, so ticking Haima off on the way
south does not tick it off on the way home.

**Adding a day means adding one `days` entry.** Tabs, the trip weather summary,
the distance table and the peek all build themselves from it. 20–21 Aug are in
Salalah and deliberately absent until they are planned.

Round trip is 2,618 km: 1,309 out, 1,309 back. The precache is unchanged by the
return — same road, same tiles.

## Weather

A single figure for "today" is useless here. On 19 Aug the Aqabat descent is at
100 m visibility at 07:00 and 12 km by 10:00, while Adam is 42°C at midday —
same day, 400 km apart. So the forecast is fetched **per stop** and read at the
hour the schedule puts you there. Change the departure time and every reading
moves with it.

Two levels: a **trip summary** at the top of every day — one row per day with its
temperature range and worst hazard, tap to jump — and the **per-stop conditions**
inside each stop card, with a temperature on the collapsed row.

Open-Meteo, keyless and CORS-enabled; all 13 places come back in one request.
Cached in `localStorage` (~16 KB) rather than the Cache API, so clearing tiles
does not clear it. Offline, the last fetch is shown with its age stated.

Thresholds live in `warnings()` in `weather.js`. Two of them earned their
values the hard way:

- **Heat fires on apparent ≥ 42°C _or_ actual ≥ 44°C.** In dry desert air the
  apparent temperature runs *below* the real one — Qitbit on 22 Aug is 45°C real
  but 40°C felt. Keying on "feels like" alone reported that day as clear.
- **Visibility under 1 km**, which is what makes the Aqabat dangerous rather
  than scenic.

Rain at or above 50% and wind at or above 40 km/h round it out.

## Tile provider and terms

Default is Esri (World Street Map + World Imagery). Keyless, and it gives you both
a road map and satellite.

**OpenStreetMap's tile usage policy forbids bulk downloading**, which is exactly
what a precache does. The OSM hosts are listed in the service worker so casual
browsing is cached, but OSM is deliberately excluded from `PLAN`. For a build that
is unambiguously in the clear, self-host tiles or use a provider whose terms permit
offline caching — MapTiler, Stadia and Thunderforest all have free tiers that do.

## Verifying it actually works

Download → flight mode → hard reload. If the tiles draw, you're covered.

DevTools → Application → Cache Storage shows both caches. `Service Workers` →
`Offline` simulates the drop without touching the radio.

## Extending

Add a stop: append to `ROUTE.stops` in `route-data.js`. New `type` values need a
matching entry in `ROUTE.types` for the colour and glyph. The precache picks up new
stops automatically on the next run.
