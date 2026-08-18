/* ============================================================
   sw.js — PART 2: SERVICE WORKER
   Two caches, deliberately separate:
     SHELL — app code. Versioned; wiped on every deploy.
     TILES — map imagery. NEVER wiped on activate, because
             re-downloading 8,000 tiles in the desert is not an
             option. Cleared only when the user asks.
   ============================================================ */

const VERSION     = "v9";
const SHELL_CACHE = "roadbook-shell-" + VERSION;
const TILE_CACHE  = "roadbook-tiles";        // intentionally unversioned

const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./precache.js",
  "./route-data.js",
  "./sheet.js",
  "./weather.js",
  "./manifest.webmanifest",
  "./icon.svg",
  "./vendor/leaflet.js",
  "./vendor/leaflet.css",
  /* The route files are offered from the Prep tab; precache them so
     "export to Organic Maps" still works from a hotel with no wifi. */
  "./downloads/dubai-salalah-route.gpx",
  "./downloads/dubai-salalah-route.kml"
];

/* Hosts whose responses are map tiles. Extend if you swap provider. */
const TILE_HOSTS = [
  "server.arcgisonline.com",
  "tile.openstreetmap.org",
  "a.tile.openstreetmap.org",
  "b.tile.openstreetmap.org",
  "c.tile.openstreetmap.org",
  "basemaps.cartocdn.com",
  "tile.opentopomap.org"
];

function isTileRequest(url) {
  return TILE_HOSTS.indexOf(url.hostname) !== -1;
}

/* A tile that is neither cached nor reachable. Returning this instead of
   a network error stops Leaflet from retrying in a loop offline. */
function placeholderTile() {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">' +
    '<rect width="256" height="256" fill="#1a1714"/>' +
    '<path d="M0 0l256 256M256 0L0 256" stroke="#2a2520" stroke-width="1"/>' +
    '<text x="128" y="132" fill="#5E5648" font-family="monospace" font-size="11" ' +
    'text-anchor="middle">not cached</text></svg>';
  return new Response(svg, {
    status: 200,
    headers: { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" }
  });
}

/* ---------------------------- install ---------------------------- */
/* No skipWaiting here. A new build installs into its own cache and then sits
   in `waiting` until the page asks for it, so the shell never swaps out from
   under a tile download or a half-read roadbook. The Prep tab drives it. */
self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      /* cache:"reload" bypasses the browser's own HTTP cache. Without it a
         new worker can install stale copies of the very files it exists to
         replace: GitHub Pages serves the shell with its own max-age and
         gives us no way to send no-cache there the way nginx does. */
      return cache.addAll(SHELL_ASSETS.map(function (url) {
        return new Request(url, { cache: "reload" });
      }));
    })
  );
});

/* ---------------------------- activate --------------------------- */
self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (k) {
          // drop old shell versions only — never touch the tile cache
          if (k.indexOf("roadbook-shell-") === 0 && k !== SHELL_CACHE) return caches.delete(k);
          return null;
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

/* ----------------------------- fetch ----------------------------- */
self.addEventListener("fetch", function (event) {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  if (isTileRequest(url)) {
    event.respondWith(tileStrategy(req));
  } else if (url.origin === self.location.origin) {
    event.respondWith(shellStrategy(req));
  }
});

/* --- TILES: cache first, network fallback, write-through on success --- */
function tileStrategy(request) {
  return caches.open(TILE_CACHE).then(function (cache) {
    return cache.match(request, { ignoreVary: true }).then(function (hit) {
      if (hit) return hit;                       // offline-proof path

      return fetch(request).then(function (res) {
        // opaque responses (no CORS) still cache and still render;
        // they just can't be inspected. Accept both.
        if (res && (res.ok || res.type === "opaque")) {
          cache.put(request, res.clone()).catch(function () {});
        }
        return res;
      }).catch(function () {
        return placeholderTile();
      });
    });
  });
}

/* --- SHELL: cache first, then network, then the cached index --- */
function shellStrategy(request) {
  return caches.match(request).then(function (hit) {
    if (hit) return hit;
    return fetch(request).then(function (res) {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(SHELL_CACHE).then(function (c) { c.put(request, copy).catch(function () {}); });
      }
      return res;
    }).catch(function () {
      if (request.mode === "navigate") return caches.match("./index.html");
      return new Response("", { status: 504, statusText: "Offline" });
    });
  });
}

/* ------------------- messages from the page ---------------------- */
self.addEventListener("message", function (event) {
  const msg = event.data || {};
  const reply = function (payload) {
    if (event.ports && event.ports[0]) event.ports[0].postMessage(payload);
  };

  if (msg.type === "TILE_STATS") {
    caches.open(TILE_CACHE)
      .then(function (c) { return c.keys(); })
      .then(function (keys) {
        return navigator.storage && navigator.storage.estimate
          ? navigator.storage.estimate().then(function (e) {
              return { count: keys.length, usage: e.usage || 0, quota: e.quota || 0 };
            })
          : { count: keys.length, usage: 0, quota: 0 };
      })
      .then(reply)
      .catch(function () { reply({ count: 0, usage: 0, quota: 0 }); });
  }

  if (msg.type === "CLEAR_TILES") {
    caches.delete(TILE_CACHE)
      .then(function () { reply({ ok: true }); })
      .catch(function () { reply({ ok: false }); });
  }

  /* Reported in the Prep tab so a stuck device can be identified by build. */
  if (msg.type === "VERSION") reply({ version: VERSION });

  if (msg.type === "SKIP_WAITING") self.skipWaiting();
});
