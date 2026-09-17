/** Base class for every error this package throws. Catch this to handle all of them at once. */
export class ThreemfError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ThreemfError"
  }
}

/** The input bytes are not a valid zip archive, so they cannot be a 3MF file at all. */
export class NotAZipError extends ThreemfError {
  constructor(cause: string) {
    super(`input is not a valid zip archive: ${cause}`)
    this.name = "NotAZipError"
  }
}

/** The archive has no `3D/3dmodel.model` entry, so it is not a 3MF package. */
export class MissingModelError extends ThreemfError {
  constructor() {
    super("archive has no 3D/3dmodel.model entry")
    this.name = "MissingModelError"
  }
}

/**
 * The archive is a zip with a `3D/3dmodel.model` entry, but that entry's contents don't look
 * like a 3MF core model (no `<object>` definitions and no `<item>` build entries), so there is
 * nothing this converter can extract.
 */
export class UnsupportedStructureError extends ThreemfError {
  constructor(reason: string) {
    super(`unsupported 3MF structure: ${reason}`)
    this.name = "UnsupportedStructureError"
  }
}
