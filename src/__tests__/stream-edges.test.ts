import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { strToU8, unzipSync, zipSync } from "fflate"
import { convertThreemfToGlb, scanModel, streamingStats } from "../convert.js"
import { dominantPaintState } from "../dominant-paint.js"
import { NotAZipError, ThreemfError } from "../errors.js"
import { ZipEntries } from "../zip.js"
import { buildPartWithUuidFixture } from "./fixtures.js"

// What reading the model files one at a time, as bytes, must keep from the converter that read
// them all as text: linear time, Bambu Studio's part pairing, the typed errors on damaged
// archives, long attributes, and the memory it exists to save. All archives here are synthetic.

type Gltf = {
  nodes: { name?: string; mesh?: number; children?: number[] }[]
  meshes: { primitives: { indices: number; material: number }[] }[]
  materials: { name: string }[]
  accessors: { count: number }[]
}
function gltf(glb: Uint8Array): Gltf {
  const length = new DataView(glb.buffer, glb.byteOffset, glb.byteLength).getUint32(12, true)
  return JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + length))) as Gltf
}
/** Each mesh node's primitives as material names, in node order. */
const materialsByNode = (g: Gltf) =>
  g.nodes
    .filter((n) => n.mesh !== undefined)
    .map((n) => g.meshes[n.mesh as number].primitives.map((p) => g.materials[p.material].name))

const NS = `xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"`
const TRI_VERTICES = `<vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/><vertex x="0" y="0" z="1"/>`

/** A geometry model file of `objects`, each `[id, triangles XML]`. */
const geometry = (objects: [string, string][]) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" ${NS}><resources>${objects
    .map(
      ([id, tris]) =>
        `<object id="${id}" type="model"><mesh><vertices>${TRI_VERTICES}</vertices><triangles>${tris}</triangles></mesh></object>`,
    )
    .join("\n")}</resources><build/></model>`

type Item = { id: string; components: [path: string, objectId: string][] }
/** A project: root model items with components, model_settings parts, three filaments. */
function project(
  items: Item[],
  parts: Record<string, string>,
  files: Record<string, string>,
  extra: Record<string, Uint8Array> = {},
  rootPadding = 0,
): Uint8Array {
  const root = `<?xml version="1.0" encoding="UTF-8"?>\n<!--${" ".repeat(rootPadding)}-->\n<model unit="millimeter" ${NS}><resources>${items
    .map(
      (it) =>
        `<object id="${it.id}" type="model"><components>${it.components
          .map(([path, oid]) => `<component p:path="/${path}" objectid="${oid}"/>`)
          .join("")}</components></object>`,
    )
    .join(
      "",
    )}</resources><build>${items.map((it) => `<item objectid="${it.id}"/>`).join("")}</build></model>`
  const settings = `<?xml version="1.0" encoding="UTF-8"?>\n<config>${items
    .map(
      (it) =>
        `<object id="${it.id}"><metadata key="extruder" value="1"/>${parts[it.id] ?? ""}</object>`,
    )
    .join("")}<plate><metadata key="plater_id" value="1"/>${items
    .map((it) => `<model_instance><metadata key="object_id" value="${it.id}"/></model_instance>`)
    .join("")}</plate></config>`
  return zipSync({
    "3D/3dmodel.model": strToU8(root),
    "Metadata/model_settings.config": strToU8(settings),
    "Metadata/project_settings.config": strToU8(
      JSON.stringify({ filament_colour: ["#FF0000", "#00FF00", "#0000FF"] }),
    ),
    ...Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])),
    ...extra,
  })
}

const tri = (paint?: string) =>
  `<triangle v1="0" v2="1" v3="2"${paint ? ` paint_color="${paint}"` : ""}/>`

describe("time: linear in the number of triangles", () => {
  const unpainted = (n: number) => {
    const tris = Array.from(
      { length: n },
      (_, i) => `<triangle v1="${i % 4}" v2="${(i + 1) % 4}" v3="${(i + 2) % 4}"/>`,
    ).join("\n")
    return project(
      [{ id: "2", components: [["3D/Objects/o.model", "1"]] }],
      {},
      { "3D/Objects/o.model": geometry([["1", tris]]) },
    )
  }
  // A count, not a time: each triangle's paint search covers only its own tag, so the bytes it is
  // given add up to less than the file. Searching to the end of the file instead gives about
  // n²/2 tags' worth; not searching within the tag at all gives none.
  it("the paint search covers each triangle's own tag only: less than the file, in total", () => {
    for (const n of [20_000, 80_000]) {
      const input = unpainted(n)
      const size = unzipSync(input)["3D/Objects/o.model"].length
      convertThreemfToGlb(input)
      expect(streamingStats.paintSearchBytes).toBeGreaterThan(0)
      expect(streamingStats.paintSearchBytes).toBeLessThan(size)
    }
  })
})

describe("parts: Bambu Studio's pairing of components with parts", () => {
  const body = [tri("8"), tri("8"), tri()].join("") // filament state 2 twice, then unpainted

  it("a shared mesh: two components with the same object id take the part at their own position", () => {
    const input = project(
      [
        {
          id: "2",
          components: [
            ["3D/Objects/o.model", "1"],
            ["3D/Objects/o.model", "1"],
          ],
        },
      ],
      {
        "2": `<part id="1" subtype="normal_part"><metadata key="extruder" value="2"/></part><part id="1" subtype="negative_part"></part>`,
      },
      { "3D/Objects/o.model": geometry([["1", tri()]]) },
    )
    expect(materialsByNode(gltf(convertThreemfToGlb(input)))).toEqual([
      ["filament_2"],
      ["negative"],
    ])
  })

  it("parts whose ids name no component are taken by position", () => {
    const input = project(
      [
        {
          id: "2",
          components: [
            ["3D/Objects/o.model", "1"],
            ["3D/Objects/o.model", "3"],
          ],
        },
      ],
      {
        "2": `<part id="5" subtype="normal_part"><metadata key="extruder" value="2"/></part><part id="6" subtype="negative_part"></part>`,
      },
      {
        "3D/Objects/o.model": geometry([
          ["1", tri()],
          ["3", tri()],
        ]),
      },
    )
    expect(materialsByNode(gltf(convertThreemfToGlb(input)))).toEqual([
      ["filament_2"],
      ["negative"],
    ])
  })

  it("primitives in the order each paint state first appears; a negative part is one primitive of every triangle", () => {
    const input = project(
      [
        {
          id: "2",
          components: [
            ["3D/Objects/o.model", "1"],
            ["3D/Objects/o.model", "3"],
          ],
        },
      ],
      {
        "2": `<part id="1" subtype="normal_part"></part><part id="3" subtype="negative_part"></part>`,
      },
      {
        "3D/Objects/o.model": geometry([
          ["1", [tri("8"), tri("4"), tri("8")].join("")],
          ["3", body],
        ]),
      },
    )
    const g = gltf(convertThreemfToGlb(input))
    expect(materialsByNode(g)).toEqual([["filament_2", "filament_1"], ["negative"]])
    const negative = g.meshes[g.nodes.filter((n) => n.mesh !== undefined)[1].mesh as number]
    expect(g.accessors[negative.primitives[0].indices].count).toBe(9)
  })
})

/** The model entry `name`'s central and local records, to damage them. */
function records(z: Uint8Array, name: string) {
  const v = new DataView(z.buffer, z.byteOffset, z.byteLength)
  let eocd = z.length - 22
  while (v.getUint32(eocd, true) !== 0x06054b50) eocd--
  let at = v.getUint32(eocd + 16, true)
  for (let n = v.getUint16(eocd + 10, true); n > 0; n--) {
    const nameLength = v.getUint16(at + 28, true)
    const entry = new TextDecoder().decode(z.subarray(at + 46, at + 46 + nameLength))
    const local = v.getUint32(at + 42, true)
    if (entry === name) {
      const data = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true)
      return { v, eocd, central: at, local, data }
    }
    at += 46 + nameLength + v.getUint16(at + 30, true) + v.getUint16(at + 32, true)
  }
  throw new Error(`no ${name}`)
}

describe("damaged archives: the typed errors and results of the selective inflate", () => {
  const GEO = "3D/Objects/geo3.model"
  const clean = () => buildPartWithUuidFixture()
  const damaged = (change: (r: ReturnType<typeof records>) => void) => {
    const z = clean().slice()
    change(records(z, GEO))
    return z
  }
  const meshNodes = (glb: Uint8Array) => gltf(glb).nodes.filter((n) => n.mesh !== undefined).length

  it("deflate data that does not inflate throws NotAZipError", () => {
    const z = damaged((r) => {
      r.v.setUint8(r.data, 0x07) // final block, reserved block type
    })
    expect(() => convertThreemfToGlb(z)).toThrow(NotAZipError)
  })

  it("an unknown compression method throws NotAZipError", () => {
    const z = damaged((r) => {
      r.v.setUint16(r.central + 10, 12, true)
      r.v.setUint16(r.local + 8, 12, true)
    })
    expect(() => convertThreemfToGlb(z)).toThrow(NotAZipError)
  })

  it("a damaged local header, or a size larger or smaller than the entry, converts as fflate reads it", () => {
    const variants = [
      damaged((r) => r.v.setUint32(r.local, 0x12345678, true)),
      damaged((r) => {
        r.v.setUint32(r.central + 24, r.v.getUint32(r.central + 24, true) + 5, true)
        r.v.setUint32(r.local + 22, r.v.getUint32(r.local + 22, true) + 5, true)
      }),
      // Half what it is: the reader must not hand on its own cut-short copy.
      damaged((r) => {
        r.v.setUint32(r.central + 24, Math.floor(r.v.getUint32(r.central + 24, true) / 2), true)
        r.v.setUint32(r.local + 22, Math.floor(r.v.getUint32(r.local + 22, true) / 2), true)
      }),
    ]
    const results = variants.map((z) => convertThreemfToGlb(z.slice()))
    // The same archives through fflate alone, as the converter read them before streaming.
    const open = spyOn(ZipEntries, "open").mockReturnValue(null)
    const viaFflate = variants.map((z) => convertThreemfToGlb(z.slice()))
    open.mockRestore()
    for (const [k, glb] of results.entries())
      expect(Buffer.compare(Buffer.from(glb), Buffer.from(viaFflate[k]))).toBe(0)
    // The first two read in full: the clean file's output.
    const clean0 = convertThreemfToGlb(clean())
    expect(Buffer.compare(Buffer.from(results[0]), Buffer.from(clean0))).toBe(0)
    expect(Buffer.compare(Buffer.from(results[1]), Buffer.from(clean0))).toBe(0)
  })

  it("an entry count lower than the archive's converts, as fflate reads it, without an untyped error", () => {
    const z = damaged((r) => {
      r.v.setUint16(r.eocd + 8, r.v.getUint16(r.eocd + 8, true) - 1, true)
      r.v.setUint16(r.eocd + 10, r.v.getUint16(r.eocd + 10, true) - 1, true)
    })
    expect(convertThreemfToGlb(z).length).toBeGreaterThan(0)
  })

  it("a local header offset past the end converts without the entry, and never throws an untyped error", () => {
    const z = damaged((r) => r.v.setUint32(r.central + 42, 0x7fffffff, true))
    let glb: Uint8Array | null = null
    try {
      glb = convertThreemfToGlb(z)
    } catch (error) {
      expect(error).toBeInstanceOf(ThreemfError)
    }
    if (glb) expect(meshNodes(glb)).toBeLessThan(meshNodes(convertThreemfToGlb(clean())))
  })
})

describe("attributes of any length", () => {
  it("a paint_color of 2,100,000 characters and a vertex value of 200,000 digits convert", () => {
    // Long enough to overflow a call stack spread one argument per byte, under Node and Bun.
    const longPaint = `<triangle v1="0" v2="1" v3="2" paint_color="${"0".repeat(2_099_999)}8"/>`
    const longVertex = `<vertex x="${"1".repeat(200_000)}" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/>`
    const input = project(
      [{ id: "2", components: [["3D/Objects/o.model", "1"]] }],
      {},
      {
        "3D/Objects/o.model": `<model ${NS}><resources><object id="1" type="model"><mesh><vertices>${longVertex}</vertices><triangles>${longPaint}</triangles></mesh></object></resources></model>`,
      },
    )
    expect(convertThreemfToGlb(input).length).toBeGreaterThan(0)
  })
})

describe("memory: one model file at a time", () => {
  let spy: ReturnType<typeof spyOn> | null = null
  afterEach(() => spy?.mockRestore())

  const threeFiles = (rootPadding = 0) =>
    project(
      [
        { id: "2", components: [["3D/Objects/a.model", "1"]] },
        { id: "3", components: [["3D/Objects/b.model", "1"]] },
        { id: "4", components: [["3D/Objects/c.model", "1"]] },
      ],
      {},
      {
        "3D/Objects/a.model": geometry([["1", tri().repeat(10)]]),
        "3D/Objects/b.model": geometry([["1", tri().repeat(30)]]),
        "3D/Objects/c.model": geometry([["1", tri().repeat(20)]]),
      },
      {},
      // A root model larger than any object file: it is not inflated into the shared buffer.
      rootPadding,
    )

  it("inflates each object file on its own, into one buffer sized for the largest, after the metadata", () => {
    const input = threeFiles(50_000)
    const sizes = unzipSync(input, { filter: (f) => f.name.startsWith("3D/Objects/") })
    const largest = Math.max(...Object.values(sizes).map((b) => b.length))
    const buffers: Uint8Array[] = []
    const names: string[] = []
    const original = ZipEntries.prototype.read
    spy = spyOn(ZipEntries.prototype, "read").mockImplementation(function (
      this: ZipEntries,
      name: string,
      scratch: Uint8Array,
    ) {
      buffers.push(scratch)
      names.push(name)
      return original.call(this, name, scratch)
    })
    convertThreemfToGlb(input)
    expect(names).toEqual(["3D/Objects/a.model", "3D/Objects/b.model", "3D/Objects/c.model"])
    expect(new Set(buffers).size).toBe(1)
    expect(buffers[0].length).toBe(largest + 1)
    expect(streamingStats.upFront).toEqual([
      "3D/3dmodel.model",
      "Metadata/model_settings.config",
      "Metadata/project_settings.config",
    ])
  })

  it("holds one object's geometry at a time when each is used once", () => {
    convertThreemfToGlb(threeFiles())
    expect(streamingStats.mostGeometriesHeld).toBe(1)
  })

  it("keeps a geometry until its last use: two build items of one object both get its mesh", () => {
    const input = project(
      [
        { id: "2", components: [["3D/Objects/a.model", "1"]] },
        { id: "3", components: [["3D/Objects/a.model", "1"]] },
      ],
      {},
      { "3D/Objects/a.model": geometry([["1", tri()]]) },
    )
    const g = gltf(convertThreemfToGlb(input))
    const items = g.nodes.filter((n) => n.name?.startsWith("item-"))
    expect(items).toHaveLength(2)
    for (const item of items) expect(g.nodes[item.children?.[0] as number].mesh).toBeDefined()
  })

  it("a paint cache per conversion: the second conversion's holds only its own paint strings", () => {
    const painted = (paints: string[]) =>
      project(
        [{ id: "2", components: [["3D/Objects/o.model", "1"]] }],
        {},
        { "3D/Objects/o.model": geometry([["1", paints.map(tri).join("")]]) },
      )
    convertThreemfToGlb(painted(["4", "8", "4"]))
    expect(streamingStats.paintStrings).toBe(2)
    convertThreemfToGlb(painted(["C"]))
    expect(streamingStats.paintStrings).toBe(1)
  })
})

describe("scanModel: where the regexes it replaced went their own way", () => {
  it("a second <object inside an object's tag, before its first >, is part of that tag, as the regex reads it", () => {
    const xml = `<object <object id="1"><mesh><vertices><vertex x="1" y="2" z="3"/></vertices><triangles><triangle v1="0" v2="0" v3="0"/></triangles></mesh></object>`
    // The regex matches from the first "<object" to the id, and resumes after it: one section.
    expect([...xml.matchAll(/<object\b[^>]*\bid="(\d+)"/g)].map((m) => m.index)).toEqual([0])
    const sections = scanModel(strToU8(xml))
    expect(sections.map((s) => s.id)).toEqual(["1"])
    expect([...sections[0].pos]).toEqual([1, 2, 3])
  })

  it("17 and 19 digit triangle indices are the numbers Number() reads, not a digit sum", () => {
    // Each sums to a different double from Number()'s, and to a different Uint32 too.
    for (const v of ["31278707854909454", "7610749856721630309"]) {
      const xml = `<object id="1"><mesh><vertices><vertex x="1" y="2" z="3"/></vertices><triangles><triangle v1="${v}" v2="0" v3="0"/></triangles></mesh></object>`
      expect(scanModel(strToU8(xml))[0].tris[0]).toBe(Number(v) >>> 0)
    }
  })

  it("a field the fast paths leave to Number() is decoded as UTF-8, as the whole file was", () => {
    // A no-break space (UTF-8 C2 A0) is white space to Number(): 1.5, as v0.1.1 read it from the
    // decoded file. Decoded as Latin-1 the field is "Â" and a no-break space: NaN.
    for (const x of ["\u00a01.5", "1.5\u00a0", "\u20281.5"]) {
      const xml = `<object id="1"><mesh><vertices><vertex x="${x}" y="2" z="3"/></vertices><triangles><triangle v1="0" v2="0" v3="0"/></triangles></mesh></object>`
      expect(scanModel(strToU8(xml))[0].pos[0]).toBe(Number(x))
    }
  })

  it("a triangle index past 15 digits is the number Number() reads", () => {
    const xml = `<object id="1"><mesh><vertices><vertex x="1" y="2" z="3"/></vertices><triangles><triangle v1="99999999999999999999" v2="0" v3="0"/></triangles></mesh></object>`
    expect([...scanModel(strToU8(xml))[0].tris]).toEqual([
      ...Uint32Array.from([Number("99999999999999999999"), 0, 0]),
    ])
  })
})

describe("absent model files: one directory walk, not one per path", () => {
  // A count, not a time: the fallback to fflate runs only for names fflate lists, so absent
  // paths cost nothing however many there are. One walk per absent path made 16,000 absent paths
  // in a 16,000-entry archive take 42 s.
  const many = (n: number) => {
    const filler = Object.fromEntries(
      Array.from({ length: n }, (_, i) => [`Metadata/filler-${i}.txt`, "x"]),
    )
    return project(
      [
        {
          id: "2",
          components: [
            ["3D/Objects/o.model", "1"],
            ...Array.from(
              { length: n },
              (_, i) => [`3D/Objects/absent-${i}.model`, "1"] as [string, string],
            ),
          ],
        },
      ],
      {},
      { "3D/Objects/o.model": geometry([["1", tri()]]), ...filler },
    )
  }

  it("absent paths fall back to fflate never; a present file the reader refuses, once", () => {
    const input = many(2_000)
    const glb = convertThreemfToGlb(input)
    expect(streamingStats.fallbackInflates).toBe(0)
    expect(gltf(glb).nodes.filter((n) => n.mesh !== undefined)).toHaveLength(1)

    // Without the reader, the one present model file falls back, and still only it.
    const open = spyOn(ZipEntries, "open").mockReturnValue(null)
    try {
      expect(convertThreemfToGlb(input)).toEqual(glb)
      expect(streamingStats.fallbackInflates).toBe(1)
    } finally {
      open.mockRestore()
    }
  })
})

describe("components that point outside the geometry files", () => {
  it("a component path to an entry that is not a .model file is not read, as before streaming", () => {
    const input = project(
      [{ id: "2", components: [["Metadata/notes.txt", "1"]] }],
      {},
      { "Metadata/notes.txt": geometry([["1", tri()]]) },
    )
    expect(gltf(convertThreemfToGlb(input)).nodes.filter((n) => n.mesh !== undefined)).toHaveLength(
      0,
    )
  })
})

describe("scanModel: the triangle and vertex patterns, exactly", () => {
  it("takes the first hex paint_color, and refuses a triangle without the quote after v3 or a vertex with an empty value", () => {
    const xml = `<object id="1"><mesh><vertices><vertex x="" y="1" z="2"/><vertex x="1" y="2" z="3"/></vertices><triangles><triangle v1="0" v2="1" v3="2" paint_color="4" paint_color="8"/><triangle v1="0" v2="1" v3="2/></triangles></mesh></object>`
    const [section] = scanModel(strToU8(xml))
    expect([...section.pos]).toEqual([1, 2, 3])
    expect([...section.tris]).toEqual([0, 1, 2])
    expect(section.states ? [...section.states] : null).toEqual([dominantPaintState("4")])
  })
})

/** A stored zip whose records carry extra fields and comments, as some writers produce. */
function zipWithExtras(files: Record<string, Uint8Array>, archiveComment: string): Uint8Array {
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  const crc32 = (data: Uint8Array) => {
    let c = 0xffffffff
    for (const byte of data) {
      c ^= byte
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    return (c ^ 0xffffffff) >>> 0
  }
  for (const [name, data] of Object.entries(files)) {
    const nameBytes = strToU8(name)
    const extra = new Uint8Array([0xfe, 0xca, 4, 0, 1, 2, 3, 4]) // tag, length 4, payload
    const comment = strToU8("a comment on this entry")
    const crc = crc32(data)
    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 20, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, data.length, true)
    local.setUint32(22, data.length, true)
    local.setUint16(26, nameBytes.length, true)
    local.setUint16(28, extra.length, true)
    const cd = new DataView(new ArrayBuffer(46))
    cd.setUint32(0, 0x02014b50, true)
    cd.setUint16(4, 20, true)
    cd.setUint16(6, 20, true)
    cd.setUint32(16, crc, true)
    cd.setUint32(20, data.length, true)
    cd.setUint32(24, data.length, true)
    cd.setUint16(28, nameBytes.length, true)
    cd.setUint16(30, extra.length + 4, true)
    cd.setUint16(32, comment.length, true)
    cd.setUint32(42, offset, true)
    const localBytes = [new Uint8Array(local.buffer), nameBytes, extra, data]
    parts.push(...localBytes)
    offset += localBytes.reduce((n, b) => n + b.length, 0)
    central.push(
      new Uint8Array(cd.buffer),
      nameBytes,
      extra,
      new Uint8Array([0xfe, 0xcb, 0, 0]),
      comment,
    )
  }
  const cdBytes = central.reduce((n, b) => n + b.length, 0)
  const commentBytes = strToU8(archiveComment)
  const eocd = new DataView(new ArrayBuffer(22))
  eocd.setUint32(0, 0x06054b50, true)
  const count = Object.keys(files).length
  eocd.setUint16(8, count, true)
  eocd.setUint16(10, count, true)
  eocd.setUint32(12, cdBytes, true)
  eocd.setUint32(16, offset, true)
  eocd.setUint16(20, commentBytes.length, true)
  const all = [...parts, ...central, new Uint8Array(eocd.buffer), commentBytes]
  const out = new Uint8Array(all.reduce((n, b) => n + b.length, 0))
  let at = 0
  for (const b of all) {
    out.set(b, at)
    at += b.length
  }
  return out
}

describe("ZipEntries: what other zip writers put in an archive", () => {
  const files = unzipSync(buildPartWithUuidFixture())

  it("reads past extra fields and comments in the records and a comment on the archive", () => {
    const z = zipWithExtras(files, "an archive comment with PK\u0005\u0006 in it")
    const entries = ZipEntries.open(z)
    expect(entries).not.toBeNull()
    const read = entries?.read("3D/Objects/geo3.model", new Uint8Array(0))
    expect(
      Buffer.compare(
        Buffer.from(read ?? new Uint8Array()),
        Buffer.from(files["3D/Objects/geo3.model"]),
      ),
    ).toBe(0)
    expect(
      Buffer.compare(
        Buffer.from(convertThreemfToGlb(z)),
        Buffer.from(convertThreemfToGlb(buildPartWithUuidFixture())),
      ),
    ).toBe(0)
  })

  it("leaves a ZIP64 archive (sizes of 0xFFFFFFFF) to fflate", () => {
    const z = buildPartWithUuidFixture().slice()
    const r = records(z, "3D/Objects/geo3.model")
    r.v.setUint32(r.central + 20, 0xffffffff, true)
    expect(ZipEntries.open(z)).toBeNull()
  })
})
