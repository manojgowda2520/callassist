# CallAssist server image. Build from the repo root:
#   docker build -f infra/Dockerfile -t callassist .
FROM node:24-alpine AS deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund && npm cache clean --force

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY server ./server
COPY skills ./skills
RUN mkdir -p server/data/local && chown -R node:node server/data
USER node
WORKDIR /app/server
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "--import", "tsx", "src/index.ts"]
