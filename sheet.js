/* ============================================================
   sheet.js — PART 4: THE ROADBOOK, AS A BOTTOM SHEET

   Replaces roadbook.html. That page carried its own copy of the
   trip and its own schematic SVG map; both are gone. The map
   behind this sheet is the real one, and the data comes from
   route-data.js, so the two can no longer disagree.

   Three detents: peek (next stop only), half, full. Dragging is
   pointer-based so it works with a mouse as well as a thumb, and
   the handle is a button, so it works with neither.

   Depends on: route-data.js, app.js (RoadbookMap), precache.js
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

  /* ---------------- trip indexing ----------------
     Day 2 starts from the Nizwa hotel, which is day 1's arrival.
     It is one stop in the data and appears as the origin of day 2's
     timeline, so a day list is not simply a filter. */
  function dayList(day) {
    const out = [];
    ROUTE.stops.forEach((s, gi) => { if (s.day === day) out.push({ s, gi }); });
    if (day === 2) {
      let originGi = -1;
      ROUTE.stops.forEach((s, gi) => { if (s.day === 1) originGi = gi; });
      if (originGi >= 0) out.unshift({ s: ROUTE.stops[originGi], gi: originGi, origin: true });
    }
    return out;
  }

  const state = {
    1: { depart: store.get("d1_dep", ROUTE.days[1].depart), anchor: null },
    2: { depart: store.get("d2_dep", ROUTE.days[2].depart), anchor: null },
    open: {}, done: store.get("done", {}), sat: {}, satz: {},
    tab: "d1"
  };

  function schedule(day) {
    const list = dayList(day), st = state[day];
    let t = parse(st.depart);
    if (t === null) t = parse(ROUTE.days[day].depart);
    return list.map((e, i) => {
      if (i > 0) t += e.s.drive;
      if (st.anchor && st.anchor.gi === e.gi) t = st.anchor.t;
      const arrive = t;
      t += e.s.stay;
      return { arrive, leave: t };
    });
  }
  function kmRemaining(list, i) {
    let k = 0;
    for (let j = i + 1; j < list.length; j++) k += list[j].s.km;
    return k;
  }

  /* ---------------- satellite tiles, cached in IndexedDB ----------------
     Deliberately not the Cache API bucket the basemap uses: these are
     small per-stop grids the user downloads separately, and clearing
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
    get(k)      { return SAT.tx("readonly",  s => s.get(k), null); },
    put(k, b)   { return SAT.tx("readwrite", s => s.put(b, k), null); },
    clear()     { return SAT.tx("readwrite", s => s.clear(), null); },
    count()     { return SAT.tx("readonly",  s => s.count(), 0); },
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

  async function paintSat(gi) {
    const host = $("#sat-" + gi); if (!host) return;
    const s = ROUTE.stops[gi], z = state.satz[gi] || 16;
    const tiles = SAT.tilesFor(s.lat, s.lng, z);
    const grid = $(".satgrid", host);
    grid.innerHTML = tiles.map(t => `<img alt="" data-k="${t.k}" class="miss">`).join("");
    const cx = Math.floor(SAT.fx(s.lng, z)), cy = Math.floor(SAT.fy(s.lat, z));
    $(".xhair", host).style.left = ((SAT.fx(s.lng, z) - (cx - 1)) / 3 * 100).toFixed(2) + "%";
    $(".xhair", host).style.top  = ((SAT.fy(s.lat, z) - (cy - 1)) / 3 * 100).toFixed(2) + "%";
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
    ROUTE.stops.forEach(s => {
      SAT.tilesFor(s.lat, s.lng, 16).forEach(t => list.push(t));
      if (wide) SAT.tilesFor(s.lat, s.lng, 13).forEach(t => list.push(t));
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

  /* ---------------- peek: the one thing you need while moving ---------------- */
  function nextStop() {
    for (let i = 0; i < ROUTE.stops.length; i++) if (!state.done[i]) return i;
    return -1;
  }
  function renderPeek() {
    const gi = nextStop(), el = $("#peekBody");
    if (gi < 0) {
      el.innerHTML = `<div class="pk-kick">Trip complete</div>
        <div class="pk-name">Salalah<span class="pk-far">all 13 stops done</span></div>`;
      return;
    }
    const s = ROUTE.stops[gi];
    const list = dayList(s.day), sch = schedule(s.day);
    const idx = list.findIndex(e => e.gi === gi && !e.origin);
    const eta = idx >= 0 ? fmt(sch[idx].arrive) : "—";
    el.innerHTML =
      `<div class="pk-kick">Next · ${gi + 1} of ${ROUTE.stops.length} · Day ${s.day}</div>
       <div class="pk-name">${esc(s.name)}
         <span class="pk-far">${esc(s.sub)}</span></div>
       <div class="pk-num">${gi === 0
          ? "<b>Start</b>"
          : `<b>${s.km}</b><small>km</small>`}<i>${gi === 0 ? "Depart " : "ETA "}${eta}</i></div>`;
  }

  /* ---------------- day view ---------------- */
  function renderDay(day) {
    const list = dayList(day), sch = schedule(day), st = state[day];
    const meta = ROUTE.days[day];
    const dep = parse(st.depart) ?? parse(meta.depart);
    const totalKm = list.reduce((t, e, i) => t + (i === 0 ? 0 : e.s.km), 0);

    let h = `<div class="ctrl">
      <label for="dep-${day}">Depart</label>
      <input type="time" id="dep-${day}" value="${st.depart}">
      <button class="btn ghost" data-reset="${day}">Reset</button>
      <button class="btn ghost" id="fmtBtn">${H12 ? "12h" : "24h"}</button>
      <span class="grow"></span>
      <span class="mono tiny muted">${totalKm} km · ${dur(sch[sch.length - 1].arrive - dep)}</span>
    </div>
    <p class="tiny muted" style="margin:10px 2px 14px">${esc(meta.blurb)}</p>`;

    list.forEach((e, i) => {
      const s = e.s, gi = e.gi;
      const done = !!state.done[gi], open = !!state.open[gi];
      const rem = kmRemaining(list, i), nxt = list[i + 1];

      if (i > 0) {
        const warn = s.km >= 180;
        h += `<div class="gap ${warn ? "warn" : ""}">${warn ? "&#9888; " : ""}${s.km} km · ${dur(s.drive)} driving${warn ? " · longest gap without fuel" : ""}</div>`;
      }
      h += `<article class="stop ${s.fuel ? "fuel" : ""} ${done ? "done" : ""} ${e.origin ? "origin" : ""}" data-gi="${gi}">
        <div class="stophd" data-toggle="${gi}" role="button" tabindex="0">
          <div class="eta">${fmt(sch[i].arrive)}</div>
          <div class="num" style="--pin:${(ROUTE.types[s.type] || {}).color || "#888"}">${gi + 1}</div>
          <div class="sname">${esc(s.name)}<small>${esc((e.origin ? "Departure" : s.sub).toUpperCase())}${s.stay && !e.origin ? " · " + s.stay + " MIN" : ""}</small></div>
          <div class="chev">${open ? "▲" : "▼"}</div>
        </div>
        <div class="stopbody ${open ? "" : "hide"}">
          <div class="chips">${s.svc.map(v => `<span class="chip">${esc(v)}</span>`).join("")}</div>
          <p>${esc(s.note)}</p>
          <div class="lm"><b>How you'll know you're there</b>${esc(s.lm)}</div>
          <p class="tiny muted" style="margin-bottom:10px">
            ${sch[i].leave !== sch[i].arrive ? `Leave by <b class="mono">${fmt(sch[i].leave)}</b> · ` : ""}${rem} km still to go</p>
          <div class="acts">
            <span class="coord">${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}</span>
            <button class="btn" data-show="${gi}">Show on map</button>
            <button class="btn ${state.sat[gi] ? "on" : ""}" data-sat="${gi}">Satellite</button>
            <a class="btn" href="geo:${s.lat},${s.lng}?q=${s.lat},${s.lng}(${encodeURIComponent(s.name)})">Any map app</a>
            <button class="btn" data-here="${gi}" data-day="${day}">I'm here now</button>
            <button class="btn" data-done="${gi}">${done ? "Undo" : "Mark done"}</button>
          </div>
          ${state.sat[gi] ? `<div class="sat" id="sat-${gi}">
            <div class="satgrid"></div><div class="xhair"></div>
            <div class="satbar">
              <button class="btn ${(state.satz[gi] || 16) === 16 ? "on" : ""}" data-satz="16" data-gi="${gi}">Close</button>
              <button class="btn ${(state.satz[gi] || 16) === 13 ? "on" : ""}" data-satz="13" data-gi="${gi}">Wide</button>
              <span class="tiny muted satnote">Loading…</span>
            </div>
            <div class="satattr">Imagery © Esri, Maxar, Earthstar Geographics</div>
          </div>` : ""}
          ${nxt ? `<p class="tiny muted nextline">
            <b>Next:</b> ${esc(nxt.s.name)} — ${nxt.s.km} km, ${dur(nxt.s.drive)}, bearing ${Math.round(bearing(s.lat, s.lng, nxt.s.lat, nxt.s.lng))}° ${compass(bearing(s.lat, s.lng, nxt.s.lat, nxt.s.lng))}</p>` : ""}
        </div>
      </article>`;
    });
    return h;
  }

  /* ---------------- prep view ---------------- */
  function checkList(id, items) {
    const done = store.get(id, {});
    return items.map((t, i) =>
      `<label class="chk"><input type="checkbox" data-chk="${id}" data-i="${i}" ${done[i] ? "checked" : ""}><span>${esc(t)}</span></label>`
    ).join("");
  }
  function gapTable() {
    const rows = ROUTE.stops.map((s, i) => i === 0 ? "" :
      `<div class="row ${s.km >= 180 ? "warn" : ""}"><span>${esc(ROUTE.stops[i - 1].name)} → ${esc(s.name)}</span><span>${s.km} km</span></div>`
    ).join("");
    return rows;
  }
  function renderPrep() {
    return `
    <h2>Offline basemap</h2>
    <div class="card">
      <p class="tiny" style="margin-top:0">Caches the road corridor and the area around every stop, so the map behind this sheet keeps working when the data drops. Do this on wifi before you leave.</p>
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
      <p class="tiny" style="margin-top:0">Aerial tiles for every stop, stored on this device, so you can see what the junction and the forecourt actually look like with the SIM off. Do this on hotel wifi in Dubai — not at the border.</p>
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
      <p class="tiny muted" style="margin:0">13 waypoints and the real road track, ${ROUTE.line.length.toLocaleString()} points. GPX for Organic Maps, OsmAnd and Garmin; KML for Google My Maps and Google Earth. Generated from the same data as the map, so they cannot drift apart.</p>
    </div>

    <h2>Fuel gaps</h2>
    <div class="card" id="gapTable">${gapTable()}</div>

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
  function render() {
    renderPeek();
    const body = $("#sheetBody");
    body.innerHTML =
      state.tab === "prep" ? renderPrep() :
      renderDay(state.tab === "d1" ? 1 : 2);

    $$(".tab").forEach(t => t.setAttribute("aria-selected", String(t.dataset.view === state.tab)));

    if (state.tab === "prep") { wirePrep(); return; }
    const day = state.tab === "d1" ? 1 : 2;

    const inp = $("#dep-" + day);
    const onTime = ev => {
      const v = ev.target.value;
      if (parse(v) === null) return;                 // ignore half-typed values
      state[day].depart = v; state[day].anchor = null;
      store.set("d" + day + "_dep", v);
      render();
    };
    inp.addEventListener("input", onTime);
    inp.addEventListener("change", onTime);

    $("[data-reset]").addEventListener("click", () => {
      state[day].depart = ROUTE.days[day].depart; state[day].anchor = null;
      store.set("d" + day + "_dep", state[day].depart);
      render();
    });
    $("#fmtBtn").addEventListener("click", () => { H12 = !H12; store.set("h12", H12); render(); });

    $$("[data-toggle]").forEach(b => {
      const go = () => { const gi = +b.dataset.toggle; state.open[gi] = !state.open[gi]; render(); focusStop(gi); };
      b.addEventListener("click", go);
      b.addEventListener("keydown", ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); go(); } });
    });
    $$("[data-show]").forEach(b => b.addEventListener("click", ev => {
      ev.stopPropagation(); focusStop(+b.dataset.show, true);
    }));
    $$("[data-sat]").forEach(b => b.addEventListener("click", () => {
      const gi = +b.dataset.sat; state.sat[gi] = !state.sat[gi]; render();
      if (state.sat[gi]) paintSat(gi);
    }));
    $$("[data-satz]").forEach(b => b.addEventListener("click", () => {
      const gi = +b.dataset.gi; state.satz[gi] = +b.dataset.satz; render(); paintSat(gi);
    }));
    $$("[data-here]").forEach(b => b.addEventListener("click", () => {
      const gi = +b.dataset.here, d = +b.dataset.day, now = new Date();
      state[d].anchor = { gi, t: now.getHours() * 60 + now.getMinutes() };
      for (let j = 0; j < gi; j++) state.done[j] = true;
      store.set("done", state.done); render();
    }));
    $$("[data-done]").forEach(b => b.addEventListener("click", () => {
      const gi = +b.dataset.done; state.done[gi] = !state.done[gi];
      store.set("done", state.done); render();
    }));

    Object.keys(state.sat).forEach(gi => { if (state.sat[gi]) paintSat(+gi); });
  }

  function wirePrep() {
    /* basemap precache */
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

    /* satellite imagery */
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

    /* checklists */
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

  /* ---------------- sheet mechanics ----------------
     Detents are translateY offsets from fully-open. Dragging the
     handle always moves the sheet; dragging the body only moves it
     when the body is already scrolled to the top and you pull down,
     so the list scrolls normally the rest of the time. */
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

    const handle = $("#grab");
    handle.addEventListener("pointerdown", ev => { handle.setPointerCapture(ev.pointerId); down(ev, false); });
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);

    scroller.addEventListener("pointerdown", ev => { down(ev, true); });
    scroller.addEventListener("pointermove", move, { passive: false });
    scroller.addEventListener("pointerup", up);
    scroller.addEventListener("pointercancel", up);

    // Tap the handle to cycle, so the sheet is usable without dragging.
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
    $$(".tab").forEach(t => t.addEventListener("click", () => {
      state.tab = t.dataset.view;
      render();
      if (current === DET.PEEK) snapTo(DET.HALF);
      scroller.scrollTop = 0;
    }));
    $("#peek").addEventListener("click", ev => {
      if (ev.target.closest("#grab")) return;
      const gi = nextStop();
      if (gi >= 0) { state.open[gi] = true; state.tab = ROUTE.stops[gi].day === 1 ? "d1" : "d2"; render(); }
      snapTo(DET.HALF);
      if (gi >= 0) focusStop(gi);
    });
    bindDrag();
    render();
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    return { snapTo, DET };
  }

  return { init, snapTo: d => snapTo(d), DET, coveredPx };
})();
