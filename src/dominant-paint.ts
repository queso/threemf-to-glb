import { decodePaint, type PaintNode } from "./paint-rle.js"

const dominantCache = new Map<string, number>()

/**
 * Reduce one `paint_color` string to its area-dominant filament state: split children share
 * area equally, and the state covering the most area wins. State 0 = unpainted (extrudes the
 * part's base extruder). A malformed paint string must not take a whole conversion down: it
 * resolves to state 0 (unpainted) instead of throwing.
 */
export function dominantPaintState(hex: string): number {
  const cached = dominantCache.get(hex)
  if (cached !== undefined) return cached

  const weights = new Map<number, number>()
  const walk = (n: PaintNode, w: number): void => {
    if (n.kind === "leaf") {
      weights.set(n.state, (weights.get(n.state) ?? 0) + w)
      return
    }
    for (const c of n.children) walk(c, w / n.children.length)
  }
  try {
    walk(decodePaint(hex), 1)
  } catch {
    dominantCache.set(hex, 0)
    return 0
  }

  let best = 0
  let bestW = -1
  for (const [state, w] of weights) {
    if (w > bestW) {
      best = state
      bestW = w
    }
  }
  dominantCache.set(hex, best)
  return best
}
