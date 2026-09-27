/**
 * Terminal lab: the real Worker, the real LAN agent (`isapi-bridge/agent.mjs`)
 * and a simulated Hikvision access terminal, wired together over real HTTP so
 * a card operation can be followed from the Worker queue, through the agent,
 * onto the terminal, and back into the hardware logs an operator reads.
 *
 * The simulated terminal only enforces documented ISAPI behaviour:
 *  - `employeeNo` (the person ID) is 1-32 bytes; anything longer is refused
 *    with the ISAPI ResponseStatus shape (statusCode 6 "Invalid Content",
 *    subStatusCode "badParameters", errorMsg naming the field);
 *  - a card record binds a card number to whatever `employeeNo` it names, so a
 *    card sent with the wrong employee number is attached to the wrong person;
 *  - deleting a card succeeds whether or not the card exists.
 * It deliberately does not invent firmware-specific behaviour beyond that.
 *
 * Node built-ins are loaded through computed specifiers, like `harness.ts`, so
 * the root tsconfig does not need `@types/node`.
 */
import worker from '../src/index';
import type { Env } from '../src/types';

interface NodeIncomingMessage {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  on(event: 'data', listener: (chunk: Uint8Array) => void): void;
  on(event: 'end', listener: () => void): void;
}

interface NodeServerResponse {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string | Uint8Array): void;
}

interface NodeServer {
  listen(port: number, host: string, listener: () => void): void;
  address(): { port: number };
  close(listener?: () => void): void;
  closeAllConnections?(): void;
}

interface NodeHttp {
  createServer(handler: (request: NodeIncomingMessage, response: NodeServerResponse) => void): NodeServer;
}

interface NodeReadable { on(event: 'data', listener: (chunk: Uint8Array) => void): void }

interface NodeChildProcess {
  stdout: NodeReadable;
  stderr: NodeReadable;
  exitCode: number | null;
  on(event: 'exit', listener: (code: number | null) => void): void;
  kill(signal?: string): boolean;
}

interface NodeChildProcessModule {
  spawn(command: string, args: string[], options: { env: Record<string, string | undefined>; cwd?: string }): NodeChildProcess;
}

interface NodeFs {
  mkdtempSync(prefix: string): string;
  writeFileSync(path: string, data: string): void;
  rmSync(path: string, options: { recursive: boolean; force: boolean }): void;
}

interface NodeOs { tmpdir(): string }

interface NodeProcess { execPath: string; env: Record<string, string | undefined> }

async function nodeModule<T>(name: string): Promise<T> {
  const specifier = ['node:', name].join('');
  return await import(specifier) as T;
}

const nodeProcess = (globalThis as unknown as { process: NodeProcess }).process;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

function readBody(request: NodeIncomingMessage): Promise<ArrayBuffer> {
  return new Promise((resolve) => {
    const chunks: Uint8Array[] = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const body = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
      // A fresh array sized to the body, so its buffer is exactly the body bytes.
      resolve(body.buffer as ArrayBuffer);
    });
  });
}

function listen(server: NodeServer): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function closeServer(server: NodeServer): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

const HOP_BY_HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive']);

export interface WorkerServer {
  url: string;
  close(): Promise<void>;
}

/** Serves the real Worker on a loopback port so an out-of-process agent can reach it. */
export async function startWorkerServer(env: Env): Promise<WorkerServer> {
  const http = await nodeModule<NodeHttp>('http');
  const context = { waitUntil: async () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const server = http.createServer((incoming, outgoing) => {
    void (async () => {
      const body = await readBody(incoming);
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (typeof value === 'string' && !HOP_BY_HOP.has(name.toLowerCase())) headers.set(name, value);
      }
      const method = incoming.method ?? 'GET';
      try {
        const response = await worker.fetch(
          new Request(`https://estatemate.test${incoming.url ?? '/'}`, { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : body }),
          env,
          context,
        );
        const payload = new Uint8Array(await response.arrayBuffer());
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, name) => { if (!HOP_BY_HOP.has(name.toLowerCase())) responseHeaders[name] = value; });
        outgoing.writeHead(response.status, responseHeaders);
        outgoing.end(payload);
      } catch (error) {
        outgoing.writeHead(500, { 'Content-Type': 'text/plain' });
        outgoing.end(String(error));
      }
    })();
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, close: () => closeServer(server) };
}

export interface TerminalRequest { method: string; path: string; body: string }

export interface SimulatedTerminal {
  port: number;
  /** employeeNo -> person name, i.e. who the terminal knows each employee number as. */
  persons: Map<string, string>;
  /** cardNo -> employeeNo the terminal has bound that card to. */
  cards: Map<string, string>;
  requests: TerminalRequest[];
  close(): Promise<void>;
}

/** Documented ISAPI limit for the person ID on access-control terminals. */
export const ISAPI_EMPLOYEE_NO_MAX_BYTES = 32;

function responseStatus(json: boolean, statusCode: number, statusString: string, subStatusCode: string, errorMsg?: string): string {
  if (json) {
    return JSON.stringify({
      statusCode, statusString, subStatusCode,
      ...(statusCode === 1 ? {} : { errorCode: 1610612737, errorMsg: errorMsg ?? subStatusCode }),
    });
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<ResponseStatus version="2.0"><statusCode>${statusCode}</statusCode><statusString>${statusString}</statusString><subStatusCode>${subStatusCode}</subStatusCode>${errorMsg ? `<errorMsg>${errorMsg}</errorMsg>` : ''}</ResponseStatus>`;
}

/**
 * Starts a simulated terminal. `persons` seeds who is already enrolled on it
 * (employeeNo -> name), as an installer would have left it.
 */
export async function startSimulatedTerminal(options: { persons?: Record<string, string> } = {}): Promise<SimulatedTerminal> {
  const http = await nodeModule<NodeHttp>('http');
  const persons = new Map(Object.entries(options.persons ?? {}));
  const cards = new Map<string, string>();
  const requests: TerminalRequest[] = [];
  const server = http.createServer((incoming, outgoing) => {
    void (async () => {
      const method = incoming.method ?? 'GET';
      const path = incoming.url ?? '/';
      const body = decoder.decode(await readBody(incoming));
      if (!incoming.headers.authorization) {
        outgoing.writeHead(401, { 'WWW-Authenticate': 'Basic realm="terminal"' });
        outgoing.end();
        return;
      }
      requests.push({ method, path, body });
      const json = path.includes('format=json');
      const reply = (status: number, text: string) => {
        outgoing.writeHead(status, { 'Content-Type': json ? 'application/json' : 'application/xml' });
        outgoing.end(text);
      };

      if (method === 'POST' && path.startsWith('/ISAPI/AccessControl/CardInfo/Record')) {
        let employeeNo: unknown;
        let cardNo: unknown;
        if (json) {
          try {
            const parsed = JSON.parse(body) as { CardInfo?: { employeeNo?: unknown; cardNo?: unknown } };
            employeeNo = parsed.CardInfo?.employeeNo;
            cardNo = parsed.CardInfo?.cardNo;
          } catch {
            reply(400, responseStatus(true, 6, 'Invalid Content', 'badJsonContent'));
            return;
          }
        } else {
          employeeNo = /<employeeNo>([^<]*)<\/employeeNo>/.exec(body)?.[1];
          cardNo = /<cardNo>([^<]*)<\/cardNo>/.exec(body)?.[1];
        }
        if (typeof employeeNo !== 'string' || !employeeNo || typeof cardNo !== 'string' || !cardNo) {
          reply(400, responseStatus(json, 6, 'Invalid Content', 'MessageParametersLack', 'CardInfo'));
          return;
        }
        if (encoder.encode(employeeNo).length > ISAPI_EMPLOYEE_NO_MAX_BYTES) {
          reply(400, responseStatus(json, 6, 'Invalid Content', 'badParameters', 'employeeNo'));
          return;
        }
        cards.set(cardNo, employeeNo);
        reply(200, responseStatus(json, 1, 'OK', 'ok'));
        return;
      }

      if (method === 'PUT' && path.startsWith('/ISAPI/AccessControl/CardInfo/Delete')) {
        const numbers = json
          ? (() => { try { return ((JSON.parse(body) as { CardNoList?: Array<{ CardNo?: string }> }).CardNoList ?? []).map((item) => String(item.CardNo ?? '')); } catch { return []; } })()
          : [...body.matchAll(/<CardNo>([^<]*)<\/CardNo>/g)].map((match) => match[1] ?? '');
        for (const number of numbers) cards.delete(number);
        reply(200, responseStatus(json, 1, 'OK', 'ok'));
        return;
      }

      reply(404, responseStatus(json, 4, 'Invalid Operation', 'notSupport'));
    })();
  });
  const port = await listen(server);
  return { port, persons, cards, requests, close: () => closeServer(server) };
}

export interface AgentRun {
  output: string;
  exitCode: number | null;
}

/**
 * Runs the real `isapi-bridge/agent.mjs` as its own process against the given
 * Worker URL until `until()` holds (or the timeout passes), then stops it the
 * way a service manager would (SIGTERM). The alert stream is switched off so
 * only the operation path is exercised.
 */
export async function runAgent(options: {
  workerUrl: string;
  agentId: string;
  agentSecret: string;
  terminals: Array<{ estateMateDeviceId: string; name: string; port: number }>;
  until: () => boolean | Promise<boolean>;
  timeoutMs?: number;
}): Promise<AgentRun> {
  const fs = await nodeModule<NodeFs>('fs');
  const os = await nodeModule<NodeOs>('os');
  const childProcess = await nodeModule<NodeChildProcessModule>('child_process');
  const dir = fs.mkdtempSync(`${os.tmpdir()}/estatemate-terminal-lab-`);
  const configPath = `${dir}/agent-config.json`;
  const devicesPath = `${dir}/isapi-devices.json`;
  fs.writeFileSync(configPath, JSON.stringify({
    agentId: options.agentId,
    agentSecret: options.agentSecret,
    workerUrl: options.workerUrl,
    syncIntervalSeconds: 5,
    heartbeatIntervalSeconds: 3600,
    eventStream: false,
    logLevel: 'info',
  }));
  fs.writeFileSync(devicesPath, JSON.stringify({
    devices: options.terminals.map((terminal) => ({
      estateMateDeviceId: terminal.estateMateDeviceId,
      name: terminal.name,
      isapiHost: '127.0.0.1',
      isapiPort: terminal.port,
      isapiUsername: 'admin',
      isapiPassword: 'terminal-password',
      protocol: 'http',
    })),
  }));

  const env = { ...nodeProcess.env };
  delete env.ESTATEMATE_AGENT_STANDBY;
  const child = childProcess.spawn(nodeProcess.execPath, ['isapi-bridge/agent.mjs', '--config', configPath, '--devices', devicesPath], { env });
  let output = '';
  child.stdout.on('data', (chunk) => { output += decoder.decode(chunk); });
  child.stderr.on('data', (chunk) => { output += decoder.decode(chunk); });
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));

  const deadline = Date.now() + (options.timeoutMs ?? 20000);
  let exitCode: number | null = null;
  try {
    while (Date.now() < deadline && child.exitCode === null) {
      if (await options.until()) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 4000);
    exitCode = await exited;
    clearTimeout(timer);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { output, exitCode };
}
