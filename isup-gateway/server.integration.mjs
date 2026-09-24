import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const temp = mkdtempSync(join(tmpdir(), 'estatemate-isup-test-'));
const localDeviceId = 'main-gate';
const deviceId = '11111111-1111-4111-8111-111111111111';
const deviceKey = 'test-device-key-00000000000000000000000000000000';
const adapterSecret = 'test-adapter-secret-000000000000000000000000000000';
writeFileSync(join(temp, 'devices.json'), JSON.stringify({ devices:[{ localDeviceId,estateMateDeviceId:deviceId,deviceKey }] }));

let eventBody = '';
let resultBody = '';
let sawSecretHeader = false;
const mock = http.createServer(async (request,response) => {
  sawSecretHeader ||= request.headers['x-estatemate-device-key'] === deviceKey;
  const chunks=[]; for await (const chunk of request) chunks.push(chunk);
  const body=Buffer.concat(chunks).toString();
  if (request.method==='POST' && request.url===`/api/hikvision/v1/events/${deviceId}`) {
    eventBody=body; response.writeHead(200,{'Content-Type':'application/json'}); response.end('{"ok":true,"accepted":1}'); return;
  }
  if (request.method==='GET' && request.url===`/api/hikvision/v1/operations/${deviceId}?limit=20`) {
    response.writeHead(200,{'Content-Type':'application/json'}); response.end('{"items":[{"id":"22222222-2222-4222-8222-222222222222","kind":"card"}]}'); return;
  }
  if (request.method==='POST' && request.url===`/api/hikvision/v1/operations/${deviceId}/22222222-2222-4222-8222-222222222222/result`) {
    resultBody=body; response.writeHead(200,{'Content-Type':'application/json'}); response.end('{"ok":true}'); return;
  }
  response.writeHead(404); response.end();
});

await new Promise((resolve)=>mock.listen(0,'127.0.0.1',resolve));
const mockPort=mock.address().port;
const gatewayPort=mockPort+1;
const child=spawn(process.execPath,['server.mjs'],{
  cwd:new URL('.',import.meta.url),
  env:{...process.env,HOST:'127.0.0.1',PORT:String(gatewayPort),ESTATEMATE_WORKER_URL:`http://127.0.0.1:${mockPort}`,ESTATEMATE_DEVICES_FILE:join(temp,'devices.json'),ADAPTER_SHARED_SECRET:adapterSecret},
  stdio:['ignore','pipe','pipe'],
});
let logs=''; child.stdout.on('data',(chunk)=>logs+=chunk); child.stderr.on('data',(chunk)=>logs+=chunk);
try {
  const deadline=Date.now()+5000;
  while (Date.now()<deadline) {
    try { const response=await fetch(`http://127.0.0.1:${gatewayPort}/health`); if (response.ok) break; } catch {}
    await new Promise((resolve)=>setTimeout(resolve,50));
  }
  const auth={ Authorization:`Bearer ${adapterSecret}` };
  const unauthorized=await fetch(`http://127.0.0.1:${gatewayPort}/v1/adapter/operations/${localDeviceId}`);
  assert.equal(unauthorized.status,401);
  const event=await fetch(`http://127.0.0.1:${gatewayPort}/v1/adapter/events/${localDeviceId}`,{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:'{"eventType":"AccessControllerEvent"}'});
  assert.equal(event.status,200);
  const operations=await fetch(`http://127.0.0.1:${gatewayPort}/v1/adapter/operations/${localDeviceId}`,{headers:auth});
  assert.equal(operations.status,200);
  assert.equal((await operations.json()).items.length,1);
  const result=await fetch(`http://127.0.0.1:${gatewayPort}/v1/adapter/operations/${localDeviceId}/22222222-2222-4222-8222-222222222222/result`,{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:'{"kind":"card","status":"applied"}'});
  assert.equal(result.status,200);
  assert.match(eventBody,/AccessControllerEvent/);
  assert.match(resultBody,/applied/);
  assert.equal(sawSecretHeader,true);
  console.log('ISUP control-plane relay test passed');
} finally {
  child.kill('SIGTERM');
  mock.close();
  rmSync(temp,{recursive:true,force:true});
}
