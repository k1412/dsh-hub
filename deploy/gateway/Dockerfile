# syntax=docker/dockerfile:1.7
FROM node:22.22.1-bookworm-slim AS build
WORKDIR /source
RUN apt-get update && apt-get install -y --no-install-recommends git make g++ python3 \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile
RUN node scripts/build-gateway.mjs

FROM node:22.22.1-bookworm-slim AS network
ARG TARGETARCH
WORKDIR /source
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY deploy/gateway/download-network.mjs deploy/gateway/network-pins.json ./
RUN node download-network.mjs --directory /downloads --install-directory /bin/network --arch ${TARGETARCH}

FROM node:22.22.1-bookworm-slim AS runtime
LABEL org.opencontainers.image.source="https://github.com/k1412/dsh-hub"
LABEL org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production \
    PORT=8080 \
    DSH_GATEWAY_PRIVATE_PORT=8081 \
    DSH_GATEWAY_NETWORK_BIN=/opt/dsh-gateway/bin \
    DSH_GATEWAY_STATE_DIRECTORY=/var/lib/dsh-gateway \
    DSH_GATEWAY_TAILSCALE_MODE=managed
RUN groupadd --gid 10001 dsh-gateway \
    && useradd --uid 10001 --gid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin dsh-gateway \
    && mkdir -p /app/downloads /var/lib/dsh-gateway /opt/dsh-gateway/bin \
    && chown -R 10001:10001 /app /var/lib/dsh-gateway
COPY --from=build --chown=10001:10001 /source/dist/gateway/ /app/
COPY --from=network /bin/network/ /opt/dsh-gateway/bin/
COPY --from=network --chown=10001:10001 /downloads/ /app/downloads/
COPY --chown=10001:10001 deploy/gateway/install.sh /app/install.sh
USER 10001:10001
WORKDIR /app
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "const fs=require('node:fs');let secret=process.env.DSH_GATEWAY_ORIGIN_SECRET||'';try{if(process.env.DSH_GATEWAY_AUTH_FILE)secret=JSON.parse(fs.readFileSync(process.env.DSH_GATEWAY_AUTH_FILE,'utf8')).originSecret||secret}catch{process.exit(1)}fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz',{headers:{'x-dsh-origin-secret':secret}}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "/app/server.mjs"]
