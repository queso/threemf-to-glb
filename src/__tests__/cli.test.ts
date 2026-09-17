import { describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildTwoPlateFixture, notAZip } from "./fixtures.js"

// Real process invocation, per this mission's testing philosophy: mocking fs/process here would
// verify the wrapper we wrote, not the CLI a consumer actually runs. `bun <file>.ts` executes the
// CLI's real argv/exit-code/file-write behavior; the exact "runs under plain node" contract is
// verified separately (see README) by building and running the compiled dist/cli.js.
const CLI = path.join(import.meta.dir, "..", "cli.ts")

function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["bun", CLI, ...args], { stdout: "pipe", stderr: "pipe" })
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

describe("CLI", () => {
  it("exits non-zero with a usage message when arguments are missing", () => {
    const result = runCli([])
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain("usage:")
  })

  it("exits non-zero with a one-line message and writes nothing for a missing input file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "threemf-cli-"))
    try {
      const output = path.join(dir, "out.glb")
      const result = runCli([path.join(dir, "nonexistent.3mf"), output])
      expect(result.code).not.toBe(0)
      expect(result.stderr.trim().split("\n")).toHaveLength(1)
      expect(existsSync(output)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("exits non-zero with a one-line message and writes nothing for a non-3MF input", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "threemf-cli-"))
    try {
      const input = path.join(dir, "not-a-zip.3mf")
      const output = path.join(dir, "out.glb")
      writeFileSync(input, notAZip())

      const result = runCli([input, output])
      expect(result.code).not.toBe(0)
      expect(result.stderr.trim().split("\n")).toHaveLength(1)
      expect(result.stderr).toContain("not a valid zip")
      expect(existsSync(output)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("writes a valid .glb and exits 0 on success, creating nested output directories", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "threemf-cli-"))
    try {
      const input = path.join(dir, "input.3mf")
      const output = path.join(dir, "nested", "deeper", "out.glb")
      writeFileSync(input, buildTwoPlateFixture())

      const result = runCli([input, output])
      expect(result.code).toBe(0)
      expect(existsSync(output)).toBe(true)

      const bytes = readFileSync(output)
      expect(bytes.readUInt32LE(0)).toBe(0x46546c67) // "glTF" magic
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
