import { inflateSync, unzipSync } from "fflate"
import { NotAZipError } from "./errors.js"

/**
 * Inflate only the zip entries matching `filter`. This is the memory-safety property the whole
 * package exists to preserve: a sliced Bambu `.gcode.3mf` carries hundreds of megabytes of plate
 * gcode and thumbnails alongside the handful of KB-to-MB XML files this converter actually reads.
 * Inflating everything OOM-killed a 512Mi pod on a 58MB input in production. Callers pass a
 * narrow filter (see convert.ts and parse-bambu.ts) so the gcode and images are never decompressed.
 */
export function unzipSelective(
  input: Uint8Array,
  filter: (name: string) => boolean,
): Record<string, Uint8Array> {
  try {
    return unzipSync(input, { filter: (file) => filter(file.name) })
  } catch (err) {
    throw new NotAZipError(err instanceof Error ? err.message : String(err))
  }
}

/**
 * Inflate one zip entry, or return null when it is absent. The converter reads the object
 * geometry files this way, one at a time, so their XML is never all in memory together.
 */
export function inflateOne(input: Uint8Array, name: string): Uint8Array | null {
  const key = name.replace(/^\//, "")
  return unzipSelective(input, (n) => n === key)[key] ?? null
}

const decoder = new TextDecoder()

/** Read one inflated entry as UTF-8 text, or null if it wasn't inflated (filtered out or absent). */
export function readText(files: Record<string, Uint8Array>, name: string): string | null {
  const u8 = files[name.replace(/^\//, "")]
  return u8 ? decoder.decode(u8) : null
}

type Entry = { method: number; csize: number; usize: number; local: number }

/**
 * A zip's entries by name, read from its central directory, so one entry can be inflated into a
 * buffer the caller reuses. Null when the archive is not one this reads (ZIP64, a multi-disk
 * archive, or no central directory): callers fall back to {@link inflateOne}.
 */
export class ZipEntries {
  private constructor(
    private readonly input: Uint8Array,
    readonly entries: Map<string, Entry>,
  ) {}

  static open(input: Uint8Array): ZipEntries | null {
    const v = new DataView(input.buffer, input.byteOffset, input.byteLength)
    let eocd = -1
    for (let i = input.length - 22; i >= Math.max(0, input.length - 22 - 65535); i--) {
      if (v.getUint32(i, true) === 0x06054b50) {
        eocd = i
        break
      }
    }
    if (eocd === -1) return null
    const count = v.getUint16(eocd + 10, true)
    let at = v.getUint32(eocd + 16, true)
    if (count === 0xffff || at === 0xffffffff) return null
    const entries = new Map<string, Entry>()
    const decoder = new TextDecoder()
    for (let n = 0; n < count; n++) {
      if (at + 46 > input.length || v.getUint32(at, true) !== 0x02014b50) return null
      const method = v.getUint16(at + 10, true)
      const csize = v.getUint32(at + 20, true)
      const usize = v.getUint32(at + 24, true)
      const nameLen = v.getUint16(at + 28, true)
      const extraLen = v.getUint16(at + 30, true)
      const commentLen = v.getUint16(at + 32, true)
      const local = v.getUint32(at + 42, true)
      if (csize === 0xffffffff || usize === 0xffffffff || local === 0xffffffff) return null
      entries.set(decoder.decode(input.subarray(at + 46, at + 46 + nameLen)), {
        method,
        csize,
        usize,
        local,
      })
      at += 46 + nameLen + extraLen + commentLen
    }
    return new ZipEntries(input, entries)
  }

  /**
   * Entry `name`'s bytes, written into `scratch` when it is deflated (and big enough). The result
   * may share `scratch` or the input: read it before the next call.
   */
  read(name: string, scratch: Uint8Array): Uint8Array | null {
    const e = this.entries.get(name.replace(/^\//, ""))
    if (!e) return null
    const v = new DataView(this.input.buffer, this.input.byteOffset, this.input.byteLength)
    if (v.getUint32(e.local, true) !== 0x04034b50) return null
    const start = e.local + 30 + v.getUint16(e.local + 26, true) + v.getUint16(e.local + 28, true)
    const data = this.input.subarray(start, start + e.csize)
    if (e.method === 0) return data
    if (e.method !== 8) return null
    const out = e.usize <= scratch.length ? scratch.subarray(0, e.usize) : new Uint8Array(e.usize)
    return inflateSync(data, { out })
  }
}
