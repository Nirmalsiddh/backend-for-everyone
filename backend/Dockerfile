FROM node:24-bookworm-slim AS build
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
COPY shared/ /app/shared/
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app/backend
COPY --from=build --chown=node:node /app/backend/package*.json ./
COPY --from=build --chown=node:node /app/backend/node_modules ./node_modules
COPY --from=build --chown=node:node /app/backend/dist ./dist
COPY --from=build --chown=node:node /app/backend/migrations ./migrations
COPY --from=build --chown=node:node /app/shared /app/shared
USER node
CMD ["node", "dist/server.js"]
