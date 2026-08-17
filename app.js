/* ============================================================
   app.js — PART 1: MAP IMPLEMENTATION
   Depends on: leaflet, route-data.js
   Exposes: RoadbookMap (map, layers, bounds) for precache.js
   ============================================================ */

const RoadbookMap = (function () {
  "use strict";

  let map = null;
  const tileLayers = {};
  let routeBounds = null;

  /* ---- bounding box straight off the route, with a small pad ---- */
  function computeBounds(padDeg) {
    const p = padDeg || 0.25;
    const lats = ROUTE.line.map(c => c[0]);
    const lngs = ROUTE.line.map(c => c[1]);
    return L.latLngBounds(
      [Math.min.apply(null, lats) - p, Math.min.apply(null, lngs) - p],
      [Math.max.apply(null, lats) + p, Math.max.apply(null, lngs) + p]
    );
  }

  /* ---- divIcon markers: no image files, so nothing extra to cache ---- */
  function markerIcon(type, index) {
    const t = ROUTE.types[type] || ROUTE.types.scenic;
    return L.divIcon({
      className: "rb-pin-wrap",
      html:
        '<div class="rb-pin" style="--pin:' + t.color + '">' +
          '<span class="rb-pin-glyph">' + t.glyph + '</span>' +
          '<span class="rb-pin-num">' + index + '</span>' +
        '</div>',
      iconSize: [30, 30],
      iconAnchor: [15, 15],
      popupAnchor: [0, -16]
    });
  }

  /* A place is visited once on the way out and once on the way home, so the
     popup describes the place and lists every visit rather than assuming one. */
  function visitsTo(placeIndex) {
    const out = [];
    Object.keys(ROUTE.days).forEach(function (d) {
      ROUTE.days[d].legs.forEach(function (leg) {
        if (leg.at === placeIndex) out.push({ day: ROUTE.days[d], leg: leg });
      });
    });
    return out;
  }

  function popupHtml(place, index) {
    const t = ROUTE.types[place.type] || {};
    const visits = visitsTo(index);
    return (
      '<div class="rb-pop">' +
        '<div class="rb-pop-kicker">' + (t.label || place.type) + '</div>' +
        '<h3>' + (index + 1) + '. ' + place.name + '</h3>' +
        visits.map(function (v) {
          return '<p class="rb-pop-visit"><b>' + v.day.tab + '</b> · ' + v.leg.sub +
                 (v.leg.stay ? ' · ' + v.leg.stay + ' min' : '') + '</p>';
        }).join("") +
        '<div class="rb-pop-coord">' + place.lat.toFixed(5) + ', ' + place.lng.toFixed(5) + '</div>' +
        '<div class="rb-pop-links">' +
          '<a href="geo:' + place.lat + ',' + place.lng + '?q=' + place.lat + ',' + place.lng +
            '(' + encodeURIComponent(place.name) + ')">Open in map app</a>' +
          '<span>' + visits.length + (visits.length === 1 ? ' visit' : ' visits') + '</span>' +
        '</div>' +
      '</div>'
    );
  }

  const markers = [];
  function addMarkers() {
    const group = L.layerGroup().addTo(map);
    ROUTE.stops.forEach(function (place, i) {
      const m = L.marker([place.lat, place.lng], {
        icon: markerIcon(place.type, i + 1),
        title: place.name,
        keyboard: true,
        alt: place.name
      })
        .bindPopup(popupHtml(place, i), { maxWidth: 280 })
        .addTo(group);
      markers[i] = m;
    });
    return group;
  }

  function addRouteLine() {
    // casing underneath, bright core on top — readable on both basemaps
    L.polyline(ROUTE.line, { color: "#000", weight: 8, opacity: 0.35, lineJoin: "round" }).addTo(map);
    return L.polyline(ROUTE.line, { color: "#F5A623", weight: 3.5, lineJoin: "round" }).addTo(map);
  }

  function init(containerId) {
    routeBounds = computeBounds();

    map = L.map(containerId, {
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,          // ceiling: keeps the tile pyramid affordable
      maxBounds: computeBounds(1.5),
      maxBoundsViscosity: 0.6,
      zoomControl: true,
      attributionControl: true
    });

    Object.keys(TILE_SOURCES).forEach(function (key) {
      const src = TILE_SOURCES[key];
      tileLayers[src.label] = L.tileLayer(src.url, {
        maxZoom: MAX_ZOOM,
        minZoom: MIN_ZOOM,
        attribution: src.attribution,
        crossOrigin: true,          // lets the service worker cache the response
        keepBuffer: 4,
        // shown when a tile is neither cached nor reachable
        errorTileUrl:
          "data:image/svg+xml;charset=UTF-8," +
          encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">' +
            '<rect width="256" height="256" fill="#1a1714"/>' +
            '<path d="M0 0l256 256M256 0L0 256" stroke="#2a2520" stroke-width="1"/>' +
            '<text x="128" y="132" fill="#5E5648" font-family="monospace" font-size="11" ' +
            'text-anchor="middle">not cached</text></svg>'
          )
      });
    });

    tileLayers.Streets.addTo(map);
    L.control.layers(tileLayers, null, { position: "topright", collapsed: true }).addTo(map);
    L.control.scale({ imperial: false, position: "bottomleft" }).addTo(map);

    addRouteLine();
    addMarkers();
    map.fitBounds(routeBounds, { padding: [10, 10] });

    return map;
  }

  /* ---- live position, GPS only, works with no data connection ---- */
  let meMarker = null, meCircle = null;
  function locate() {
    return new Promise(function (resolve, reject) {
      if (!navigator.geolocation) return reject(new Error("No geolocation in this browser"));
      navigator.geolocation.getCurrentPosition(
        function (pos) {
          const ll = [pos.coords.latitude, pos.coords.longitude];
          if (!meMarker) {
            meMarker = L.circleMarker(ll, {
              radius: 7, color: "#fff", weight: 2, fillColor: "#5E9FD4", fillOpacity: 1
            }).addTo(map).bindPopup("You are here");
            meCircle = L.circle(ll, { radius: pos.coords.accuracy, color: "#5E9FD4", weight: 1, fillOpacity: 0.12 }).addTo(map);
          } else {
            meMarker.setLatLng(ll);
            meCircle.setLatLng(ll).setRadius(pos.coords.accuracy);
          }
          map.setView(ll, Math.max(map.getZoom(), 12));
          resolve({ lat: ll[0], lng: ll[1], accuracy: pos.coords.accuracy, nearest: nearestStop(ll[0], ll[1]) });
        },
        reject,
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
      );
    });
  }

  function haversine(a, b, c, d) {
    const R = 6371, r = Math.PI / 180, x = (c - a) * r, y = (d - b) * r;
    const q = Math.sin(x / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(y / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(q));
  }
  function nearestStop(lat, lng) {
    let best = null, bestD = Infinity;
    ROUTE.stops.forEach(function (s) {
      const d = haversine(lat, lng, s.lat, s.lng);
      if (d < bestD) { bestD = d; best = s; }
    });
    return { stop: best, km: bestD };
  }

  return {
    init: init,
    locate: locate,
    nearestStop: nearestStop,
    getMap: function () { return map; },
    getBounds: function () { return routeBounds; },

    /* Centre a stop in the map area the sheet is NOT covering.
       coveredPx is how much of the viewport the sheet occupies; shifting
       the centre down by half of that lifts the marker into what is
       actually visible, rather than parking it behind the sheet. */
    focusStop: function (i, coveredPx) {
      const s = ROUTE.stops[i];
      if (!s) return;
      const zoom = Math.min(13, MAX_ZOOM);
      const target = map.project([s.lat, s.lng], zoom).add([0, (coveredPx || 0) / 2]);
      map.flyTo(map.unproject(target, zoom), zoom, { duration: 0.6 });
      const m = markers[i];
      if (m) map.once("moveend", function () { m.openPopup(); });
    },

    /* Kept for callers that just want the pin centred. */
    flyToStop: function (i) {
      const s = ROUTE.stops[i];
      if (s) map.setView([s.lat, s.lng], 14);
    }
  };
})();
