# Builds the SPA and serves it through nginx. Build context is the repo root.
FROM node:24-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
COPY frontend/package.json frontend/
COPY server/package.json server/
COPY db/package.json db/
RUN npm ci --workspace @tnl/frontend

COPY frontend/ frontend/
# The self-hosted bundle talks to /api/* on its own origin instead of Supabase.
ENV VITE_API_MODE=true
RUN npm run build -w frontend

FROM nginx:1.27-alpine
COPY deploy/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/dist /usr/share/nginx/html
