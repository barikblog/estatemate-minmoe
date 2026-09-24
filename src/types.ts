export type Role = 'admin' | 'manager' | 'resident' | 'security' | 'cashier';

export interface Env {
  DB: D1Database;
  ACCESS_EVENTS: Queue<AccessEventQueuePayload>;
  LIVE_FEED: DurableObjectNamespace;
  ASSETS: Fetcher;
  APP_NAME: string;
  ALLOWED_ORIGINS: string;
  HIKVISION_MODE: string;
  FILE_STORAGE_MODE?: string;
  JWT_SECRET: string;
  BOOTSTRAP_TOKEN: string;
  DEVICE_INGEST_PEPPER: string;
  STORAGE_ENCRYPTION_KEY?: string;
  GEMINI_API_KEY?: string;
}

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  property_id: string | null;
}

export interface JwtClaims {
  sub: string;
  role: Role;
  name: string;
  iat: number;
  exp: number;
}

export interface DeviceIdentity {
  id: string;
  name: string;
  username: string;
  direction: 'entry' | 'exit' | 'both';
  accessPointId: string | null;
  profileKey: string;
  connectionPattern: string;
}

export interface NormalizedAccessEvent {
  id: string;
  vendorEventId: string;
  deviceId: string;
  accessPointId: string | null;
  cardUid: string | null;
  employeeNo: string | null;
  personName: string | null;
  credentialType: string | null;
  doorNo: string | null;
  direction: 'entry' | 'exit';
  result: 'granted' | 'denied' | 'unknown';
  eventType: string;
  deviceTimestamp: string;
  profileKey: string;
  rawSummary: string;
}

/**
 * Queue message payload. A message normally carries a single event, but batch
 * ingestion (ISAPI bridge agent event streaming, multipart device posts) sends
 * one message containing the whole request batch so a burst of events costs a
 * single Queue operation set instead of one set per event.
 */
export type AccessEventQueuePayload = NormalizedAccessEvent | { batch: NormalizedAccessEvent[] };

export function flattenQueuePayload(body: AccessEventQueuePayload): NormalizedAccessEvent[] {
  if (body && typeof body === 'object' && 'batch' in body && Array.isArray((body as { batch?: unknown }).batch)) {
    return (body as { batch: NormalizedAccessEvent[] }).batch;
  }
  return [body as NormalizedAccessEvent];
}

export interface AppVariables {
  user: AuthUser;
  device: DeviceIdentity;
}
