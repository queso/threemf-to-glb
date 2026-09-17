import { MissingModelError, UnsupportedStructureError } from "./errors.js"
import { readText, unzipSelective } from "./zip.js"

export type PartInfo = { subtype: string; extruder: number | null }
export type ComponentRef = { path: string; objectId: string; transform: string | null }
export type BuildItem = { objectId: string; transform: string | null }

export type BambuMetadata = {
  /** Project filament colors as hex strings; index 0 is filament slot 1. Empty for a non-Bambu file. */
  filamentColors: string[]
  /** object id -> plate (plater_id) it belongs to, from Metadata/model_settings.config. */
  plateByObjectId: Record<string, number>
  /** object id -> its <part> entries (subtype plus any per-part extruder override). */
  partsByObject: Record<string, PartInfo[]>
  /** object id -> base extruder, from that object's own <metadata key="extruder">. */
  extruderByObject: Record<string, number>
  /** object id -> the <component> references inside its <object> in 3D/3dmodel.model. */
  componentsByObject: Record<string, ComponentRef[]>
  /** The <item> elements under <build>, in document order: the join key for the whole node graph. */
  buildItems: BuildItem[]
}

const NEEDED_METADATA = new Set([
  "Metadata/model_settings.config",
  "Metadata/project_settings.config",
])
const ROOT_MODEL = "3D/3dmodel.model"

function metadataMap(block: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of block.matchAll(/<metadata key="([^"]+)" value="([^"]*)"/g)) out[m[1]] = m[2]
  return out
}

/**
 * Parse the Bambu-specific metadata (plates, filament colors, build-item -> component graph) from
 * already-inflated files. Shared by {@link parseBambuMetadata} (metadata only) and the converter
 * (which also needs the object geometry files inflated).
 */
export function parseBambuMetadataFromFiles(files: Record<string, Uint8Array>): BambuMetadata {
  const rootXml = readText(files, ROOT_MODEL)
  if (rootXml === null) throw new MissingModelError()

  let filamentColors: string[] = []
  try {
    filamentColors =
      JSON.parse(readText(files, "Metadata/project_settings.config") ?? "{}").filament_colour ?? []
  } catch {
    // Not a Bambu project file: colors stay empty and everything renders with the fallback gray.
  }

  const partsByObject: Record<string, PartInfo[]> = {}
  const extruderByObject: Record<string, number> = {}
  const plateByObjectId: Record<string, number> = {}
  const settingsXml = readText(files, "Metadata/model_settings.config") ?? ""
  for (const om of settingsXml.matchAll(/<object id="(\d+)">([\s\S]*?)<\/object>/g)) {
    const [, id, body] = om
    const headEnd = body.search(/<part\b/)
    const head = headEnd === -1 ? body : body.slice(0, headEnd)
    const hm = metadataMap(head)
    if (hm.extruder) extruderByObject[id] = Number(hm.extruder)
    partsByObject[id] = [
      ...body.matchAll(/<part id="[^"]*" subtype="([^"]*)">([\s\S]*?)<\/part>/g),
    ].map((pm) => {
      const meta = metadataMap(pm[2])
      return { subtype: pm[1], extruder: meta.extruder ? Number(meta.extruder) : null }
    })
  }
  for (const pm of settingsXml.matchAll(/<plate>([\s\S]*?)<\/plate>/g)) {
    const plateId = Number(metadataMap(pm[1]).plater_id)
    if (!plateId) continue
    for (const mi of pm[1].matchAll(/<model_instance>([\s\S]*?)<\/model_instance>/g)) {
      const oid = metadataMap(mi[1]).object_id
      if (oid) plateByObjectId[oid] = plateId
    }
  }

  const componentsByObject: Record<string, ComponentRef[]> = {}
  let objectCount = 0
  for (const om of rootXml.matchAll(/<object id="(\d+)"[^>]*>([\s\S]*?)<\/object>/g)) {
    objectCount++
    const comps = [...om[2].matchAll(/<component\b([^>]*)\/>/g)].map((cm) => ({
      path: (/p:path="([^"]+)"/.exec(cm[1])?.[1] ?? `/${ROOT_MODEL}`).replace(/^\//, ""),
      objectId: /objectid="(\d+)"/.exec(cm[1])?.[1] ?? "",
      transform: /transform="([^"]+)"/.exec(cm[1])?.[1] ?? null,
    }))
    if (comps.length) componentsByObject[om[1]] = comps
  }
  const buildItems: BuildItem[] = [...rootXml.matchAll(/<item\b([^>]*)\/>/g)].map((im) => ({
    objectId: /objectid="(\d+)"/.exec(im[1])?.[1] ?? "",
    transform: /transform="([^"]+)"/.exec(im[1])?.[1] ?? null,
  }))

  if (objectCount === 0 && buildItems.length === 0) {
    throw new UnsupportedStructureError(
      "3D/3dmodel.model has no <object> definitions and no <item> build entries",
    )
  }

  return {
    filamentColors,
    plateByObjectId,
    partsByObject,
    extruderByObject,
    componentsByObject,
    buildItems,
  }
}

/**
 * Parse the Bambu metadata (plates, filament colors, build-item -> component graph) out of a 3MF
 * file's bytes, without touching any object geometry. Cheaper than a full conversion when a
 * caller only needs to know what's on which plate, or what colors a project uses.
 */
export function parseBambuMetadata(input: Uint8Array): BambuMetadata {
  const files = unzipSelective(input, (name) => name === ROOT_MODEL || NEEDED_METADATA.has(name))
  return parseBambuMetadataFromFiles(files)
}
