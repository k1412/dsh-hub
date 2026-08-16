# syntax=docker/dockerfile:1.7

FROM node:22.22.1-bookworm-slim AS build
WORKDIR /source
RUN apt-get update \
    && apt-get install -y --no-install-recommends git make g++ python3 \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm run hub:web:build
RUN node scripts/build-hub-server.mjs /source/hub-server.mjs

FROM node:22.22.1-bookworm-slim AS runtime
LABEL org.opencontainers.image.source="https://github.com/k1412/dsh-hub"
LABEL org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production \
    PORT=8080 \
    DSH_HUB_HOST=0.0.0.0 \
    DSH_HUB_STATE_DIRECTORY=/var/lib/dsh-hub \
    DSH_HUB_STATIC_DIRECTORY=/app/public
RUN groupadd --gid 10001 dsh-hub \
    && useradd --uid 10001 --gid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin dsh-hub \
    && mkdir -p /app/public /var/lib/dsh-hub \
    && chown -R 10001:10001 /app /var/lib/dsh-hub
COPY --from=build --chown=10001:10001 /source/hub-server.mjs /source/hub-server.mjs.map /app/
COPY --from=build --chown=10001:10001 /source/apps/hub-web/dist/ /app/public/
USER 10001:10001
WORKDIR /app
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz',{headers:{'x-dsh-origin-secret':process.env.DSH_HUB_ORIGIN_SECRET}}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "/app/hub-server.mjs"]
