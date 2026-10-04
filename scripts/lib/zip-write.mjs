#!/usr/bin/env node
/**
 * A minimal ZIP writer, store-only (no compression), no dependencies.
 *
 * The installer kit is the one archive this repository *creates* rather than
 * consumes: the MSI, its launcher and its checksums, zipped so a person has one
 * file to download and one file to double-click. `zlib` cannot write a ZIP
 * container on its own, and a release build must not depend on a 7-Zip or
 * Compress-Archive being present on the runner, so the container is written
 * here: local headers, then the central directory, then the end record.
 *
 * Store-only is deliberate. The payload is an MSI (already LZX-compressed) and
 * two small scripts, so deflating them would save little and make the bytes
 * depend on a compressor version.
 *
 * Entry names are written as UTF-8 with the language-encoding flag set, and
 * every timestamp is fixed, so the same inputs always produce the same archive.
 */
import fs from 'node:fs';

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_RECORD = 0x06054b50;
const VERSION_NEEDED = 20; // 2.0: the first version that readers can rely on for stored entries
const FLAG_UTF8 = 0x0800;

/** Precomputed CRC-32 table (the polynomial from the ZIP specification). */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

/** 1980-01-01, the earliest date MS-DOS timestamps can express. */
function dosDateTime(date) {
  const year = Math.max(1980, date.getUTCFullYear());
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (Math.floor(date.getUTCSeconds() / 2) & 0x1f),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

function entryBuffer(entry) {
  if (entry.data !== undefined) {
    return Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, entry.encoding || 'utf8');
  }
  if (entry.path) return fs.readFileSync(entry.path);
  throw new Error(`zip entry ${entry.name} has neither data nor path`);
}

/**
 * Builds a ZIP archive in memory.
 *
 * @param {Array<{name: string, data?: Buffer|string, path?: string}>} entries
 * @param {{date?: Date}} [options]
 * @returns {Buffer}
 */
export function createZip(entries, options = {}) {
  const stamp = dosDateTime(options.date instanceof Date ? options.date : new Date(Date.UTC(1980, 0, 1)));
  const parts = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    if (!entry || !entry.name) throw new Error('zip entry needs a name');
    const name = Buffer.from(String(entry.name).replace(/\\/g, '/'), 'utf8');
    const data = entryBuffer(entry);
    if (name.length > 0xffff) throw new Error(`zip entry name too long: ${entry.name}`);
    if (data.length > 0xffffffff) throw new Error(`zip entry too large for a store-only zip: ${entry.name}`);

    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL_HEADER, 0);
    header.writeUInt16LE(VERSION_NEEDED, 4);
    header.writeUInt16LE(FLAG_UTF8, 6);
    header.writeUInt16LE(0, 8); // stored
    header.writeUInt16LE(stamp.time, 10);
    header.writeUInt16LE(stamp.date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);

    parts.push(header, name, data);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(CENTRAL_HEADER, 0);
    record.writeUInt16LE(VERSION_NEEDED, 4);
    record.writeUInt16LE(VERSION_NEEDED, 6);
    record.writeUInt16LE(FLAG_UTF8, 8);
    record.writeUInt16LE(0, 10); // stored
    record.writeUInt16LE(stamp.time, 12);
    record.writeUInt16LE(stamp.date, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt16LE(0, 30); // extra
    record.writeUInt16LE(0, 32); // comment
    record.writeUInt16LE(0, 34); // disk number
    record.writeUInt16LE(0, 36); // internal attributes
    record.writeUInt32LE(0, 38); // external attributes
    record.writeUInt32LE(offset, 42);
    central.push(record, name);

    offset += header.length + name.length + data.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_RECORD, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with the central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...parts, centralBuffer, end]);
}
