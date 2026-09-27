#!/usr/bin/env node
/**
 * mock-device.mjs — a tiny stand-in for a Hikvision terminal's ISAPI HTTP API,
 * used to smoke-test `hikvision-tunnel-worker` without hardware.
 *
 * It enforces HTTP Digest authentication (qop=auth) exactly like the device:
 *   1. request without credentials            → 401 + WWW-Authenticate challenge
 *   2. request with a valid Digest header     → 200 + the ISAPI JSON payload
 *
 * Endpoints:
 *   GET  /ISAPI/AccessControl/AcsEvent?format=json     → AcsEvent.InfoList (3 events)
 *   POST /ISAPI/AccessControl/UserInfo/Record?format=json → ResponseStatus OK (stores user)
 *   PUT  /ISAPI/AccessControl/UserInfo/Record?format=json → same (firmware PUT fallback)
 *
 * Usage: node mock-device.mjs          # listens on 0.0.0.0:9099
 *        PORT=8080 node mock-device.mjs
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 9099);
const REALM = 'hikvision-mock';
const USERNAME = process.env.HIK_USER ?? 'admin';
const PASSWORD = process.env.HIK_PASS ?? 'mock-password-123';

const md5 = (value) => createHash('md5').update(value, 'utf8').digest('hex');

/** The events the mock "terminal" reports (stable ids → upserts stay idempotent). */
const EVENTS = [
  {
    monitorIndex: '1',
    majorType: 5,
    minorType: 75,
    time: '2026-09-27T08:30:12+00:00',
    employeeNo: '1001',
    name: 'Jane Doe',
    cardNo: '654321',
    doorNo: 1,
    currentAuthResult: 'success',
  },
  {
    monitorIndex: '2',
    majorType: 5,
    minorType: 75,
    time: '2026-09-27T08:45:00+00:00',
    employeeNo: '1002',
    name: 'Ali Musa',
    cardNo: '778811',
    doorNo: 1,
    currentAuthResult: 'success',
  },
  {
    monitorIndex: '3',
    majorType: 5,
    minorType: 76,
    time: '2026-09-27T09:01:33+00:00',
    employeeNo: '',
    cardNo: '000000',
    doorNo: 2,
    currentAuthResult: 'failed',
  },
];

const usersReceived = [];

function parseDigest(header) {
  const params = {};
  const pattern = /([a-zA-Z][a-zA-Z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
  let match;
  while ((match = pattern.exec(header)) !== null) {
    params[(match[1] ?? '').toLowerCase()] = match[2] ?? match[3] ?? '';
  }
  return params;
}

function verifyDigest(authorization, method, uri) {
  if (!authorization || !/^Digest\b/i.test(authorization)) return false;
  const p = parseDigest(authorization);
  if (!p.nonce) return false;
  const ha1 = md5(`${USERNAME}:${p.realm ?? REALM}:${PASSWORD}`);
  const ha2 = md5(`${method}:${uri}`);
  const qop = p.qop && p.qop.includes('auth') ? 'auth' : null;
  const expected = qop
    ? md5(`${ha1}:${p.nonce}:${p.nc ?? ''}:${p.cnonce ?? ''}:${qop}:${ha2}`)
    : md5(`${ha1}:${p.nonce}:${ha2}`);
  return p.response === expected;
}

function challenge() {
  const nonce = randomBytes(16).toString('hex');
  return (
    `Digest realm="${REALM}", nonce="${nonce}", qop="auth", algorithm=MD5, ` +
    `opaque="${randomBytes(8).toString('hex')}", Basic realm="${REALM}"`
  );
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const uri = `${url.pathname}${url.search}`;

  // Drain the body so keep-alive connections stay healthy.
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const auth = req.headers.authorization;
    if (!verifyDigest(auth, req.method ?? 'GET', uri)) {
      res.setHeader('WWW-Authenticate', challenge());
      send(res, 401, { error: 'unauthorized' });
      return;
    }

    if (url.pathname === '/ISAPI/AccessControl/AcsEvent' && req.method === 'GET') {
      send(res, 200, {
        AcsEvent: {
          searchID: 'mock-search-1',
          responseStatus: 'true',
          responseStatusStrg: 'OK',
          numOfMatches: String(EVENTS.length),
          InfoList: EVENTS,
        },
      });
      return;
    }

    if (url.pathname === '/ISAPI/AccessControl/UserInfo/Record') {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        send(res, 400, {
          ResponseStatus: { statusCode: 3, statusString: 'Parameter Error', subStatusCode: 'paramsError' },
        });
        return;
      }
      const employeeNo = body?.UserInfo?.employeeNo;
      if (!employeeNo) {
        send(res, 200, {
          ResponseStatus: { statusCode: 3, statusString: 'Parameter Error', subStatusCode: 'paramsError' },
        });
        return;
      }
      usersReceived.push({ employeeNo, name: body.UserInfo.name, at: new Date().toISOString() });
      console.log(`[mock-device] ${req.method} user received:`, JSON.stringify(body.UserInfo));
      send(res, 200, {
        ResponseStatus: { requestURL: uri, statusCode: 1, statusString: 'OK', subStatusCode: 'ok' },
      });
      return;
    }

    send(res, 404, {
      ResponseStatus: { statusCode: 4, statusString: 'Invalid URL', subStatusCode: 'invalidOperation' },
    });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[mock-device] Hikvision ISAPI mock listening on http://0.0.0.0:${PORT}`);
  console.log(`[mock-device] digest user=${USERNAME} (password from HIK_PASS / mock default)`);
});
