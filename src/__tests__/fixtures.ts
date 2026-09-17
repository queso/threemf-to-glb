import { unzipSync, zipSync } from "fflate"

// Synthetic Bambu 3MF builders for tests. NEVER load real customer .3mf files into this repo:
// these hand-written XML snippets exercise the same tag shapes as a real Bambu Studio export
// (confirmed against a real reference file during development) without shipping anyone's design.

export type FixtureObject = {
  /** object id used inside the geometry file. */
  id: string
  /** Each vertex is [x, y, z]. */
  vertices: [number, number, number][]
  /** Each triangle is [v1, v2, v3, paintColorHex | null]. */
  triangles: [number, number, number, string | null][]
}

function objectModelXml(objects: FixtureObject[]): string {
  const objectsXml = objects
    .map((obj) => {
      const verts = obj.vertices
        .map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`)
        .join("\n      ")
      const tris = obj.triangles
        .map(([v1, v2, v3, paint]) => {
          const paintAttr = paint ? ` paint_color="${paint}"` : ""
          return `<triangle v1="${v1}" v2="${v2}" v3="${v3}"${paintAttr}/>`
        })
        .join("\n      ")
      return `  <object id="${obj.id}" type="model">
    <mesh>
      <vertices>
      ${verts}
      </vertices>
      <triangles>
      ${tris}
      </triangles>
    </mesh>
  </object>`
    })
    .join("\n")
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
 <resources>
${objectsXml}
 </resources>
 <build/>
</model>
`
}

export type FixtureWrapperObject = {
  /** object id used in the root model (the "instance" wrapper Bambu wraps geometry objects in). */
  id: string
  path: string
  componentObjectId: string
  transform?: string
}

export type FixtureBuildItem = {
  objectId: string
  transform?: string
}

function rootModelXml(wrappers: FixtureWrapperObject[], buildItems: FixtureBuildItem[]): string {
  const objectsXml = wrappers
    .map(
      (w) => `  <object id="${w.id}" type="model">
    <components>
      <component p:path="/${w.path}" objectid="${w.componentObjectId}"${
        w.transform ? ` transform="${w.transform}"` : ""
      }/>
    </components>
  </object>`,
    )
    .join("\n")
  const itemsXml = buildItems
    .map(
      (it) =>
        `  <item objectid="${it.objectId}"${it.transform ? ` transform="${it.transform}"` : ""}/>`,
    )
    .join("\n")
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
 <resources>
${objectsXml}
 </resources>
 <build>
${itemsXml}
 </build>
</model>
`
}

export type FixtureWrapperMeta = {
  id: string
  extruder?: number
  subtype?: "normal_part" | "negative_part"
}

export type FixturePlate = { platerId: number; objectIds: string[] }

function modelSettingsXml(wrappers: FixtureWrapperMeta[], plates: FixturePlate[]): string {
  const objectsXml = wrappers
    .map(
      (w) => `  <object id="${w.id}">
    <metadata key="name" value="fixture-${w.id}"/>
    ${w.extruder !== undefined ? `<metadata key="extruder" value="${w.extruder}"/>` : ""}
    <part id="1" subtype="${w.subtype ?? "normal_part"}">
      <metadata key="name" value="fixture-${w.id}-part"/>
    </part>
  </object>`,
    )
    .join("\n")
  const platesXml = plates
    .map(
      (p) => `  <plate>
    <metadata key="plater_id" value="${p.platerId}"/>
    ${p.objectIds
      .map(
        (oid) => `<model_instance>
      <metadata key="object_id" value="${oid}"/>
    </model_instance>`,
      )
      .join("\n    ")}
  </plate>`,
    )
    .join("\n")
  return `<?xml version="1.0" encoding="UTF-8"?>
<config>
${objectsXml}
${platesXml}
</config>
`
}

function projectSettingsJson(filamentColors: string[]): string {
  return JSON.stringify({ filament_colour: filamentColors })
}

const enc = new TextEncoder()

/**
 * The main synthetic fixture: two plates, an object instanced twice (shared mesh), painted
 * triangles spanning more than one filament state, and one unpainted object.
 */
export function buildTwoPlateFixture(): Uint8Array {
  const objectModel = objectModelXml([
    {
      id: "1",
      vertices: [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      triangles: [
        [0, 1, 2, "4"], // state 1
        [0, 1, 3, "8"], // state 2
        [1, 2, 3, "4"], // state 1
      ],
    },
  ])
  const unpaintedModel = objectModelXml([
    {
      id: "1",
      vertices: [
        [0, 0, 0],
        [2, 0, 0],
        [0, 2, 0],
      ],
      triangles: [[0, 1, 2, null]],
    },
  ])

  const root = rootModelXml(
    [
      { id: "10", path: "3D/Objects/geo1.model", componentObjectId: "1" },
      {
        id: "11",
        path: "3D/Objects/geo1.model",
        componentObjectId: "1",
        transform: "1 0 0 0 1 0 0 0 1 10 0 0",
      },
      { id: "20", path: "3D/Objects/geo2.model", componentObjectId: "1" },
    ],
    [
      { objectId: "10" },
      { objectId: "11" },
      { objectId: "20", transform: "1 0 0 0 1 0 0 0 1 0 50 0" },
    ],
  )

  const modelSettings = modelSettingsXml(
    [
      { id: "10", extruder: 1 },
      { id: "11", extruder: 1 },
      { id: "20", extruder: 2 },
    ],
    [
      { platerId: 1, objectIds: ["10", "11"] },
      { platerId: 2, objectIds: ["20"] },
    ],
  )

  const projectSettings = projectSettingsJson(["#FF0000", "#00FF00", "#0000FF"])

  return zipSync({
    "[Content_Types].xml": enc.encode('<?xml version="1.0"?><Types/>'),
    "3D/3dmodel.model": enc.encode(root),
    "3D/Objects/geo1.model": enc.encode(objectModel),
    "3D/Objects/geo2.model": enc.encode(unpaintedModel),
    "Metadata/model_settings.config": enc.encode(modelSettings),
    "Metadata/project_settings.config": enc.encode(projectSettings),
  })
}

/** A minimal single-plate, single-object, unpainted fixture with no filament colors at all. */
export function buildMinimalFixture(): Uint8Array {
  const objectModel = objectModelXml([
    {
      id: "1",
      vertices: [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ],
      triangles: [[0, 1, 2, null]],
    },
  ])
  const root = rootModelXml(
    [{ id: "5", path: "3D/Objects/geo.model", componentObjectId: "1" }],
    [{ objectId: "5" }],
  )
  const modelSettings = modelSettingsXml(
    [{ id: "5", extruder: 1 }],
    [{ platerId: 1, objectIds: ["5"] }],
  )

  return zipSync({
    "3D/3dmodel.model": enc.encode(root),
    "3D/Objects/geo.model": enc.encode(objectModel),
    "Metadata/model_settings.config": enc.encode(modelSettings),
  })
}

/** Not a zip at all. */
export function notAZip(): Uint8Array {
  return enc.encode("this is definitely not a zip file")
}

/** A valid zip with no 3D/3dmodel.model entry at all. */
export function zipWithoutModel(): Uint8Array {
  return zipSync({ "readme.txt": enc.encode("hello") })
}

/** A valid zip whose 3D/3dmodel.model has no <object> definitions and no <item> build entries. */
export function zipWithEmptyModel(): Uint8Array {
  return zipSync({
    "3D/3dmodel.model": enc.encode(
      '<?xml version="1.0"?><model><resources></resources><build></build></model>',
    ),
  })
}

/**
 * A valid fixture (from {@link buildTwoPlateFixture}) plus one deliberately corrupted large entry
 * named like sliced-plate gcode. The bytes claim to be deflate-compressed but are not valid
 * deflate: inflating this entry throws. Selective inflate must never touch it, proving the
 * memory-safety property this package exists to preserve.
 */
export function buildFixtureWithCorruptGcode(uncompressedSize = 20 * 1024 * 1024): Uint8Array {
  const base = buildTwoPlateFixture()
  const corruptEntryName = "Metadata/plate_1.gcode"
  const zeros = new Uint8Array(uncompressedSize) // compresses to a small run under real deflate
  const withGcode = zipSync({
    ...unzipToZippable(base),
    [corruptEntryName]: [zeros, { level: 6 }],
  })
  return corruptDeflateEntry(withGcode, corruptEntryName)
}

// ---- helpers for buildFixtureWithCorruptGcode ----

function unzipToZippable(zipBytes: Uint8Array): Record<string, Uint8Array> {
  // Re-inflate everything here (test-only, small fixture) so we can re-zip it alongside the
  // corrupt entry. The library itself never does this: this is fixture plumbing, not production code.
  return unzipSync(zipBytes)
}

/**
 * Flip bytes inside the LOCAL file header's compressed-data region for `entryName`, using the
 * standard ZIP local-file-header layout (PKWARE APPNOTE 4.3.7). This corrupts only that entry's
 * compressed bytes; every other entry (including the central directory) is untouched, so a
 * filter that never selects `entryName` parses the archive normally.
 */
function corruptDeflateEntry(zipBytes: Uint8Array, entryName: string): Uint8Array {
  const out = new Uint8Array(zipBytes)
  const view = new DataView(out.buffer)
  const nameBytes = enc.encode(entryName)

  for (let i = 0; i + 4 <= out.length; i++) {
    if (view.getUint32(i, true) !== 0x04034b50) continue
    const nameLen = view.getUint16(i + 26, true)
    const extraLen = view.getUint16(i + 28, true)
    if (nameLen !== nameBytes.length) continue
    const nameStart = i + 30
    let matches = true
    for (let j = 0; j < nameLen; j++) {
      if (out[nameStart + j] !== nameBytes[j]) {
        matches = false
        break
      }
    }
    if (!matches) continue

    const method = view.getUint16(i + 8, true)
    const compressedSize = view.getUint32(i + 18, true)
    if (method !== 8 || compressedSize < 16) continue // not deflate, or too small to safely corrupt

    const dataStart = nameStart + nameLen + extraLen
    // Flip a stretch in the middle of the compressed stream: enough to break the deflate block
    // structure without running past the declared compressed size.
    const corruptStart = dataStart + Math.floor(compressedSize / 2)
    const corruptLength = Math.min(64, compressedSize - Math.floor(compressedSize / 2))
    for (let k = 0; k < corruptLength; k++) {
      out[corruptStart + k] ^= 0xff
    }
    return out
  }
  throw new Error(`corruptDeflateEntry: could not find local header for ${entryName}`)
}
