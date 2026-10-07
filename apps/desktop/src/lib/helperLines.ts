import type { Rect } from "./arrange";

/** One helper line: where it runs, how far (from the first tile on it to the
 * last, along the line), and whether it joins the centres of tiles (drawn
 * dotted and muted) or their edges. */
export interface Guide {
  at: number;
  from: number;
  to: number;
  center: boolean;
}

/** The helper lines of a drag, in canvas coordinates: vertical lines (tiles
 * line up horizontally) and horizontal ones. Every alignment that holds is
 * listed, not just the one that was snapped to. */
export interface Guides {
  vertical: Guide[];
  horizontal: Guide[];
}

export const NO_GUIDES: Guides = { vertical: [], horizontal: [] };

/** How close, in canvas pixels, an edge has to come before it snaps. */
export const SNAP_RADIUS = 6;

/** One axis: like with like — the dragged tile's two edges against every
 * other tile's two edges, and its centre against their centres. The closest
 * pair within `radius` decides where the tile lands; every pair that then
 * lines up exactly is a hit (same-sized tiles line up on both edges and the
 * centre at once). */
function snapAxis(start: number, size: number, others: Array<[start: number, size: number]>, radius: number) {
  const pairs: Array<{ offset: number; target: number; center: boolean; other: number }> = [];
  others.forEach(([otherStart, otherSize], other) => {
    for (const edge of [otherStart, otherStart + otherSize]) {
      pairs.push({ offset: 0, target: edge, center: false, other }, { offset: size, target: edge, center: false, other });
    }
    pairs.push({ offset: size / 2, target: otherStart + otherSize / 2, center: true, other });
  });
  let landed = start;
  let nearest = Infinity;
  for (const p of pairs) {
    const distance = Math.abs(start + p.offset - p.target);
    // `<` keeps the first of equally close pairs, and edges are listed before centres.
    if (distance <= radius && distance < nearest) {
      landed = p.target - p.offset;
      nearest = distance;
    }
  }
  const hits = pairs.filter((p) => Math.abs(landed + p.offset - p.target) < 0.5 && Math.abs(start + p.offset - p.target) <= radius);
  return { start: landed, hits };
}

/** The hits of one axis as lines: one per position and kind, reaching from
 * the dragged tile to the farthest tile it lines up with there. `across`
 * gives a tile's extent along the line. */
function lines(hits: ReturnType<typeof snapAxis>["hits"], moving: [number, number], across: (other: number) => [number, number]): Guide[] {
  const guides: Guide[] = [];
  for (const hit of hits) {
    const [start, size] = across(hit.other);
    const guide = guides.find((g) => g.at === hit.target && g.center === hit.center);
    if (guide) {
      guide.from = Math.min(guide.from, start);
      guide.to = Math.max(guide.to, start + size);
    } else {
      guides.push({ at: hit.target, center: hit.center, from: Math.min(moving[0], start), to: Math.max(moving[0] + moving[1], start + size) });
    }
  }
  return guides;
}

/** Where a dragged tile lands once it snaps to the tiles around it, and the
 * guides to draw for that. An axis with nothing within `radius` keeps the
 * tile's own position and gets no guide. */
export function snapToGuides(moving: Rect, others: Rect[], radius = SNAP_RADIUS): { x: number; y: number; guides: Guides } {
  const x = snapAxis(moving.x, moving.width, others.map((o) => [o.x, o.width]), radius);
  const y = snapAxis(moving.y, moving.height, others.map((o) => [o.y, o.height]), radius);
  return {
    x: x.start,
    y: y.start,
    guides: {
      vertical: lines(x.hits, [y.start, moving.height], (i) => [others[i].y, others[i].height]),
      horizontal: lines(y.hits, [x.start, moving.width], (i) => [others[i].x, others[i].width]),
    },
  };
}
