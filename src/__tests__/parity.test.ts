import { describe, expect, it } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { convertThreemfToGlb } from "../convert.js"
import { buildMinimalFixture, buildTwoPlateFixture } from "./fixtures.js"

// This test compares our converter's output against the ORIGINAL print-farm script it was
// extracted from. It only runs when THREEMF_ORIGINAL_SCRIPT points at that script (an absolute
// path outside this repo, since real print-farm source is never checked in here), so a clean
// clone's `bun test` skips it cleanly instead of failing on a path that doesn't exist.
//
//   THREEMF_ORIGINAL_SCRIPT=/path/to/print-farm/app/scripts/threemf-to-glb.mjs bun test
const ORIGINAL_SCRIPT = process.env.THREEMF_ORIGINAL_SCRIPT

const FIXTURES: Record<string, () => Uint8Array> = {
  "two-plate, shared-mesh, multi-filament, one unpainted object": buildTwoPlateFixture,
  "minimal single object": buildMinimalFixture,
}

describe.skipIf(!ORIGINAL_SCRIPT)("parity with the original print-farm script", () => {
  for (const [name, build] of Object.entries(FIXTURES)) {
    it(`byte-identical output for: ${name}`, () => {
      const dir = mkdtempSync(path.join(tmpdir(), "threemf-to-glb-parity-"))
      try {
        const inputPath = path.join(dir, "input.3mf")
        const originalOutPath = path.join(dir, "original.glb")
        writeFileSync(inputPath, build())

        execFileSync("node", [ORIGINAL_SCRIPT as string, inputPath, originalOutPath], {
          stdio: "pipe",
        })
        const original = readFileSync(originalOutPath)

        // The legacy script's default generator string; passing it here is the one option this
        // package exposes specifically so this comparison can be truly byte-identical (see the
        // README's "Migrating from print-farm" section).
        const ours = convertThreemfToGlb(new Uint8Array(readFileSync(inputPath)), {
          generator: "print-farm threemf-to-glb POC",
        })

        expect(Buffer.compare(Buffer.from(ours), original)).toBe(0)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }
})
