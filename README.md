# threemf-to-glb

Convert a Bambu Lab 3MF file into a glTF binary (`.glb`): geometry, `paint_color` triangle paint,
and plate layout, baked into a form a WebGL/Three.js viewer can load in milliseconds instead of
parsing tens of megabytes of XML on the client.

A pure library plus a thin CLI. No filesystem access in the library, no queue awareness, no
logging: bytes in, bytes out.

## What it does

Given a Bambu-exported `.3mf` (or a sliced `.gcode.3mf`), the converter reads:

- geometry from every referenced `3D/**/*.model` part
- `paint_color` triangle-paint strings (the PrusaSlicer TriangleSelector RLE format)
- plate membership and per-part extruders from `Metadata/model_settings.config`
- project filament colors from `Metadata/project_settings.config`

and bakes them into a single `.glb` scene graph.

### GLB conventions consumers rely on

- **Materials, not baked colors.** Geometry carries no per-vertex color. Every triangle's
  (area-dominant) filament state assigns it to a primitive whose material is named `filament_N`
  (`N` is the 1-based filament slot; unpainted triangles use their part's base extruder). A viewer
  recolors the entire model by setting a handful of material colors, no re-parse or geometry work
  required — this is what makes live AMS-mapping recolor possible.
- **`extras.plate` on build-item nodes.** Each top-level node wrapping a build item carries
  `{ plate: <plater_id> | null }` in its glTF `extras`, so a viewer can filter to one plate.
- **`extras.filamentColors` on the scene.** The scene's `extras.filamentColors` is the project's
  filament color array (hex strings, index 0 = filament slot 1), for the viewer's default palette
  before any AMS mapping is applied.
- **Shared meshes.** Two instances of the same source geometry (same object file, same object id,
  same base extruder, same negative-part flag) reference the same glTF mesh index. Placing the
  same part 60 times costs one mesh, not 60.
- **Z-up to Y-up.** 3MF is Z-up; the output wraps everything in one root node with the axis-swap
  matrix, so no consumer needs to know 3MF was ever Z-up.

## Memory behavior

A sliced `.gcode.3mf` carries plate gcode (can be hundreds of megabytes decompressed) and
thumbnail images right alongside the small set of XML files this converter actually needs. This
package inflates **only** the zip entries it reads: every `*.model` file plus the two `Metadata`
config files. Everything else in the archive is never decompressed, at any size. This property
exists because inflating everything OOM-killed a 512Mi container on a 58MB input in production;
`src/__tests__/memory.test.ts` proves it by shipping a fixture with a large, deliberately corrupt
"gcode" entry that would throw if it were ever inflated, and asserting conversion still succeeds.

## Install

```bash
npm install threemf-to-glb
# or
bun add threemf-to-glb
```

Only runtime dependency: [`fflate`](https://github.com/101arrowz/fflate).

## Library usage

```ts
import { readFileSync } from "node:fs"
import { convertThreemfToGlb, parseBambuMetadata, ThreemfError } from "threemf-to-glb"

const input = new Uint8Array(readFileSync("plate.3mf"))

try {
  const glb = convertThreemfToGlb(input)
  // glb: Uint8Array — write it, stream it, whatever you need.
} catch (err) {
  if (err instanceof ThreemfError) {
    // NotAZipError | MissingModelError | UnsupportedStructureError
    console.error(err.message)
  }
}

// Read plates / filament colors / the object graph without paying for a full conversion:
const meta = parseBambuMetadata(input)
console.log(meta.filamentColors, meta.plateByObjectId)
```

Also exported: `decodePaint`, `encodePaint`, `paintStates` (the PrusaSlicer TriangleSelector RLE
codec) and `dominantPaintState` (reduces one paint string to its area-dominant filament state).

### `convertThreemfToGlb(input, options?)`

```ts
type ConvertOptions = {
  /**
   * Override the glTF `asset.generator` string. Defaults to "threemf-to-glb". Pass
   * "print-farm threemf-to-glb POC" to reproduce the legacy script's output byte-for-byte
   * (see "Migrating from print-farm" below).
   */
  generator?: string
}
```

### Errors

All extend `ThreemfError`:

| Error | Thrown when |
|---|---|
| `NotAZipError` | the input bytes aren't a valid zip archive |
| `MissingModelError` | the archive has no `3D/3dmodel.model` entry |
| `UnsupportedStructureError` | `3D/3dmodel.model` has no `<object>` definitions and no `<item>` build entries |

## CLI usage

```bash
threemf-to-glb <input.3mf> <output.glb>
```

Exits non-zero with a one-line message on stderr on any failure, and writes nothing: a failed
conversion never leaves a partial or empty output file behind.

## Migrating from print-farm's `scripts/threemf-to-glb.mjs`

This package was extracted from print-farm's in-app POC script. To adopt it in print-farm's
`lib/glb-cache.ts`:

- Replace `generatorScript()`'s default
  (`path.join(process.cwd(), "scripts", "threemf-to-glb.mjs")`) with the path to this package's
  `dist/cli.js` (or keep pointing `POC_GLB_GENERATOR` at whichever copy you're testing against —
  `glb-cache.ts` already reads that env var at call time).
- The argv contract is unchanged: `node <generator> <resolved3mfPath> <tmpOutputPath>`, spawned
  with `--max-old-space-size=256` and a 180s timeout. This package's CLI satisfies that exactly.
- Runtime dependency is still only `fflate`; no other install changes needed.
- If you need byte-identical output against the old script (e.g. for a migration diff), pass
  `{ generator: "print-farm threemf-to-glb POC" }` to `convertThreemfToGlb` — see "Differences
  from the original script" below.

## Differences from the original script

The only behavioral difference from `print-farm/app/scripts/threemf-to-glb.mjs` is the default
`asset.generator` string in the output glTF JSON: this package defaults to `"threemf-to-glb"`
instead of `"print-farm threemf-to-glb POC"`. Everything else — geometry, paint-state bucketing,
material naming, node/extras layout, selective-inflate behavior, and byte layout of the GLB
container — is byte-for-byte identical, verified both on synthetic fixtures and on a real
production reference file (see Testing below). Pass `{ generator: "print-farm threemf-to-glb POC" }`
to `convertThreemfToGlb` to reproduce the legacy default exactly.

## Testing

```bash
bun run check   # typecheck + biome
bun test        # unit + structural GLB tests
```

A parity suite compares this package's output against the original print-farm script directly.
Since that script lives in a private, closed-source repo, the suite skips cleanly unless you point
it at a local checkout:

```bash
THREEMF_ORIGINAL_SCRIPT=/path/to/print-farm/app/scripts/threemf-to-glb.mjs bun test
```

## License

MIT
