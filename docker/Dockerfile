FROM node:20-slim AS build
WORKDIR /app
COPY . .
RUN npm ci && npm run build && npm prune --omit=dev

FROM node:20-slim
WORKDIR /app
# Model installation shells out to real git (source checkout) and unzip
# (zip-archived assets) — node:20-slim ships neither by default. ca-certificates
# is required too: without it, git's HTTPS clone of a real source repository
# fails TLS verification (confirmed by testing without it first).
RUN apt-get update && apt-get install -y --no-install-recommends git unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/registry/package.json ./packages/registry/package.json
COPY --from=build /app/packages/registry/dist ./packages/registry/dist
COPY --from=build /app/packages/runtime/package.json ./packages/runtime/package.json
COPY --from=build /app/packages/runtime/dist ./packages/runtime/dist
COPY --from=build /app/packages/adapters/package.json ./packages/adapters/package.json
COPY --from=build /app/packages/adapters/dist ./packages/adapters/dist
COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/apps/cli/package.json ./apps/cli/package.json
COPY --from=build /app/apps/cli/dist ./apps/cli/dist
ENTRYPOINT ["node", "apps/cli/dist/index.js"]
