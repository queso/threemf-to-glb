# Changelog

All notable changes to this project are documented in this file.

## [0.1.0] - 2026-09-17

### Added

- Initial extraction of `threemf-to-glb` from print-farm's in-app POC script
  (`scripts/threemf-to-glb.mjs`) into a standalone package.
- `convertThreemfToGlb(input, options?)`: pure library API, bytes in, GLB bytes out.
- `parseBambuMetadata(input)`: plates, filament colors, and the build-item -> component graph,
  without paying for a full geometry conversion.
- `decodePaint`, `encodePaint`, `paintStates`, `dominantPaintState`: the PrusaSlicer
  TriangleSelector RLE codec, ported once from print-farm's `lib/paint-rle.ts` and
  `app/poc/threemf/parse-bambu.ts` (previously duplicated because the original script couldn't
  import TypeScript).
- Typed errors: `ThreemfError`, `NotAZipError`, `MissingModelError`, `UnsupportedStructureError`.
- `threemf-to-glb` CLI: a thin fs wrapper over the library, matching the original script's argv
  contract (`<input.3mf> <output.glb>`), exits non-zero on failure, writes nothing on failure.
- Preserved the original script's selective-inflate memory behavior: only `*.model` files and the
  two `Metadata` config files are ever decompressed, regardless of what else the archive contains.
- Verified byte-identical output against the original script on synthetic fixtures and a real
  production reference file (with `{ generator: "print-farm threemf-to-glb POC" }`).
- The CLI's entry-point guard compares real paths, so it runs when invoked through the
  `node_modules/.bin` symlink npm installs (a plain path comparison made it a silent no-op there).
  Covered by a test that lays out a consumer `node_modules` and runs the compiled CLI under node.
