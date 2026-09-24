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

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    credentials: 'include',
    headers: {
      ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const contentType = response.headers.get('Content-Type') ?? '';
  const data = contentType.includes('json') ? await response.json() : await response.text();
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
