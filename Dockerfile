# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runner

ENV NODE_ENV=production \
    WRANGLER_LOG_PATH=/tmp/wrangler.log \
    WRANGLER_SEND_METRICS=false

WORKDIR /app

RUN npm install --global wrangler@4.92.0 \
    && npm cache clean --force \
    && mkdir -p /data \
    && chown node:node /app /data

COPY --from=builder --chown=node:node /app/dist ./dist

USER node

EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/books').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]

CMD ["wrangler", "dev", "--config", "/app/dist/server/wrangler.json", "--local", "--persist-to", "/data", "--ip", "0.0.0.0", "--port", "3000", "--show-interactive-dev-session=false"]
