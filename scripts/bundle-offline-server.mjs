#!/usr/bin/env node
/**
 * Bundles the EstateMate offline Android engine.
 *
 * One esbuild pass turns `bridge-apps/android-offline/server/adapter.js` plus
 * the unmodified Cloudflare Worker (`src/index.ts`, TypeScript, hono from
 * node_modules) into a single classic-script IIFE the app's hidden WebView
 * executes. There is no fork of product code: the APK literally runs the
 * repository's Worker.
 *
 * Output: <out>/server-bundle.js  (global EstateMateOfflineModule)
 *         <out>/boot.html        (the page the WebView loads)
 *
 * Usage: node scripts/bundle-offline-server.mjs [--out dir] [--minify]
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const outDir = resolve(argValue('out', 'dist/offline-server-bundle'));
const minify = args.includes('--minify');

export async function buildServerBundle(options = {}) {
  const targetDir = resolve(options.out ?? outDir);
  mkdirSync(targetDir, { recursive: true });
  const result = await build({
    entryPoints: [resolve(root, 'bridge-apps/android-offline/server/adapter.js')],
    bundle: true,
    format: 'iife',
    globalName: 'EstateMateOfflineModule',
    platform: 'browser',
    // WebView (Chromium) baseline; keeps optional chaining, async/await, etc.
    target: 'es2021',
    minify: options.minify ?? minify,
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'info',
    outfile: resolve(targetDir, 'server-bundle.js'),
    metafile: true,
  });
  const html = `<!doctype html>
<!-- EstateMate offline engine host page. Served from APK assets at
     https://localhost/ via shouldInterceptRequest, which is what makes the
     WebView a secure context (crypto.subtle) without any network. -->
<html><head><meta charset="utf-8"><title>EstateMate offline engine</title></head>
<body><script src="server-bundle.js"></script></body></html>
`;
  writeFileSync(resolve(targetDir, 'boot.html'), html, 'utf8');
  return {
    bundle: resolve(targetDir, 'server-bundle.js'),
    html: resolve(targetDir, 'boot.html'),
    metafile: result.metafile,
  };
}

const isEntrypoint = process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href;
if (isEntrypoint) {
  buildServerBundle().then((result) => {
    console.log(`bundle: ${result.bundle} (${(statSync(result.bundle).size / 1024).toFixed(1)} kB)`);
    console.log(`html:   ${result.html}`);
  }).catch((error) => {
    console.error('Bundle failed:', error);
    process.exit(1);
  });
}
