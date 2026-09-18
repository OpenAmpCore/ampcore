import type { ReactNode } from "react";

import type { ResponsePoint } from "../lib/filterResponse";

/** The two FIR plots — magnitude response and impulse response — over the
 * coefficient array `FirPanel` reads with FC=43.
 *
 * Sizing follows `EqEditor`'s `ResponseGraph`: a fixed `viewBox` drawn at
 * `width:100%; height:auto` with a `minHeight` floor, so the chart scales with
 * its container without ever measuring it. Nothing here needs a ResizeObserver
 * or a bounded-height parent. */

const GRAPH_WIDTH = 1000;
const GRAPH_HEIGHT = 420;
/** Below this the fixed aspect ratio leaves a plot too short to read. The
 * viewBox letterboxes (default `xMidYMid meet`) rather than stretching, so the
 * curve keeps its true shape — same floor and reasoning as the EQ graph. */
const GRAPH_MIN_HEIGHT = 190;
const MID_Y = GRAPH_HEIGHT / 2;

const MIN_HZ = 20;
const MAX_HZ = 20000;
const GRID_FREQS_HZ = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const LOG_HZ_SPAN = Math.log10(MAX_HZ) - Math.log10(MIN_HZ);

/** Deliberately *not* the EQ graph's ±24 dB. A FIR stopband goes tens of dB
 * deeper than any parametric band can reach, so clamping at -24 would flatten
 * out exactly the rejection the filter exists to provide. Exported because the
 * curve builder needs the same value as its -Infinity floor — one source of
 * truth, or the curve would clip against an axis it doesn't match. */
export const FIR_MIN_DB = -60;
const FIR_MAX_DB = 12;
const GRID_DB = [-60, -48, -36, -24, -12, 0, 12];

/** Candidate millisecond grid spacings for the impulse axis, coarsened until
 * the axis holds at most 8 labels. A 512-tap buffer at 48 kHz spans ~10.6 ms
 * and lands on 2 ms. */
const MS_GRID_STEPS = [0.5, 1, 2, 5, 10, 20, 50];

function xForFreq(freqHz: number): number {
  const clamped = Math.min(MAX_HZ, Math.max(MIN_HZ, freqHz));
  const t = (Math.log10(clamped) - Math.log10(MIN_HZ)) / LOG_HZ_SPAN;
  return t * GRAPH_WIDTH;
}

function yForDb(db: number): number {
  const clamped = Math.min(FIR_MAX_DB, Math.max(FIR_MIN_DB, db));
  const t = (clamped - FIR_MIN_DB) / (FIR_MAX_DB - FIR_MIN_DB);
  return GRAPH_HEIGHT - t * GRAPH_HEIGHT;
}

function xForTap(index: number, tapCount: number): number {
  if (tapCount <= 1) return 0;
  return (index / (tapCount - 1)) * GRAPH_WIDTH;
}

function yForAmp(value: number, peak: number): number {
  return MID_Y - (value / peak) * MID_Y;
}

function freqLabel(hz: number): string {
  return hz >= 1000 ? `${hz / 1000}k` : String(hz);
}

function formatAmp(value: number): string {
  const abs = Math.abs(value);
  if (abs === 0) return "0";
  return abs >= 0.001 ? value.toFixed(3) : value.toExponential(1);
}

function msGridStep(totalMs: number): number {
  return MS_GRID_STEPS.find((step) => totalMs / step <= 8) ?? MS_GRID_STEPS[MS_GRID_STEPS.length - 1];
}

/** The shared SVG surface: fixed viewBox, fluid width, panel-matching radius. */
function GraphShell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <svg
      viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
      role="img"
      aria-label={label}
      // A surface, not a small control — matches the EQ graph's radius.
      className="rounded-lg"
      style={{
        backgroundColor: "var(--amp-color-dark-8)",
        display: "block",
        width: "100%",
        height: "auto",
        minHeight: GRAPH_MIN_HEIGHT,
      }}
    >
      {children}
    </svg>
  );
}

/** Magnitude response: dB against log frequency — the view that answers what
 * the filter actually does to the signal. */
export function FirFrequencyGraph({ points }: { points: ResponsePoint[] }) {
  const curve = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xForFreq(p.freqHz).toFixed(2)} ${yForDb(p.db).toFixed(2)}`)
    .join(" ");
  const zeroY = yForDb(0);

  return (
    <GraphShell label="FIR magnitude response">
      {GRID_FREQS_HZ.map((hz) => (
        <line
          key={hz}
          x1={xForFreq(hz)}
          x2={xForFreq(hz)}
          y1={0}
          y2={GRAPH_HEIGHT}
          stroke="var(--amp-color-dark-5)"
          strokeWidth={1}
        />
      ))}
      {GRID_DB.map((db) => (
        <line
          key={db}
          x1={0}
          x2={GRAPH_WIDTH}
          y1={yForDb(db)}
          y2={yForDb(db)}
          stroke="var(--amp-color-dark-5)"
          strokeWidth={1}
        />
      ))}
      <line x1={0} x2={GRAPH_WIDTH} y1={zeroY} y2={zeroY} stroke="var(--amp-color-dark-3)" strokeWidth={1} />
      <path d={curve} fill="none" stroke="var(--accent)" strokeWidth={2} />
      {GRID_FREQS_HZ.map((hz) => (
        <text key={hz} x={xForFreq(hz) + 3} y={GRAPH_HEIGHT - 4} fontSize={9} fill="var(--amp-color-dimmed)">
          {freqLabel(hz)}
        </text>
      ))}
      {GRID_DB.map((db) => (
        <text key={db} x={3} y={yForDb(db) - 3} fontSize={9} fill="var(--amp-color-dimmed)">
          {db > 0 ? `+${db}` : db}
        </text>
      ))}
    </GraphShell>
  );
}

/** Impulse response: the tap array plotted as-is, amplitude against time.
 *
 * The amplitude axis auto-scales symmetrically to the peak tap instead of
 * using a fixed range, because coefficient magnitude has no natural scale — a
 * smoothing filter's taps may all sit near 0.002, which any fixed range would
 * render as a flat line. */
export function FirImpulseGraph({
  taps,
  sampleRateHz,
  timeZeroIndex,
}: {
  taps: number[];
  sampleRateHz: number;
  timeZeroIndex: number;
}) {
  let peak = 0;
  for (const tap of taps) {
    const abs = Math.abs(tap);
    if (abs > peak) peak = abs;
  }
  // An all-zero array would divide by zero. It shouldn't reach here (an empty
  // channel holds a unit impulse) but the axis has to resolve regardless.
  if (peak === 0) peak = 1;

  const samplesPerMs = sampleRateHz / 1000;
  const totalMs = taps.length > 1 ? (taps.length - 1) / samplesPerMs : 0;
  const step = msGridStep(totalMs);
  const msMarks: number[] = [];
  for (let ms = 0; ms <= totalMs + 1e-9; ms += step) msMarks.push(Number(ms.toFixed(3)));

  const curve = taps
    .map((tap, i) => `${i === 0 ? "M" : "L"} ${xForTap(i, taps.length).toFixed(2)} ${yForAmp(tap, peak).toFixed(2)}`)
    .join(" ");
  const timeZeroX = xForTap(timeZeroIndex, taps.length);

  return (
    <GraphShell label="FIR impulse response">
      {msMarks.map((ms) => (
        <line
          key={ms}
          x1={xForTap(ms * samplesPerMs, taps.length)}
          x2={xForTap(ms * samplesPerMs, taps.length)}
          y1={0}
          y2={GRAPH_HEIGHT}
          stroke="var(--amp-color-dark-5)"
          strokeWidth={1}
        />
      ))}
      {[-1, -0.5, 0.5, 1].map((fraction) => (
        <line
          key={fraction}
          x1={0}
          x2={GRAPH_WIDTH}
          y1={yForAmp(peak * fraction, peak)}
          y2={yForAmp(peak * fraction, peak)}
          stroke="var(--amp-color-dark-5)"
          strokeWidth={1}
        />
      ))}
      <line x1={0} x2={GRAPH_WIDTH} y1={MID_Y} y2={MID_Y} stroke="var(--amp-color-dark-3)" strokeWidth={1} />
      {/* Zero-time marker — ties the plot to the zero-time stat in the header. */}
      <line
        x1={timeZeroX}
        x2={timeZeroX}
        y1={0}
        y2={GRAPH_HEIGHT}
        stroke="var(--amp-color-blue-5)"
        strokeWidth={1.5}
        strokeDasharray="4 3"
      />
      <text x={timeZeroX + 4} y={12} fontSize={9} fill="var(--amp-color-blue-5)">
        t0
      </text>
      <path d={curve} fill="none" stroke="var(--accent)" strokeWidth={1.5} />
      {msMarks.map((ms) => (
        <text
          key={ms}
          x={xForTap(ms * samplesPerMs, taps.length) + 3}
          y={GRAPH_HEIGHT - 4}
          fontSize={9}
          fill="var(--amp-color-dimmed)"
        >
          {`${ms} ms`}
        </text>
      ))}
      {[peak, 0, -peak].map((value) => (
        <text key={value} x={3} y={yForAmp(value, peak) - 3} fontSize={9} fill="var(--amp-color-dimmed)">
          {formatAmp(value)}
        </text>
      ))}
    </GraphShell>
  );
}
