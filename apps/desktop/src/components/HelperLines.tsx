import { ViewportPortal, useViewport } from "@xyflow/react";
import type { Guide, Guides } from "../lib/helperLines";

/** The stretch at each end of a line over which it fades in — inside the
 * line, so it never reaches past the tiles it joins. Capped for short lines,
 * which keep a solid middle. */
const FADE = 72;

/** The alignment guides of a drag (`snapToGuides` in `lib/helperLines.ts`),
 * drawn inside a `<ReactFlow>`. They live in the viewport, so they are placed
 * in canvas coordinates and pan and zoom with the tiles. A line reaches from
 * the outer edge of the first tile on it to the outer edge of the last: full
 * strength between the tiles, fading to nothing by the time it gets there. */
export function HelperLines({ guides }: { guides: Guides }) {
  // Half a pixel on screen at any zoom (the browser draws at least one device
  // pixel), so the lines stay hairlines when the canvas is zoomed in.
  const thickness = 0.5 / useViewport().zoom;

  const line = (g: Guide, vertical: boolean) => {
    const along = vertical ? "to bottom" : "to right";
    const colour = g.center ? "var(--amp-color-dimmed)" : "var(--accent)";
    const length = g.to - g.from;
    const fade = Math.min(FADE, length * 0.4);
    // Eased, not linear: a straight ramp shows where it starts.
    const ramp = [0, 0.08, 0.3, 0.65, 1].map((alpha, i) => `rgba(0,0,0,${alpha}) ${(fade * i) / 4}px`);
    const mirrored = [1, 0.65, 0.3, 0.08, 0].map((alpha, i) => `rgba(0,0,0,${alpha}) calc(100% - ${(fade * (4 - i)) / 4}px)`);
    const mask = `linear-gradient(${along}, ${[...ramp, ...mirrored].join(", ")})`;
    return (
      <div
        key={`${vertical}${g.at}${g.center}`}
        className="pointer-events-none absolute"
        style={{
          ...(vertical ? { left: g.at, top: g.from, width: thickness, height: length } : { top: g.at, left: g.from, height: thickness, width: length }),
          // Edges solid accent; centres dotted, muted and fainter still.
          background: g.center ? `repeating-linear-gradient(${along}, ${colour} 0 2px, transparent 2px 6px)` : colour,
          opacity: g.center ? 0.4 : 0.8,
          maskImage: mask,
          WebkitMaskImage: mask,
        }}
      />
    );
  };

  return (
    <ViewportPortal>
      {guides.vertical.map((g) => line(g, true))}
      {guides.horizontal.map((g) => line(g, false))}
    </ViewportPortal>
  );
}
