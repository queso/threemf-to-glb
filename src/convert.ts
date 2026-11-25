import { dominantPaintState } from "./dominant-paint.js"
import { UnsupportedStructureError } from "./errors.js"
import { parseBambuMetadataFromFiles } from "./parse-bambu.js"
import { inflateOne, unzipSelective, ZipEntries } from "./zip.js"

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
const ROOT_MODEL = "3D/3dmodel.model"

/**
 * One object's geometry. `states` holds each triangle's dominant paint state (0 = unpainted),
 * or is null when no triangle is painted: the paint strings are reduced as they are read.
 */
type Geom = { pos: Float32Array; tris: Uint32Array; states: Uint8Array | null }

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

  // The root model and the two configs only. Each object geometry file is inflated when it is
  // first needed, parsed, and dropped before the next one (parseModelFile).
  const files = unzipSelective(input, (name) => name === ROOT_MODEL || NEEDED_METADATA.has(name))
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
  // One buffer for every object geometry file, sized for the largest: each file is inflated into
  // it, scanned, and overwritten by the next.
  const zip = ZipEntries.open(input)
  let scratch: Uint8Array = new Uint8Array(0)
  if (zip) {
    let largest = 0
    for (const [name, e] of zip.entries)
      if (name.endsWith(".model")) largest = Math.max(largest, e.usize)
    scratch = new Uint8Array(largest)
  }
  function parseModelFile(p: string): void {
    if (parsedPaths.has(p)) return
    parsedPaths.add(p)
    const bytes =
      p.replace(/^\//, "") === ROOT_MODEL
        ? files[ROOT_MODEL]
        : ((zip ? zip.read(p, scratch) : inflateOne(input, p)) ?? undefined)
    if (!bytes) return
    for (const section of scanModel(bytes)) {
      if (section.tris.length) geomByRef.set(`${p}#${section.id}`, section)
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

  /**
   * A geometry's triangles split by paint state, in the order each state first appears, as the
   * primitives list them. Shared by every mesh of that geometry (one per base extruder).
   */
  const bucketsByRef = new Map<string, [number, Uint32Array][]>()
  function buckets(ref: string, geom: Geom): [number, Uint32Array][] {
    const cached = bucketsByRef.get(ref)
    if (cached) return cached
    const triCount = geom.tris.length / 3
    const counts = new Map<number, number>()
    for (let t = 0; t < triCount; t++) {
      const state = geom.states?.[t] ?? 0
      counts.set(state, (counts.get(state) ?? 0) + 1)
    }
    const out = new Map<number, { arr: Uint32Array; at: number }>()
    for (const [state, n] of counts) out.set(state, { arr: new Uint32Array(n * 3), at: 0 })
    for (let t = 0; t < triCount; t++) {
      const b = out.get(geom.states?.[t] ?? 0) as { arr: Uint32Array; at: number }
      b.arr[b.at++] = geom.tris[t * 3]
      b.arr[b.at++] = geom.tris[t * 3 + 1]
      b.arr[b.at++] = geom.tris[t * 3 + 2]
    }
    const list = [...out].map(([state, b]) => [state, b.arr] as [number, Uint32Array])
    bucketsByRef.set(ref, list)
    return list
  }

  function buildMesh(ref: string, extruder: number, negative: boolean): number | null {
    const key = `${ref}#${extruder}#${negative ? 1 : 0}`
    const cached = gltfMeshes.get(key)
    if (cached !== undefined) return cached
    const geom = geomByRef.get(ref)
    if (!geom) return null

    const posAcc = positionAccessor(ref, geom)
    // A negative part is one primitive of every triangle in order; otherwise one per filament
    // state (0 = the part's base extruder).
    const parts: [number, Uint32Array][] = negative ? [[0, geom.tris]] : buckets(ref, geom)

    const primitives: PrimitiveJson[] = []
    for (const [state, indices] of parts) {
      const idxView = addBufferView(
        new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength),
        34963,
      )
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

  // How many meshes each geometry still has to build: after its last, its triangles and paint
  // states are dropped (the GLB keeps the positions and the per-state index arrays).
  const usesLeft = new Map<string, number>()
  for (const item of buildItems) {
    const comps = componentsByObject[item.objectId] ?? [
      { path: "3D/3dmodel.model", objectId: item.objectId, transform: null },
    ]
    for (const comp of comps) {
      const ref = `${comp.path}#${comp.objectId}`
      usesLeft.set(ref, (usesLeft.get(ref) ?? 0) + 1)
    }
  }
  const used = (ref: string) => {
    const left = (usesLeft.get(ref) ?? 1) - 1
    usesLeft.set(ref, left)
    if (left === 0) geomByRef.delete(ref)
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
      // The part whose id is the component's object id; by position when no part has that id.
      const part = parts.find((p) => p.id === comp.objectId) ?? parts[j]
      const extruder = part?.extruder ?? extruderByObject[item.objectId] ?? 1
      const ref = `${comp.path}#${comp.objectId}`
      const meshIdx = buildMesh(ref, extruder, part?.subtype === "negative_part")
      used(ref)
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

  scratch = new Uint8Array(0)

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

// ---------- the model XML, scanned as bytes ----------
// The object geometry files are tens of MB each. Scanning their bytes, with only the short number
// and paint fields turned into strings, keeps a file's whole text and its regex matches out of
// memory. The scanner accepts what these patterns accept, and nothing else:
//   objects:    <object\b[^>]*\bid="(\d+)"          (the last id in the tag)
//   vertices:   <vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"
//   triangles:  <triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"([^>]*)
//   paint:      paint_color="([0-9A-Fa-f]+)"  (the first in the rest of the tag)

/** A typed array that grows by doubling, so a large mesh is never held as JS numbers. */
class Grow<T extends Float32Array | Uint32Array | Uint8Array> {
  private buf: T
  length = 0
  constructor(private readonly make: (n: number) => T) {
    this.buf = make(1024)
  }
  push(v: number): void {
    if (this.length === this.buf.length) {
      const next = this.make(this.buf.length * 2)
      next.set(this.buf)
      this.buf = next
    }
    this.buf[this.length++] = v
  }
  /** The filled part, copied to an array of its own length. */
  done(): T {
    return this.buf.slice(0, this.length) as T
  }
}

type Section = Geom & { id: string }

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0))
const OBJECT = ascii("<object")
const VERTEX = ascii('<vertex x="')
const TRIANGLE = ascii('<triangle v1="')
const Y = ascii('" y="')
const Z = ascii('" z="')
const V2 = ascii('" v2="')
const V3 = ascii('" v3="')
const PAINT = ascii('paint_color="')
const QUOTE = 0x22
const GT = 0x3e

const isWord = (c: number) =>
  (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f
const isDigit = (c: number) => c >= 0x30 && c <= 0x39
const isHex = (c: number) => isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66)

function find(b: Uint8Array, pat: Uint8Array, from: number, to: number): number {
  for (
    let i = b.indexOf(pat[0], from);
    i !== -1 && i + pat.length <= to;
    i = b.indexOf(pat[0], i + 1)
  ) {
    let k = 1
    while (k < pat.length && b[i + k] === pat[k]) k++
    if (k === pat.length) return i
  }
  return -1
}
const at = (b: Uint8Array, pat: Uint8Array, i: number) => {
  for (let k = 0; k < pat.length; k++) if (b[i + k] !== pat[k]) return false
  return true
}
const text = (b: Uint8Array, from: number, to: number) =>
  String.fromCharCode.apply(null, b.subarray(from, to) as unknown as number[])

const POW10 = Array.from({ length: 23 }, (_, k) => 10 ** k)

/**
 * The number in b[from, to), equal to `Number()` of its text. A plain decimal ([-]digits[.digits]
 * [e[-+]digits]) with at most 15 significant digits and a power of ten within 10^±22 is one
 * exactly-representable mantissa times or over one exact power of ten, a single correctly rounded
 * operation, as `Number()` is. Anything else goes through `Number()`.
 */
function decimal(b: Uint8Array, from: number, to: number): number {
  let i = from
  const negative = b[i] === 0x2d
  if (negative) i++
  let m = 0
  let digits = 0
  let scale = 0
  let any = false
  while (i < to && isDigit(b[i])) {
    if (m !== 0 || b[i] !== 0x30) digits++
    m = m * 10 + (b[i++] - 0x30)
    any = true
  }
  if (i < to && b[i] === 0x2e) {
    i++
    while (i < to && isDigit(b[i])) {
      if (m !== 0 || b[i] !== 0x30) digits++
      m = m * 10 + (b[i++] - 0x30)
      scale--
      any = true
    }
  }
  if (any && i < to && (b[i] === 0x65 || b[i] === 0x45)) {
    i++
    const expNegative = b[i] === 0x2d
    if (b[i] === 0x2d || b[i] === 0x2b) i++
    let e = 0
    const e0 = i
    while (i < to && isDigit(b[i]) && e < 1000) e = e * 10 + (b[i++] - 0x30)
    if (i === e0) return Number(text(b, from, to))
    scale += expNegative ? -e : e
  }
  if (!any || i !== to || digits > 15 || scale > 22 || scale < -22) return Number(text(b, from, to))
  const v = scale >= 0 ? m * POW10[scale] : m / POW10[-scale]
  return negative ? -v : v
}

/** The object sections of one model file, as the patterns above read them. */
export function scanModel(b: Uint8Array): Section[] {
  const starts: { id: string; start: number }[] = []
  for (let i = find(b, OBJECT, 0, b.length); i !== -1; i = find(b, OBJECT, i + 1, b.length)) {
    if (i + OBJECT.length < b.length && isWord(b[i + OBJECT.length])) continue
    // [^>]* is greedy: the tag's last \bid="digits" before its first ">".
    const close = b.indexOf(GT, i)
    const end = close === -1 ? b.length : close
    let id: string | null = null
    for (let k = i + OBJECT.length; k + 4 <= end; k++) {
      if (b[k] !== 0x69 || b[k + 1] !== 0x64 || b[k + 2] !== 0x3d || b[k + 3] !== QUOTE) continue
      if (isWord(b[k - 1])) continue
      let d = k + 4
      while (d < b.length && isDigit(b[d])) d++
      if (d > k + 4 && b[d] === QUOTE) id = text(b, k + 4, d)
    }
    // The regex can match past this tag's ">" only if [^>]* could; it cannot.
    if (id !== null) starts.push({ id, start: i })
  }
  const sections: Section[] = []
  for (let s = 0; s < starts.length; s++) {
    const from = starts[s].start
    const to = starts[s + 1]?.start ?? b.length
    const pos = new Grow((n) => new Float32Array(n))
    for (let i = find(b, VERTEX, from, to); i !== -1; ) {
      let next = i + 1
      const x0 = i + VERTEX.length
      const x1 = b.indexOf(QUOTE, x0)
      if (x1 > x0 && x1 < to && at(b, Y, x1)) {
        const y0 = x1 + Y.length
        const y1 = b.indexOf(QUOTE, y0)
        if (y1 > y0 && y1 < to && at(b, Z, y1)) {
          const z0 = y1 + Z.length
          const z1 = b.indexOf(QUOTE, z0)
          if (z1 > z0 && z1 < to) {
            pos.push(decimal(b, x0, x1))
            pos.push(decimal(b, y0, y1))
            pos.push(decimal(b, z0, z1))
            next = z1 + 1
          }
        }
      }
      i = find(b, VERTEX, next, to)
    }
    const tris = new Grow((n) => new Uint32Array(n))
    const states = new Grow((n) => new Uint8Array(n))
    let painted = false
    const int = (from: number): [number, number] | null => {
      let v = 0
      let k = from
      while (k < to && isDigit(b[k])) v = v * 10 + (b[k++] - 0x30)
      return k > from ? [v, k] : null
    }
    for (let i = find(b, TRIANGLE, from, to); i !== -1; ) {
      let next = i + 1
      const a = int(i + TRIANGLE.length)
      if (a && at(b, V2, a[1])) {
        const c = int(a[1] + V2.length)
        if (c && at(b, V3, c[1])) {
          const d = int(c[1] + V3.length)
          if (d && b[d[1]] === QUOTE) {
            const restFrom = d[1] + 1
            let restTo = b.indexOf(GT, restFrom)
            if (restTo === -1 || restTo > to) restTo = to
            let state = 0
            let hasPaint = false
            for (
              let q = find(b, PAINT, restFrom, restTo);
              q !== -1;
              q = find(b, PAINT, q + 1, restTo)
            ) {
              const h0 = q + PAINT.length
              let h1 = h0
              while (h1 < restTo && isHex(b[h1])) h1++
              if (h1 > h0 && b[h1] === QUOTE) {
                state = dominantPaintState(text(b, h0, h1))
                hasPaint = true
                break
              }
            }
            if (state > 255)
              throw new UnsupportedStructureError(`paint state ${state} out of range`)
            tris.push(a[0])
            tris.push(c[0])
            tris.push(d[0])
            states.push(state)
            if (hasPaint) painted = true
            next = restTo
          }
        }
      }
      i = find(b, TRIANGLE, next, to)
    }
    sections.push({
      id: starts[s].id,
      pos: pos.done(),
      tris: tris.done(),
      states: painted ? states.done() : null,
    })
  }
  return sections
}
