/** One tile as the arranger sees it: where it is and how big. */
export interface Rect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Arrangement = "left" | "top" | "right" | "bottom" | "centerH" | "centerV" | "distributeH" | "distributeV" | "packH" | "packV";

/** The space Pack leaves between two tiles. */
export const PACK_GAP = 4;

/** New top-left positions for `rects` under one Align, Distribute or Pack, by
 * id. Align moves every tile to the selection's outer edge (or onto the middle
 * of its bounding box); Distribute keeps the two outermost tiles and gives the
 * ones between them equal gaps; Pack puts the tiles side by side (or one under
 * the other) in their current order, starting at the selection's top-left
 * corner. Fewer than two tiles (three to distribute) come back where they are. */
export function arrange(op: Arrangement, rects: Rect[]): Map<string, { x: number; y: number }> {
  const out = new Map(rects.map((r) => [r.id, { x: r.x, y: r.y }]));
  const distribute = op === "distributeH" || op === "distributeV";
  if (rects.length < (distribute ? 3 : 2)) return out;

  const left = Math.min(...rects.map((r) => r.x));
  const top = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));

  if (op === "packH" || op === "packV") {
    const horizontal = op === "packH";
    let at = horizontal ? left : top;
    for (const r of [...rects].sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y))) {
      out.set(r.id, horizontal ? { x: at, y: top } : { x: left, y: at });
      at += (horizontal ? r.width : r.height) + PACK_GAP;
    }
    return out;
  }

  if (distribute) {
    const horizontal = op === "distributeH";
    const start = (r: Rect) => (horizontal ? r.x : r.y);
    const size = (r: Rect) => (horizontal ? r.width : r.height);
    const sorted = [...rects].sort((a, b) => start(a) - start(b));
    const span = (horizontal ? right - left : bottom - top) - sorted.reduce((sum, r) => sum + size(r), 0);
    const gap = span / (sorted.length - 1);
    let at = horizontal ? left : top;
    for (const r of sorted) {
      out.set(r.id, horizontal ? { x: Math.round(at), y: r.y } : { x: r.x, y: Math.round(at) });
      at += size(r) + gap;
    }
    return out;
  }

  for (const r of rects) {
    out.set(r.id, {
      x: op === "left" ? left : op === "right" ? right - r.width : op === "centerH" ? Math.round((left + right - r.width) / 2) : r.x,
      y: op === "top" ? top : op === "bottom" ? bottom - r.height : op === "centerV" ? Math.round((top + bottom - r.height) / 2) : r.y,
    });
  }
  return out;
}
