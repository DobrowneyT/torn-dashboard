# Per-faction API service. Build context is the repo root (npm workspaces).
FROM node:24-alpine

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
