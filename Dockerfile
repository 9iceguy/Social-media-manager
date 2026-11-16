FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY server ./server
COPY setup.js ./setup.js
RUN mkdir -p /data /app/data
ENV DATA_DIR=/data
EXPOSE 3001
CMD ["node", "server/index.js"]
