import { describe, expect, it } from "bun:test"
import { strToU8, unzipSync, zipSync } from "fflate"
import { decimal, scanModel } from "../convert.js"
import { dominantPaintState } from "../dominant-paint.js"
import { ZipEntries } from "../zip.js"
import { buildFixtureWithCorruptGcode, buildTwoPlateFixture } from "./fixtures.js"

// The converter reads object model files as bytes (scanModel, decimal) and inflates one entry
// at a time (ZipEntries). These pin that it reads exactly what the regexes it replaced read.

/** The regex reading scanModel replaced, kept here as the reference. */
function regexModel(xml: string) {
  const sections = [...xml.matchAll(/<object\b[^>]*\bid="(\d+)"/g)].map((m) => ({
    id: m[1],
    start: m.index,
  }))
  return sections.map((s, i) => {
    const chunk = xml.slice(s.start, sections[i + 1]?.start ?? xml.length)
    const pos: number[] = []
    for (const vm of chunk.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)) {
      pos.push(Number(vm[1]), Number(vm[2]), Number(vm[3]))
    }
    const tris: number[] = []
    const states: number[] = []
    let painted = false
    for (const tm of xmlTriangles(chunk)) {
      tris.push(Number(tm[1]), Number(tm[2]), Number(tm[3]))
      const pc = /paint_color="([0-9A-Fa-f]+)"/.exec(tm[4])
      states.push(pc ? dominantPaintState(pc[1]) : 0)
      if (pc) painted = true
    }
    return {
      id: s.id,
      pos: Float32Array.from(pos),
      tris: Uint32Array.from(tris),
      states: painted ? Uint8Array.from(states) : null,
    }
  })
}
const xmlTriangles = (chunk: string) =>
  chunk.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"([^>]*)/g)

const bytes = (s: string) => new TextEncoder().encode(s)

describe("scanModel reads what the regexes read", () => {
  it("objects, vertices, triangles and paint, with the cases the patterns treat specially", () => {
    const xml = [
      '<model><resources><objects count="2">', // \\b after <object: <objects is not an object
      '<objectgroup id="3">', // nor is <objectgroup, though it has an id
      '<object id="1" type="model" pid="9"><mesh><vertices>',
      '<vertex x="1.5" y="-2.25" z="0"/><vertex x="1e-3" y="+4" z=" 7"/>',
      '<vertex  x="9" y="9" z="9"/>', // two spaces: not a vertex to the regex
      '<vertex x="0.1" y="-0" z="123456789012345678"/>',
      "</vertices><triangles>",
      '<triangle v1="0" v2="1" v3="2"/>',
      '<triangle v1="1" v2="2" v3="3" paint_color="0C"/>',
      '<triangle v1="2" v2="3" v3="0" paint_color="zz" paint_color="4"/>', // the first hex one
      '<triangle v1="3" v2="0" v3="1" paint_color=""/>',
      '<triangle v1="x" v2="0" v3="1"/>', // not digits: skipped
      "</triangles></mesh></object>",
      '<object type="model" id="7" id="8"><mesh><vertices>', // the last id in the tag
      '<vertex x="3" y="4" z="5"/></vertices><triangles><triangle v1="0" v2="0" v3="0"/>',
      '</triangles></mesh></object><object id="9"></object>', // no triangles
      "</objects></resources></model>",
    ].join("\n")
    const scanned = scanModel(bytes(xml))
    const reference = regexModel(xml)
    expect(scanned.map((s) => s.id)).toEqual(reference.map((s) => s.id))
    expect(scanned.map((s) => s.id)).toEqual(["1", "8", "9"])
    for (const [i, ref] of reference.entries()) {
      expect([...scanned[i].pos]).toEqual([...ref.pos])
      expect([...scanned[i].tris]).toEqual([...ref.tris])
      expect(scanned[i].states ? [...scanned[i].states] : null).toEqual(
        ref.states ? [...ref.states] : null,
      )
    }
  })

  it("the two-plate fixture's model files scan as the regexes read them", () => {
    const files = unzipSync(buildTwoPlateFixture(), { filter: (f) => f.name.endsWith(".model") })
    for (const [name, data] of Object.entries(files)) {
      const scanned = scanModel(data)
      const reference = regexModel(new TextDecoder().decode(data))
      expect(scanned.length, name).toBe(reference.length)
      for (const [i, ref] of reference.entries()) {
        expect([...scanned[i].pos], name).toEqual([...ref.pos])
        expect([...scanned[i].tris], name).toEqual([...ref.tris])
      }
    }
  })
})

describe("decimal equals Number()", () => {
  const cases = [
    "0",
    "-0",
    "1",
    "-1",
    "0.1",
    "0.2",
    "0.30000000000000004",
    "123.456",
    "-98.7654321",
    "1e10",
    "1E-7",
    "2.5e+3",
    "-3.4028235e38",
    "9007199254740993",
    "0.000001",
    "1234567.891",
    "4.94065645841247e-324",
    "1e23",
    "1e-23",
    "123456789012345678901234567890",
    ".5",
    "5.",
    "+4",
    " 7",
    "1e",
    "abc",
    "",
    "-",
    "0x10",
    "Infinity",
    "1_0",
    "00012.500",
    "2883246525.9724236",
    "43972506073.902412",
    "19220276536306.630",
  ]
  it.each(cases)("%p", (s) => {
    const b = bytes(s)
    const got = decimal(b, 0, b.length)
    const want = Number(s)
    expect(Object.is(got, want) || (Number.isNaN(got) && Number.isNaN(want))).toBe(true)
    // What the GLB stores: the float32 of it.
    expect(Object.is(Math.fround(got), Math.fround(want)) || Number.isNaN(want)).toBe(true)
  })

  it("random plain decimals of up to 15 significant digits", () => {
    let seed = 7
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    for (let n = 0; n < 20000; n++) {
      const intDigits = Math.floor(rand() * 7)
      const fracDigits = Math.floor(rand() * 9)
      const digits = (k: number) =>
        Array.from({ length: k }, () => Math.floor(rand() * 10)).join("")
      const s = `${rand() < 0.5 ? "-" : ""}${digits(intDigits) || "0"}${fracDigits ? `.${digits(fracDigits)}` : ""}`
      const b = bytes(s)
      expect(Object.is(decimal(b, 0, b.length), Number(s)), s).toBe(true)
    }
  })
})

describe("ZipEntries", () => {
  it("reads deflated and stored entries as fflate does, into a reused buffer", () => {
    const zip = zipSync({
      "a.model": [strToU8("x".repeat(5000)), { level: 6 }],
      "b.model": [strToU8("stored entry"), { level: 0 }],
    })
    const entries = ZipEntries.open(zip)
    if (!entries) throw new Error("not read")
    const scratch = new Uint8Array(5000)
    const all = unzipSync(zip)
    const a = entries.read("a.model", scratch)
    expect(new TextDecoder().decode(a ?? undefined)).toBe(new TextDecoder().decode(all["a.model"]))
    expect(a?.buffer).toBe(scratch.buffer)
    expect(new TextDecoder().decode(entries.read("/b.model", scratch) ?? undefined)).toBe(
      "stored entry",
    )
    expect(entries.read("missing.model", scratch)).toBeNull()
  })

  it("never inflates an entry it is not asked for: the corrupt gcode stays untouched", () => {
    const entries = ZipEntries.open(buildFixtureWithCorruptGcode())
    if (!entries) throw new Error("not read")
    const model = [...entries.entries.keys()].find((n) => n.endsWith(".model"))
    expect(model).toBeDefined()
    expect(() => entries.read(model as string, new Uint8Array(0))).not.toThrow()
  })

  it("is null for what it does not read, so the converter falls back", () => {
    expect(ZipEntries.open(new Uint8Array([1, 2, 3]))).toBeNull()
  })
})
