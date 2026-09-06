# Admin control plane (#609). Same source tree as the tenant API, different
# entrypoint — so it inherits the workspace's dependencies and tooling without
# a second package to keep in step.
#
# ⚠️ Deployed deliberately, never swept along with tenants: it sits behind
# `profiles: ["admin"]` in compose, so a plain `docker compose up` does not
# start it. A bad push here is fleet-wide.
FROM node:24-alpine

WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY frontend/package.json frontend/
COPY db/package.json db/
RUN npm ci --workspace @tnl/server

COPY VERSION ./
COPY server/ server/

WORKDIR /app/server
# 8090 public (behind nginx), 8091 local (published to host loopback only).
EXPOSE 8090 8091
CMD ["npx", "tsx", "src/adminMain.ts"]
