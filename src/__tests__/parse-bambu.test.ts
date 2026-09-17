import { describe, expect, it } from "bun:test"
import { MissingModelError, UnsupportedStructureError } from "../errors.js"
import { parseBambuMetadata } from "../parse-bambu.js"
import {
  buildMinimalFixture,
  buildTwoPlateFixture,
  notAZip,
  zipWithEmptyModel,
  zipWithoutModel,
} from "./fixtures.js"

describe("parseBambuMetadata", () => {
  it("reads filament colors from project_settings.config", () => {
    const meta = parseBambuMetadata(buildTwoPlateFixture())
    expect(meta.filamentColors).toEqual(["#FF0000", "#00FF00", "#0000FF"])
  })

  it("reads plate membership from model_settings.config", () => {
    const meta = parseBambuMetadata(buildTwoPlateFixture())
    expect(meta.plateByObjectId["10"]).toBe(1)
    expect(meta.plateByObjectId["11"]).toBe(1)
    expect(meta.plateByObjectId["20"]).toBe(2)
  })

  it("reads the build-item -> component graph from 3D/3dmodel.model", () => {
    const meta = parseBambuMetadata(buildTwoPlateFixture())
    expect(meta.buildItems.map((i) => i.objectId)).toEqual(["10", "11", "20"])
    expect(meta.componentsByObject["10"]).toEqual([
      { path: "3D/Objects/geo1.model", objectId: "1", transform: null },
    ])
    expect(meta.componentsByObject["11"]?.[0]?.transform).toBe("1 0 0 0 1 0 0 0 1 10 0 0")
  })

  it("reads per-object base extruder", () => {
    const meta = parseBambuMetadata(buildTwoPlateFixture())
    expect(meta.extruderByObject["10"]).toBe(1)
    expect(meta.extruderByObject["20"]).toBe(2)
  })

  it("returns empty filament colors for a minimal fixture with no project_settings.config", () => {
    const meta = parseBambuMetadata(buildMinimalFixture())
    expect(meta.filamentColors).toEqual([])
  })

  it("does not require inflating any object geometry file", () => {
    // buildMinimalFixture's geometry lives only in 3D/Objects/geo.model; metadata parsing must
    // succeed using only the root model + the two Metadata configs.
    const meta = parseBambuMetadata(buildMinimalFixture())
    expect(meta.buildItems).toHaveLength(1)
  })

  it("throws NotAZipError-family for non-zip input", () => {
    expect(() => parseBambuMetadata(notAZip())).toThrow()
  })

  it("throws MissingModelError when the archive has no 3D/3dmodel.model", () => {
    expect(() => parseBambuMetadata(zipWithoutModel())).toThrow(MissingModelError)
  })

  it("throws UnsupportedStructureError when the model has no objects and no build items", () => {
    expect(() => parseBambuMetadata(zipWithEmptyModel())).toThrow(UnsupportedStructureError)
  })
})
