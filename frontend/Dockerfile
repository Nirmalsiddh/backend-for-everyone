FROM node:24-bookworm-slim AS build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
COPY shared/ /app/shared/
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app/frontend
COPY --from=build --chown=node:node /app/frontend/package*.json ./
COPY --from=build --chown=node:node /app/frontend/node_modules ./node_modules
COPY --from=build --chown=node:node /app/frontend/.next ./.next
COPY --from=build --chown=node:node /app/frontend/next.config.ts ./next.config.ts
COPY --from=build --chown=node:node /app/shared /app/shared
USER node
CMD ["node", "node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0", "--port", "3001"]
