'use strict';
/**
 * Minimal, fast, zero-dependency ZIP / JAR reader using Node's built-in `zlib`.
 * Supports reading entries from a file buffer or a nested JAR buffer in memory.
 */
const fs = require('fs');
const zlib = require('zlib');

function listZipEntries(buf) {
  // Find End of Central Directory (EOCD) signature 0x06054b50
  const minEocd = Math.max(0, buf.length - 65557);
  let eocdPos = -1;
  for (let i = buf.length - 22; i >= minEocd; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdPos = i;
      break;
    }
  }
  if (eocdPos < 0) return [];

  const cdCount = buf.readUInt16LE(eocdPos + 10);
  const cdOffset = buf.readUInt32LE(eocdPos + 16);
  const entries = [];
  let pos = cdOffset;

  for (let k = 0; k < cdCount && pos + 46 <= buf.length; k++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;
    const method = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const uncompSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
    entries.push({ name, method, compSize, uncompSize, localOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readZipEntryBuffer(buf, entry) {
  const lh = entry.localOffset;
  if (lh + 30 > buf.length || buf.readUInt32LE(lh) !== 0x04034b50) {
    throw new Error(`Invalid local header for ${entry.name}`);
  }
  const nameLen = buf.readUInt16LE(lh + 26);
  const extraLen = buf.readUInt16LE(lh + 28);
  const dataStart = lh + 30 + nameLen + extraLen;
  const raw = buf.subarray(dataStart, dataStart + entry.compSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`Unsupported compression method ${entry.method}`);
}

function openZipBuffer(buf) {
  const entries = listZipEntries(buf);
  const byName = new Map(entries.map((e) => [e.name, e]));
  return {
    entries,
    has: (name) => byName.has(name),
    readBuffer: (name) => {
      const e = byName.get(name);
      return e ? readZipEntryBuffer(buf, e) : null;
    },
    readText: (name) => {
      const b = byName.get(name);
      return b ? readZipEntryBuffer(buf, b).toString('utf8') : null;
    },
  };
}

function openZipFile(absPath) {
  return openZipBuffer(fs.readFileSync(absPath));
}

module.exports = { openZipFile, openZipBuffer };
