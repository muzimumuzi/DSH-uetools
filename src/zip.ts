/**
 * Minimal ZIP reader for the bundled UnrealAgentLink plugin archives.
 *
 * The archives are ordinary deflate ZIPs written by the plugin packaging script;
 * only stored (0) and deflate (8) entries are needed. Reading through the
 * central directory — rather than guessing at local headers — keeps names,
 * offsets and directory entries exact.
 *
 * @module
 */

import { inflateRawSync } from 'node:zlib'

/** One extracted archive entry. */
export interface ZipEntry {
  /** Normalized POSIX path inside the archive. */
  readonly name: string
  /** Uncompressed bytes; empty for directory entries. */
  readonly data: Buffer
  /** Whether this entry is a directory. */
  readonly directory: boolean
}

/** End-of-central-directory locator. */
const EOCD_SIGNATURE = 0x0605_4b50

/** Central-directory file header. */
const CENTRAL_SIGNATURE = 0x0201_4b50

/** Local file header. */
const LOCAL_SIGNATURE = 0x0403_4b50

/**
 * Reject archive paths that could escape the extraction root.
 * @param name - raw archive entry name.
 * @returns the normalized relative path.
 */
function safeName(name: string): string {
  const normalized = name.replaceAll('\\', '/').replace(/^\/+/u, '').replace(/\/+$/u, '')
  const parts = normalized.split('/')
  if (parts.some(part => part === '..' || part === '')) {
    throw new Error(`zip entry has an unsafe path: ${name}`)
  }
  return normalized
}

/** Locate the end-of-central-directory record. */
function findEnd(buf: Buffer): number {
  const minimum = Math.max(0, buf.length - 65_557)
  for (let offset = buf.length - 22; offset >= minimum; offset -= 1) {
    if (buf.readUInt32LE(offset) === EOCD_SIGNATURE) return offset
  }
  throw new Error('not a ZIP archive: end-of-central-directory record not found')
}

/**
 * Read every entry of a ZIP archive.
 *
 * @param buf - complete archive bytes.
 * @returns entries in central-directory order.
 */
export function readZip(buf: Buffer): ZipEntry[] {
  const eocd = findEnd(buf)
  const count = buf.readUInt16LE(eocd + 10)
  const centralOffset = buf.readUInt32LE(eocd + 16)
  const entries: ZipEntry[] = []
  let offset = centralOffset
  for (let index = 0; index < count; index += 1) {
    if (buf.readUInt32LE(offset) !== CENTRAL_SIGNATURE) throw new Error('corrupt ZIP central directory')
    const method = buf.readUInt16LE(offset + 10)
    const compressedSize = buf.readUInt32LE(offset + 20)
    const nameLength = buf.readUInt16LE(offset + 28)
    const extraLength = buf.readUInt16LE(offset + 30)
    const commentLength = buf.readUInt16LE(offset + 32)
    const localOffset = buf.readUInt32LE(offset + 42)
    const rawName = buf.toString('utf8', offset + 46, offset + 46 + nameLength)
    offset += 46 + nameLength + extraLength + commentLength

    const directory = rawName.endsWith('/')
    if (directory) {
      entries.push({ name: safeName(rawName), data: Buffer.alloc(0), directory })
      continue
    }
    if (buf.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) throw new Error(`corrupt ZIP local header: ${rawName}`)
    const localNameLength = buf.readUInt16LE(localOffset + 26)
    const localExtraLength = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const raw = buf.subarray(dataStart, dataStart + compressedSize)
    if (method === 0) {
      entries.push({ name: safeName(rawName), data: Buffer.from(raw), directory })
    } else if (method === 8) {
      entries.push({ name: safeName(rawName), data: inflateRawSync(raw), directory })
    } else {
      throw new Error(`unsupported ZIP compression method ${String(method)} for ${rawName}`)
    }
  }
  return entries
}
