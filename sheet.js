/* ============================================================
   sheet.js — PART 4: THE ROADBOOK, AS A BOTTOM SHEET

   Replaces roadbook.html. That page carried its own copy of the
   trip and its own schematic SVG map; both are gone. The map
   behind this sheet is the real one, and the data comes from
   route-data.js, so the two can no longer disagree.

   Three detents: peek (next stop only), half, full. Dragging is
   pointer-based so it works with a mouse as well as a thumb, and
   the handle is a button, so it works with neither.

   A stop is identified by "<day>:<legIndex>", not by place: the
   return visits every place a second time, and marking Haima done
   on the way south must not tick it off on the way home.

   Depends on: route-data.js, app.js (RoadbookMap), precache.js,
   weather.js
   ============================================================ */

const RoadbookSheet = (function () {
  "use strict";

  const $  = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const pad = n => String(n).padStart(2, "0");
  const esc = s => String(s).replace(/[&<>"]/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const store = {
    get(k, f) { try { const v = localStorage.getItem("rb_" + k); return v == null ? f : JSON.parse(v); } catch (e) { return f; } },
    set(k, v) { try { localStorage.setItem("rb_" + k, JSON.stringify(v)); } catch (e) {} }
  };

  /* ---------------- time ---------------- */
  let H12 = store.get("h12", false);
  function parse(v) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || "").trim());
    if (!m) return null;
    const h = +m[1], mi = +m[2];
    return (h > 23 || mi > 59) ? null : h * 60 + mi;
  }
  function fmt(m) {
    m = ((Math.round(m) % 1440) + 1440) % 1440;
    const h = Math.floor(m / 60), mm = m % 60;
    if (!H12) return pad(h) + ":" + pad(mm);
    const ap = h < 12 ? "am" : "pm";
    return ((h % 12) || 12) + ":" + pad(mm) + ap;
  }
  function dur(m) {
    m = Math.max(0, Math.round(m));
    const h = Math.floor(m / 60), mm = m % 60;
    return h ? (mm ? h + " h " + mm + " m" : h + " h") : mm + " m";
  }
  const bearing = (a, b, c, d) => {
    const r = Math.PI / 180;
    const y = Math.sin((d - b) * r) * Math.cos(c * r);
    const x = Math.cos(a * r) * Math.sin(c * r) - Math.sin(a * r) * Math.cos(c * r) * Math.cos((d - b) * r);
    return (Math.atan2(y, x) / r + 360) % 360;
  };
  const compass = d => ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"][Math.round(d / 22.5) % 16];

  /* ---------------- trip indexing ---------------- */
  const DAYS = Object.keys(ROUTE.days).map(Number).sort((a, b) => a - b);

  /* A leg joined to the place it visits. `key` is the stable identity used
     for done/open state; `gi` is the place, which the map and forecast use. */
  function dayList(day) {
    return ROUTE.days[day].legs.map((l, i) => {
      const p = ROUTE.stops[l.at];
      return {
        leg: l, i, day, gi: l.at, key: day + ":" + i,
        name: p.name, lat: p.lat, lng: p.lng,
        type: l.type || p.type
      };
    });
  }

  /* Stops are keyed "<day>:<legIndex>". Renumbering the days — which happened
     when the Salalah days were inserted between the drive out and the drive
     home — silently repoints every saved tick at a different stop. Bump this
     whenever day numbers move, and stale progress is dropped rather than
     shown against the wrong place. */
  const SCHEMA = 2;
  if (store.get("schema", 1) !== SCHEMA) {
    store.set("done", {});
    store.set("schema", SCHEMA);
  }

  const state = {
    depart: {}, anchor: {},
    open: {}, done: store.get("done", {}), sat: {}, satz: {},
    tab: "d" + DAYS[0]
  };
  DAYS.forEach(d => {
    state.depart[d] = store.get("d" + d + "_dep", ROUTE.days[d].depart);
    state.anchor[d] = null;
  });

  function schedule(day) {
    const list = dayList(day);
    let t = parse(state.depart[day]);
    if (t === null) t = parse(ROUTE.days[day].depart);
    return list.map((e, i) => {
      if (i > 0) t += e.leg.drive;
      if (state.anchor[day] && state.anchor[day].key === e.key) t = state.anchor[day].t;
      const arrive = t;
      t += e.leg.stay;
      return { arrive, leave: t };
    });
  }
  function kmRemaining(list, i) {
    let k = 0;
    for (let j = i + 1; j < list.length; j++) k += list[j].leg.km;
    return k;
  }
  function dayKm(day) {
    return ROUTE.days[day].legs.reduce((t, l) => t + l.km, 0);
  }

  /* ---------------- satellite tiles, cached in IndexedDB ----------------
     Deliberately not the Cache API bucket the basemap uses: these are
     small per-place grids the user downloads separately, and clearing
     one should not clear the other. */
  const SAT = {
    url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    fx: (lng, z) => (lng + 180) / 360 * Math.pow(2, z),
    fy: (lat, z) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z); },
    db: null,
    open() {
      if (SAT.db) return SAT.db;
      SAT.db = new Promise((res, rej) => {
        let r; try { r = indexedDB.open("rb_tiles", 1); } catch (e) { return rej(e); }
        r.onupgradeneeded = () => { try { r.result.createObjectStore("t"); } catch (e) {} };
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      }).catch(() => null);
      return SAT.db;
    },
    async tx(mode, fn, fallback) {
      const db = await SAT.open(); if (!db) return fallback;
      return new Promise(res => {
        try { const q = fn(db.transaction("t", mode).objectStore("t"));
          q.onsuccess = () => res(q.result === undefined ? fallback : q.result);
          q.onerror = () => res(fallback);
        } catch (e) { res(fallback); }
      });
    },
    get(k)    { return SAT.tx("readonly",  s => s.get(k), null); },
    put(k, b) { return SAT.tx("readwrite", s => s.put(b, k), null); },
    clear()   { return SAT.tx("readwrite", s => s.clear(), null); },
    count()   { return SAT.tx("readonly",  s => s.count(), 0); },
    tilesFor(lat, lng, z) {
      const cx = Math.floor(SAT.fx(lng, z)), cy = Math.floor(SAT.fy(lat, z)), out = [];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++)
        out.push({ z, x: cx + dx, y: cy + dy, k: `${z}/${cx + dx}/${cy + dy}` });
      return out;
    },
    async fetchTile(t) {
      const hit = await SAT.get(t.k); if (hit) return hit;
      if (!navigator.onLine) return null;
      try {
        const r = await fetch(SAT.url(t.z, t.x, t.y), { mode: "cors" });
        if (!r.ok) return null;
        const b = await r.blob();
        await SAT.put(t.k, b);
        return b;
      } catch (e) { return null; }
    }
  };

  async function paintSat(key) {
    const host = $("#sat-" + CSS.escape(key)); if (!host) return;
    const gi = +host.dataset.gi, p = ROUTE.stops[gi], z = state.satz[key] || 16;
    const tiles = SAT.tilesFor(p.lat, p.lng, z);
    const grid = $(".satgrid", host);
    grid.innerHTML = tiles.map(t => `<img alt="" data-k="${t.k}" class="miss">`).join("");
    const cx = Math.floor(SAT.fx(p.lng, z)), cy = Math.floor(SAT.fy(p.lat, z));
    const xh = $(".xhair", host);
    xh.style.left = ((SAT.fx(p.lng, z) - (cx - 1)) / 3 * 100).toFixed(2) + "%";
    xh.style.top  = ((SAT.fy(p.lat, z) - (cy - 1)) / 3 * 100).toFixed(2) + "%";
    let got = 0;
    await Promise.all(tiles.map(async t => {
      const b = await SAT.fetchTile(t);
      const img = $(`img[data-k="${CSS.escape(t.k)}"]`, grid);
      if (b && img) { img.src = URL.createObjectURL(b); img.classList.remove("miss"); got++; }
    }));
    const note = $(".satnote", host);
    if (note) note.textContent = got === 9
      ? `${z === 16 ? "Close" : "Wide"} view · ${z === 16 ? "~3.4" : "~27"} km across`
      : (got === 0 ? "No imagery — cache it on wifi from the Prep tab first."
                   : `${got} of 9 tiles available offline.`);
  }

  async function satDownloadAll(wide, onProg) {
    const list = [];
    ROUTE.stops.forEach(p => {
      SAT.tilesFor(p.lat, p.lng, 16).forEach(t => list.push(t));
      if (wide) SAT.tilesFor(p.lat, p.lng, 13).forEach(t => list.push(t));
    });
    const seen = new Set();
    const uniq = list.filter(t => seen.has(t.k) ? false : (seen.add(t.k), true));
    let done = 0, ok = 0;
    for (const t of uniq) {
      if (await SAT.fetchTile(t)) ok++;
      onProg(++done, uniq.length, ok);
    }
    return { done, ok, total: uniq.length };
  }

  /* ---------------- weather ----------------
     Read per stop at the hour the schedule puts you there. The same day is
     42°C at Adam and 20°C in fog on the Aqabat, 400 km apart, so a single
     figure for "today" would be worse than none. */
  function weatherRows(day) {
    const list = dayList(day), sch = schedule(day), date = ROUTE.days[day].date;
    return list.map((e, i) => ({
      key: e.key, gi: e.gi, name: e.name,
      time: fmt(sch[i].arrive),
      wx: RoadbookWeather.atStop(e.gi, date, sch[i].arrive)
    }));
  }

  function renderTripWeather(activeDay) {
    if (!RoadbookWeather.has()) {
      return `<div class="wx"><div class="wxhd"><span>Trip weather</span><span class="grow"></span>
        <button class="btn ghost" id="wxGet">${navigator.onLine ? "Load" : "Offline"}</button></div>
        <p class="tiny muted" style="margin:0 12px 10px">${navigator.onLine
          ? "Not loaded yet. Fetch it on wifi and it stays on the device for the drive."
          : "No forecast stored. Connect once and it is kept for the trip."}</p></div>`;
    }
    const rows = DAYS.map(d => {
      const r = weatherRows(d).filter(x => x.wx);
      return { day: d, meta: ROUTE.days[d], span: RoadbookWeather.span(r), warns: RoadbookWeather.warnings(r) };
    });
    const any = rows.some(r => r.span);
    if (!any) {
      return `<div class="wx"><div class="wxhd"><span>Trip weather</span><span class="grow"></span>
        <button class="btn ghost" id="wxGet">Reload</button></div>
        <p class="tiny muted" style="margin:0 12px 10px">The stored forecast doesn't reach these dates.
        Forecasts run about 16 days ahead — reload closer to the trip.</p></div>`;
    }
    return `<div class="wx">
      <div class="wxhd"><span>Trip weather</span><span class="grow"></span>
        <span class="tiny muted">${navigator.onLine ? "" : "offline · "}${RoadbookWeather.age()}</span>
        <button class="btn ghost" id="wxGet" aria-label="Refresh forecast">↻</button></div>
      ${rows.map(r => {
        const worst = r.warns[0];
        return `<div class="wxday ${r.day === activeDay ? "on" : ""} ${worst && worst.level === "high" ? "bad" : ""}"
                     data-wxday="${r.day}" role="button" tabindex="0">
          <b>${esc(r.meta.tab)}</b>
          <span>${esc(r.meta.leg)}</span>
          ${r.span ? `<i>${r.span.glyph}</i><u>${r.span.lo}°–${r.span.hi}°</u>` : `<u class="muted">—</u>`}
          ${worst ? `<s class="${worst.level}">${esc(worst.short)}</s>` : `<s class="ok">clear</s>`}
        </div>`;
      }).join("")}
    </div>`;
  }

  function wxDetail(wx) {
    if (!wx) return "";
    const bits = [
      `<b>${Math.round(wx.temp)}°</b>`,
      `feels ${Math.round(wx.feels)}°`,
      esc(wx.label),
      `wind ${Math.round(wx.wind)} km/h`
    ];
    /* Below 10 km, show a decimal. Rounding 2,660 m to "3 km" hides exactly
       the range that matters on the Aqabat — murky but drivable. */
    if (wx.vis != null) bits.push(wx.vis < 2000
      ? `<em class="bad">visibility ${Math.round(wx.vis)} m</em>`
      : `visibility ${(wx.vis / 1000).toFixed(wx.vis < 10000 ? 1 : 0)} km`);
    if (wx.rain >= 20) bits.push(`${wx.rain}% rain`);
    return `<div class="wxstop"><i>${wx.glyph}</i><div>${bits.join(" · ")}</div></div>`;
  }

  /* ---------------- day view ---------------- */
  function renderDay(day) {
    const list = dayList(day), sch = schedule(day), meta = ROUTE.days[day];
    const dep = parse(state.depart[day]) ?? parse(meta.depart);
    const date = meta.date;

    let h = renderTripWeather(day) + `<div class="ctrl">
      <label for="dep-${day}">Depart</label>
      <input type="time" id="dep-${day}" value="${state.depart[day]}">
      <button class="btn ghost" data-reset="${day}">Reset</button>
      <button class="btn ghost" id="fmtBtn">${H12 ? "12h" : "24h"}</button>
      <span class="grow"></span>
      <span class="mono tiny muted">${dayKm(day)} km · ${dur(sch[sch.length - 1].arrive - dep)}</span>
    </div>
    <p class="tiny muted" style="margin:10px 2px 14px">${esc(meta.blurb)}</p>`;

    list.forEach((e, i) => {
      const l = e.leg, key = e.key;
      const done = !!state.done[key], open = !!state.open[key];
      const rem = kmRemaining(list, i), nxt = list[i + 1];
      const wx = RoadbookWeather.atStop(e.gi, date, sch[i].arrive);

      if (i > 0) {
        const warn = l.km >= 180;
        h += `<div class="gap ${warn ? "warn" : ""}">${warn ? "&#9888; " : ""}${l.km} km · ${dur(l.drive)} driving${warn ? " · longest gap without fuel" : ""}</div>`;
      }
      h += `<article class="stop ${l.fuel ? "fuel" : ""} ${done ? "done" : ""} ${i === 0 ? "origin" : ""}" data-key="${key}">
        <div class="stophd" data-toggle="${key}" role="button" tabindex="0">
          <div class="eta">${fmt(sch[i].arrive)}${wx ? `<em>${Math.round(wx.temp)}° ${wx.glyph}</em>` : ""}</div>
          <div class="num" style="--pin:${(ROUTE.types[e.type] || {}).color || "#888"}">${e.gi + 1}</div>
          <div class="sname">${esc(e.name)}<small>${esc(l.sub.toUpperCase())}${l.stay ? " · " + l.stay + " MIN" : ""}</small></div>
          <div class="chev">${open ? "▲" : "▼"}</div>
        </div>
        <div class="stopbody ${open ? "" : "hide"}">
          ${wxDetail(wx)}
          <div class="chips">${l.svc.map(v => `<span class="chip">${esc(v)}</span>`).join("")}</div>
          <p>${esc(l.note)}</p>
          <div class="lm"><b>How you'll know you're there</b>${esc(l.lm)}</div>
          <p class="tiny muted" style="margin-bottom:10px">
            ${sch[i].leave !== sch[i].arrive ? `Leave by <b class="mono">${fmt(sch[i].leave)}</b> · ` : ""}${rem} km still to go</p>
          <div class="acts">
            <span class="coord">${e.lat.toFixed(5)}, ${e.lng.toFixed(5)}</span>
            <button class="btn" data-show="${e.gi}">Show on map</button>
            <button class="btn ${state.sat[key] ? "on" : ""}" data-sat="${key}">Satellite</button>
            <a class="btn" href="geo:${e.lat},${e.lng}?q=${e.lat},${e.lng}(${encodeURIComponent(e.name)})">Any map app</a>
            <button class="btn" data-here="${key}">I'm here now</button>
            <button class="btn" data-done="${key}">${done ? "Undo" : "Mark done"}</button>
          </div>
          ${state.sat[key] ? `<div class="sat" id="sat-${key}" data-gi="${e.gi}">
            <div class="satgrid"></div><div class="xhair"></div>
            <div class="satbar">
              <button class="btn ${(state.satz[key] || 16) === 16 ? "on" : ""}" data-satz="16" data-key="${key}">Close</button>
              <button class="btn ${(state.satz[key] || 16) === 13 ? "on" : ""}" data-satz="13" data-key="${key}">Wide</button>
              <span class="tiny muted satnote">Loading…</span>
            </div>
            <div class="satattr">Imagery © Esri, Maxar, Earthstar Geographics</div>
          </div>` : ""}
          ${nxt ? `<p class="tiny muted nextline">
            <b>Next:</b> ${esc(nxt.name)} — ${nxt.leg.km} km, ${dur(nxt.leg.drive)}, bearing ${Math.round(bearing(e.lat, e.lng, nxt.lat, nxt.lng))}° ${compass(bearing(e.lat, e.lng, nxt.lat, nxt.lng))}</p>` : ""}
        </div>
      </article>`;
    });
    return h;
  }

  /* ---------------- peek ---------------- */
  function nextStop() {
    for (const d of DAYS) {
      const list = dayList(d);
      for (let i = 0; i < list.length; i++) if (!state.done[list[i].key]) return list[i];
    }
    return null;
  }
  function renderPeek() {
    const e = nextStop(), el = $("#peekBody");
    if (!e) {
      el.innerHTML = `<div class="pk-kick">Trip complete</div>
        <div class="pk-name">Home<span class="pk-far">every stop done</span></div>`;
      return;
    }
    const sch = schedule(e.day);
    const eta = fmt(sch[e.i].arrive);
    const wx = RoadbookWeather.atStop(e.gi, ROUTE.days[e.day].date, sch[e.i].arrive);
    const first = e.i === 0;
    el.innerHTML =
      `<div class="pk-kick">Next · ${esc(ROUTE.days[e.day].tab)} · ${e.i + 1} of ${dayList(e.day).length}</div>
       <div class="pk-name">${esc(e.name)}<span class="pk-far">${esc(e.leg.sub)}</span></div>
       <div class="pk-num">${first ? "<b>Start</b>" : `<b>${e.leg.km}</b><small>km</small>`}
         <i>${first ? "Depart " : "ETA "}${eta}${wx ? ` · ${Math.round(wx.temp)}°` : ""}</i></div>`;
  }

  /* ---------------- prep view ---------------- */
  function checkList(id, items) {
    const done = store.get(id, {});
    return items.map((t, i) =>
      `<label class="chk"><input type="checkbox" data-chk="${id}" data-i="${i}" ${done[i] ? "checked" : ""}><span>${esc(t)}</span></label>`
    ).join("");
  }
  function gapTable() {
    return DAYS.map(d => {
      const list = dayList(d);
      return `<div class="row" style="border-top:0;padding-top:12px"><span><b>${esc(ROUTE.days[d].tab)}</b> ${esc(ROUTE.days[d].leg)}</span><span>${dayKm(d)} km</span></div>` +
        list.slice(1).map((e, i) =>
          `<div class="row ${e.leg.km >= 180 ? "warn" : ""}"><span>${esc(list[i].name)} → ${esc(e.name)}</span><span>${e.leg.km} km</span></div>`
        ).join("");
    }).join("");
  }
  function renderPrep() {
    const totalKm = DAYS.reduce((t, d) => t + dayKm(d), 0);
    return `
    <h2>Offline basemap</h2>
    <div class="card">
      <p class="tiny" style="margin-top:0">Caches the road corridor and the area around every stop, so the map behind this sheet keeps working when the data drops. The return uses the same road, so this covers both directions. Do it on wifi before you leave.</p>
      <div id="estRows"></div>
      <div class="bar"><i id="bar"></i></div>
      <div class="tiny muted" id="stat">Checking what's already stored…</div>
      <div class="acts" style="margin-top:12px">
        <button class="btn primary" id="btnGet">Download</button>
        <button class="btn" id="btnStop" disabled>Stop</button>
        <button class="btn danger" id="btnClear">Clear cache</button>
      </div>
      <div class="warn note" style="margin-top:12px"><b>Test it before you rely on it.</b> Download, then switch on flight mode and reload. If the tiles still draw, you're covered. Better to find that out in Dubai than past Adam.</div>
    </div>

    <h2>Satellite imagery per stop</h2>
    <div class="card">
      <p class="tiny" style="margin-top:0">Aerial tiles for all ${ROUTE.stops.length} places, stored on this device, so you can see what the junction and the forecourt actually look like with the SIM off. Do this on hotel wifi in Dubai — not at the border.</p>
      <label class="chk" style="border:none;padding:4px 0"><input type="checkbox" id="satWide" checked><span class="tiny">Also grab the wide view (helps confirm you're on the right road, roughly doubles the size)</span></label>
      <div class="acts" style="margin:8px 0">
        <button class="btn primary" id="satGet">Download imagery</button>
        <button class="btn danger" id="satClear">Clear imagery</button>
      </div>
      <div class="bar"><i id="satBar"></i></div>
      <div class="tiny muted" id="satStat">Not downloaded yet.</div>
      <p class="tiny muted" style="margin:10px 0 0">Imagery © Esri, Maxar, Earthstar Geographics. Stored in this browser only — repeat on each device you want it on.</p>
    </div>

    <h2>Route files</h2>
    <div class="card">
      <div class="acts" style="margin-bottom:10px">
        <a class="btn primary" href="./downloads/dubai-salalah-route.gpx" download>Download GPX</a>
        <a class="btn" href="./downloads/dubai-salalah-route.kml" download>Download KML</a>
      </div>
      <p class="tiny muted" style="margin:0">The real road track, ${ROUTE.line.length.toLocaleString()} points, Dubai to Salalah. The return follows the same road, so import it once and reverse it in your maps app. Generated from the same data as the map, so they cannot drift apart.</p>
    </div>

    <h2>Distances and fuel gaps</h2>
    <div class="card" id="gapTable">${gapTable()}
      <div class="row" style="margin-top:10px"><span><b>Round trip</b></span><span>${totalKm.toLocaleString()} km</span></div>
    </div>

    <h2>Documents</h2>
    <div class="card">${checkList("chk_docs", ROUTE.checks.docs)}</div>

    <h2>The car</h2>
    <div class="card">${checkList("chk_car", ROUTE.checks.car)}</div>

    <h2>Numbers</h2>
    <div class="card">
      ${ROUTE.contacts.map(c => `<a class="tel" href="tel:${c.tel}"><span>${esc(c.who)}${c.sub ? `<em>${esc(c.sub)}</em>` : ""}</span><b>${esc(c.show)}</b></a>`).join("")}
    </div>
    <div class="foot">Cached tiles and imagery need no network<br>Everything on this page works with the SIM off</div>`;
  }

  /* ---------------- render + wiring ---------------- */
  function buildTabs() {
    const el = $(".tabs");
    el.innerHTML = DAYS.map(d =>
      `<button class="tab" role="tab" data-view="d${d}" aria-selected="false">${esc(ROUTE.days[d].tab)}</button>`
    ).join("") + `<button class="tab" role="tab" data-view="prep" aria-selected="false">Prep</button>`;
    el.querySelectorAll(".tab").forEach(t => t.addEventListener("click", () => {
      state.tab = t.dataset.view;
      render();
      syncMap();
      if (current === DET.PEEK) snapTo(DET.HALF);
      scroller.scrollTop = 0;
    }));
  }

  function render() {
    renderPeek();
    const body = $("#sheetBody");
    body.innerHTML = state.tab === "prep" ? renderPrep()
                                          : renderDay(+state.tab.slice(1));
    $$(".tab").forEach(t => t.setAttribute("aria-selected", String(t.dataset.view === state.tab)));

    wireWeather();
    if (state.tab === "prep") { wirePrep(); return; }
    const day = +state.tab.slice(1);

    const inp = $("#dep-" + day);
    const onTime = ev => {
      const v = ev.target.value;
      if (parse(v) === null) return;                 // ignore half-typed values
      state.depart[day] = v; state.anchor[day] = null;
      store.set("d" + day + "_dep", v);
      render();
    };
    inp.addEventListener("input", onTime);
    inp.addEventListener("change", onTime);

    $("[data-reset]").addEventListener("click", () => {
      state.depart[day] = ROUTE.days[day].depart; state.anchor[day] = null;
      store.set("d" + day + "_dep", state.depart[day]);
      render();
    });
    $("#fmtBtn").addEventListener("click", () => { H12 = !H12; store.set("h12", H12); render(); });

    $$("[data-toggle]").forEach(b => {
      const go = () => {
        const key = b.dataset.toggle;
        state.open[key] = !state.open[key];
        render();
        focusStop(+b.closest(".stop").querySelector("[data-show]").dataset.show);
      };
      b.addEventListener("click", go);
      b.addEventListener("keydown", ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); go(); } });
    });
    $$("[data-show]").forEach(b => b.addEventListener("click", ev => {
      ev.stopPropagation(); focusStop(+b.dataset.show, true);
    }));
    $$("[data-sat]").forEach(b => b.addEventListener("click", () => {
      const key = b.dataset.sat; state.sat[key] = !state.sat[key]; render();
      if (state.sat[key]) paintSat(key);
    }));
    $$("[data-satz]").forEach(b => b.addEventListener("click", () => {
      const key = b.dataset.key; state.satz[key] = +b.dataset.satz; render(); paintSat(key);
    }));
    $$("[data-here]").forEach(b => b.addEventListener("click", () => {
      const key = b.dataset.here, now = new Date();
      state.anchor[day] = { key, t: now.getHours() * 60 + now.getMinutes() };
      const list = dayList(day);
      const upto = list.findIndex(e => e.key === key);
      for (const d2 of DAYS) {
        if (d2 > day) break;
        dayList(d2).forEach((e, i) => { if (d2 < day || i < upto) state.done[e.key] = true; });
      }
      store.set("done", state.done); render();
    }));
    $$("[data-done]").forEach(b => b.addEventListener("click", () => {
      const key = b.dataset.done; state.done[key] = !state.done[key];
      store.set("done", state.done); render();
    }));

    Object.keys(state.sat).forEach(k => { if (state.sat[k]) paintSat(k); });
  }

  function wireWeather() {
    const btn = $("#wxGet");
    if (btn) btn.addEventListener("click", () => {
      btn.disabled = true;
      const was = btn.textContent;
      btn.textContent = "…";
      RoadbookWeather.refresh(true)
        .then(render)
        .catch(err => {
          btn.disabled = false; btn.textContent = was;
          const hd = $(".wxhd");
          if (hd) hd.insertAdjacentHTML("afterend",
            `<p class="tiny muted" style="margin:0 12px 10px">Couldn't load: ${esc(err.message)}</p>`);
        });
    });
    $$("[data-wxday]").forEach(r => {
      const go = () => { state.tab = "d" + r.dataset.wxday; render(); syncMap(); scroller.scrollTop = 0; };
      r.addEventListener("click", go);
      r.addEventListener("keydown", ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); go(); } });
    });
  }

  function wirePrep() {
    const bar = $("#bar"), stat = $("#stat");
    const fmtMB = b => (b / 1048576).toFixed(0) + " MB";
    const e = TilePrecache.estimate();
    $("#estRows").innerHTML =
      `<div class="row"><span><b>Total</b></span><span>${e.uniqueTiles.toLocaleString()} tiles · ~${e.approxMB} MB</span></div>` +
      e.breakdown.map(t => `<div class="row"><span>${t.label} <small style="color:var(--faint)">z${t.zooms}</small></span><span>${t.tiles.toLocaleString()}</span></div>`).join("");

    const refresh = () => TilePrecache.stats().then(s => {
      stat.innerHTML = s.count
        ? `<b>${s.count.toLocaleString()}</b> tiles stored${s.usage ? " · using " + fmtMB(s.usage) + " of " + fmtMB(s.quota) + " available" : ""}`
        : "Nothing stored yet.";
    });
    refresh();

    const btnGet = $("#btnGet"), btnStop = $("#btnStop");
    btnGet.onclick = () => {
      if (!navigator.onLine) { stat.textContent = "You're offline. Connect to wifi first."; return; }
      btnGet.disabled = true; btnStop.disabled = false;
      TilePrecache.persist();
      TilePrecache.run({ concurrency: 6, onProgress: p => {
        bar.style.width = (p.done / p.total * 100).toFixed(1) + "%";
        stat.innerHTML = `${p.done.toLocaleString()} / ${p.total.toLocaleString()} · <b>${p.stored.toLocaleString()}</b> new · ${p.skipped.toLocaleString()} already had · ${p.failed.toLocaleString()} failed`;
      }}).then(r => {
        btnGet.disabled = false; btnStop.disabled = true;
        stat.innerHTML = r.aborted
          ? `Stopped. <b>${r.stored.toLocaleString()}</b> tiles saved — run again to finish.`
          : (r.stored + r.skipped === 0
              ? "Nothing saved. The tile server may be blocked on this network."
              : `Done. <b>${(r.stored + r.skipped).toLocaleString()}</b> tiles available offline${r.failed ? " · " + r.failed + " failed, run again to retry" : ""}.`);
        setTimeout(refresh, 800);
      }).catch(err => {
        btnGet.disabled = false; btnStop.disabled = true;
        stat.textContent = err.message;
      });
    };
    btnStop.onclick = () => { TilePrecache.abort(); btnStop.disabled = true; };
    $("#btnClear").onclick = () => TilePrecache.clear().then(() => { bar.style.width = "0"; refresh(); });

    const satBar = $("#satBar"), satStat = $("#satStat");
    SAT.count().then(n => { if (n) satStat.innerHTML = `<b>${n.toLocaleString()}</b> imagery tiles stored.`; });
    $("#satGet").onclick = async function () {
      if (!navigator.onLine) { satStat.textContent = "You're offline. Connect to wifi first."; return; }
      this.disabled = true;
      const r = await satDownloadAll($("#satWide").checked, (d, t, ok) => {
        satBar.style.width = (d / t * 100).toFixed(1) + "%";
        satStat.innerHTML = `${d} / ${t} · <b>${ok}</b> stored`;
      });
      this.disabled = false;
      satStat.innerHTML = `Done. <b>${r.ok.toLocaleString()}</b> of ${r.total.toLocaleString()} imagery tiles stored.`;
    };
    $("#satClear").onclick = async () => {
      await SAT.clear(); satBar.style.width = "0"; satStat.textContent = "Imagery cleared.";
    };

    $$("[data-chk]").forEach(c => c.addEventListener("change", () => {
      const id = c.dataset.chk, m = store.get(id, {});
      m[c.dataset.i] = c.checked; store.set(id, m);
    }));
  }

  /* ---------------- map coupling ---------------- */
  function focusStop(gi, collapse) {
    if (collapse && current === DET.FULL) snapTo(DET.HALF);
    RoadbookMap.focusStop(gi, coveredPx());
  }

  /* Show the selected day's places and nothing else. On Prep, show everything.
     Sightseeing days drop the highway line — see RoadbookMap.showDay. */
  function syncMap() {
    if (state.tab === "prep") RoadbookMap.showAll();
    else RoadbookMap.showDay(+state.tab.slice(1));
  }

  /* ---------------- sheet mechanics ---------------- */
  const DET = { FULL: "full", HALF: "half", PEEK: "peek" };
  let sheet, scroller, grabEl, peekEl, tabsEl, maxH = 0, current = DET.PEEK, y = 0;

  function detentY(d) {
    if (d === DET.FULL) return 0;
    if (d === DET.HALF) return Math.max(0, maxH - window.innerHeight * 0.48);
    return Math.max(0, maxH - peekH());
  }
  /* #peek is display:none once expanded, so it cannot be measured on demand —
     the peek detent would collapse to nothing. Cache it while it is visible. */
  let peekPx = 96;
  function peekH() {
    if (peekEl && peekEl.offsetHeight) peekPx = peekEl.offsetHeight;
    return peekPx + 10;
  }
  function coveredPx() { return Math.max(0, maxH - y); }

  /* Cap the scroller to the on-screen part of the sheet, so its scrollable
     region is exactly what the user can see. Recomputed on every move rather
     than only on snap, because a drag can stop anywhere between detents. */
  function fitScroller() {
    const expanded = y < detentY(DET.HALF) + 4;
    const chrome = (grabEl ? grabEl.offsetHeight : 0) +
                   (expanded ? (tabsEl ? tabsEl.offsetHeight : 0)
                             : (peekEl ? peekEl.offsetHeight : 0));
    scroller.style.maxHeight = Math.max(0, coveredPx() - chrome) + "px";
  }

  function measure() {
    maxH = Math.round(window.innerHeight * 0.92);
    sheet.style.height = maxH + "px";
    snapTo(current, true);
  }
  function setY(v, animate) {
    y = Math.min(detentY(DET.PEEK), Math.max(0, v));
    sheet.style.transition = animate ? "transform .26s cubic-bezier(.22,.61,.36,1)" : "none";
    sheet.style.transform = "translateY(" + y + "px)";
    sheet.classList.toggle("expanded", y < detentY(DET.HALF) + 4);
    fitScroller();
  }
  function snapTo(d, instant) {
    current = d;
    setY(detentY(d), !instant);
    sheet.setAttribute("data-detent", d);
    if (d === DET.PEEK) scroller.scrollTop = 0;
  }
  function nearest(v, vel) {
    const cands = [DET.FULL, DET.HALF, DET.PEEK];
    if (Math.abs(vel) > 0.5) {
      const order = vel > 0 ? cands : cands.slice().reverse();     // down : up
      for (const d of order) {
        const dy = detentY(d);
        if (vel > 0 ? dy > v + 4 : dy < v - 4) return d;
      }
    }
    return cands.reduce((a, b) => Math.abs(detentY(a) - v) < Math.abs(detentY(b) - v) ? a : b);
  }

  function bindDrag() {
    let active = false, startY = 0, startTop = 0, lastY = 0, lastT = 0, vel = 0, fromBody = false;

    const down = (ev, body) => {
      if (ev.pointerType === "mouse" && ev.button !== 0) return;
      active = true; fromBody = body;
      startY = lastY = ev.clientY; startTop = y; vel = 0; lastT = ev.timeStamp;
      sheet.style.transition = "none";
    };
    const move = ev => {
      if (!active) return;
      const dy = ev.clientY - startY;
      /* From the body, the sheet only moves on a downward pull that starts at
         the very top of the list — at every detent, not just full. Anything
         else is a scroll, so bail out and let the browser handle it natively
         (no preventDefault, or the scroll never happens). */
      if (fromBody && !(scroller.scrollTop <= 0 && dy > 0)) {
        active = false; return;
      }
      const dt = Math.max(1, ev.timeStamp - lastT);
      vel = (ev.clientY - lastY) / dt;
      lastY = ev.clientY; lastT = ev.timeStamp;
      if (Math.abs(dy) > 2) ev.preventDefault();
      setY(startTop + dy, false);
    };
    const up = () => {
      if (!active) return;
      active = false;
      snapTo(nearest(y, vel));
    };

    const handle = grabEl;
    handle.addEventListener("pointerdown", ev => { handle.setPointerCapture(ev.pointerId); down(ev, false); });
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);

    scroller.addEventListener("pointerdown", ev => { down(ev, true); });
    scroller.addEventListener("pointermove", move, { passive: false });
    scroller.addEventListener("pointerup", up);
    scroller.addEventListener("pointercancel", up);

    handle.addEventListener("click", () => {
      if (Math.abs(y - detentY(current)) > 4) return;              // was a drag
      snapTo(current === DET.PEEK ? DET.HALF : current === DET.HALF ? DET.FULL : DET.PEEK);
    });
    handle.addEventListener("keydown", ev => {
      if (ev.key === "ArrowUp")   { ev.preventDefault(); snapTo(current === DET.PEEK ? DET.HALF : DET.FULL); }
      if (ev.key === "ArrowDown") { ev.preventDefault(); snapTo(current === DET.FULL ? DET.HALF : DET.PEEK); }
      if (ev.key === "Escape")    { snapTo(DET.PEEK); }
    });
  }

  function init() {
    sheet = $("#sheet"); scroller = $("#sheetBody");
    grabEl = $("#grab"); peekEl = $("#peek"); tabsEl = $(".tabs");
    buildTabs();
    peekEl.addEventListener("click", ev => {
      if (ev.target.closest("#grab")) return;
      const e = nextStop();
      if (e) { state.open[e.key] = true; state.tab = "d" + e.day; render(); syncMap(); }
      snapTo(DET.HALF);
      if (e) focusStop(e.gi);
    });
    bindDrag();
    render();
    syncMap();
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);

    /* Warm the forecast in the background. A failure here is silent by
       design: no network is the expected state for most of this trip, and
       the strip already says so. */
    RoadbookWeather.refresh().then(render).catch(() => {});
    window.addEventListener("online", () => {
      RoadbookWeather.refresh().then(render).catch(() => {});
    });
    return { snapTo, DET };
  }

  return { init, snapTo: d => snapTo(d), DET, coveredPx };
})();
