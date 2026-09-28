import { defineConfig } from 'vitest/config';

/**
 * Vitest defaults plus one addition: the offline editions ship their own
 * integration runners (`local-server/server.test.mjs` and
 * `bridge-apps/android-offline/server/adapter.test.mjs`, plain Node scripts
 * that boot the real server / real engine bundle against mocks), so they must
 * stay out of the vitest suite and run through `npm run test:local-server`
 * and `npm run test:offline-adapter` instead.
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
      'bridge-apps/android-offline/**',
    ],
  },
});
