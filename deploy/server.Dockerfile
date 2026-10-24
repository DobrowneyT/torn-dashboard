# Per-faction API service. Build context is the repo root (npm workspaces).
# ⚠️ Pinned: 24.22.1 fixes the Oct 2026 security release (Brotli RCE,
# CVE-2026-111497). Raise deliberately; a floating tag only moves when the
# cached base is re-pulled.
FROM node:24.22.1-alpine

WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY frontend/package.json frontend/
COPY db/package.json db/
RUN npm ci --workspace @tnl/server

# Version source of truth (#154) — /api/health reads ../../VERSION at runtime.
COPY VERSION ./
COPY server/ server/

WORKDIR /app/server
EXPOSE 8080
CMD ["npx", "tsx", "src/main.ts"]
