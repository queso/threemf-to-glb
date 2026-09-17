import { unzipSync } from "fflate"
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

const decoder = new TextDecoder()

/** Read one inflated entry as UTF-8 text, or null if it wasn't inflated (filtered out or absent). */
export function readText(files: Record<string, Uint8Array>, name: string): string | null {
  const u8 = files[name.replace(/^\//, "")]
  return u8 ? decoder.decode(u8) : null
}
