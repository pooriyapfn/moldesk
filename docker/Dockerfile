FROM node:20-slim AS build
WORKDIR /app
COPY . .
RUN corepack enable && pnpm install --frozen-lockfile && pnpm --filter @moldesk/cli build

FROM node:20-slim
WORKDIR /app
COPY --from=build /app/apps/cli/dist ./dist
COPY --from=build /app/apps/cli/package.json ./package.json
ENTRYPOINT ["node", "dist/index.js"]
