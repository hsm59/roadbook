# syntax=docker/dockerfile:1
###############################################################################
# Roadbook PWA — static site on nginx.
#
# Stage 1 pre-compresses assets so nginx can serve .gz without burning CPU
# per request. Stage 2 is the runtime: nginx:alpine, ~12 MB image.
#
# The service worker needs HTTPS. Every host in DEPLOY.md terminates TLS for
# you, so the container itself speaks plain HTTP on $PORT.
###############################################################################

# ---------- stage 1: compress ----------
FROM alpine:3.20 AS assets

RUN apk add --no-cache gzip brotli
WORKDIR /src

COPY index.html app.js sw.js precache.js route-data.js sheet.js ./
COPY manifest.webmanifest icon.svg ./
COPY vendor/ ./vendor/
COPY downloads/ ./downloads/

# Precompress everything worth compressing. -k keeps the original so nginx can
# still serve clients that don't send Accept-Encoding.
RUN find . -type f \( -name '*.html' -o -name '*.js' -o -name '*.css' \
      -o -name '*.svg' -o -name '*.json' -o -name '*.webmanifest' \
      -o -name '*.gpx' -o -name '*.kml' -o -name '*.md' \) \
      -exec gzip -9 -k {} \; \
      -exec brotli -q 11 -k {} \; \
  && ls -la

# ---------- stage 2: runtime ----------
FROM nginx:1.27-alpine

LABEL org.opencontainers.image.title="Roadbook PWA" \
      org.opencontainers.image.description="Offline-first route map for the Dubai to Salalah drive" \
      org.opencontainers.image.licenses="MIT"

# Most PaaS inject $PORT. 8080 is what Cloud Run expects and is fine everywhere.
ENV PORT=8080

# nginx:alpine runs envsubst over /etc/nginx/templates/*.template at boot,
# so ${PORT} is resolved without an entrypoint script of our own.
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY nginx/mime.extra.types      /etc/nginx/mime.extra.types

COPY --from=assets /src/ /usr/share/nginx/html/

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" || exit 1
