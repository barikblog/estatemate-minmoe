/**
 * Cloudflare Queues → in-process delivery for the offline server.
 *
 * The Worker produces to `ACCESS_EVENTS` and a Cloudflare Queue consumer
 * drains it into D1. Offline there is no queue service to lose data, so the
 * same Worker `queue()` consumer runs inside the server process: `send()`
 * buffers messages, and a background drainer hands them over in batches of
 * `maxBatchSize` (flushed at least every `maxBatchTimeout` seconds), exactly
 * the shape the production consumer is configured with in wrangler.jsonc.
 *
 * Delivery retries with backoff up to `maxRetries`; anything that still fails
 * is written to the dead-letter directory as JSON so no gate event is ever
 * silently dropped. (The cloud deploy uses a DLQ for the same guarantee.)
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function createAccessEventsQueue({ getWorker, getEnv, dlqDir, logger = console, maxBatchSize = 50, maxBatchTimeoutSeconds = 5, maxRetries = 5 }) {
  const buffer = [];
  let flushing = false;
  let timer = null;

  function scheduleFlush() {
    if (timer || flushing) return;
    timer = setTimeout(() => {
      timer = null;
      flush().catch((error) => logger.error('[queue] flush failed', error));
    }, Math.max(1, maxBatchTimeoutSeconds) * 1000);
    timer.unref?.();
  }

  function makeBatch(messages) {
    const acks = new Set();
    const batch = {
      queue: 'estatemate-access-events',
      messages: messages.map((message) => ({
        id: message.id,
        timestamp: message.timestamp,
        attempts: message.attempts,
        body: message.body,
        ack() { acks.add(message.id); },
        retry() { message.retried = true; },
      })),
      ackAll() { for (const message of messages) acks.add(message.id); },
      retryAll() { for (const message of messages) message.retried = true; },
      ackAllMessageIds() { return [...acks]; },
    };
    return batch;
  }

  async function deadLetter(messages, error) {
    try {
      mkdirSync(dlqDir, { recursive: true });
      const file = join(dlqDir, `dlq-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.json`);
      writeFileSync(file, JSON.stringify({ error: String(error?.message ?? error), failedAt: new Date().toISOString(), messages: messages.map((message) => message.body) }, null, 2));
      logger.error(`[queue] ${messages.length} message(s) moved to the dead-letter file ${file}`);
    } catch (writeError) {
      logger.error('[queue] dead-letter write failed', writeError);
    }
  }

  async function deliver(messages) {
    const worker = getWorker();
    const env = getEnv();
    let lastError;
    for (let attempt = 1; attempt <= Math.max(1, maxRetries); attempt += 1) {
      try {
        await worker.queue(makeBatch(messages), env);
        return true;
      } catch (error) {
        lastError = error;
        logger.error(`[queue] consumer attempt ${attempt}/${maxRetries} failed`, error);
        if (attempt < maxRetries) {
          await new Promise((resolve) => { setTimeout(resolve, Math.min(500 * 2 ** (attempt - 1), 10000)); });
        }
      }
    }
    await deadLetter(messages, lastError);
    return false;
  }

  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      while (buffer.length) {
        const messages = buffer.splice(0, Math.max(1, maxBatchSize));
        await deliver(messages);
      }
    } finally {
      flushing = false;
      if (buffer.length) scheduleFlush();
    }
  }

  return {
    /** Producer API the Worker calls: `env.ACCESS_EVENTS.send(payload)`. */
    async send(payload) {
      if (payload === undefined || payload === null) return;
      buffer.push({ id: randomUUID(), timestamp: Date.now(), attempts: 1, body: payload, retried: false });
      if (buffer.length >= maxBatchSize) {
        if (timer) { clearTimeout(timer); timer = null; }
        flush().catch((error) => logger.error('[queue] flush failed', error));
      } else {
        scheduleFlush();
      }
    },
    /** Waits until every buffered message has been handed to the consumer. */
    async drain(timeoutMs = 10000) {
      const deadline = Date.now() + timeoutMs;
      while ((buffer.length || flushing) && Date.now() < deadline) {
        await new Promise((resolve) => { setTimeout(resolve, 25); });
      }
    },
    stats() {
      return { buffered: buffer.length, flushing };
    },
    _makeBatch: makeBatch,
  };
}
