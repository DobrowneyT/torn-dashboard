# Staging SPA + front door (#292). Same build as deploy/nginx.Dockerfile, but
# serves deploy/nginx-dev/ instead of the production vhosts — see that file for
# why the staging front door must not route to the prod api-<slug> containers.
# Build context is the repo root (of the dev worktree).
FROM node:24-alpine AS build

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
COPY --from=build /app/frontend/dist /usr/share/nginx/html
