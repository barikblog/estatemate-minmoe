/**
 * ESM resolve hook for the offline server.
 *
 * The EstateMate Worker is TypeScript (`src/index.ts`) with extensionless
 * relative imports (`import ... from './csv'`). Node 22 runs TypeScript
 * natively via type stripping, but it does not add the `.ts` extension while
 * resolving, so this hook rewrites `./csv` → `./csv.ts` (and `./x` →
 * `./x/index.ts`) when the file exists. Nothing is transpiled or bundled: the
 * offline server runs the exact same source files as the Cloudflare deploy,
 * so the two can never drift apart.
 */
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function resolveFileUrl(specifier, parentURL) {
  try {
    const url = new URL(specifier, parentURL);
    const path = fileURLToPath(url);
    if (existsSync(path) && statSync(path).isFile()) return url;
  } catch {
    /* Not resolvable as a file URL — fall through. */
  }
  return null;
}

export async function resolve(specifier, context, next) {
  if (
    context.parentURL?.startsWith('file:')
    && (specifier.startsWith('./') || specifier.startsWith('../'))
    && !/\.[A-Za-z0-9]+\/?$/.test(specifier)
  ) {
    for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
      if (resolveFileUrl(candidate, context.parentURL)) {
        return next(candidate, context);
      }
    }
  }
  return next(specifier, context);
}
