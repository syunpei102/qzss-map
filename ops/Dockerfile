FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY ops/package.json ops/package-lock.json ./ops/
RUN npm ci --prefix ops --omit=dev && apt-get update && apt-get install -y --no-install-recommends python3 openssl chromium ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
COPY ops ./ops
COPY public ./public
CMD ["node","ops/server.js"]
