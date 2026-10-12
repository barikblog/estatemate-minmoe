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

/**
 * A failed request, with everything a screen needs to explain it.
 *
 * `status` is the HTTP status, or 0 when no response arrived at all.
 * `code` is the Worker's machine-readable reason where it sends one
 * (`invalid_credentials`, `account_inactive`, `too_many_attempts`, …), so a
 * screen can use its own wording without parsing the sentence.
 * `retryAfterSeconds` is how long the Worker asked the client to wait.
 */
export class ApiError extends Error {
  status: number;
  code: string | null;
  retryAfterSeconds: number | null;
  constructor(message: string, status: number, options: { code?: string | null; retryAfterSeconds?: number | null } = {}) {
    super(message);
    this.status = status;
    this.code = options.code ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

/**
 * Called when a request comes back 401 outside the sign-in routes, i.e. the
 * session is gone. The app registers one handler and returns to the sign-in
 * screen with an explanation, instead of leaving every later screen failing
 * silently with "Request failed (401)".
 */
type SessionEndedHandler = (problem: ApiError) => void;
let sessionEndedHandler: SessionEndedHandler | null = null;

export function onSessionEnded(handler: SessionEndedHandler | null): void {
  sessionEndedHandler = handler;
}

/** Paths where a 401 is the expected answer, not a lost session. */
function isSignInPath(path: string): boolean {
  return path.startsWith('/api/auth/');
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
  return reason instanceof TypeError ? new ApiError(NETWORK_ERROR_MESSAGE, 0, { code: 'network_unreachable' }) : reason;
}

/** True when the browser never reached the Worker at all. */
export function isOffline(error: unknown): boolean {
  if (error instanceof ApiError) return error.status === 0;
  return typeof navigator !== 'undefined' && navigator.onLine === false;
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
      const body = typeof data === 'object' && data ? (data as Record<string, unknown>) : null;
      const message = body && 'error' in body ? String(body.error) : `Request failed (${response.status})`;
      const headerRetry = Number(response.headers.get('Retry-After'));
      const bodyRetry = Number(body?.retryAfterSeconds);
      const retryAfterSeconds = Number.isFinite(bodyRetry) && bodyRetry > 0
        ? bodyRetry
        : Number.isFinite(headerRetry) && headerRetry > 0 ? headerRetry : null;
      const error = new ApiError(message, response.status, {
        code: body && typeof body.code === 'string' ? body.code : null,
        retryAfterSeconds,
      });
      // A 401 from anywhere but the sign-in routes means the session ended:
      // it expired, the account was deactivated, or the password was changed
      // somewhere else. The app decides what to show; this only reports it.
      if (response.status === 401 && !isSignInPath(path)) sessionEndedHandler?.(error);
      throw error;
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
