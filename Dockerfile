# syntax=docker/dockerfile:1
# Ozmo Spectre — the served board and the agent API, without Electron.
#
# Two stages. The builder produces `out/web` (the browser client) and
# `out/server/index.cjs` (the headless core); the runtime carries neither a
# toolchain nor a devDependency.
#
# The build NEVER downloads Electron. `npm ci --ignore-scripts` skips the
# electron package's postinstall, which is the ~200MB Chromium fetch — nothing
# in either build reaches Electron, and `scripts/build-server.mjs` fails the
# build if anything ever does.

# ---------------------------------------------------------------- build ----
FROM node:20-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
# --ignore-scripts: no Electron download, no native rebuild. Neither build needs
# either, and both cost minutes.
#
# The extra_ca secret is for machines behind TLS interception (corporate proxy,
# or an antivirus that MITMs HTTPS — Norton does exactly this). The host trusts
# that root CA; a container does not, so registry fetches fail to verify. Mount
# it as a SECRET rather than COPY: it never lands in a layer, and the build works
# unchanged on a machine that has no such cert. See docker-compose.yml.
RUN --mount=type=secret,id=extra_ca     set -eu;     if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi;     npm ci --ignore-scripts --no-audit --no-fund

COPY tsconfig*.json electron.vite.config.ts vite.web.config.ts ./
COPY src ./src
COPY scripts ./scripts

# the browser client, then the server that serves it
RUN npm run build:web \
 && node scripts/build-server.mjs

# -------------------------------------------------------------- runtime ----
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Production dependencies only — six packages, ~40MB. Scripts DO run here, on
# purpose: better-sqlite3 fetches its prebuilt binary for this image's Node ABI,
# which is what makes OZMO_DB_DRIVER=native available. Our own postinstall
# (rebuild-native.mjs) finds no Electron, warns, and exits 0 by design, so a
# missing prebuild degrades to the sql.js default instead of failing the build.
COPY package.json package-lock.json ./
# postinstall names this script, so it has to exist before npm ci runs. It
# imports nothing but node builtins, so the one file is the whole dependency.
COPY scripts/rebuild-native.mjs ./scripts/rebuild-native.mjs
RUN --mount=type=secret,id=extra_ca     set -eu;     if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi;     npm ci --omit=dev --no-audit --no-fund;     npm cache clean --force

COPY --from=build /app/out/server ./out/server
COPY --from=build /app/out/web ./out/web

# /vault is the Obsidian vault (markdown + .ozmo/spec.db); /data holds
# settings.json. Both are mounted, never baked.
RUN mkdir -p /vault /data && chown -R node:node /vault /data /app
USER node

# OZMO_BIND_HOST=0.0.0.0 is the CONTAINER's own interface, not a decision about
# who can reach it. That decision is the PUBLISHED port in compose - bind it to
# 127.0.0.1 on the host and put Tailscale in front. See docker-compose.yml.
ENV OZMO_VAULT_PATH=/vault \
    OZMO_DATA_DIR=/data \
    OZMO_PORT=4820 \
    OZMO_APP_DIR=/app \
    OZMO_BIND_HOST=0.0.0.0

EXPOSE 4820

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.OZMO_PORT||4820,path:'/api/health',timeout:4000},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "out/server/index.cjs"]
