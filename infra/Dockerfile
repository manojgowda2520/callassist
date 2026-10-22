# CallAssist server image. Build from the repo root:
#   docker build -f infra/Dockerfile -t callassist .

# 1) Compile TypeScript to plain JavaScript (build tools stay in this stage).
FROM node:24-alpine AS build
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY server ./
RUN npm run build

# 2) Production dependencies only: no compilers, no esbuild/tsx binaries.
FROM node:24-alpine AS prod-deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

# 3) Runtime image.
FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/server/node_modules ./server/node_modules
COPY --from=build /app/server/dist ./server/dist
COPY server/package.json ./server/
COPY server/public ./server/public
COPY server/data/seed.json ./server/data/seed.json
COPY skills ./skills
RUN mkdir -p server/data/local && chown -R node:node server/data
USER node
WORKDIR /app/server
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "dist/index.js"]
