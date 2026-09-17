import { describe, expect, it } from "bun:test"
import { convertThreemfToGlb } from "../convert.js"
import { MissingModelError, NotAZipError, UnsupportedStructureError } from "../errors.js"
import {
  buildMinimalFixture,
  buildTwoPlateFixture,
  notAZip,
  zipWithEmptyModel,
  zipWithoutModel,
} from "./fixtures.js"

const GLB_MAGIC = 0x46546c67
const JSON_CHUNK_TYPE = 0x4e4f534a
const BIN_CHUNK_TYPE = 0x004e4942

type TestGltfNode = {
  name?: string
  mesh?: number
  children?: number[]
  extras?: { plate: number | null }
}
type TestGltfAccessor = { type: string }
type TestGltfPrimitive = { attributes: { POSITION: number }; indices: number; material: number }
type TestGltfMesh = { name: string; primitives: TestGltfPrimitive[] }
type TestGltfMaterial = { name: string }
type TestGltfJson = {
  asset: { generator: string }
  scenes: [{ extras: { filamentColors: string[] } }]
  nodes: TestGltfNode[]
  meshes: TestGltfMesh[]
  materials: TestGltfMaterial[]
  accessors: TestGltfAccessor[]
  buffers: [{ byteLength: number }]
}

type ParsedGlb = { json: TestGltfJson; binByteLength: number }

function parseGlb(glb: Uint8Array): ParsedGlb {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength)
  expect(view.getUint32(0, true)).toBe(GLB_MAGIC)
  expect(view.getUint32(4, true)).toBe(2)
  expect(view.getUint32(8, true)).toBe(glb.byteLength)

  const jsonChunkLength = view.getUint32(12, true)
  expect(view.getUint32(16, true)).toBe(JSON_CHUNK_TYPE)
  const jsonBytes = glb.slice(20, 20 + jsonChunkLength)
  const json = JSON.parse(new TextDecoder().decode(jsonBytes))

  const binOffset = 20 + jsonChunkLength
  const binChunkLength = view.getUint32(binOffset, true)
  expect(view.getUint32(binOffset + 4, true)).toBe(BIN_CHUNK_TYPE)

  return { json, binByteLength: binChunkLength }
}

describe("convertThreemfToGlb — GLB container", () => {
  it("produces a valid 12-byte header and JSON+BIN chunk layout", () => {
    const glb = convertThreemfToGlb(buildTwoPlateFixture())
    // parseGlb asserts header/chunk-type invariants; a throw here is the failure signal.
    parseGlb(glb)
  })
})

describe("convertThreemfToGlb — glTF conventions consumers rely on", () => {
  it("carries plate ids on build-item nodes as extras.plate", () => {
    const { json } = parseGlb(convertThreemfToGlb(buildTwoPlateFixture()))
    const itemNodes = json.nodes.filter((n) => n.name?.startsWith("item-"))
    expect(itemNodes).toHaveLength(3)
    const plateByItem = Object.fromEntries(itemNodes.map((n) => [n.name, n.extras?.plate]))
    expect(plateByItem["item-10"]).toBe(1)
    expect(plateByItem["item-11"]).toBe(1)
    expect(plateByItem["item-20"]).toBe(2)
  })

  it("carries project filament colors on the scene as extras.filamentColors", () => {
    const { json } = parseGlb(convertThreemfToGlb(buildTwoPlateFixture()))
    expect(json.scenes[0].extras.filamentColors).toEqual(["#FF0000", "#00FF00", "#0000FF"])
  })

  it("shares one mesh between two instances of the same source geometry", () => {
    const { json } = parseGlb(convertThreemfToGlb(buildTwoPlateFixture()))
    const item10 = json.nodes.find((n) => n.name === "item-10")
    const item11 = json.nodes.find((n) => n.name === "item-11")
    const meshOf = (item: TestGltfNode | undefined) => {
      const childIdx = item?.children?.[0]
      return childIdx === undefined ? undefined : json.nodes[childIdx]?.mesh
    }
    expect(meshOf(item10)).toBe(meshOf(item11))
    expect(meshOf(item10)).toBeDefined()
  })

  it("names materials filament_N, one per referenced filament state", () => {
    const { json } = parseGlb(convertThreemfToGlb(buildTwoPlateFixture()))
    const names = json.materials.map((m) => m.name).sort()
    // fixture paints states 1 and 2, plus the unpainted object's base extruder 2 (no new material).
    expect(names).toEqual(["filament_1", "filament_2"])
  })

  it("splits a painted mesh into one primitive per filament state present", () => {
    const { json } = parseGlb(convertThreemfToGlb(buildTwoPlateFixture()))
    const paintedMesh = json.meshes.find((m) => m.name.includes("geo1.model"))
    expect(paintedMesh?.primitives).toHaveLength(2) // states 1 and 2
  })

  it("gives every primitive a POSITION accessor and every mesh's positions their own accessor", () => {
    const { json } = parseGlb(convertThreemfToGlb(buildTwoPlateFixture()))
    for (const mesh of json.meshes) {
      for (const prim of mesh.primitives) {
        expect(typeof prim.attributes.POSITION).toBe("number")
        expect(json.accessors[prim.attributes.POSITION].type).toBe("VEC3")
      }
    }
  })

  it("declares a buffers[0].byteLength matching the BIN chunk", () => {
    const glb = convertThreemfToGlb(buildTwoPlateFixture())
    const { json, binByteLength } = parseGlb(glb)
    // BIN chunk length includes the 4-byte alignment pad; declared buffer length does not.
    expect(json.buffers[0].byteLength).toBeLessThanOrEqual(binByteLength)
    expect(binByteLength - json.buffers[0].byteLength).toBeLessThan(4)
  })
})

describe("convertThreemfToGlb — typed errors", () => {
  it("throws NotAZipError for input that isn't a zip", () => {
    expect(() => convertThreemfToGlb(notAZip())).toThrow(NotAZipError)
  })

  it("throws MissingModelError for a zip with no 3D/3dmodel.model", () => {
    expect(() => convertThreemfToGlb(zipWithoutModel())).toThrow(MissingModelError)
  })

  it("throws UnsupportedStructureError for a model with no objects and no build items", () => {
    expect(() => convertThreemfToGlb(zipWithEmptyModel())).toThrow(UnsupportedStructureError)
  })
})

describe("convertThreemfToGlb — options", () => {
  it("defaults asset.generator to threemf-to-glb", () => {
    const { json } = parseGlb(convertThreemfToGlb(buildMinimalFixture()))
    expect(json.asset.generator).toBe("threemf-to-glb")
  })

  it("honors a custom generator string", () => {
    const { json } = parseGlb(convertThreemfToGlb(buildMinimalFixture(), { generator: "custom" }))
    expect(json.asset.generator).toBe("custom")
  })
})
