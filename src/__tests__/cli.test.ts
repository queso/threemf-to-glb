import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
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

// npm installs a bin as a symlink (`node_modules/.bin/threemf-to-glb -> ../threemf-to-glb/dist/cli.js`)
// and node leaves `process.argv[1]` as the unresolved symlink path. The entry-point guard in
// cli.ts compares that against `import.meta.url`, which node resolves to the real file, so a naive
// path comparison silently makes the installed CLI a no-op. This lays out a consumer's
// `node_modules` exactly as npm would (package dir with its own package.json, dist, a resolvable
// `fflate`, and the `.bin` symlink) and runs the compiled output under plain node through it.
describe("CLI invoked through a bin symlink under node", () => {
  const projectRoot = path.join(import.meta.dir, "..", "..")
  let dir: string
  let bin: string

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "threemf-cli-dist-"))
    const pkgDir = path.join(dir, "node_modules", "threemf-to-glb")
    const build = Bun.spawnSync(["bunx", "tsc", "--outDir", path.join(pkgDir, "dist")], {
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    })
    if (build.exitCode !== 0) {
      throw new Error(`tsc failed: ${build.stderr.toString()}${build.stdout.toString()}`)
    }
    writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ type: "module" }))
    symlinkSync(path.join(projectRoot, "node_modules"), path.join(pkgDir, "node_modules"))
    mkdirSync(path.join(dir, "node_modules", ".bin"))
    bin = path.join(dir, "node_modules", ".bin", "threemf-to-glb")
    symlinkSync(path.join("..", "threemf-to-glb", "dist", "cli.js"), bin)
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function runNode(args: string[]): { code: number; stderr: string } {
    const result = Bun.spawnSync(["node", bin, ...args], { stdout: "pipe", stderr: "pipe" })
    return { code: result.exitCode, stderr: result.stderr.toString() }
  }

  it("still runs main: exits non-zero with a usage message when arguments are missing", () => {
    const result = runNode([])
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain("usage:")
  })

  it("still runs main: converts a fixture and exits 0", () => {
    const input = path.join(dir, "input.3mf")
    const output = path.join(dir, "out.glb")
    writeFileSync(input, buildTwoPlateFixture())

    const result = runNode([input, output])
    expect(result.code).toBe(0)
    expect(existsSync(output)).toBe(true)
    expect(readFileSync(output).readUInt32LE(0)).toBe(0x46546c67)
  })
})
