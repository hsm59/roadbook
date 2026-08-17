# Deploying the Roadbook PWA

## Read this first

**If all you want is the site online, you don't need Docker.** It's a static
folder. Cloudflare Pages, Netlify, Vercel and GitHub Pages will host it free,
with HTTPS, in about two minutes and no container at all:

```bash
npx wrangler pages deploy .        # Cloudflare Pages
npx netlify deploy --prod --dir .  # Netlify
```

The Docker image is worth it if you want one artefact you can move between hosts,
pin a known-good nginx config, or run it on your own box alongside your other
self-hosted services. That's what's here.

**The non-negotiable bit:** service workers only run on HTTPS or `localhost`.
Every host below terminates TLS in front of the container, so it serves plain
HTTP on `$PORT` and that's fine. If you put this behind your own reverse proxy,
give it a real certificate or the offline caching silently does nothing.

---

## Build and run locally

```bash
docker build -t roadbook-pwa .
docker run --rm -p 8080:8080 roadbook-pwa
# http://localhost:8080
```

or `docker compose up --build`, or `make run`.

`localhost` counts as a secure context, so you can test the full offline flow
here: download the tiles, kill the container, reload. Tiles should still draw.

---

## Free hosts

Free tiers change constantly — check current terms before you rely on any of
these. Ranked by how little work they need.

### Fly.io — the easiest for a container
```bash
fly launch --no-deploy --copy-config   # reads fly.toml
fly deploy
```
`primary_region = "dxb"` puts it in Dubai. `auto_stop_machines` idles it to zero
when nobody's using it. `force_https = true` is already set and is mandatory.

### Render
Push the repo, then **New → Blueprint** and point at it. `render.yaml` sets the
free plan, the Singapore region and the `/healthz` check. Free services sleep
after inactivity, so the first request after a gap takes ~30 s to wake. Irrelevant
here — you'll have cached everything before you leave.

### Koyeb
```bash
koyeb app init roadbook \
  --docker ghcr.io/<you>/roadbook-pwa:latest \
  --ports 8080:http --routes /:8080 --instance-type free
```

### Google Cloud Run
Generous always-free tier, scales to zero, expects port 8080 — which is the
default here.
```bash
gcloud run deploy roadbook --source . --region me-central1 --allow-unauthenticated
```

### Hugging Face Spaces
Create a Space with the **Docker** SDK, push this repo, set `PORT=7860` in the
Space variables. Free and permanent.

### Your own machine
It's a 15 MB image. It'll sit happily next to whatever else you're running — just
make sure whatever fronts it serves real HTTPS.

---

## Publishing the image

`.github/workflows/publish.yml` builds `linux/amd64` and `linux/arm64` on every
push to `main` and pushes to GHCR. Public GHCR images are free. Any Docker host
can then pull `ghcr.io/<you>/roadbook-pwa:latest` with no build step.

Manually:
```bash
make multiarch REGISTRY=ghcr.io/<you>
```

arm64 matters — Fly machines and Apple Silicon both want it.

---

## What's in the image

| Path | What it is |
|---|---|
| `/` | The whole app — Leaflet map, roadbook bottom sheet, offline tile download |
| `/downloads/*.gpx` `.kml` | Route files for Organic Maps, OsmAnd, Garmin, My Maps |
| `/healthz` | Health check, returns `ok` |

---

## The cache headers, and why they're like that

This is the part that bites people, so it's worth being explicit.

| Path | `Cache-Control` | Reason |
|---|---|---|
| `/sw.js` | `no-cache, no-store, must-revalidate` | A stale service worker can pin the app to an old shell more or less forever. Never cache it. |
| `/index.html`, `/app.js`, `/precache.js`, `/route-data.js`, `/sheet.js` | `no-cache` | Revalidate every load. Cheap 304s. The SW owns the real caching. |
| `/vendor/*` | `public, max-age=31536000, immutable` | Pinned Leaflet 1.9.4. Never changes. |
| `/downloads/*` | `public, max-age=86400` + `Content-Disposition: attachment` | So GPX/KML download instead of rendering as XML in the tab. |

None of this touches the map tiles — those live in Cache Storage, managed by
`sw.js`, and survive redeploys because the tile cache is deliberately unversioned.

`Permissions-Policy` explicitly keeps `geolocation=(self)` enabled. Drop that and
**Find me** stops working, with no obvious error.

## After you deploy

1. Open the URL on the phone.
2. **Add to Home Screen.** It installs standalone and keeps its caches.
3. **Offline maps → Download.** On wifi. ~3,500 tiles, ~125 MB.
4. Flight mode, force-quit, reopen. If the tiles draw, you're ready.

Do step 4 in Dubai. Finding out at Ghaba is not the moment.
