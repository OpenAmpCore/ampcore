import { useLayoutEffect, useRef, useState } from "react";

/** Tracks a ref'd element's rendered content width in px, live across
 * resizes. `null` until the first measurement (nothing mounted yet, or a
 * `display: none` ancestor) — callers that need a number should fall back to
 * treating that the same as "no fixed size to measure yet".
 *
 * For elements whose width comes from flex/flow layout rather than a prop —
 * e.g. `ChannelLevelMeter`'s row meter, which is `flex: 1 1 0%` and has no
 * width known at render time — this is the only way to get a real
 * pixels-per-unit figure for something like limiter threshold collision
 * detection (see `buildLimiterThresholdVisuals`'s `pixelsPerDb`). */
export function useElementWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number | null] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;

    setWidth(node.getBoundingClientRect().width);

    const observer = new ResizeObserver(([entry]) => {
      setWidth(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}
