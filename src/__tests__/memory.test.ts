import { describe, expect, it } from "bun:test"
import { unzipSync } from "fflate"
import { convertThreemfToGlb } from "../convert.js"
import { buildFixtureWithCorruptGcode, buildTwoPlateFixture } from "./fixtures.js"

// Selective inflate is the property this package exists to preserve: a sliced Bambu .gcode.3mf
// carries hundreds of MB of plate gcode alongside the KB-scale XML this converter reads, and
// inflating all of it OOM-killed a 512Mi pod on a 58MB input in production. These tests prove the
// converter never touches an entry outside its filter by making that entry corrupt: if it were
// ever inflated, inflation would throw.

describe("selective inflate", () => {
  it("the corrupt gcode entry really is corrupt (sanity check on the fixture itself)", () => {
    const fixture = buildFixtureWithCorruptGcode()
    // A filter that DOES select the gcode entry must throw when fflate tries to inflate it.
    expect(() => unzipSync(fixture, { filter: () => true })).toThrow()
  })

  it("converts successfully despite a large corrupt gcode entry present in the archive", () => {
    const withGcode = buildFixtureWithCorruptGcode()
    const withoutGcode = buildTwoPlateFixture()

    const glbWithGcode = convertThreemfToGlb(withGcode)
    const glbWithoutGcode = convertThreemfToGlb(withoutGcode)

    // Same geometry/metadata either way: the gcode entry contributes nothing to the output,
    // because it was never inflated in the first place.
    expect(glbWithGcode.length).toBe(glbWithoutGcode.length)
    expect(Buffer.compare(Buffer.from(glbWithGcode), Buffer.from(glbWithoutGcode))).toBe(0)
  })
})
