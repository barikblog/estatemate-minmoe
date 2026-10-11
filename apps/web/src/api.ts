export interface User {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'manager' | 'resident' | 'security' | 'cashier';
  property_id: string | null;
}

export interface ListResponse<T = Record<string, unknown>> {
  items: T[];
  page: number;
  limit: number;
  [key: string]: unknown;
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/**
 * The browser could not complete the request at all: offline, a blocked or
 * filtered host, DNS/VPN trouble, or a connection that died mid-response.
 * Chrome reports this as a bare `TypeError: Failed to fetch`, which means
 * nothing to an operator staring at the sign-in screen, so callers get a
 * sentence they can act on instead. Status 0 marks "no HTTP response at all";
 * every real HTTP failure keeps its status code.
 */
const NETWORK_ERROR_MESSAGE = "Can't reach the server. Check your internet connection and try again.";

function asNetworkError(reason: unknown): unknown {
  return reason instanceof TypeError ? new ApiError(NETWORK_ERROR_MESSAGE, 0) : reason;
}

/**
 * Lightweight in-memory GET cache and in-flight deduplication so switching
 * between sections or mobile tabs is instantaneous (0ms stale-while-revalidate)
 * and duplicate concurrent requests share a single network round-trip.
 * Any mutating request (POST/PUT/PATCH/DELETE) clears the cache immediately.
 */
const GET_CACHE_TTL_MS = 60_000;
const responseCache = new Map<string, { data: unknown; timestamp: number }>();
const inFlightGet = new Map<string, Promise<unknown>>();

export function peekApiCache<T>(path: string): T | undefined {
  const entry = responseCache.get(path);
  if (!entry) return undefined;
  if (Date.now() - entry.timestamp > GET_CACHE_TTL_MS) {
    responseCache.delete(path);
    return undefined;
  }
  return entry.data as T;
}

export function clearApiCache(): void {
  responseCache.clear();
  inFlightGet.clear();
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase();
  const isGet = method === 'GET' && !options.body;

  if (!isGet) {
    clearApiCache();
  } else {
    const existing = inFlightGet.get(path);
    if (existing) return existing as Promise<T>;
  }

  const execute = (async (): Promise<T> => {
    let response: Response;
    try {
      response = await fetch(path, {
        ...options,
        credentials: 'include',
        headers: {
          ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
          ...options.headers,
        },
      });
    } catch (reason) {
      throw asNetworkError(reason);
    }
    let data: unknown;
    try {
      const contentType = response.headers.get('Content-Type') ?? '';
      data = contentType.includes('json') ? await response.json() : await response.text();
    } catch (reason) {
      // The response started and then the connection dropped while reading it.
      throw asNetworkError(reason);
    }
    if (!response.ok) {
      if (response.status === 401) clearApiCache();
      const message = typeof data === 'object' && data && 'error' in data ? String(data.error) : `Request failed (${response.status})`;
      throw new ApiError(message, response.status);
    }
    if (isGet) {
      responseCache.set(path, { data, timestamp: Date.now() });
    }
    return data as T;
  })();

  if (isGet) {
    inFlightGet.set(path, execute);
    execute.finally(() => {
      if (inFlightGet.get(path) === execute) inFlightGet.delete(path);
    }).catch(() => {});
  }

  return execute;
}

export function money(minor: unknown, currency = 'NGN'): string {
  return new Intl.NumberFormat('en-NG', { style: 'currency', currency }).format(Number(minor ?? 0) / 100);
}

export function readableDate(value: unknown): string {
  if (!value) return '—';
  const date = new Date(String(value));
  return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString();
}
