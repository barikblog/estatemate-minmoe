import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev-server host allowlist. Leave unset for the Vite default (localhost only);
// set VITE_DEV_ALLOWED_HOSTS to a comma-separated list when the portal is served
// through a proxy or preview host.
const allowedHosts = (process.env.VITE_DEV_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean);

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    ...(allowedHosts.length ? { allowedHosts } : {}),
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
