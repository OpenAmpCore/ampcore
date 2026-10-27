import { memo, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { ResponsePoint } from "../lib/filterResponse";

/** The one plot surface of the EQ and FIR editors: plain SVG drawn at the
 * container's real pixel size (a `ResizeObserver`, no `viewBox` scaling), so
 * text stays the same size in a narrow and a wide dialog, and every colour
 * and size is a token.
 *
 * Built for dragging at frame rate: the grid and axes only re-render when the
 * size or the axes change, and each curve is one `<path>` of straight
 * segments — core already samples densely, so no spline is needed (and a
 * spline overshoots at steep crossover slopes). */

export interface PlotPoint {
  x: number;
  y: number;
}

export interface PlotCurve {
  key: string;
  points: PlotPoint[];
  color: string;
  width?: number;
  dash?: string;
  opacity?: number;
  /** Shown in the hover readout; a curve without one isn't. */
  label?: string;
  className?: string;
}

export interface PlotAxis {
  min: number;
  max: number;
  log?: boolean;
  /** Labelled, solid grid lines. */
  ticks: number[];
  /** Unlabelled, fainter grid lines. */
  minorTicks?: number[];
  format: (value: number) => string;
}

/** Where things are drawn: `toX`/`toY` map values to SVG pixels, `fromX`/
 * `fromY` back; `plot` is the area inside the axes. */
export interface PlotScale {
  plot: { left: number; top: number; width: number; height: number };
  toX: (value: number) => number;
  toY: (value: number) => number;
  fromX: (px: number) => number;
  fromY: (px: number) => number;
}

const MARGIN = { left: 38, right: 12, top: 10, bottom: 22 };

const decadeMinors = (min: number, max: number) => {
  const marks: number[] = [];
  for (let decade = 10; decade < max; decade *= 10) {
    for (let k = 2; k <= 9; k++) {
      const hz = decade * k;
      if (hz > min && hz < max && ![20, 50, 200, 500, 2000, 5000].includes(hz)) marks.push(hz);
    }
  }
  return marks;
};

export const FREQ_AXIS: PlotAxis = {
  min: 20,
  max: 20000,
  log: true,
  ticks: [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000],
  minorTicks: decadeMinors(20, 20000),
  format: (hz) => (hz >= 1000 ? `${hz / 1000}k` : String(hz)),
};

export const formatDb = (db: number) => (db > 0 ? `+${db}` : String(db));

/** Core's response points as plot points. */
export const toPlotPoints = (points: ResponsePoint[]): PlotPoint[] => points.map((p) => ({ x: p.freqHz, y: p.db }));

function axisMap(axis: PlotAxis, from: number, to: number) {
  const t = (v: number) => (axis.log ? Math.log10(v) : v);
  const [a, b] = [t(axis.min), t(axis.max)];
  return {
    to: (v: number) => from + ((t(Math.min(axis.max, Math.max(axis.min, v))) - a) / (b - a)) * (to - from),
    from: (px: number) => {
      const v = a + ((px - from) / (to - from)) * (b - a);
      return axis.log ? 10 ** v : v;
    },
  };
}

function buildScale(width: number, height: number, x: PlotAxis, y: PlotAxis): PlotScale {
  const plot = {
    left: MARGIN.left,
    top: MARGIN.top,
    width: Math.max(1, width - MARGIN.left - MARGIN.right),
    height: Math.max(1, height - MARGIN.top - MARGIN.bottom),
  };
  const xs = axisMap(x, plot.left, plot.left + plot.width);
  const ys = axisMap(y, plot.top + plot.height, plot.top);
  return { plot, toX: xs.to, toY: ys.to, fromX: xs.from, fromY: ys.from };
}

const LABEL_STYLE = { fontSize: "var(--amp-font-size-xs)", fill: "var(--amp-color-dimmed)" } as const;

const Grid = memo(function Grid({ scale, x, y }: { scale: PlotScale; x: PlotAxis; y: PlotAxis }) {
  const { plot } = scale;
  const bottom = plot.top + plot.height;
  const right = plot.left + plot.width;
  return (
    <g pointerEvents="none">
      {x.minorTicks?.map((v) => (
        <line key={`xm${v}`} x1={scale.toX(v)} x2={scale.toX(v)} y1={plot.top} y2={bottom} stroke="var(--amp-graph-grid-minor)" />
      ))}
      {y.minorTicks?.map((v) => (
        <line key={`ym${v}`} x1={plot.left} x2={right} y1={scale.toY(v)} y2={scale.toY(v)} stroke="var(--amp-graph-grid-minor)" strokeDasharray="2 4" />
      ))}
      {x.ticks.map((v) => (
        <g key={`x${v}`}>
          <line x1={scale.toX(v)} x2={scale.toX(v)} y1={plot.top} y2={bottom} stroke="var(--amp-graph-grid-major)" strokeOpacity={0.55} />
          <text x={scale.toX(v)} y={bottom + 15} textAnchor="middle" style={LABEL_STYLE}>
            {x.format(v)}
          </text>
        </g>
      ))}
      {y.ticks.map((v) => (
        <g key={`y${v}`}>
          <line
            x1={plot.left}
            x2={right}
            y1={scale.toY(v)}
            y2={scale.toY(v)}
            stroke="var(--amp-graph-grid-major)"
            strokeOpacity={v === 0 ? 1 : 0.55}
          />
          <text x={plot.left - 6} y={scale.toY(v)} textAnchor="end" dominantBaseline="central" style={LABEL_STYLE}>
            {y.format(v)}
          </text>
        </g>
      ))}
    </g>
  );
});

/** A curve's `d` — also what a drag writes straight to the path. */
export function pathD(points: PlotPoint[], scale: PlotScale): string {
  let path = "";
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    path += `${i === 0 ? "M" : "L"}${scale.toX(p.x).toFixed(1)} ${scale.toY(p.y).toFixed(1)}`;
  }
  return path;
}

const Curve = memo(function Curve({ curve, scale }: { curve: PlotCurve; scale: PlotScale }) {
  const d = useMemo(() => pathD(curve.points, scale), [curve.points, scale]);
  return (
    <path
      data-curve={curve.key}
      className={curve.className}
      d={d}
      fill="none"
      stroke={curve.color}
      strokeWidth={curve.width ?? 2}
      strokeDasharray={curve.dash}
      strokeOpacity={curve.opacity}
      strokeLinejoin="round"
      pointerEvents="none"
    />
  );
});

/** The point of `points` (sorted by x) nearest to `x`. */
function nearest(points: PlotPoint[], x: number): PlotPoint | undefined {
  let lo = 0;
  let hi = points.length - 1;
  if (hi < 0) return undefined;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].x < x) lo = mid;
    else hi = mid;
  }
  return Math.abs(points[lo].x - x) <= Math.abs(points[hi].x - x) ? points[lo] : points[hi];
}

/** The hover cursor and readout, in HTML over the plot with state of its own,
 * so moving the mouse re-renders only this — not the curves or the overlay.
 * Hidden while a button is held: that is a drag, not a look. */
function HoverReadout({
  box,
  scale,
  x,
  curves,
  width,
  format,
}: {
  box: React.RefObject<HTMLDivElement | null>;
  scale: PlotScale;
  x: PlotAxis;
  curves: PlotCurve[];
  width: number;
  format: (value: number) => string;
}) {
  const [px, setPx] = useState<number | null>(null);
  const { plot } = scale;
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const move = (event: PointerEvent) => {
      if (event.buttons !== 0) return setPx(null);
      const at = event.clientX - element.getBoundingClientRect().left;
      setPx(at >= plot.left && at <= plot.left + plot.width ? at : null);
    };
    const leave = () => setPx(null);
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerleave", leave);
    return () => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerleave", leave);
    };
  }, [box, plot.left, plot.width]);

  if (px === null) return null;
  const value = scale.fromX(px);
  const labelled = curves.filter((c) => c.label);
  return (
    <>
      <div
        className="pointer-events-none absolute w-px"
        style={{ left: px, top: plot.top, height: plot.height, background: "var(--amp-color-text)", opacity: 0.35 }}
      />
      {labelled.length > 0 && (
        <div
          className="pointer-events-none absolute z-10 rounded-lg border px-2.5 py-1.5 tabular-nums shadow-sm"
          style={{
            top: plot.top + 6,
            left: px + 160 > width ? px - 150 : px + 10,
            width: 140,
            background: "var(--amp-graph-tip-bg)",
            borderColor: "var(--amp-graph-tip-border)",
            fontSize: "var(--amp-font-size-xs)",
          }}
        >
          <div className="font-semibold">{x.log ? `${Math.round(value)} Hz` : x.format(value)}</div>
          {labelled.map((curve) => {
            const point = nearest(curve.points, value);
            return (
              point && (
                <div key={curve.key} className="flex justify-between gap-2">
                  <span style={{ color: curve.color }}>{curve.label}</span>
                  <span>{format(point.y)}</span>
                </div>
              )
            );
          })}
        </div>
      )}
    </>
  );
}

export function FrequencyPlot({
  x = FREQ_AXIS,
  y,
  curves,
  overlay,
  className,
  ariaLabel,
  readoutFormat = (v) => `${v.toFixed(1)} dB`,
}: {
  x?: PlotAxis;
  y: PlotAxis;
  curves: PlotCurve[];
  /** Drawn above the curves with the plot's scale — the EQ's handles. */
  overlay?: (scale: PlotScale) => ReactNode;
  /** Size and frame come from the caller (a height, border, radius). */
  className?: string;
  ariaLabel: string;
  readoutFormat?: (value: number) => string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const scale = useMemo(() => buildScale(size.width, size.height, x, y), [size, x, y]);

  return (
    <div ref={box} className={`relative ${className ?? ""}`} style={{ backgroundColor: "var(--amp-graph-bg)" }}>
      {size.width > 0 && (
        <svg
          width={size.width}
          height={size.height}
          role="img"
          aria-label={ariaLabel}
          className="absolute inset-0 block select-none"
        >
          <Grid scale={scale} x={x} y={y} />
          {curves.map((curve) => (
            <Curve key={curve.key} curve={curve} scale={scale} />
          ))}
          {overlay?.(scale)}
        </svg>
      )}
      {size.width > 0 && <HoverReadout box={box} scale={scale} x={x} curves={curves} width={size.width} format={readoutFormat} />}
    </div>
  );
}
