FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js report-state.js persist-queue.js request-guards.js device-commands.js device-status.js region_groups.json ./
COPY public ./public

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
