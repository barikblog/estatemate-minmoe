import { defineConfig } from 'vitest/config';

/**
 * Vitest defaults plus one addition: the offline LAN server ships its own
 * integration runner (`local-server/server.test.mjs`, a plain Node script
 * that boots the real server and a fake terminal), so it must stay out of
 * the vitest suite and runs through `npm run test:local-server` instead.
 */
export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build}.config.*',
      'local-server/**',
    ],
  },
});
