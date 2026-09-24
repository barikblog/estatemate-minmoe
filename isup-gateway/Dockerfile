FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json server.mjs ./
# The process has no Linux capabilities and a read-only root filesystem in compose.
# It stays uid 0 only so it can read the host-mounted 0600 device-secret file.
ENV HOST=127.0.0.1 PORT=8788 NODE_ENV=production
CMD ["node", "server.mjs"]
