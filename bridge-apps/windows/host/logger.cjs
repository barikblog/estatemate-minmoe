/**
 * Console + rolling-file logger for the EstateMate Bridge executable.
 *
 * A bridge normally runs unattended: as a Scheduled Task there is no console at
 * all, and on Windows stdout of a console process started by the Task Scheduler
 * goes nowhere. Every line therefore lands in a log file as well as the console,
 * and `console.log` itself is patched so the embedded bridge agent — which logs
 * through `console` — is captured without touching `isapi-bridge/agent.mjs`.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const MAX_BYTES_DEFAULT = 5 * 1024 * 1024;

function formatArg(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function createLogger(options = {}) {
  let level = LEVELS[options.level] === undefined ? LEVELS.info : LEVELS[options.level];
  const mirrorConsole = options.console !== false;
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : MAX_BYTES_DEFAULT;
  const original = {
    log: console.log.bind(console),
    error: console.error.bind(console),
    warn: console.warn.bind(console),
    debug: console.debug.bind(console),
    info: console.info ? console.info.bind(console) : console.log.bind(console),
  };

  let stream = null;
  let filePath = null;
  let fileWarning = null;

  function openFile(target) {
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      stream = fs.createWriteStream(target, { flags: 'a' });
      stream.on('error', (error) => {
        fileWarning = `log file ${target} is not writable (${error.message}); continuing on console only`;
        stream = null;
      });
      filePath = target;
    } catch (error) {
      fileWarning = `cannot write log file ${target} (${error.message}); continuing on console only`;
      stream = null;
      filePath = null;
    }
  }

  if (options.file) openFile(path.resolve(options.file));

  function rotateIfNeeded() {
    if (!filePath) return;
    try {
      const stat = fs.statSync(filePath);
      if (stat.size < maxBytes) return;
      stream?.end();
      const backup = `${filePath}.1`;
      fs.rmSync(backup, { force: true });
      fs.renameSync(filePath, backup);
      openFile(filePath);
      write('info', [`Log rotated; previous file kept at ${backup}`]);
    } catch {
      // rotation is best effort; never let it break logging
    }
  }

  function write(levelName, args) {
    if (LEVELS[levelName] < level) return;
    const message = args.map(formatArg).join(' ');
    const line = `[${new Date().toISOString()}] [${levelName.toUpperCase()}] ${message}`;
    if (stream) {
      try {
        stream.write(`${line}\n`);
      } catch {
        // ignore: a broken log file must not stop the bridge
      }
    }
    if (!mirrorConsole) return;
    const sink = levelName === 'error' ? 'stderr' : 'stdout';
    try {
      process[sink].write(`${line}\n`);
    } catch {
      // A service context can have no usable stdout handle; the file keeps the line.
    }
  }

  const logger = {
    get level() {
      return Object.keys(LEVELS).find((name) => LEVELS[name] === level) || 'info';
    },
    setLevel(name) {
      if (LEVELS[name] === undefined) return false;
      level = LEVELS[name];
      return true;
    },
    get filePath() {
      return filePath;
    },
    get fileWarning() {
      return fileWarning;
    },
    debug: (...a) => write('debug', a),
    info: (...a) => {
      rotateIfNeeded();
      write('info', a);
    },
    warn: (...a) => write('warn', a),
    error: (...a) => write('error', a),
    /** Raw line, no level stamping — used for tables and banners. */
    raw: (text = '') => {
      if (stream) {
        try {
          stream.write(`${text}\n`);
        } catch {
          /* ignore */
        }
      }
      if (!mirrorConsole) return;
      try {
        process.stdout.write(`${text}\n`);
      } catch {
        /* ignore */
      }
    },
    /** Route everything the bridge agent prints through this logger. */
    installConsoleMirror() {
      const route = (levelName, fallback) => (...args) => {
        if (LEVELS[levelName] < level) {
          // Still emit below-threshold lines to the console when it exists, so a
          // technician running with -v is not surprised by missing output.
          if (!mirrorConsole) return;
          try {
            fallback(...args);
          } catch {
            /* ignore */
          }
          return;
        }
        write(levelName, args);
      };
      console.log = route('info', original.log);
      console.info = route('info', original.info);
      console.warn = route('warn', original.warn);
      console.error = route('error', original.error);
      console.debug = route('debug', original.debug);
    },
    close() {
      try {
        stream?.end();
      } catch {
        /* ignore */
      }
      stream = null;
    },
    tail(lines = 20) {
      if (!filePath) return [];
      try {
        const content = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
        return content.slice(-lines);
      } catch {
        return [];
      }
    },
  };

  return logger;
}

module.exports = { createLogger, LEVELS };
