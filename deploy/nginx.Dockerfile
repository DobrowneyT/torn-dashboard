# Builds the SPA and serves it through nginx. Build context is the repo root.
# ⚠️ Pinned: 24.22.1 fixes the Oct 2026 security release (Brotli RCE,
# CVE-2026-111497). Raise deliberately; a floating tag only moves when the
# cached base is re-pulled.
FROM node:24.22.1-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
COPY frontend/package.json frontend/
COPY server/package.json server/
COPY db/package.json db/
RUN npm ci --workspace @tnl/frontend

COPY frontend/ frontend/
# Version source of truth (#154) — vite.config reads ../VERSION so the footer
# matches /api/health instead of falling back to a stale default.
COPY VERSION ./
# The self-hosted bundle talks to /api/* on its own origin.
ENV VITE_API_MODE=true
RUN npm run build -w frontend

FROM nginx:1.27-alpine
# default.conf + per-faction vhosts under factions/ (slice #75).
COPY deploy/nginx/ /etc/nginx/conf.d/
COPY --from=build /app/frontend/dist /usr/share/nginx/html
