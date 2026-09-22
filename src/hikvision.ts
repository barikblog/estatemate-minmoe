import { getHikvisionProfile, type HikvisionProfile } from './hikvision-profiles';
import type { DeviceIdentity, NormalizedAccessEvent } from './types';
import { sha256 } from './security';

const decoder = new TextDecoder();

function xmlValue(xml: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<(?:\\w+:)?${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?${escaped}>`, 'i').exec(xml);
  return match?.[1]?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() ?? null;
}

function firstXml(xml: string, aliases: string[]): string | null {
  for (const alias of aliases) {
    const result = xmlValue(xml, alias);
    if (result != null) return result;
  }
  return null;
}

function findDeep(value: unknown, keys: string[]): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) if (record[key] != null) return record[key];
  for (const child of Object.values(record)) {
    const result = findDeep(child, keys);
    if (result != null) return result;
  }
  return undefined;
}

function text(value: unknown): string | null {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim() || null;
  return null;
}

function multipartTextParts(bytes: Uint8Array, contentType: string): string[] {
  const boundaryMatch = /boundary\s*=\s*"?([^";]+)"?/i.exec(contentType);
  if (!boundaryMatch?.[1]) return [decoder.decode(bytes)];
  const whole = decoder.decode(bytes);
  return whole
    .split(`--${boundaryMatch[1]}`)
    .map((part) => part.replace(/^\r?\n/, ''))
    .map((part) => {
      const separator = part.search(/\r?\n\r?\n/);
      if (separator < 0) return '';
      return part.slice(separator + (part.includes('\r\n\r\n') ? 4 : 2));
    })
    .map((part) => part.replace(/\r?\n--?\s*$/, '').trim())
    .filter((part) => part.startsWith('{') || part.startsWith('<'));
}

export function extractEventDocuments(bytes: Uint8Array, contentType: string): string[] {
  if (/multipart\//i.test(contentType)) return multipartTextParts(bytes, contentType);
  const value = decoder.decode(bytes).trim();
  return value ? [value] : [];
}

function mapResult(
  profile: HikvisionProfile,
  eventType: string,
  status: string | null,
  description: string | null,
): 'granted' | 'denied' | 'unknown' {
  const value = `${eventType} ${status ?? ''} ${description ?? ''}`.toLowerCase();
  if (profile.deniedPatterns.some((pattern) => value.includes(pattern.toLowerCase()))) return 'denied';
  if (profile.grantedPatterns.some((pattern) => value.includes(pattern.toLowerCase()))) return 'granted';
  return 'unknown';
}

function toIso(value: string | null): string {
  if (!value) return new Date().toISOString();
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? new Date().toISOString() : date.toISOString();
}

function normalizeDirection(value: string | null, fallback: DeviceIdentity['direction']): 'entry' | 'exit' {
  if (value && /out|exit|check.?out|leave|egress|2/i.test(value)) return 'exit';
  if (value && /in|entry|check.?in|enter|ingress|1/i.test(value)) return 'entry';
  return fallback === 'exit' ? 'exit' : 'entry';
}

function inferCredentialType(value: string | null, eventType: string | null, cardUid: string | null): string | null {
  const haystack = `${value ?? ''} ${eventType ?? ''}`.toLowerCase();
  if (/palm|vein/.test(haystack)) return 'palm';
  if (/iris/.test(haystack)) return 'iris';
  if (/finger/.test(haystack)) return 'fingerprint';
  if (/face/.test(haystack)) return 'face';
  if (/qr|qrcode/.test(haystack)) return 'qr';
  if (/pin|password/.test(haystack)) return 'pin';
  if (/card/.test(haystack) || cardUid) return 'card';
  return value;
}

export async function normalizeHikvisionDocument(
  document: string,
  device: DeviceIdentity,
): Promise<NormalizedAccessEvent | null> {
  const profile = getHikvisionProfile(device.profileKey);
  const fields: Record<keyof HikvisionProfile['aliases'], string | null> = {
    eventType: null,
    eventId: null,
    timestamp: null,
    cardUid: null,
    personName: null,
    employeeNo: null,
    status: null,
    description: null,
    direction: null,
    credentialType: null,
    doorNo: null,
  };

  if (document.startsWith('{')) {
    let parsed: unknown;
    try { parsed = JSON.parse(document); } catch { return null; }
    for (const [field, fieldAliases] of Object.entries(profile.aliases)) {
      fields[field as keyof typeof fields] = text(findDeep(parsed, fieldAliases));
    }
  } else if (document.startsWith('<')) {
    for (const [field, fieldAliases] of Object.entries(profile.aliases)) {
      fields[field as keyof typeof fields] = firstXml(document, fieldAliases);
    }
  } else {
    return null;
  }

  if (!fields.eventType && !fields.cardUid && !fields.employeeNo) return null;
  const eventType = fields.eventType ?? 'access';
  const deviceTimestamp = toIso(fields.timestamp);
  const direction = normalizeDirection(fields.direction, device.direction);
  const vendorEventId = fields.eventId ?? (await sha256(
    `${device.id}|${deviceTimestamp}|${eventType}|${fields.cardUid}|${fields.employeeNo}|${fields.description}|${fields.doorNo}`,
  )).slice(0, 32);
  const result = mapResult(profile, eventType, fields.status, fields.description);
  const credentialType = inferCredentialType(fields.credentialType, eventType, fields.cardUid);
  const rawSummary = JSON.stringify({
    profile: profile.key,
    status: fields.status,
    description: fields.description,
    employeeNo: fields.employeeNo,
    credentialType,
    doorNo: fields.doorNo,
  }).slice(0, 700);

  return {
    id: crypto.randomUUID(),
    vendorEventId,
    deviceId: device.id,
    accessPointId: device.accessPointId,
    cardUid: fields.cardUid,
    employeeNo: fields.employeeNo,
    personName: fields.personName,
    credentialType,
    doorNo: fields.doorNo,
    direction,
    result,
    eventType,
    deviceTimestamp,
    profileKey: profile.key,
    rawSummary,
  };
}
