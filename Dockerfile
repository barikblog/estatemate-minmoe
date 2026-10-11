# Sornix EstateOS — Multi-Platform Self-Hosted Container Image
# Runs the full Hono API + React SPA + persistent SQLite D1 database on any
# Docker host, Coolify, Portainer, Railway, Render, Fly.io, or Ubuntu VPS.

FROM node:22-bookworm-slim

WORKDIR /app

# Copy workspace manifests first for fast Docker layer caching
COPY package.json package-lock.json ./
COPY apps/web/package.json ./apps/web/

RUN npm ci

# Copy application source, migrations, and configuration
COPY . .

# Build optimized frontend bundle
RUN npm run build:web

VOLUME ["/data"]
EXPOSE 8787

# Apply all D1 SQLite migrations to persistent /data volume and start server
CMD ["sh", "-c", "npx wrangler d1 migrations apply estatemate-db --local --persist-to /data && npx wrangler dev --local --ip 0.0.0.0 --port ${PORT:-8787} --persist-to /data"]
