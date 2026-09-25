/**
 * Minimal client for the machine-authenticated Worker endpoints the bridge uses
 * for its own diagnostics (`GET /devices`, `POST /heartbeat`).
 *
 * The agent itself talks to the same endpoints from `isapi-bridge/agent.mjs`;
 * this module exists so `bridge check`/`bridge status` can ask the Worker a
 * question without starting the event loops.
 */
'use strict';

const AGENT_KEY_HEADER = 'X-EstateMate-Agent-Key';

function trimUrl(url) {
  return String(url || '').replace(/\/+$/, '');
}

async function workerRequest({ workerUrl, agentId, agentSecret, method = 'GET', path: apiPath, body = null, timeoutMs = 20000 }) {
  const base = trimUrl(workerUrl);
  const url = `${base}${apiPath}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(2000, timeoutMs));
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        [AGENT_KEY_HEADER]: agentSecret,
        'User-Agent': 'EstateMate-Bridge-Host/1.0',
      },
      body: body === null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { ok: response.ok, status: response.status, json, text, durationMs: Date.now() - started, url };
  } catch (error) {
    const aborted = error && (error.name === 'AbortError' || /abort/i.test(error.message || ''));
    return {
      ok: false,
      status: 0,
      json: null,
      text: aborted ? `timed out after ${timeoutMs} ms` : String(error && error.message),
      durationMs: Date.now() - started,
      url,
      networkError: true,
      idleAgentId: agentId,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Read-only liveness + authentication check: lists the devices linked to this agent. */
function listLinkedDevices(options) {
  return workerRequest({ ...options, method: 'GET', path: `/api/isapi/v1/agents/${encodeURIComponent(options.agentId)}/devices` });
}

function sendHeartbeat(options, { hostname, platform, version, stats } = {}) {
  return workerRequest({
    ...options,
    method: 'POST',
    path: `/api/isapi/v1/agents/${encodeURIComponent(options.agentId)}/heartbeat`,
    body: { hostname, platform, version, stats },
  });
}

module.exports = { AGENT_KEY_HEADER, listLinkedDevices, sendHeartbeat, workerRequest };
