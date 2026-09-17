import { describe, expect, it } from "bun:test"
import { dominantPaintState } from "../dominant-paint.js"

// Expected values were derived from the reference Python decoder (spike-toolkit's paint_rle.py)
// run against real paint_color strings pulled from a real painted Bambu model:
//   441C43    -> {1: 0.75, 4: 0.25}    dominant 1
//   1C4443    -> {1: 0.75, 4: 0.25}    dominant 1
//   1C41C1C3  -> {4: 0.75, 1: 0.25}    dominant 4
//   40C443    -> {1: 0.75, 3: 0.25}    dominant 1
//   0C0C40C3  -> {3: 0.75, 1: 0.25}    dominant 3

describe("dominantPaintState — single-leaf vectors", () => {
  it.each([
    ["4", 1],
    ["8", 2],
    ["0C", 3],
    ["1C", 4],
  ])("decodes %s to state %i", (hex, expected) => {
    expect(dominantPaintState(hex)).toBe(expected)
  })
})

describe("dominantPaintState — split-tree vectors (expected values from paint_rle.py)", () => {
  it.each([
    ["441C43", 1],
    ["1C4443", 1],
    ["1C41C1C3", 4],
    ["40C443", 1],
    ["0C0C40C3", 3],
  ])("decodes %s to the area-dominant state %i", (hex, expected) => {
    expect(dominantPaintState(hex)).toBe(expected)
  })
})

describe("dominantPaintState — cache determinism", () => {
  it("returns the same value on repeated calls for the same hex string", () => {
    const first = dominantPaintState("1C41C1C3")
    const second = dominantPaintState("1C41C1C3")
    expect(second).toBe(first)
    expect(second).toBe(4)
  })
})

describe("dominantPaintState — case insensitivity", () => {
  it("decodes lowercase hex the same as uppercase", () => {
    expect(dominantPaintState("1c")).toBe(dominantPaintState("1C"))
    expect(dominantPaintState("1c")).toBe(4)
  })

  it("decodes a mixed-case split-tree string the same as its uppercase form", () => {
    expect(dominantPaintState("1c41c1c3")).toBe(dominantPaintState("1C41C1C3"))
  })
})

describe("dominantPaintState — edge cases", () => {
  it("treats a single zero nibble as leaf state 0 (unpainted)", () => {
    expect(dominantPaintState("0")).toBe(0)
  })

  it("degrades a malformed paint string to state 0 instead of throwing", () => {
    expect(dominantPaintState("XYZ")).toBe(0)
  })
})
