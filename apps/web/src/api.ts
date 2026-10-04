export interface User {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'manager' | 'resident' | 'security' | 'cashier' | 'facility_staff';
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

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
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
    const message = typeof data === 'object' && data && 'error' in data ? String(data.error) : `Request failed (${response.status})`;
    throw new ApiError(message, response.status);
  }
  return data as T;
}

export function money(minor: unknown, currency = 'NGN'): string {
  return new Intl.NumberFormat('en-NG', { style: 'currency', currency }).format(Number(minor ?? 0) / 100);
}

export function readableDate(value: unknown): string {
  if (!value) return '—';
  const date = new Date(String(value));
  return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString();
}
