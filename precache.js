/* ============================================================
   precache.js — PART 3: PRE-CACHE UTILITY

   Why this is not a plain bounding box:
   the Dubai→Salalah box is 3.8° x 8.3°. At z15 that is roughly
   278,000 tiles — about 4 GB. Unusable.

   Instead we buffer the route polyline and cache only tiles within
   N km of the road, with the buffer tightening as zoom increases.
   Same route, ~6,000 tiles, well under 150 MB.
   ============================================================ */

const TilePrecache = (function () {
  "use strict";

  /* ---------------- slippy tile maths ---------------- */
  function lngToTileX(lng, z) { return Math.floor((lng + 180) / 360 * Math.pow(2, z)); }
  function latToTileY(lat, z) {
    const r = lat * Math.PI / 180;
    return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z));
  }
  function metresPerTile(lat, z) {
    return 40075016.686 * Math.cos(lat * Math.PI / 180) / Math.pow(2, z);
  }
  function buildUrl(template, z, x, y) {
    return template.replace("{z}", z).replace("{x}", x).replace("{y}", y);
  }

  /* Every tile within radiusKm of one point, at one zoom. */
  function tilesAround(lat, lng, z, radiusKm, out) {
    const span = Math.ceil((radiusKm * 1000) / metresPerTile(lat, z));
    const cx = lngToTileX(lng, z), cy = latToTileY(lat, z), n = Math.pow(2, z);
    for (let dx = -span; dx <= span; dx++) {
      for (let dy = -span; dy <= span; dy++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        out.add(z + "/" + x + "/" + y);
      }
    }
  }

  /* Walk the polyline dropping a sample every stepKm so the buffer
     has no gaps between widely spaced vertices. */
  function densify(line, stepKm) {
    const pts = [];
    for (let i = 0; i < line.length - 1; i++) {
      const [la1, ln1] = line[i], [la2, ln2] = line[i + 1];
      const km = haversine(la1, ln1, la2, ln2);
      const n = Math.max(1, Math.ceil(km / stepKm));
      for (let s = 0; s < n; s++) {
        pts.push([la1 + (la2 - la1) * (s / n), ln1 + (ln2 - ln1) * (s / n)]);
      }
    }
    pts.push(line[line.length - 1]);
    return pts;
  }
  function haversine(a, b, c, d) {
    const R = 6371, r = Math.PI / 180, x = (c - a) * r, y = (d - b) * r;
    const q = Math.sin(x / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(y / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(q));
  }

  /* ---------------- what to cache, tier by tier ----------------
     Wide and cheap at low zoom; tight and detailed at high zoom. */
  const PLAN = [
    { label: "Region overview", zooms: [6, 7, 8, 9], along: "route", radiusKm: 40, stepKm: 20 },
    { label: "Corridor",        zooms: [10, 11],     along: "route", radiusKm: 15, stepKm: 8  },
    { label: "Road detail",     zooms: [12, 13],     along: "route", radiusKm: 6,  stepKm: 3  },
    { label: "Around stops",    zooms: [14, 15],     along: "stops", radiusKm: 2.5, stepKm: 0 }
  ];

  /* Returns a Set of "z/x/y" keys for the whole plan. */
  function buildTileKeys(plan) {
    const keys = new Set();
    (plan || PLAN).forEach(function (tier) {
      const pts = tier.along === "stops"
        ? ROUTE.stops.map(function (s) { return [s.lat, s.lng]; })
        : densify(ROUTE.line, tier.stepKm);
      tier.zooms.forEach(function (z) {
        if (z > MAX_ZOOM || z < MIN_ZOOM) return;   // respect the ceiling
        pts.forEach(function (p) { tilesAround(p[0], p[1], z, tier.radiusKm, keys); });
      });
    });
    return keys;
  }

  /* Expand keys into real URLs for every basemap flagged precache:true. */
  function buildTileUrls(keys, sourceIds) {
    const ids = sourceIds || Object.keys(TILE_SOURCES).filter(function (k) {
      return TILE_SOURCES[k].precache;
    });
    const urls = [];
    keys.forEach(function (key) {
      const [z, x, y] = key.split("/");
      ids.forEach(function (id) { urls.push(buildUrl(TILE_SOURCES[id].url, z, x, y)); });
    });
    return urls;
  }

  /* Count and rough size, so nobody starts a 4 GB download by accident. */
  function estimate(sourceIds) {
    const keys = buildTileKeys();
    const urls = buildTileUrls(keys, sourceIds);
    const perTierBreakdown = PLAN.map(function (tier) {
      const k = buildTileKeys([tier]);
      return { label: tier.label, zooms: tier.zooms.join("–"), tiles: k.size };
    });
    return {
      uniqueTiles: keys.size,
      requests: urls.length,
      approxMB: Math.round(urls.length * 18 / 1024),   // ~18 KB per tile, empirical
      breakdown: perTierBreakdown
    };
  }

  /* ---------------- the download itself ----------------
     Bounded concurrency, abortable, writes straight into the same
     Cache API bucket the service worker reads from. Requests go
     through the SW too, so a tile fetched here is a tile cached
     everywhere. */
  const TILE_CACHE = "roadbook-tiles";
  let controller = null;

  async function run(options) {
    const opts = options || {};
    const onProgress = opts.onProgress || function () {};
    const concurrency = opts.concurrency || 6;

    if (!("caches" in window)) throw new Error("Cache API unavailable — needs HTTPS or localhost");
    if (!navigator.onLine) throw new Error("You are offline. Connect to wifi and try again.");

    controller = new AbortController();
    const cache = await caches.open(TILE_CACHE);
    const urls = buildTileUrls(buildTileKeys(), opts.sources);

    let done = 0, stored = 0, skipped = 0, failed = 0;
    let cursor = 0;

    async function worker() {
      while (cursor < urls.length) {
        if (controller.signal.aborted) return;
        const url = urls[cursor++];
        try {
          const already = await cache.match(url, { ignoreVary: true });
          if (already) { skipped++; }
          else {
            const res = await fetch(url, { mode: "cors", signal: controller.signal });
            if (res && res.ok) { await cache.put(url, res.clone()); stored++; }
            else { failed++; }
          }
        } catch (e) {
          if (e.name === "AbortError") return;
          failed++;
        }
        done++;
        if (done % 5 === 0 || done === urls.length) {
          onProgress({ done: done, total: urls.length, stored: stored, skipped: skipped, failed: failed });
        }
      }
    }

    const pool = [];
    for (let i = 0; i < concurrency; i++) pool.push(worker());
    await Promise.all(pool);

    onProgress({ done: done, total: urls.length, stored: stored, skipped: skipped, failed: failed });
    return { total: urls.length, done: done, stored: stored, skipped: skipped, failed: failed,
             aborted: controller.signal.aborted };
  }

  function abort() { if (controller) controller.abort(); }

  async function stats() {
    if (!("caches" in window)) return { count: 0, usage: 0, quota: 0 };
    const cache = await caches.open(TILE_CACHE);
    const keys = await cache.keys();
    let usage = 0, quota = 0;
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      usage = e.usage || 0; quota = e.quota || 0;
    }
    return { count: keys.length, usage: usage, quota: quota };
  }

  async function clear() {
    if (!("caches" in window)) return false;
    return caches.delete(TILE_CACHE);
  }

  /* Ask the browser not to evict us under storage pressure. */
  async function persist() {
    if (navigator.storage && navigator.storage.persist) {
      try { return await navigator.storage.persist(); } catch (e) { return false; }
    }
    return false;
  }

  return {
    PLAN: PLAN,
    buildTileKeys: buildTileKeys,
    buildTileUrls: buildTileUrls,
    estimate: estimate,
    run: run,
    abort: abort,
    stats: stats,
    clear: clear,
    persist: persist
  };
})();
