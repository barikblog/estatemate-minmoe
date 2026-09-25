#!/usr/bin/env node
/**
 * The two archive formats the bridge packaging touches, read in-process.
 *
 * Node.js runtimes arrive as `.zip` from nodejs.org and as `.tgz` from the npm
 * registry, and postject arrives as `.tgz` too. Shelling out to `tar`/`unzip`
 * for those fails on Windows for a boring reason: the archive path is
 * `C:\Users\...\node.zip`, and the GNU tar that Git Bash puts on PATH reads the
 * `C:` as a remote host and exits with "Cannot connect to C: resolve failed".
 * Windows' own tar has no such quirk, but a build that depends on which tar is
 * first in PATH is a build that breaks on someone else's machine.
 *
 * So: no external tools. `zlib` is built into Node, and a ZIP central directory
 * and a POSIX tar header are both small, well-specified formats.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR = 0x07064b50;

const TAR_BLOCK = 512;

export class ArchiveError extends Error {}

function isMatch(name, match) {
  if (typeof match === 'function') return match(name);
  if (match instanceof RegExp) return match.test(name);
  return name === match || name.endsWith(`/${match}`) || path.posix.basename(name) === match;
}

function writeEntry(name, data, destination, mode) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, data);
  // Preserve the archive's permission bits: an npm runtime tarball ships
  // bin/node as 0755, and a Node binary without the execute bit cannot be
  // spawned. On Windows chmod only toggles the read-only attribute, which is
  // harmless.
  if (mode) {
    try {
      fs.chmodSync(destination, mode & 0o777);
    } catch {
      /* permission bits are advisory here */
    }
  }
  return { name, bytes: data.length, destination };
}

/** Locate the end-of-central-directory record, then walk the central directory. */
function readZipCentralDirectory(buffer) {
  const searchFrom = Math.max(0, buffer.length - 0xffff - 22);
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= searchFrom; offset -= 1) {
    if (buffer.readUInt32LE(offset) === ZIP_END_OF_CENTRAL_DIRECTORY) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new ArchiveError('the archive has no ZIP end-of-central-directory record');

  let entryCount = buffer.readUInt16LE(eocd + 10);
  let directoryOffset = buffer.readUInt32LE(eocd + 16);
  const needsZip64 = entryCount === 0xffff || directoryOffset === 0xffffffff;
  if (needsZip64) {
    const locator = eocd - 20;
    if (locator < 0 || buffer.readUInt32LE(locator) !== ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR) {
      throw new ArchiveError('the archive needs ZIP64 support but has no ZIP64 locator');
    }
    const zip64Eocd = Number(buffer.readBigUInt64LE(locator + 8));
    if (zip64Eocd < 0 || zip64Eocd + 56 > buffer.length) throw new ArchiveError('the ZIP64 end-of-central-directory record is out of range');
    entryCount = Number(buffer.readBigUInt64LE(zip64Eocd + 32));
    directoryOffset = Number(buffer.readBigUInt64LE(zip64Eocd + 48));
  }

  const entries = [];
  let cursor = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== ZIP_CENTRAL_HEADER) {
      throw new ArchiveError(`the ZIP central directory is malformed at entry ${index}`);
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    let compressedSize = buffer.readUInt32LE(cursor + 20);
    let uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    let localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    const mode = (externalAttributes >>> 16) & 0o777;

    // A ZIP64 extra field (id 0x0001) carries whichever 32-bit fields overflowed,
    // in this fixed order.
    if (uncompressedSize === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      let extra = cursor + 46 + nameLength;
      const extraEnd = extra + extraLength;
      while (extra + 4 <= extraEnd) {
        const id = buffer.readUInt16LE(extra);
        const size = buffer.readUInt16LE(extra + 2);
        if (id === 0x0001) {
          let field = extra + 4;
          if (uncompressedSize === 0xffffffff) {
            uncompressedSize = Number(buffer.readBigUInt64LE(field));
            field += 8;
          }
          if (compressedSize === 0xffffffff) {
            compressedSize = Number(buffer.readBigUInt64LE(field));
            field += 8;
          }
          if (localOffset === 0xffffffff) localOffset = Number(buffer.readBigUInt64LE(field));
          break;
        }
        extra += 4 + size;
      }
    }

    entries.push({ name, method, flags, compressedSize, uncompressedSize, localOffset, mode });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readZipEntryData(buffer, entry) {
  const header = entry.localOffset;
  if (header + 30 > buffer.length || buffer.readUInt32LE(header) !== ZIP_LOCAL_HEADER) {
    throw new ArchiveError(`the ZIP entry ${entry.name} has no local header`);
  }
  const nameLength = buffer.readUInt16LE(header + 26);
  const extraLength = buffer.readUInt16LE(header + 28);
  const start = header + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > buffer.length) throw new ArchiveError(`the ZIP entry ${entry.name} runs past the end of the archive`);
  const compressed = buffer.subarray(start, end);
  if (entry.method === 0) return Buffer.from(compressed);
  if (entry.method === 8) return zlib.inflateRawSync(compressed);
  throw new ArchiveError(`the ZIP entry ${entry.name} uses unsupported compression method ${entry.method}`);
}

/**
 * Extract the first ZIP entry matching `match` (a name, a name suffix, or a
 * predicate) to `destination`. Returns { name, bytes, destination }.
 */
export function extractFromZip(archivePath, match, destination) {
  const buffer = fs.readFileSync(archivePath);
  const entry = readZipCentralDirectory(buffer).find((candidate) => isMatch(candidate.name, match));
  if (!entry) throw new ArchiveError(`${path.basename(archivePath)} contains no entry matching ${match}`);
  return writeEntry(entry.name, readZipEntryData(buffer, entry), destination, entry.mode);
}

/** List entry names, for diagnostics. */
export function listZipEntries(archivePath) {
  return readZipCentralDirectory(fs.readFileSync(archivePath)).map((entry) => entry.name);
}

function parseOctal(buffer) {
  const text = buffer.toString('utf8').replace(/\0.*$/, '').trim();
  return text ? Number.parseInt(text, 8) : 0;
}

/**
 * Extract the first entry of a gzipped tar matching `match`. Handles the POSIX
 * and ustar layouts npm produces, including PAX `path=` overrides for names
 * longer than 100 characters; skips directories, links and the end-of-archive
 * padding.
 */
export function extractFromTarGz(archivePath, match, destination) {
  const tar = zlib.gunzipSync(fs.readFileSync(archivePath));
  let cursor = 0;
  let pendingPath = null;

  while (cursor + TAR_BLOCK <= tar.length) {
    const header = tar.subarray(cursor, cursor + TAR_BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const nameField = header.subarray(0, 100);
    const mode = parseOctal(header.subarray(100, 108));
    const size = parseOctal(header.subarray(124, 136));
    const typeFlag = String.fromCharCode(header[156] || 0x30);
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const shortName = nameField.toString('utf8').replace(/\0.*$/, '');
    const dataStart = cursor + TAR_BLOCK;
    const data = tar.subarray(dataStart, dataStart + size);
    cursor = dataStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;

    if (typeFlag === 'x' || typeFlag === 'g') {
      // PAX extended header: "LEN key=value\n" records, applied to the next entry.
      const records = data.toString('utf8').split('\n').filter(Boolean);
      for (const record of records) {
        const separator = record.indexOf(' ');
        const field = separator >= 0 ? record.slice(separator + 1) : record;
        if (field.startsWith('path=')) pendingPath = field.slice('path='.length);
      }
      continue;
    }
    if (typeFlag !== '0' && typeFlag !== '\0' && typeFlag !== '') continue; // directories, links, metadata

    const name = pendingPath || (prefix ? `${prefix}/${shortName}` : shortName);
    pendingPath = null;
    if (isMatch(name, match)) return writeEntry(name, Buffer.from(data), destination, mode);
  }
  throw new ArchiveError(`${path.basename(archivePath)} contains no entry matching ${match}`);
}
