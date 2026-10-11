import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev-server host allowlist: permit preview environments (.e2b.app) and any
// custom hosts passed via VITE_DEV_ALLOWED_HOSTS.
const extraHosts = (process.env.VITE_DEV_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean);

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: extraHosts.length ? ['.e2b.app', ...extraHosts] : true,
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    cssCodeSplit: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react-dom') || id.includes('node_modules/react/')) {
            return 'react-vendor';
          }
          if (id.includes('node_modules/qrcode') || id.includes('node_modules/jsbarcode')) {
            return 'pass-codes';
          }
          if (id.includes('node_modules/@zxing')) {
            return 'camera-scanner';
          }
          return undefined;
        },
      },
    },
  },
});
