# syntax=docker/dockerfile:1
# Separate dependency stages ensure AI libraries never enter the base image layers.
FROM node:26-slim AS tooling
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY src/ai-worker/package.json ./src/ai-worker/package.json
RUN PNPM_VERSION="$(node -p "require('./package.json').packageManager.split('@')[1]")" \
 && npm i -g "pnpm@${PNPM_VERSION}"

FROM tooling AS build
RUN pnpm --filter elegoo-web install --frozen-lockfile
COPY . .
RUN pnpm build

# Used by local/CI verification; never shipped as a production image.
FROM tooling AS checks
ENV ONNXRUNTIME_NODE_INSTALL=skip
RUN pnpm install --frozen-lockfile
COPY . .
CMD ["pnpm", "gates"]

FROM tooling AS base-deps
RUN pnpm --filter elegoo-web install --frozen-lockfile --prod

FROM tooling AS worker-deps
# CPU inference uses the binaries bundled by ONNX; do not download CUDA providers.
ENV ONNXRUNTIME_NODE_INSTALL=skip
RUN pnpm --filter @elegoo/ai-worker install --frozen-lockfile --prod
COPY src/ai-worker ./src/ai-worker
RUN pnpm --filter @elegoo/ai-worker deploy --legacy --prod /worker

FROM node:26-slim AS ai-worker
WORKDIR /app
ENV NODE_ENV=production
ENV AI_MODEL_CACHE=/models
COPY --from=worker-deps /worker ./
EXPOSE 8090
CMD ["node", "--import", "tsx", "index.ts"]

# Keep the default target the lean base service.
FROM node:26-slim AS base
LABEL org.opencontainers.image.description="Elegoo CC2 web service (optional AI worker)"
LABEL org.opencontainers.image.licenses=MIT
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-dejavu-core fontconfig \
 && rm -rf /var/lib/apt/lists/* \
 && fc-cache -f
WORKDIR /app
COPY --from=base-deps /app/node_modules ./node_modules
COPY package.json ./package.json
COPY --from=build /app/dist ./dist
COPY src ./src
ARG BUILD_COMMIT=""
ARG BUILD_DESCRIBE=""
ARG BUILD_VERSION=""
ARG BUILD_TIME=""
RUN node -e 'const f=v=>v&&v.length?v:null; require("fs").writeFileSync("build-info.json", JSON.stringify({commit:f(process.env.BUILD_COMMIT),shortCommit:f((process.env.BUILD_COMMIT||"").slice(0,7)),describe:f(process.env.BUILD_DESCRIBE),version:f(process.env.BUILD_VERSION),installedAt:f(process.env.BUILD_TIME)},null,2)+"\n")' \
 && cat build-info.json

ENV NODE_ENV=production
ENV PORT=8088
EXPOSE 8088 7125
CMD ["node", "--import", "tsx", "src/server/index.ts"]
