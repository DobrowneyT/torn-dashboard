# Staging SPA + front door (#292). Same build as deploy/nginx.Dockerfile, but
# serves deploy/nginx-dev/ instead of the production vhosts — see that file for
# why the staging front door must not route to the prod api-<slug> containers.
# Build context is the repo root (of the dev worktree).
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
COPY VERSION ./
ENV VITE_API_MODE=true
RUN npm run build -w frontend

FROM nginx:1.27-alpine
COPY deploy/nginx-dev/ /etc/nginx/conf.d/
# Shared SPA cache policy (#382) — one source of truth with the prod image.
COPY deploy/nginx/snippets/ /etc/nginx/conf.d/snippets/
COPY --from=build /app/frontend/dist /usr/share/nginx/html
