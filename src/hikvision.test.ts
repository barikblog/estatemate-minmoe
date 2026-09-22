import { describe, expect, it } from 'vitest';
import { extractEventDocuments, normalizeHikvisionDocument } from './hikvision';
import type { DeviceIdentity } from './types';

const device: DeviceIdentity = {
  id: 'device-1',
  name: 'Gate 1',
  username: 'gate1',
  direction: 'entry',
  accessPointId: 'point-1',
};

describe('Hikvision event parser', () => {
  it('normalizes JSON access events', async () => {
    const event = await normalizeHikvisionDocument(JSON.stringify({
      EventNotificationAlert: {
        eventType: 'AccessControllerEvent',
        dateTime: '2026-09-22T10:30:00+01:00',
        eventState: 'active',
        AccessControllerEvent: { cardNo: '123456', name: 'Amina', subEventType: 'legalCardPass' },
      },
    }), device);
    expect(event?.cardUid).toBe('123456');
    expect(event?.personName).toBe('Amina');
    expect(event?.result).toBe('granted');
  });

  it('normalizes XML events', async () => {
    const event = await normalizeHikvisionDocument(`<?xml version="1.0"?><EventNotificationAlert>
      <eventType>AccessControllerEvent</eventType><dateTime>2026-09-22T11:00:00+01:00</dateTime>
      <AccessControllerEvent><cardNo>999</cardNo><name>Musa</name><subEventType>invalidCard</subEventType></AccessControllerEvent>
    </EventNotificationAlert>`, device);
    expect(event?.cardUid).toBe('999');
    expect(event?.result).toBe('denied');
  });

  it('extracts multipart JSON and XML metadata', () => {
    const boundary = 'hik-boundary';
    const body = `--${boundary}\r\nContent-Type: application/json\r\n\r\n{"eventType":"access"}\r\n--${boundary}\r\nContent-Type: application/xml\r\n\r\n<Event><eventType>door</eventType></Event>\r\n--${boundary}--`;
    const parts = extractEventDocuments(new TextEncoder().encode(body), `multipart/mixed; boundary=${boundary}`);
    expect(parts).toHaveLength(2);
  });
});
