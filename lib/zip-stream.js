/**
 * Minimal streaming ZIP reader: list a ZIP's entries from its central directory and read
 * one entry line by line, without unpacking the archive or loading the entry into memory.
 * Built on node:fs + node:zlib only (no dependency).
 *
 * Written for the SEC's quarterly 13F data sets, whose holdings table is several hundred MB
 * uncompressed: it must be streamed. Supports the two methods those archives use (0 stored,
 * 8 deflate). ZIP64 archives (> 4 GB or > 65,535 entries) are refused with a clear error
 * rather than misread.
 */
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { createInflateRaw } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_EOCD_SEARCH = 65_535 + 22;

/**
 * @param {string} file  path to a .zip on disk
 * @returns {Promise<{name:string, method:number, compressedSize:number, size:number, localHeaderOffset:number}[]>}
 */
export async function listZipEntries(file) {
  const handle = await open(file, "r");
  try {
    const { size: fileSize } = await handle.stat();
    const tailLength = Math.min(fileSize, MAX_EOCD_SEARCH);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, fileSize - tailLength);
    let eocd = -1;
    for (let i = tailLength - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === EOCD_SIGNATURE) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error(`${file}: not a ZIP archive (no end-of-central-directory record)`);
    const count = tail.readUInt16LE(eocd + 10);
    const directorySize = tail.readUInt32LE(eocd + 12);
    const directoryOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      throw new Error(`${file}: ZIP64 archives are not supported`);
    }
    const directory = Buffer.alloc(directorySize);
    await handle.read(directory, 0, directorySize, directoryOffset);
    const entries = [];
    let at = 0;
    for (let n = 0; n < count; n += 1) {
      if (directory.readUInt32LE(at) !== CENTRAL_SIGNATURE) throw new Error(`${file}: corrupt central directory`);
      const method = directory.readUInt16LE(at + 10);
      const compressedSize = directory.readUInt32LE(at + 20);
      const size = directory.readUInt32LE(at + 24);
      const nameLength = directory.readUInt16LE(at + 28);
      const extraLength = directory.readUInt16LE(at + 30);
      const commentLength = directory.readUInt16LE(at + 32);
      const localHeaderOffset = directory.readUInt32LE(at + 42);
      if (compressedSize === 0xffffffff || size === 0xffffffff || localHeaderOffset === 0xffffffff) {
        throw new Error(`${file}: ZIP64 entries are not supported`);
      }
      const name = directory.toString("utf8", at + 46, at + 46 + nameLength);
      entries.push({ name, method, compressedSize, size, localHeaderOffset });
      at += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  } finally {
    await handle.close();
  }
}

/** Find an entry by its file name, ignoring folders and letter case (e.g. "INFOTABLE.tsv"). */
export function findZipEntry(entries, baseName) {
  const wanted = String(baseName).toLowerCase();
  return entries.find((entry) => entry.name.split("/").pop().toLowerCase() === wanted) ?? null;
}

async function dataStart(file, entry) {
  const handle = await open(file, "r");
  try {
    const header = Buffer.alloc(30);
    await handle.read(header, 0, 30, entry.localHeaderOffset);
    if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) throw new Error(`${file}: corrupt local header for ${entry.name}`);
    return entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  } finally {
    await handle.close();
  }
}

/** A readable stream of one entry's uncompressed bytes. */
export async function openZipEntry(file, entry) {
  if (entry.method !== 0 && entry.method !== 8) throw new Error(`${entry.name}: unsupported ZIP compression method ${entry.method}`);
  if (entry.compressedSize === 0) return Readable.from([]);
  const start = await dataStart(file, entry);
  const raw = createReadStream(file, { start, end: start + entry.compressedSize - 1 });
  if (entry.method === 0) return raw;
  const inflate = createInflateRaw();
  raw.on("error", (error) => inflate.destroy(error));
  return raw.pipe(inflate);
}

/** Async iterator over one entry's lines (no line endings), streamed. */
export async function* zipEntryLines(file, entry) {
  if (entry.size === 0) return;
  const lines = createInterface({ input: await openZipEntry(file, entry), crlfDelay: Infinity });
  for await (const line of lines) yield line;
}

/** A whole (small) entry as text. Only for files known to be small. */
export async function readZipEntryText(file, entry, { maxBytes = 64 * 1024 * 1024 } = {}) {
  if (entry.size > maxBytes) throw new Error(`${entry.name} is ${entry.size} bytes; stream it with zipEntryLines instead`);
  const chunks = [];
  for await (const chunk of await openZipEntry(file, entry)) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
