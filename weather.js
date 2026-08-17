/* ============================================================
   weather.js — PART 5: FORECAST ALONG THE ROUTE

   A single number for "the weather today" is useless on this
   drive. On 19 Aug the Aqabat descent sits at 100 m visibility
   at 07:00 and 12 km by 10:00, while Adam is 42°C at midday —
   same day, same trip, 400 km apart. So the forecast is fetched
   per stop and read at the hour you are scheduled to be there.

   Open-Meteo: keyless, CORS-enabled, and one request covers all
   13 stops (comma-separated coordinates return an array in the
   same order). Nothing here needs an account, which keeps the
   app's "no keys, nothing to expire" property intact.

   Cached in localStorage, not the Cache API: it is small, and it
   must survive independently of the tile caches the user clears.
   Offline, the last fetch is shown with its age stated plainly —
   a stale forecast you know is stale still beats no forecast.

   Depends on: route-data.js
   ============================================================ */

const RoadbookWeather = (function () {
  "use strict";

  const ENDPOINT = "https://api.open-meteo.com/v1/forecast";
  const FIELDS = ["temperature_2m", "apparent_temperature", "precipitation_probability",
                  "visibility", "wind_speed_10m", "weather_code"];
  const KEY = "rb_wx";
  const TZ = "Asia/Dubai";              // UAE and Oman are both UTC+4, no DST
  const STALE_MS = 3 * 3600 * 1000;

  /* WMO weather codes. Glyphs, not an icon font — nothing to load. */
  const CODES = {
    0:["Clear","☀"], 1:["Mainly clear","☀"], 2:["Partly cloudy","⛅"], 3:["Overcast","☁"],
    45:["Fog","≡"], 48:["Rime fog","≡"],
    51:["Light drizzle","░"], 53:["Drizzle","░"], 55:["Heavy drizzle","░"],
    56:["Freezing drizzle","░"], 57:["Freezing drizzle","░"],
    61:["Light rain","☂"], 63:["Rain","☂"], 65:["Heavy rain","☂"],
    66:["Freezing rain","☂"], 67:["Freezing rain","☂"],
    71:["Light snow","❄"], 73:["Snow","❄"], 75:["Heavy snow","❄"], 77:["Snow grains","❄"],
    80:["Light showers","☂"], 81:["Showers","☂"], 82:["Violent showers","☂"],
    85:["Snow showers","❄"], 86:["Snow showers","❄"],
    95:["Thunderstorm","⚡"], 96:["Thunderstorm, hail","⚡"], 99:["Thunderstorm, hail","⚡"]
  };
  function describe(code) { return CODES[code] || ["—", "·"]; }

  let data = load();

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch (e) { return null; }
  }
  function save(d) {
    try { localStorage.setItem(KEY, JSON.stringify(d)); } catch (e) {}
  }

  /* ---------------- dates ----------------
     Schedule minutes can exceed 1440 when a day runs past midnight, so the
     hour has to roll the date forward rather than wrap. */
  function isoAt(dateStr, minutes) {
    const dayShift = Math.floor(minutes / 1440);
    const hour = Math.floor((minutes - dayShift * 1440) / 60);
    const d = new Date(dateStr + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + dayShift);
    return d.toISOString().slice(0, 10) + "T" + String(hour).padStart(2, "0") + ":00";
  }
  function tripDates() {
    const ds = Object.keys(ROUTE.days).map(k => ROUTE.days[k].date).filter(Boolean).sort();
    return ds.length ? { start: ds[0], end: ds[ds.length - 1] } : null;
  }

  /* ---------------- fetch ---------------- */
  function buildUrl() {
    const span = tripDates();
    if (!span) return null;
    const lat = ROUTE.stops.map(s => s.lat.toFixed(4)).join(",");
    const lng = ROUTE.stops.map(s => s.lng.toFixed(4)).join(",");
    return ENDPOINT +
      "?latitude=" + lat + "&longitude=" + lng +
      "&hourly=" + FIELDS.join(",") +
      "&timezone=" + encodeURIComponent(TZ) +
      "&start_date=" + span.start + "&end_date=" + span.end;
  }

  /* Flatten to parallel arrays per stop; the time axis is shared. */
  function normalise(json) {
    const list = Array.isArray(json) ? json : [json];
    if (!list.length || !list[0].hourly) throw new Error("Unexpected forecast shape");
    return {
      fetched: Date.now(),
      times: list[0].hourly.time,
      stops: list.map(loc => ({
        t:    loc.hourly.temperature_2m,
        feel: loc.hourly.apparent_temperature,
        pp:   loc.hourly.precipitation_probability,
        vis:  loc.hourly.visibility,
        wind: loc.hourly.wind_speed_10m,
        code: loc.hourly.weather_code
      }))
    };
  }

  let inflight = null;
  function refresh(force) {
    if (inflight) return inflight;
    if (!force && data && Date.now() - data.fetched < STALE_MS) return Promise.resolve(data);
    if (!navigator.onLine) return Promise.reject(new Error("offline"));
    const url = buildUrl();
    if (!url) return Promise.reject(new Error("No trip dates set"));

    inflight = fetch(url, { mode: "cors" })
      .then(r => {
        if (!r.ok) throw new Error("Forecast service returned " + r.status);
        return r.json();
      })
      .then(j => {
        /* Outside the forecast window Open-Meteo replies with an error object
           rather than a failing status. */
        if (j && j.error) throw new Error(j.reason || "No forecast for these dates");
        data = normalise(j);
        save(data);
        return data;
      })
      .finally(() => { inflight = null; });
    return inflight;
  }

  /* ---------------- reading ---------------- */
  function atStop(gi, dateStr, minutes) {
    if (!data || !data.stops[gi]) return null;
    const i = data.times.indexOf(isoAt(dateStr, minutes));
    if (i < 0) return null;
    const s = data.stops[gi];
    const [label, glyph] = describe(s.code[i]);
    return {
      temp: s.t[i], feels: s.feel[i], rain: s.pp[i],
      vis: s.vis[i], wind: s.wind[i], code: s.code[i],
      label, glyph
    };
  }

  /* Thresholds are for this drive specifically: a Gulf summer crossing with a
     mountain descent at the end. Heat is the day-long risk, visibility is the
     one that kills on the Aqabat. */
  function warnings(rows) {
    const out = [];
    const fog = rows.filter(r => r.wx && r.wx.vis != null && r.wx.vis < 1000);
    if (fog.length) {
      const w = fog[0];
      out.push({ level: "high", text:
        `Visibility ${Math.round(w.wx.vis)} m at ${w.name} around ${w.time}. ` +
        `Lights on, slow down, and add time rather than pushing through it.` });
    }
    /* 42°C apparent, not 45: on the 18 Aug run the hottest point is 44°C at
       the last UAE fuel stop and 41°C standing at the border for 45 minutes.
       A threshold that misses that is a threshold that never fires. */
    const hot = rows.filter(r => r.wx && r.wx.feels >= 42);
    if (hot.length) {
      const w = hot.reduce((a, b) => a.wx.feels > b.wx.feels ? a : b);
      out.push({ level: "warn", text:
        `Feels like ${Math.round(w.wx.feels)}°C at ${w.name} around ${w.time}. ` +
        `Tyre pressures rise in this heat and so does blowout risk — check them cold.` });
    }
    const wet = rows.filter(r => r.wx && r.wx.rain >= 50);
    if (wet.length) {
      out.push({ level: "warn", text:
        `Rain likely (${wet[0].wx.rain}%) around ${wet[0].name} at ${wet[0].time}.` });
    }
    const windy = rows.filter(r => r.wx && r.wx.wind >= 40);
    if (windy.length) {
      out.push({ level: "warn", text:
        `Crosswinds near ${Math.round(windy[0].wx.wind)} km/h at ${windy[0].name}. ` +
        `Blowing sand and unsteady high-sided traffic.` });
    }
    return out;
  }

  function age() {
    if (!data) return null;
    const m = Math.round((Date.now() - data.fetched) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return m + " min ago";
    const h = Math.round(m / 60);
    return h < 24 ? h + " h ago" : Math.round(h / 24) + " d ago";
  }

  return {
    refresh, atStop, warnings, age, describe,
    has: () => !!data,
    fetchedAt: () => (data ? data.fetched : null)
  };
})();
