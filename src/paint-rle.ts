/**
 * Bambu `paint_color` triangle-paint strings (PrusaSlicer TriangleSelector serialization,
 * hex-nibble packed).
 *
 * Format: the hex string is a nibble stream read from the LAST character to the first; each
 * nibble contributes its bits LSB->MSB. node := 2 bits split_sides; split_sides == 0 is a leaf
 * with 2 bits state (0b11 escapes to 4 more bits, real state = 3 + those); split_sides > 0
 * carries 2 bits special_side then split_sides+1 child nodes. State k paints filament slot k
 * (1-based); state 0 = unpainted (the triangle extrudes its part's base extruder).
 *
 * Ported from the print-farm prototyper's canonical decoder (lib/paint-rle.ts), which itself
 * reproduced Bambu Studio's own encoder byte-identically across a real painted model. This is
 * the single copy: nothing else in this package re-implements the format.
 */

export type PaintNode =
  | { kind: "leaf"; state: number }
  | { kind: "split"; splitSides: number; specialSide: number; children: PaintNode[] }

class Bits {
  bits: number[] = []
  pos = 0

  static fromHex(hexstr: string): Bits {
    const b = new Bits()
    for (let i = hexstr.length - 1; i >= 0; i--) {
      const v = Number.parseInt(hexstr[i], 16)
      if (Number.isNaN(v)) throw new Error(`bad hex nibble in paint string: ${hexstr[i]}`)
      b.bits.push(v & 1, (v >> 1) & 1, (v >> 2) & 1, (v >> 3) & 1)
    }
    return b
  }

  take(n: number): number {
    if (this.pos + n > this.bits.length) throw new Error("paint string truncated")
    let v = 0
    for (let i = 0; i < n; i++) {
      v |= this.bits[this.pos++] << i
    }
    return v
  }

  put(v: number, n: number): void {
    for (let i = 0; i < n; i++) this.bits.push((v >> i) & 1)
  }

  toHex(): string {
    const out: string[] = []
    for (let i = 0; i < this.bits.length; i += 4) {
      let nib = 0
      for (let j = 0; j < 4 && i + j < this.bits.length; j++) nib |= this.bits[i + j] << j
      out.push(nib.toString(16).toUpperCase())
    }
    return out.reverse().join("")
  }
}

/** Parse one paint string into its selector tree. Throws on malformed input. */
export function decodePaint(hexstr: string): PaintNode {
  const bs = Bits.fromHex(hexstr)
  function node(): PaintNode {
    const splitSides = bs.take(2)
    if (splitSides === 0) {
      let state = bs.take(2)
      if (state === 0b11) state = 3 + bs.take(4)
      return { kind: "leaf", state }
    }
    const specialSide = bs.take(2)
    const children: PaintNode[] = []
    for (let i = 0; i <= splitSides; i++) children.push(node())
    return { kind: "split", splitSides, specialSide, children }
  }
  const tree = node()
  // The stream is zero-padded to a whole nibble; any set trailing bit means we mis-parsed.
  for (let i = bs.pos; i < bs.bits.length; i++) {
    if (bs.bits[i] !== 0) throw new Error(`trailing bits in paint string ${hexstr}`)
  }
  return tree
}

/** Re-encode a selector tree (test round-trip harness; production only reads). */
export function encodePaint(tree: PaintNode): string {
  const bs = new Bits()
  function emit(n: PaintNode): void {
    if (n.kind === "leaf") {
      bs.put(0, 2)
      if (n.state < 3) {
        bs.put(n.state, 2)
      } else {
        bs.put(0b11, 2)
        bs.put(n.state - 3, 4)
      }
    } else {
      bs.put(n.splitSides, 2)
      bs.put(n.specialSide, 2)
      for (const c of n.children) emit(c)
    }
  }
  emit(tree)
  return bs.toHex()
}

/**
 * The set of leaf states in one paint string: painted slots are the states > 0 (state k ->
 * filament slot k, 1-based); state 0 present means the triangle has unpainted regions that
 * extrude the part's base extruder. Throws on malformed input: callers must degrade toward the
 * full filament list, never guess.
 */
export function paintStates(hexstr: string): Set<number> {
  const states = new Set<number>()
  const stack: PaintNode[] = [decodePaint(hexstr)]
  while (stack.length > 0) {
    const n = stack.pop()
    if (!n) break
    if (n.kind === "leaf") states.add(n.state)
    else stack.push(...n.children)
  }
  return states
}
