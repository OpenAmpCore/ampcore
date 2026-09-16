import { useEffect, useMemo, useRef, useState } from "react";
import { Dropdown, Tooltip, dropdownVariants } from "@heroui/react";
import { CommitNumberInput } from "./CommitNumberInput";
import { SimpleSelect } from "./SimpleSelect";
import { buildBandResponseCurve, buildResponseCurve, type EqStageRef, type ResponsePoint } from "../lib/filterResponse";
import {
  type AmpAssignment,
  type AmpCapability_Serialize as AmpCapability,
  type ChannelEq,
  type CrossoverFilterType,
  type CrossoverSlotKind,
  type EqDirection,
  type EqFilterType,
} from "../lib/bindings";
import type { ConfigureActions } from "../lib/configureActions";

/** `filterType -> {supportsGain, supportsQ}` lookup, keyed for O(1) access —
 * built once from `AmpCapability.eqFilterCapabilities`, the backend-resolved
 * source of truth (`eq_filter_capabilities()` in
 * `src-tauri/src/data/capability/mod.rs`). Not hardcoded here: if a future
 * model/firmware ever needs a different gain/Q table, this stays correct
 * automatically, same as every other capability this app reads off
 * `AmpCapability` instead of assuming per-model.  */
function indexEqFilterCapabilities(
  entries: AmpCapability["eqFilterCapabilities"],
): Record<EqFilterType, { supportsGain: boolean; supportsQ: boolean }> {
  const map = {} as Record<EqFilterType, { supportsGain: boolean; supportsQ: boolean }>;
  for (const entry of entries) {
    map[entry.filterType] = { supportsGain: entry.supportsGain, supportsQ: entry.supportsQ };
  }
  return map;
}

/** `AmpChannel.inputEq`/`outputEq` are typed optional in TS (specta marks
 * any `#[serde(default = ...)]` field optional) even though the backend's
 * default constructor guarantees they're always populated. This fallback
 * mirrors that backend default (`default_channel_eq` in
 * `src-tauri/src/data/project.rs`) so the graph/editor never has to handle
 * a missing chain. */
const FALLBACK_CHANNEL_EQ: ChannelEq = {
  hp: { filterType: "butterworth12", freqHz: 20, active: false },
  bands: Array.from({ length: 8 }, () => ({
    filterType: "peaking" as EqFilterType,
    freqHz: 1000,
    gainDb: 0,
    q: 1,
    active: false,
  })),
  lp: { filterType: "butterworth12", freqHz: 20000, active: false },
};

const EQ_FILTER_LABELS: Record<EqFilterType, string> = {
  peaking: "Peaking",
  lowShelf: "Low Shelf",
  highShelf: "High Shelf",
  allPass1st: "All-Pass 1st",
  allPass2nd: "All-Pass 2nd",
  generalLow: "General LP",
  generalHigh: "General HP",
  butterworthLow: "Butterworth LP",
  butterworthHigh: "Butterworth HP",
  besselLow: "Bessel LP",
  besselHigh: "Bessel HP",
};

const CROSSOVER_FILTER_LABELS: Record<CrossoverFilterType, string> = {
  butterworth12: "BW-12",
  bessel12: "Bessel-12",
  linkwitzRiley12: "L-R 12",
  butterworth18: "BW-18",
  butterworth24: "BW-24",
  bessel24: "Bessel-24",
  linkwitzRiley24: "L-R 24",
  butterworth36: "BW-36",
  butterworth48: "BW-48",
  bessel48: "Bessel-48",
  linkwitzRiley48: "L-R 48",
};

const EQ_FILTER_OPTIONS = (Object.keys(EQ_FILTER_LABELS) as EqFilterType[]).map((value) => ({
  value,
  label: EQ_FILTER_LABELS[value],
}));
const CROSSOVER_FILTER_OPTIONS = (Object.keys(CROSSOVER_FILTER_LABELS) as CrossoverFilterType[]).map((value) => ({
  value,
  label: CROSSOVER_FILTER_LABELS[value],
}));

const GRAPH_WIDTH = 1000;
const GRAPH_HEIGHT = 420;
/** Shared cap so the graph and the band strip below it line up edge to
 * edge, rather than the graph (self-limited by its own aspect ratio) ending
 * up narrower than the full-width strip on large windows. */
const EDITOR_MAX_WIDTH = 1500;
const DROPDOWN_SLOTS = dropdownVariants();
/** Narrowest a band/crossover column can get before its inputs stop being
 * readable — the strip scrolls horizontally rather than going below it. */
const STRIP_MIN_WIDTH = 96;
const GRAPH_MIN_DB = -24;
const GRAPH_MAX_DB = 24;
const GRAPH_MIN_HZ = 20;
const GRAPH_MAX_HZ = 20000;
const GRID_FREQS_HZ = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const GRID_DB = [-24, -18, -12, -6, 0, 6, 12, 18, 24];
const LOG_HZ_SPAN = Math.log10(GRAPH_MAX_HZ) - Math.log10(GRAPH_MIN_HZ);

/** Q-drag pixel-to-Q sensitivity — ported from the old app's
 * `cvr-amp-controller-web` reference (`qDirection * deltaClientX * 0.02`),
 * which was tuned against its 800px-wide graph viewBox. That constant is
 * "ΔQ per raw client pixel," so holding it fixed on this app's wider
 * 1000px viewBox would make the same physical mouse drag cover a smaller
 * fraction of the chart — less sensitive, purely from geometry, not intent.
 * Rescaled by the viewBox width ratio so drag *feel* stays comparable:
 * 0.02 * (1000 / 800) = 0.025. */
const Q_DRAG_SENSITIVITY = 0.025;

function xForFreq(freqHz: number): number {
  const clamped = Math.min(GRAPH_MAX_HZ, Math.max(GRAPH_MIN_HZ, freqHz));
  const t = (Math.log10(clamped) - Math.log10(GRAPH_MIN_HZ)) / LOG_HZ_SPAN;
  return t * GRAPH_WIDTH;
}

function yForDb(db: number): number {
  const clamped = Math.min(GRAPH_MAX_DB, Math.max(GRAPH_MIN_DB, db));
  const t = (clamped - GRAPH_MIN_DB) / (GRAPH_MAX_DB - GRAPH_MIN_DB);
  return GRAPH_HEIGHT - t * GRAPH_HEIGHT;
}

/** Inverse of `xForFreq` — viewBox x (already clamped to the chart's plot
 * area) back to a frequency. */
function xToFreq(x: number): number {
  const t = Math.min(1, Math.max(0, x / GRAPH_WIDTH));
  return 10 ** (Math.log10(GRAPH_MIN_HZ) + t * LOG_HZ_SPAN);
}

/** Inverse of `yForDb`. */
function yToDb(y: number): number {
  const t = Math.min(1, Math.max(0, 1 - y / GRAPH_HEIGHT));
  return GRAPH_MIN_DB + t * (GRAPH_MAX_DB - GRAPH_MIN_DB);
}

/** Converts a pointer event's client coordinates into the SVG's internal
 * viewBox coordinate space — needed because the `<svg>` renders at
 * `width:100%; height:auto` against a fixed `viewBox`, so its on-screen
 * pixel size (hence the client<->viewBox ratio) varies with window width. */
function toViewBoxPoint(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } {
  const rect = svg.getBoundingClientRect();
  return {
    x: ((clientX - rect.left) / rect.width) * GRAPH_WIDTH,
    y: ((clientY - rect.top) / rect.height) * GRAPH_HEIGHT,
  };
}

function pathFor(points: ResponsePoint[]): string {
  return points.map((p, i) => `${i === 0 ? "M" : "L"} ${xForFreq(p.freqHz).toFixed(2)} ${yForDb(p.db).toFixed(2)}`).join(" ");
}

function freqLabel(hz: number): string {
  return hz >= 1000 ? `${hz / 1000}k` : String(hz);
}

/** Which of the 10 stages a `ref` and `b` name are the same one — `null`
 * only equals `null`. */
function sameStage(a: EqStageRef | null, b: EqStageRef | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "band" && b.kind === "band") return a.bandIndex === b.bandIndex;
  return true;
}

function stageKey(ref: EqStageRef): string {
  return ref.kind === "band" ? `band-${ref.bandIndex}` : ref.kind;
}

/** Resolved, always-defined view of one stage — coalesces `EqBand`'s/
 * `CrossoverSlot`'s nullable `freqHz`/`gainDb`/`q` with the same fallback
 * defaults used elsewhere in this file (`FALLBACK_CHANNEL_EQ`), and folds
 * in whether that stage even supports gain/Q at all. HP/LP are *structurally*
 * gain/Q-less (`CrossoverSlot` has no such fields — confirmed in
 * `bindings.ts`) — that's a hard fact of the type, not a capability lookup,
 * so it's hardcoded `false` here rather than routed through
 * `capsByType`, which only ever has entries for `EqFilterType`. */
function stageInfo(
  eq: ChannelEq,
  ref: EqStageRef,
  capsByType: Record<EqFilterType, { supportsGain: boolean; supportsQ: boolean }>,
): { freqHz: number; gainDb: number; q: number; active: boolean; supportsGain: boolean; supportsQ: boolean } {
  if (ref.kind === "band") {
    const band = eq.bands[ref.bandIndex];
    const caps = capsByType[band.filterType];
    return {
      freqHz: band.freqHz ?? 1000,
      gainDb: band.gainDb ?? 0,
      q: band.q ?? 1,
      active: band.active,
      supportsGain: caps.supportsGain,
      supportsQ: caps.supportsQ,
    };
  }
  const slot = ref.kind === "hp" ? eq.hp : eq.lp;
  return {
    freqHz: slot.freqHz ?? (ref.kind === "hp" ? GRAPH_MIN_HZ : GRAPH_MAX_HZ),
    gainDb: 0,
    q: 1,
    active: slot.active,
    supportsGain: false,
    supportsQ: false,
  };
}

/** Freq/gain/Q values a drag gesture is proposing, before they're rounded
 * and clamped on commit — `undefined` fields mean "unchanged by this
 * gesture" (e.g. an x-only drag never touches `gainDb`). */
type PreviewPatch = Partial<{ freqHz: number; gainDb: number; q: number }>;

/** Splices a preview patch into a `ChannelEq` immutably — the value
 * `ResponseGraph` and the strip below both render from during an in-progress
 * drag, before anything is actually written. */
function applyPreview(eq: ChannelEq, preview: { ref: EqStageRef; patch: PreviewPatch } | null): ChannelEq {
  if (!preview) return eq;
  const { ref, patch } = preview;
  if (ref.kind === "band") {
    const bands = eq.bands.slice();
    bands[ref.bandIndex] = { ...bands[ref.bandIndex], ...patch };
    return { ...eq, bands };
  }
  // CrossoverSlot has no gainDb/q fields — only freqHz can ever be previewed.
  const slot = ref.kind === "hp" ? eq.hp : eq.lp;
  const nextSlot = patch.freqHz !== undefined ? { ...slot, freqHz: patch.freqHz } : slot;
  return ref.kind === "hp" ? { ...eq, hp: nextSlot } : { ...eq, lp: nextSlot };
}

function roundFreq(hz: number): number {
  return Math.round(hz);
}
function roundGain(db: number): number {
  return Math.round(db * 10) / 10;
}
function roundQ(q: number): number {
  return Math.round(q * 100) / 100;
}
function clampToRange(value: number, range: { min: number | null; max: number | null }): number {
  let v = value;
  if (range.min != null) v = Math.max(range.min, v);
  if (range.max != null) v = Math.min(range.max, v);
  return v;
}

type ParamRange = { min: number | null; max: number | null };

type DragMode = "xy" | "x" | "y" | "qLeft" | "qRight";

type DragState = {
  pointerId: number;
  ref: EqStageRef;
  mode: DragMode;
  startClientX: number;
  startViewX: number;
  startViewY: number;
  startFreqHz: number;
  startGainDb: number;
  startQ: number;
};

/** Frequency-response graph — log-Hz x-axis, dB y-axis, one path built from
 * the real composite filter magnitude response (see `filterResponse.ts`).
 * Interactive: each of the 10 stages (HP, 8 parametric bands, LP) is a drag
 * handle when `interactive` — matching the old app's reference
 * (`components/monitor/amp-tabs/eq-curve-chart.tsx` in
 * `cvr-amp-controller-web`): a main dot for free XY drag (freq+gain), small
 * side handles for freq-only/gain-only drag, and (once selected) a pair of
 * Q-width handles. HP/LP only ever expose the main dot + freq handles — a
 * `CrossoverSlot` has no gain/Q to drag. Dragging never writes on every
 * pointer tick: `onPreview` reports a local-only proposed value every move,
 * `onCommit` fires once on release with the rounded/clamped final patch.
 *
 * Sizing matches the old app's reference: plain `width: 100%; height: auto`
 * against the `viewBox`'s intrinsic ratio — no `preserveAspectRatio="none"`,
 * no CSS `aspect-ratio`/`maxHeight` tricks, no flexbox contain-fit. SVG, not
 * Canvas: declarative, crisp at any DPI, trivial at ~800 points. */
function ResponseGraph({
  points,
  eq,
  capsByType,
  selectedRef,
  interactive,
  onSelectStage,
  onPreview,
  onCommit,
  onToggleActive,
  onResetGain,
  freqRange,
  gainRange,
  qRange,
}: {
  points: ResponsePoint[];
  eq: ChannelEq;
  capsByType: Record<EqFilterType, { supportsGain: boolean; supportsQ: boolean }>;
  selectedRef: EqStageRef | null;
  interactive: boolean;
  onSelectStage: (ref: EqStageRef | null) => void;
  onPreview: (ref: EqStageRef, patch: PreviewPatch) => void;
  onCommit: (ref: EqStageRef, patch: PreviewPatch) => void;
  onToggleActive: (ref: EqStageRef) => void;
  onResetGain: (ref: EqStageRef) => void;
  freqRange: ParamRange;
  gainRange: ParamRange;
  qRange: ParamRange;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [contextMenu, setContextMenu] = useState<{ ref: EqStageRef; x: number; y: number } | null>(null);
  const contextMenuAnchorRef = useRef<HTMLDivElement>(null);

  const zeroDbY = yForDb(0);
  const fillPath = `${pathFor(points)} L ${GRAPH_WIDTH} ${zeroDbY} L 0 ${zeroDbY} Z`;

  const stages: EqStageRef[] = [
    { kind: "hp" },
    ...eq.bands.map((_, i) => ({ kind: "band", bandIndex: i }) as const),
    { kind: "lp" },
  ];

  const isolatedCurve = useMemo(() => {
    if (!selectedRef) return null;
    const info = stageInfo(eq, selectedRef, capsByType);
    if (!info.active) return null;
    return buildBandResponseCurve(eq, selectedRef);
  }, [eq, selectedRef, capsByType]);

  function beginDrag(event: React.PointerEvent<SVGElement>, ref: EqStageRef, mode: DragMode) {
    if (!interactive) return;
    const info = stageInfo(eq, ref, capsByType);
    if (!info.active) return;
    if (mode === "y" && !info.supportsGain) return;
    if ((mode === "qLeft" || mode === "qRight") && !info.supportsQ) return;

    const svg = svgRef.current;
    if (!svg) return;
    event.preventDefault();
    event.stopPropagation();
    const vb = toViewBoxPoint(svg, event.clientX, event.clientY);

    dragRef.current = {
      pointerId: event.pointerId,
      ref,
      mode,
      startClientX: event.clientX,
      startViewX: vb.x,
      startViewY: vb.y,
      startFreqHz: info.freqHz,
      startGainDb: info.gainDb,
      startQ: info.q,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  /** First press on a not-yet-selected stage only selects it — a second
   * press on the now-selected stage's handle actually starts the drag. Stops
   * a stray touch from instantly moving a band you hadn't meant to grab. */
  function beginDragIfActivated(event: React.PointerEvent<SVGElement>, ref: EqStageRef, mode: DragMode) {
    if (event.button !== 0) return;
    if (!sameStage(selectedRef, ref)) {
      onSelectStage(ref);
      return;
    }
    beginDrag(event, ref, mode);
  }

  function handlePointerMove(event: React.PointerEvent<SVGSVGElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const info = stageInfo(eq, drag.ref, capsByType);
    const vb = toViewBoxPoint(event.currentTarget, event.clientX, event.clientY);

    if (drag.mode === "xy") {
      const patch: PreviewPatch = { freqHz: xToFreq(vb.x) };
      if (info.supportsGain) patch.gainDb = yToDb(vb.y);
      onPreview(drag.ref, patch);
      return;
    }
    if (drag.mode === "x") {
      const freqRatio = 10 ** (((vb.x - drag.startViewX) / GRAPH_WIDTH) * LOG_HZ_SPAN);
      onPreview(drag.ref, { freqHz: drag.startFreqHz * freqRatio });
      return;
    }
    if (drag.mode === "y") {
      if (!info.supportsGain) return;
      const gainDelta = ((drag.startViewY - vb.y) / GRAPH_HEIGHT) * (GRAPH_MAX_DB - GRAPH_MIN_DB);
      onPreview(drag.ref, { gainDb: drag.startGainDb + gainDelta });
      return;
    }
    // qLeft / qRight — mapped from raw client-pixel delta, not viewBox
    // distance, matching the reference's Q-drag (see Q_DRAG_SENSITIVITY).
    const deltaX = event.clientX - drag.startClientX;
    const qDirection = drag.mode === "qLeft" ? 1 : -1;
    onPreview(drag.ref, { q: drag.startQ + qDirection * deltaX * Q_DRAG_SENSITIVITY });
  }

  function endDrag(event: React.PointerEvent<SVGSVGElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;

    const info = stageInfo(eq, drag.ref, capsByType);
    const vb = toViewBoxPoint(event.currentTarget, event.clientX, event.clientY);
    const patch: PreviewPatch = {};

    if (drag.mode === "xy") {
      patch.freqHz = roundFreq(clampToRange(xToFreq(vb.x), freqRange));
      if (info.supportsGain) patch.gainDb = roundGain(clampToRange(yToDb(vb.y), gainRange));
    } else if (drag.mode === "x") {
      const freqRatio = 10 ** (((vb.x - drag.startViewX) / GRAPH_WIDTH) * LOG_HZ_SPAN);
      patch.freqHz = roundFreq(clampToRange(drag.startFreqHz * freqRatio, freqRange));
    } else if (drag.mode === "y" && info.supportsGain) {
      const gainDelta = ((drag.startViewY - vb.y) / GRAPH_HEIGHT) * (GRAPH_MAX_DB - GRAPH_MIN_DB);
      patch.gainDb = roundGain(clampToRange(drag.startGainDb + gainDelta, gainRange));
    } else if ((drag.mode === "qLeft" || drag.mode === "qRight") && info.supportsQ) {
      const deltaX = event.clientX - drag.startClientX;
      const qDirection = drag.mode === "qLeft" ? 1 : -1;
      patch.q = roundQ(clampToRange(drag.startQ + qDirection * deltaX * Q_DRAG_SENSITIVITY, qRange));
    }

    if (Object.keys(patch).length > 0) onCommit(drag.ref, patch);
    onSelectStage(drag.ref);
  }

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
        // A surface, not a small control — matches the radius of the filter
        // cards sitting under it rather than the small `--amp-radius-sm`.
        className="rounded-[var(--radius-lg)]"
        style={{
          backgroundColor: "var(--amp-color-dark-8)",
          display: "block",
          width: "100%",
          height: "auto",
          // Below ~430px wide the fixed 1000x420 aspect ratio would leave a
          // graph too short to aim at. The floor letterboxes the viewBox
          // (default `xMidYMid meet`) instead of stretching it, so the curve
          // keeps its true shape and `toViewBoxPoint` — which inverts the
          // live screen CTM — still maps drags correctly.
          minHeight: 190,
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          if (event.target === event.currentTarget) onSelectStage(null);
        }}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
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
        <line x1={0} x2={GRAPH_WIDTH} y1={zeroDbY} y2={zeroDbY} stroke="var(--amp-color-dark-3)" strokeWidth={1} />
        <path d={fillPath} fill="var(--amp-color-dark-4)" opacity={0.35} stroke="none" />
        <path d={pathFor(points)} fill="none" stroke="var(--accent)" strokeWidth={2} />
        {isolatedCurve && (
          <path
            d={pathFor(isolatedCurve)}
            fill="none"
            stroke="var(--amp-color-blue-5)"
            strokeWidth={1.5}
            strokeDasharray="4 3"
          />
        )}
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
        {stages.map((ref) => {
          const info = stageInfo(eq, ref, capsByType);
          if (!info.active) return null;
          const cx = xForFreq(info.freqHz);
          const cy = yForDb(info.gainDb);
          const selected = sameStage(selectedRef, ref);
          const label = ref.kind === "hp" ? "HP" : ref.kind === "lp" ? "LP" : String(ref.bandIndex + 1);
          const axisOffset = 14;
          const qFreqLeft = info.freqHz / Math.pow(2, 1 / Math.max(info.q, 0.1));
          const qFreqRight = info.freqHz * Math.pow(2, 1 / Math.max(info.q, 0.1));
          const qLeftX = xForFreq(qFreqLeft);
          const qRightX = xForFreq(qFreqRight);
          const mainCursor = interactive ? "grab" : "pointer";
          const axisCursor = interactive ? "ew-resize" : "default";
          const gainCursor = interactive ? "ns-resize" : "default";

          return (
            <g key={stageKey(ref)}>
              <circle
                cx={cx}
                cy={cy}
                r={16}
                fill="transparent"
                style={{ cursor: mainCursor }}
                onPointerDown={(e) => beginDragIfActivated(e, ref, "xy")}
                onContextMenu={(e) => {
                  if (!interactive) return;
                  e.preventDefault();
                  e.stopPropagation();
                  const rect = containerRef.current?.getBoundingClientRect();
                  setContextMenu({ ref, x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) });
                }}
              />
              <circle
                cx={cx}
                cy={cy}
                r={5}
                fill={selected ? "var(--accent-soft)" : "var(--amp-color-body)"}
                stroke={selected ? "var(--accent)" : "var(--amp-color-text)"}
                strokeWidth={1.5}
                pointerEvents="none"
              />
              {!selected && (
                <text x={cx} y={cy + 18} fontSize={11} textAnchor="middle" fill="var(--amp-color-text)" pointerEvents="none">
                  {label}
                </text>
              )}
              {selected && interactive && (
                <g>
                  <circle
                    cx={cx - axisOffset}
                    cy={cy}
                    r={8}
                    fill="transparent"
                    style={{ cursor: axisCursor }}
                    onPointerDown={(e) => beginDragIfActivated(e, ref, "x")}
                  />
                  <circle
                    cx={cx + axisOffset}
                    cy={cy}
                    r={8}
                    fill="transparent"
                    style={{ cursor: axisCursor }}
                    onPointerDown={(e) => beginDragIfActivated(e, ref, "x")}
                  />
                  <circle cx={cx - axisOffset} cy={cy} r={3} fill="var(--amp-color-body)" stroke="var(--accent)" strokeWidth={1} pointerEvents="none" />
                  <circle cx={cx + axisOffset} cy={cy} r={3} fill="var(--amp-color-body)" stroke="var(--accent)" strokeWidth={1} pointerEvents="none" />

                  {info.supportsGain && (
                    <>
                      <circle
                        cx={cx}
                        cy={cy - axisOffset}
                        r={8}
                        fill="transparent"
                        style={{ cursor: gainCursor }}
                        onPointerDown={(e) => beginDragIfActivated(e, ref, "y")}
                      />
                      <circle
                        cx={cx}
                        cy={cy + axisOffset}
                        r={8}
                        fill="transparent"
                        style={{ cursor: gainCursor }}
                        onPointerDown={(e) => beginDragIfActivated(e, ref, "y")}
                      />
                      <circle cx={cx} cy={cy - axisOffset} r={3} fill="var(--amp-color-body)" stroke="var(--accent)" strokeWidth={1} pointerEvents="none" />
                      <circle cx={cx} cy={cy + axisOffset} r={3} fill="var(--amp-color-body)" stroke="var(--accent)" strokeWidth={1} pointerEvents="none" />
                    </>
                  )}

                  {info.supportsQ && (
                    <>
                      <line x1={qLeftX} y1={cy} x2={qRightX} y2={cy} stroke="var(--amp-color-blue-5)" strokeWidth={1} opacity={0.5} />
                      <circle
                        cx={qLeftX}
                        cy={cy}
                        r={8}
                        fill="transparent"
                        style={{ cursor: axisCursor }}
                        onPointerDown={(e) => beginDragIfActivated(e, ref, "qLeft")}
                      />
                      <circle
                        cx={qRightX}
                        cy={cy}
                        r={8}
                        fill="transparent"
                        style={{ cursor: axisCursor }}
                        onPointerDown={(e) => beginDragIfActivated(e, ref, "qRight")}
                      />
                      <circle cx={qLeftX} cy={cy} r={2.6} fill="var(--amp-color-blue-5)" pointerEvents="none" />
                      <circle cx={qRightX} cy={cy} r={2.6} fill="var(--amp-color-blue-5)" pointerEvents="none" />
                    </>
                  )}
                </g>
              )}
            </g>
          );
        })}
      </svg>

      <div
        ref={contextMenuAnchorRef}
        style={{ position: "absolute", left: contextMenu?.x ?? 0, top: contextMenu?.y ?? 0, width: 1, height: 1 }}
      />
      {/* Slot classes passed explicitly: this menu is anchored to a bare ref
          rather than a `<Dropdown>` root, and without that root HeroUI's
          context lookup yields no classes at all — see the note beside
          `DROPDOWN_SLOTS` in `AmpConfigureView.tsx`. */}
      <Dropdown.Popover
        className={DROPDOWN_SLOTS.popover()}
        triggerRef={contextMenuAnchorRef}
        isOpen={contextMenu !== null}
        onOpenChange={(open) => !open && setContextMenu(null)}
        placement="bottom start"
      >
        <Dropdown.Menu
          className={DROPDOWN_SLOTS.menu()}
          onAction={(key) => {
            if (!contextMenu) return;
            if (key === "toggle") onToggleActive(contextMenu.ref);
            else if (key === "resetGain") onResetGain(contextMenu.ref);
            setContextMenu(null);
          }}
        >
          {contextMenu &&
            (() => {
              const info = stageInfo(eq, contextMenu.ref, capsByType);
              return (
                <>
                  <Dropdown.Item id="toggle">{info.active ? "Bypass" : "Enable"}</Dropdown.Item>
                  <Dropdown.Item id="resetGain" isDisabled={!info.supportsGain}>
                    Reset Gain
                  </Dropdown.Item>
                </>
              );
            })()}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </div>
  );
}

interface EqEditorProps {
  assignment: AmpAssignment;
  channelIndex: number;
  direction: EqDirection;
  capability: AmpCapability;
  actions: ConfigureActions;
}

/** Full EQ editor for one channel's 10-band chain (HP crossover + 8
 * parametric bands + LP crossover) — shared by the Input and Output tabs'
 * EQ sub-tabs. The graph (`ResponseGraph`) is the primary interactive
 * surface (drag to set freq/gain/Q, matching the old app's reference); the
 * strip of per-band controls below it is the precise-typed-value fallback,
 * not a competing editing mode — both read/write the same state and stay in
 * sync, including during an in-progress drag. Reads `channel.inputEq`/
 * `outputEq` per `direction`. `actions.setCrossoverSlot`/`setEqBand` are
 * optional — absent for a live-device source this phase (no EQ write
 * command exists yet), in which case the graph renders read-only (still
 * selectable, still shows the isolated per-band curve) and strip edits are
 * silently no-ops rather than sent anywhere. */
export function EqEditor({ assignment, channelIndex, direction, capability, actions }: EqEditorProps) {
  const channel = assignment.channels.find((c) => c.channelIndex === channelIndex) ?? assignment.channels[0];
  const eq = (direction === "input" ? channel.inputEq : channel.outputEq) ?? FALLBACK_CHANNEL_EQ;

  const eqCapsByType = useMemo(
    () => indexEqFilterCapabilities(capability.eqFilterCapabilities),
    [capability.eqFilterCapabilities],
  );

  const [selectedStage, setSelectedStage] = useState<EqStageRef | null>(null);
  const [preview, setPreview] = useState<{ ref: EqStageRef; patch: PreviewPatch } | null>(null);

  // Switching channel or direction (Input EQ <-> Output EQ) reuses the same
  // mounted component in some callers — clear transient selection/preview
  // rather than leave it pointing at a stage from the previous chain.
  useEffect(() => {
    setSelectedStage(null);
    setPreview(null);
  }, [channelIndex, direction]);

  const displayEq = useMemo(() => applyPreview(eq, preview), [eq, preview]);
  const points = useMemo(() => buildResponseCurve(displayEq), [displayEq]);

  const freqRange = capability.paramRanges.crossoverFreqHz;
  const gainRange = capability.paramRanges.eqBandGainDb;
  const qRange = capability.paramRanges.eqBandQ;

  const interactive = Boolean(actions.setEqBand && actions.setCrossoverSlot);

  async function handleCrossoverChange(
    slot: CrossoverSlotKind,
    patch: Partial<{ filterType: CrossoverFilterType; freqHz: number; active: boolean }>,
  ) {
    if (!actions.setCrossoverSlot) return;
    await actions.setCrossoverSlot(channelIndex, direction, slot, {
      filterType: patch.filterType ?? null,
      freqHz: patch.freqHz ?? null,
      active: patch.active ?? null,
    });
  }

  async function handleBandChange(
    bandIndex: number,
    patch: Partial<{ filterType: EqFilterType; freqHz: number; gainDb: number; q: number; active: boolean }>,
  ) {
    if (!actions.setEqBand) return;
    await actions.setEqBand(channelIndex, direction, bandIndex, {
      filterType: patch.filterType ?? null,
      freqHz: patch.freqHz ?? null,
      gainDb: patch.gainDb ?? null,
      q: patch.q ?? null,
      active: patch.active ?? null,
    });
  }

  function handlePreview(ref: EqStageRef, patch: PreviewPatch) {
    setPreview({ ref, patch });
  }

  async function handleCommit(ref: EqStageRef, patch: PreviewPatch) {
    if (ref.kind === "band") {
      await handleBandChange(ref.bandIndex, patch);
    } else {
      await handleCrossoverChange(ref.kind, patch);
    }
    setPreview(null);
  }

  function handleToggleActive(ref: EqStageRef) {
    const info = stageInfo(eq, ref, eqCapsByType);
    if (ref.kind === "band") void handleBandChange(ref.bandIndex, { active: !info.active });
    else void handleCrossoverChange(ref.kind, { active: !info.active });
  }

  function handleResetGain(ref: EqStageRef) {
    if (ref.kind !== "band") return;
    void handleBandChange(ref.bandIndex, { gainDb: 0 });
  }

  return (
    <div
      className="flex min-w-0 flex-col gap-4 p-4"
      style={{
        maxWidth: EDITOR_MAX_WIDTH,
        margin: "0 auto",
      }}
    >
      {!interactive && (
        <span
          style={{ fontSize: "var(--amp-font-size-xs)", color: "var(--amp-color-dimmed)", textAlign: "center" }}
        >
          Read-only — EQ can't be edited here right now. Click a band to select it (highlights its column below) and
          see its isolated response; freq, gain, and Q are display-only.
        </span>
      )}
      <ResponseGraph
        points={points}
        eq={displayEq}
        capsByType={eqCapsByType}
        selectedRef={selectedStage}
        interactive={interactive}
        onSelectStage={setSelectedStage}
        onPreview={handlePreview}
        onCommit={handleCommit}
        onToggleActive={handleToggleActive}
        onResetGain={handleResetGain}
        freqRange={freqRange}
        gainRange={gainRange}
        qRange={qRange}
      />
      {/* One column per band plus HP/LP. Equal `1fr` columns alone collapse
       * to unusable slivers on a narrow window (a 10-band EQ would give each
       * strip ~35px), so each column keeps a floor wide enough for its
       * `NumberInput`s and the strip scrolls sideways below that. */}
      <div className="min-w-0 overflow-x-auto">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${2 + displayEq.bands.length}, minmax(${STRIP_MIN_WIDTH}px, 1fr))`,
            gap: 8,
          }}
        >
          <CrossoverStrip
            label="HP"
            slot={displayEq.hp}
            freqMin={freqRange.min}
            freqMax={freqRange.max}
            selected={sameStage(selectedStage, { kind: "hp" })}
            onSelect={() => setSelectedStage({ kind: "hp" })}
            onChange={(patch) => handleCrossoverChange("hp", patch)}
          />
          {displayEq.bands.map((band, i) => (
            <BandStrip
              key={i}
              label={String(i + 1)}
              band={band}
              capsByType={eqCapsByType}
              freqMin={freqRange.min}
              freqMax={freqRange.max}
              gainMin={gainRange.min}
              gainMax={gainRange.max}
              qMin={qRange.min}
              qMax={qRange.max}
              selected={sameStage(selectedStage, { kind: "band", bandIndex: i })}
              onSelect={() => setSelectedStage({ kind: "band", bandIndex: i })}
              onChange={(patch) => handleBandChange(i, patch)}
            />
          ))}
          <CrossoverStrip
            label="LP"
            slot={displayEq.lp}
            freqMin={freqRange.min}
            freqMax={freqRange.max}
            selected={sameStage(selectedStage, { kind: "lp" })}
            onSelect={() => setSelectedStage({ kind: "lp" })}
            onChange={(patch) => handleCrossoverChange("lp", patch)}
          />
        </div>
      </div>
    </div>
  );
}

/** Bypass toggle for a crossover slot / band. Was a full-width
 * "Enabled"/"Bypassed" pill, which spent a whole 36px row and a lot of
 * contrast per column on what is a checkbox-weight decision — ten of them
 * across the strip were most of the visual noise. Now a single dot: filled
 * green when engaged, hollow and muted when bypassed. The word survives in
 * the tooltip so nothing is actually lost. */
function ActiveDotToggle({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <Tooltip delay={400}>
      <Tooltip.Trigger>
        <button
          type="button"
          onClick={onClick}
          className="flex h-5 w-full cursor-pointer appearance-none items-center justify-center border-0 bg-transparent p-0 font-inherit focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
          aria-pressed={active}
          aria-label={active ? "Enabled" : "Bypassed"}
        >
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              border: `1px solid ${active ? "var(--amp-color-green-6)" : "var(--amp-color-dimmed)"}`,
              background: active ? "var(--amp-color-green-6)" : "transparent",
            }}
          />
        </button>
      </Tooltip.Trigger>
      <Tooltip.Content showArrow>{active ? "Enabled — click to bypass" : "Bypassed — click to enable"}</Tooltip.Content>
    </Tooltip>
  );
}

/** Holds a row's vertical slot in columns whose filter type has no gain or
 * no Q (and in the crossover columns, which have neither), so every column
 * keeps the same row grid. Renders a faint middot rather than an empty
 * 36px void — the blank spacers read as a rendering fault. */
function EmptyParamSlot() {
  return (
    <div style={{ height: 36 }} className="flex items-center justify-center">
      <span
        className="opacity-40"
        style={{ fontSize: "var(--amp-font-size-sm)", color: "var(--amp-color-dimmed)" }}
      >
        &middot;
      </span>
    </div>
  );
}

function StripShell({
  label,
  selected,
  /** Bypassed stages recede so the two or three columns actually shaping the
   * signal are the ones that read first — previously all ten columns
   * competed at identical contrast. Selection always wins over dimming, so a
   * bypassed stage is fully legible the moment you click it, and hover
   * lifts it too. */
  dimmed,
  onSelect,
  children,
}: {
  label: string;
  selected: boolean;
  dimmed: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`flex min-w-0 flex-col gap-1 rounded-[var(--radius-lg)] border p-1.5 transition-opacity duration-150 ${
        dimmed && !selected ? "opacity-[0.55] hover:opacity-100" : ""
      }`}
      style={{
        borderColor: selected ? "var(--accent)" : "var(--amp-color-default-border)",
        background: selected ? "var(--accent-soft)" : undefined,
        cursor: "pointer",
      }}
      onClick={onSelect}
    >
      <span
        style={{
          fontSize: "var(--amp-font-size-sm)",
          fontWeight: 700,
          color: "var(--amp-color-dimmed)",
          textAlign: "center",
        }}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

function CrossoverStrip({
  label,
  slot,
  freqMin,
  freqMax,
  selected,
  onSelect,
  onChange,
}: {
  label: string;
  slot: { filterType: CrossoverFilterType; freqHz: number | null; active: boolean };
  freqMin: number | null;
  freqMax: number | null;
  selected: boolean;
  onSelect: () => void;
  onChange: (patch: Partial<{ filterType: CrossoverFilterType; freqHz: number; active: boolean }>) => void;
}) {
  return (
    <StripShell label={label} selected={selected} dimmed={!slot.active} onSelect={onSelect}>
      <SimpleSelect
        data={CROSSOVER_FILTER_OPTIONS}
        value={slot.filterType}
        onChange={(value) => value && onChange({ filterType: value as CrossoverFilterType })}
      />
      <CommitNumberInput
        suffix=" Hz"
        min={freqMin ?? undefined}
        max={freqMax ?? undefined}
        value={roundFreq(slot.freqHz ?? 0)}
        onCommit={(value) => onChange({ freqHz: value })}
      />
      {/* No gain/Q for crossover slots — Q is implied by filterType, never
       * user-settable (see CrossoverSlot in filterResponse.ts). */}
      <EmptyParamSlot />
      <EmptyParamSlot />
      <ActiveDotToggle active={slot.active} onClick={() => onChange({ active: !slot.active })} />
    </StripShell>
  );
}

function BandStrip({
  label,
  band,
  capsByType,
  freqMin,
  freqMax,
  gainMin,
  gainMax,
  qMin,
  qMax,
  selected,
  onSelect,
  onChange,
}: {
  label: string;
  band: { filterType: EqFilterType; freqHz: number | null; gainDb: number | null; q: number | null; active: boolean };
  capsByType: Record<EqFilterType, { supportsGain: boolean; supportsQ: boolean }>;
  freqMin: number | null;
  freqMax: number | null;
  gainMin: number | null;
  gainMax: number | null;
  qMin: number | null;
  qMax: number | null;
  selected: boolean;
  onSelect: () => void;
  onChange: (patch: Partial<{ filterType: EqFilterType; freqHz: number; gainDb: number; q: number; active: boolean }>) => void;
}) {
  const caps = capsByType[band.filterType];
  return (
    <StripShell label={label} selected={selected} dimmed={!band.active} onSelect={onSelect}>
      <SimpleSelect
        data={EQ_FILTER_OPTIONS}
        value={band.filterType}
        onChange={(value) => value && onChange({ filterType: value as EqFilterType })}
      />
      <CommitNumberInput
        suffix=" Hz"
        min={freqMin ?? undefined}
        max={freqMax ?? undefined}
        value={roundFreq(band.freqHz ?? 0)}
        onCommit={(value) => onChange({ freqHz: value })}
      />
      {caps.supportsGain ? (
        <CommitNumberInput
          suffix=" dB"
          step={0.5}
          min={gainMin ?? undefined}
          max={gainMax ?? undefined}
          value={roundGain(band.gainDb ?? 0)}
          onCommit={(value) => onChange({ gainDb: value })}
        />
      ) : (
        <EmptyParamSlot />
      )}
      {caps.supportsQ ? (
        <CommitNumberInput
          suffix=" Q"
          step={0.1}
          min={qMin ?? undefined}
          max={qMax ?? undefined}
          value={roundQ(band.q ?? 1)}
          onCommit={(value) => onChange({ q: value })}
        />
      ) : (
        <EmptyParamSlot />
      )}
      <ActiveDotToggle active={band.active} onClick={() => onChange({ active: !band.active })} />
    </StripShell>
  );
}
