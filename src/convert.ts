import { dominantPaintState } from "./dominant-paint.js"
import { parseBambuMetadataFromFiles } from "./parse-bambu.js"
import { readText, unzipSelective } from "./zip.js"

export type ConvertOptions = {
  /**
   * Override the glTF `asset.generator` string. Defaults to `"threemf-to-glb"`. Pass
   * `"print-farm threemf-to-glb POC"` to reproduce the legacy in-app script's output
   * byte-for-byte (see the "Migrating from print-farm" section of the README).
   */
  generator?: string
}

const NEEDED_METADATA = new Set([
  "Metadata/model_settings.config",
  "Metadata/project_settings.config",
])
const DEFAULT_GENERATOR = "threemf-to-glb"

type Geom = { pos: Float32Array; tris: Uint32Array; paint: (string | null)[] | null }

type MaterialJson = {
  name: string
  pbrMetallicRoughness: {
    baseColorFactor: number[]
    metallicFactor: number
    roughnessFactor: number
  }
  alphaMode?: "BLEND"
  doubleSided?: boolean
}

type NodeJson = {
  name?: string
  mesh?: number
  matrix?: number[]
  children?: number[]
  extras?: { plate: number | null }
}

type PrimitiveJson = { attributes: { POSITION: number }; indices: number; material: number }
type MeshJson = { name: string; primitives: PrimitiveJson[] }
type BufferViewJson = { buffer: number; byteOffset: number; byteLength: number; target: number }
type AccessorJson = {
  bufferView: number
  componentType: number
  count: number
  type: "VEC3" | "SCALAR"
  min?: number[]
  max?: number[]
}

type GltfJson = {
  asset: { version: "2.0"; generator: string }
  scene: 0
  scenes: [{ nodes: number[]; extras: { filamentColors: string[] } }]
  nodes: NodeJson[]
  meshes: MeshJson[]
  materials: MaterialJson[]
  bufferViews: BufferViewJson[]
  accessors: AccessorJson[]
  buffers: [{ byteLength: number }]
}

/**
 * Bake a Bambu 3MF (geometry, `paint_color` RLE, plate layout) into a glTF binary (.glb) with
 * shared materials named `filament_N` carrying per-triangle filament identity: instances share
 * meshes, build-item nodes carry `{plate}` in extras, and the scene carries `{filamentColors}`.
 *
 * Only the zip entries this converter reads are inflated: the model XMLs and the two Metadata
 * configs. A sliced `.gcode.3mf` also carries plate gcode (hundreds of MB decompressed) and
 * thumbnails; inflating those too is what OOM-killed a 512Mi pod on a 58MB input in production.
 */
export function convertThreemfToGlb(input: Uint8Array, options: ConvertOptions = {}): Uint8Array {
  const generator = options.generator ?? DEFAULT_GENERATOR

  const files = unzipSelective(
    input,
    (name) => name.endsWith(".model") || NEEDED_METADATA.has(name),
  )
  const meta = parseBambuMetadataFromFiles(files)
  const {
    filamentColors,
    plateByObjectId,
    partsByObject,
    extruderByObject,
    componentsByObject,
    buildItems,
  } = meta

  // ---------- geometry + paint ----------

  const geomByRef = new Map<string, Geom>()
  const parsedPaths = new Set<string>()
  function parseModelFile(p: string): void {
    if (parsedPaths.has(p)) return
    parsedPaths.add(p)
    const xml = readText(files, p)
    if (!xml) return
    const sections = [...xml.matchAll(/<object\b[^>]*\bid="(\d+)"/g)].map((m) => ({
      id: m[1],
      start: m.index,
    }))
    for (let i = 0; i < sections.length; i++) {
      const chunk = xml.slice(sections[i].start, sections[i + 1]?.start ?? xml.length)
      const pos: number[] = []
      for (const vm of chunk.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)) {
        pos.push(Number(vm[1]), Number(vm[2]), Number(vm[3]))
      }
      const tris: number[] = []
      const paint: (string | null)[] = []
      let painted = false
      for (const tm of chunk.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"([^>]*)/g)) {
        tris.push(Number(tm[1]), Number(tm[2]), Number(tm[3]))
        const pc = /paint_color="([0-9A-Fa-f]+)"/.exec(tm[4])
        paint.push(pc ? pc[1] : null)
        if (pc) painted = true
      }
      if (tris.length) {
        geomByRef.set(`${p}#${sections[i].id}`, {
          pos: Float32Array.from(pos),
          tris: Uint32Array.from(tris),
          paint: painted ? paint : null,
        })
      }
    }
  }

  const srgbToLinear = (c: number): number => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  const hexToLinear = (hex: string): number[] => {
    const h = hex.replace("#", "")
    return [0, 2, 4].map((i) => srgbToLinear(Number.parseInt(h.slice(i, i + 2) || "b8", 16)))
  }
  const filamentLinear = filamentColors.map(hexToLinear)
  const fallbackLinear = hexToLinear("#b8b8bc")

  // ---------- glTF primitives: one per filament state, shared named materials ----------
  // Geometry carries NO baked colors. Every triangle lands in the primitive of its (dominant)
  // filament; primitives reference shared materials named "filament_N". A viewer recolors the
  // whole model by setting those material colors.

  const materialsJson: MaterialJson[] = []
  const materialIndexByName = new Map<string, number>()
  function filamentMaterial(n: number): number {
    const name = `filament_${n}`
    let idx = materialIndexByName.get(name)
    if (idx === undefined) {
      const c = filamentLinear[n - 1] ?? fallbackLinear
      materialsJson.push({
        name,
        pbrMetallicRoughness: {
          baseColorFactor: [...c, 1],
          metallicFactor: 0,
          roughnessFactor: 0.9,
        },
      })
      idx = materialsJson.length - 1
      materialIndexByName.set(name, idx)
    }
    return idx
  }
  function negativeMaterial(): number {
    let idx = materialIndexByName.get("negative")
    if (idx === undefined) {
      materialsJson.push({
        name: "negative",
        pbrMetallicRoughness: {
          baseColorFactor: [1, 0.4, 0.4, 0.25],
          metallicFactor: 0,
          roughnessFactor: 0.9,
        },
        alphaMode: "BLEND",
        doubleSided: true,
      })
      idx = materialsJson.length - 1
      materialIndexByName.set("negative", idx)
    }
    return idx
  }

  // mesh key: geometry ref + base extruder + negative flag
  const gltfMeshes = new Map<string, number>()
  const meshesJson: MeshJson[] = []
  const binParts: Uint8Array[] = []
  let binLength = 0
  const bufferViews: BufferViewJson[] = []
  const accessors: AccessorJson[] = []

  function addBufferView(u8: Uint8Array, target: number): number {
    const pad = (4 - (binLength % 4)) % 4
    if (pad) {
      binParts.push(new Uint8Array(pad))
      binLength += pad
    }
    bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: u8.byteLength, target })
    binParts.push(u8)
    binLength += u8.byteLength
    return bufferViews.length - 1
  }

  // one shared POSITION accessor per source geometry, reused by every primitive
  const posAccessorByRef = new Map<string, number>()
  function positionAccessor(ref: string, geom: Geom): number {
    let idx = posAccessorByRef.get(ref)
    if (idx !== undefined) return idx
    const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]
    const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY]
    for (let i = 0; i < geom.pos.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        if (geom.pos[i + a] < min[a]) min[a] = geom.pos[i + a]
        if (geom.pos[i + a] > max[a]) max[a] = geom.pos[i + a]
      }
    }
    const view = addBufferView(
      new Uint8Array(geom.pos.buffer, geom.pos.byteOffset, geom.pos.byteLength),
      34962,
    )
    accessors.push({
      bufferView: view,
      componentType: 5126,
      count: geom.pos.length / 3,
      type: "VEC3",
      min,
      max,
    })
    idx = accessors.length - 1
    posAccessorByRef.set(ref, idx)
    return idx
  }

  function buildMesh(ref: string, extruder: number, negative: boolean): number | null {
    const key = `${ref}#${extruder}#${negative ? 1 : 0}`
    const cached = gltfMeshes.get(key)
    if (cached !== undefined) return cached
    const geom = geomByRef.get(ref)
    if (!geom) return null

    const posAcc = positionAccessor(ref, geom)
    const triCount = geom.tris.length / 3

    // bucket triangles by filament state (0 = the part's base extruder)
    const byState = new Map<number, number[]>()
    for (let t = 0; t < triCount; t++) {
      const hex = negative ? null : geom.paint?.[t]
      const state = hex ? dominantPaintState(hex) : 0
      let arr = byState.get(state)
      if (!arr) {
        arr = []
        byState.set(state, arr)
      }
      arr.push(geom.tris[t * 3], geom.tris[t * 3 + 1], geom.tris[t * 3 + 2])
    }

    const primitives: PrimitiveJson[] = []
    for (const [state, idxArr] of byState) {
      const indices = Uint32Array.from(idxArr)
      const idxView = addBufferView(new Uint8Array(indices.buffer), 34963)
      accessors.push({
        bufferView: idxView,
        componentType: 5125,
        count: indices.length,
        type: "SCALAR",
      })
      primitives.push({
        attributes: { POSITION: posAcc },
        indices: accessors.length - 1,
        material: negative ? negativeMaterial() : filamentMaterial(state === 0 ? extruder : state),
      })
    }

    meshesJson.push({ name: key, primitives })
    gltfMeshes.set(key, meshesJson.length - 1)
    return meshesJson.length - 1
  }

  // ---------- node graph ----------

  const to3mfMatrix = (t: string | null): number[] | null => {
    if (!t) return null
    const v = t.trim().split(/\s+/).map(Number)
    // 3MF row triplets -> glTF column-major 4x4
    return [v[0], v[1], v[2], 0, v[3], v[4], v[5], 0, v[6], v[7], v[8], 0, v[9], v[10], v[11], 1]
  }

  const nodes: NodeJson[] = []
  const itemNodeIndices: number[] = []
  for (const item of buildItems) {
    const comps = componentsByObject[item.objectId] ?? [
      { path: "3D/3dmodel.model", objectId: item.objectId, transform: null },
    ]
    const parts = partsByObject[item.objectId] ?? []
    const childIndices: number[] = []
    comps.forEach((comp, j) => {
      parseModelFile(comp.path)
      const part = parts[j]
      const extruder = part?.extruder ?? extruderByObject[item.objectId] ?? 1
      const meshIdx = buildMesh(
        `${comp.path}#${comp.objectId}`,
        extruder,
        part?.subtype === "negative_part",
      )
      if (meshIdx === null) return
      const node: NodeJson = { mesh: meshIdx }
      const m = to3mfMatrix(comp.transform)
      if (m) node.matrix = m
      nodes.push(node)
      childIndices.push(nodes.length - 1)
    })
    if (!childIndices.length) continue
    const itemNode: NodeJson = {
      name: `item-${item.objectId}`,
      children: childIndices,
      extras: { plate: plateByObjectId[item.objectId] ?? null },
    }
    const m = to3mfMatrix(item.transform)
    if (m) itemNode.matrix = m
    nodes.push(itemNode)
    itemNodeIndices.push(nodes.length - 1)
  }

  // Z-up (3MF) -> Y-up (glTF)
  nodes.push({
    name: "zup-root",
    matrix: [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1],
    children: itemNodeIndices,
  })

  const gltf: GltfJson = {
    asset: { version: "2.0", generator },
    scene: 0,
    scenes: [{ nodes: [nodes.length - 1], extras: { filamentColors } }],
    nodes,
    meshes: meshesJson,
    materials: materialsJson,
    bufferViews,
    accessors,
    buffers: [{ byteLength: binLength }],
  }

  return assembleGlb(gltf, binParts, binLength)
}

// ---------- GLB container ----------

function assembleGlb(gltf: GltfJson, binParts: Uint8Array[], binLength: number): Uint8Array {
  let jsonBytes = new TextEncoder().encode(JSON.stringify(gltf))
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4
  if (jsonPad) {
    const padded = new Uint8Array(jsonBytes.length + jsonPad)
    padded.set(jsonBytes)
    padded.fill(0x20, jsonBytes.length)
    jsonBytes = padded
  }
  const binPad = (4 - (binLength % 4)) % 4
  const totalLength = 12 + 8 + jsonBytes.length + 8 + binLength + binPad

  const glb = new Uint8Array(totalLength)
  const view = new DataView(glb.buffer)
  view.setUint32(0, 0x46546c67, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, totalLength, true)
  view.setUint32(12, jsonBytes.length, true)
  view.setUint32(16, 0x4e4f534a, true)
  glb.set(jsonBytes, 20)
  let off = 20 + jsonBytes.length
  view.setUint32(off, binLength + binPad, true)
  view.setUint32(off + 4, 0x004e4942, true)
  off += 8
  for (const part of binParts) {
    glb.set(part, off)
    off += part.byteLength
  }
  return glb
}
