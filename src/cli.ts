#!/usr/bin/env node
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { convertThreemfToGlb } from "./convert.js"
import { ThreemfError } from "./errors.js"

export function main(argv: string[]): number {
  const [input, output] = argv
  if (!input || !output) {
    console.error("usage: threemf-to-glb <input.3mf> <output.glb>")
    return 1
  }

  let inputBytes: Uint8Array
  try {
    inputBytes = new Uint8Array(readFileSync(input))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`threemf-to-glb: could not read ${input}: ${message}`)
    return 1
  }

  let glb: Uint8Array
  try {
    glb = convertThreemfToGlb(inputBytes)
  } catch (err) {
    const message = err instanceof ThreemfError ? err.message : String(err)
    console.error(`threemf-to-glb: ${message}`)
    return 1
  }

  // Only write once conversion has fully succeeded: a failure above leaves no output file at all.
  mkdirSync(path.dirname(output), { recursive: true })
  writeFileSync(output, glb)
  return 0
}

// Only run as a side effect when this file is the actual entry point (a real `node dist/cli.js`
// invocation, or a direct `bun src/cli.ts` run), never when a test imports `main` to call it
// in-process.
//
// Compare real paths on both sides. npm installs the bin as a symlink
// (`node_modules/.bin/threemf-to-glb -> ../threemf-to-glb/dist/cli.js`) and node keeps
// `process.argv[1]` as the unresolved symlink while `import.meta.url` is the resolved file, so a
// plain string comparison makes every installed CLI a silent no-op.
function isEntryPoint(): boolean {
  const invoked = process.argv[1]
  if (!invoked) return false
  try {
    return realpathSync(path.resolve(invoked)) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  process.exit(main(process.argv.slice(2)))
}
