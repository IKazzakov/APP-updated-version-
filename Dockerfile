FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080 MOVEMENT_DB_PATH=/app/.data/movement.sqlite
COPY --from=build /app/package.json ./
COPY --from=build /app/server ./server
COPY --from=build /app/src/config.js ./src/config.js
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/dist/client ./dist/client
RUN mkdir .data && chown node:node .data
USER node
EXPOSE 8080
CMD ["node", "server/node.js"]
