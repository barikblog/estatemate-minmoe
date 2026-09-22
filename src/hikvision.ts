import type { DeviceIdentity, NormalizedAccessEvent } from './types';
import { sha256 } from './security';

const decoder = new TextDecoder();

function xmlValue(xml: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<(?:\\w+:)?${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?${escaped}>`, 'i').exec(xml);
  return match?.[1]?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() ?? null;
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
    .map((part) => part.slice(part.search(/\r?\n\r?\n/) + (part.includes('\r\n\r\n') ? 4 : 2)))
    .map((part) => part.replace(/\r?\n--?\s*$/, '').trim())
    .filter((part) => part.startsWith('{') || part.startsWith('<'));
}

export function extractEventDocuments(bytes: Uint8Array, contentType: string): string[] {
  if (/multipart\//i.test(contentType)) return multipartTextParts(bytes, contentType);
  const value = decoder.decode(bytes).trim();
  return value ? [value] : [];
}

function mapResult(eventType: string, status: string | null, description: string | null): 'granted' | 'denied' | 'unknown' {
  const value = `${eventType} ${status ?? ''} ${description ?? ''}`.toLowerCase();
  if (/denied|invalid|failed|forbidden|illegal|expired|blacklist|no permission/.test(value)) return 'denied';
  if (/granted|success|legal|pass|authenticated|allowed/.test(value)) return 'granted';
  return 'unknown';
}

function toIso(value: string | null): string {
  if (!value) return new Date().toISOString();
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? new Date().toISOString() : date.toISOString();
}

export async function normalizeHikvisionDocument(
  document: string,
  device: DeviceIdentity,
): Promise<NormalizedAccessEvent | null> {
  let eventType: string | null = null;
  let eventId: string | null = null;
  let timestamp: string | null = null;
  let cardUid: string | null = null;
  let personName: string | null = null;
  let status: string | null = null;
  let description: string | null = null;
  let direction: 'entry' | 'exit' = device.direction === 'exit' ? 'exit' : 'entry';

  if (document.startsWith('{')) {
    let parsed: unknown;
    try { parsed = JSON.parse(document); } catch { return null; }
    eventType = text(findDeep(parsed, ['eventType', 'type', 'majorEventType']));
    eventId = text(findDeep(parsed, ['eventID', 'eventId', 'serialNo', 'seq']));
    timestamp = text(findDeep(parsed, ['dateTime', 'time', 'eventTime']));
    cardUid = text(findDeep(parsed, ['cardNo', 'cardNumber', 'credentialNo']));
    personName = text(findDeep(parsed, ['name', 'employeeName', 'personName']));
    status = text(findDeep(parsed, ['eventState', 'status', 'currentVerifyMode']));
    description = text(findDeep(parsed, ['eventDescription', 'subEventType', 'minorEventType', 'minor']));
    const directionText = text(findDeep(parsed, ['direction', 'inOutType', 'attendanceStatus']))?.toLowerCase();
    if (directionText && /out|exit/.test(directionText)) direction = 'exit';
  } else if (document.startsWith('<')) {
    eventType = xmlValue(document, 'eventType') ?? xmlValue(document, 'majorEventType');
    eventId = xmlValue(document, 'eventID') ?? xmlValue(document, 'serialNo');
    timestamp = xmlValue(document, 'dateTime') ?? xmlValue(document, 'eventTime');
    cardUid = xmlValue(document, 'cardNo') ?? xmlValue(document, 'cardNumber');
    personName = xmlValue(document, 'name') ?? xmlValue(document, 'employeeName');
    status = xmlValue(document, 'eventState') ?? xmlValue(document, 'status');
    description = xmlValue(document, 'eventDescription') ?? xmlValue(document, 'subEventType') ?? xmlValue(document, 'minor');
    const directionText = (xmlValue(document, 'direction') ?? xmlValue(document, 'inOutType'))?.toLowerCase();
    if (directionText && /out|exit/.test(directionText)) direction = 'exit';
  } else {
    return null;
  }

  if (!eventType && !cardUid) return null;
  const deviceTimestamp = toIso(timestamp);
  const vendorEventId = eventId ?? (await sha256(`${device.id}|${deviceTimestamp}|${eventType}|${cardUid}|${description}`)).slice(0, 32);
  const result = mapResult(eventType ?? 'access', status, description);
  const rawSummary = JSON.stringify({ status, description }).slice(0, 500);

  return {
    id: crypto.randomUUID(),
    vendorEventId,
    deviceId: device.id,
    accessPointId: device.accessPointId,
    cardUid,
    personName,
    direction,
    result,
    eventType: eventType ?? 'access',
    deviceTimestamp,
    rawSummary,
  };
}
