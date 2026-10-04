import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dropdown, Tooltip, dropdownVariants } from "@heroui/react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  usePlotArea,
  useXAxisInverseScale,
  useXAxisScale,
  useYAxisInverseScale,
  useYAxisScale,
  XAxis,
  YAxis,
} from "recharts";
import { ClipboardButtons } from "./ClipboardButtons";
import { CommitNumberInput } from "./CommitNumberInput";
import { SimpleSelect } from "./SimpleSelect";
import { useResponseCurve, type EqStageRef } from "../lib/filterResponse";
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
const GRAPH_FREQ_TICKS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
/** Space the chart reserves around its plot area: the y-axis labels on the
 * left, the x-axis labels at the bottom, a little air on top and right. */
const PLOT_LEFT = 32;
const PLOT_BOTTOM = 20;
const PLOT_TOP = 22;
const PLOT_RIGHT = 8;
/** Dashed minor grid lines every 2 dB; the solid major ones sit on the ticks. */
const GRAPH_DB_MINOR = Array.from({ length: 25 }, (_, i) => -24 + i * 2).filter((db) => db % 6 !== 0);
const GRAPH_DB_TICKS = [-24, -18, -12, -6, 0, 6, 12, 18, 24];
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

/** Converts a pointer event's client coordinates into the chart SVG's own
 * coordinate space (the one Recharts' scales and the handles use). */
function toViewBoxPoint(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } {
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const point = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
  return { x: point.x, y: point.y };
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

/** One row of the chart: the whole chain's response and, when a stage is
 * selected, that stage on its own. */
type GraphRow = { f: number; total: number; stage: number | null };

function freqText(hz: number): string {
  return hz >= 1000 ? `${(hz / 1000).toFixed(2)} kHz` : `${Math.round(hz)} Hz`;
}

/** The hover readout: frequency, the chain's level there and, with a stage
 * selected, that stage's. Recharts hands it the hovered row. */
function GraphTooltip({
  active,
  payload,
  stageLabel,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: unknown }>;
  stageLabel: string | null;
}) {
  const row = payload?.[0]?.payload as GraphRow | undefined;
  if (!active || !row) return null;
  return (
    <div
      className="rounded-lg border"
      style={{
        background: "var(--amp-graph-tip-bg)",
        borderColor: "var(--amp-graph-tip-border)",
        color: "var(--amp-color-text)",
        padding: "8px 12px",
        fontSize: 12,
        lineHeight: 1.6,
      }}
    >
      <div className="font-semibold">{freqText(row.f)}</div>
      <div style={{ color: "var(--accent)" }}>Total: {row.total.toFixed(1)} dB</div>
      {stageLabel && row.stage !== null && (
        <div style={{ color: "var(--amp-graph-stage)" }}>
          {stageLabel}: {row.stage.toFixed(1)} dB
        </div>
      )}
    </div>
  );
}

/** Points asked of core per curve: few while a handle moves, so every frame is
 * cheap, and enough at rest for the steepest slopes to look smooth. */
const DRAG_CURVE_POINTS = 120;
const REST_CURVE_POINTS = 360;

/** The draggable handles of the 10 stages (HP, 8 parametric bands, LP), drawn
 * inside the chart so Recharts' own scales place them: a main dot for free XY
 * drag (freq+gain), small side handles for freq-only/gain-only drag, and (once
 * selected) a pair of Q-width handles — matching the old app's reference
 * (`components/monitor/amp-tabs/eq-curve-chart.tsx` in `cvr-amp-controller-web`).
 * HP/LP only ever expose the main dot + freq handles — a `CrossoverSlot` has no
 * gain/Q to drag.
 *
 * Dragging never writes on every pointer tick: a preview is reported at most
 * once per animation frame (a mouse can poll faster than the screen redraws),
 * and `onCommit` fires once on release with the rounded/clamped final patch. */
function StageHandles({
  eq,
  capsByType,
  selectedRef,
  interactive,
  onSelectStage,
  onPreview,
  onCommit,
  onDraggingChange,
  onStageMenu,
  freqRange,
  gainRange,
  qRange,
}: {
  eq: ChannelEq;
  capsByType: Record<EqFilterType, { supportsGain: boolean; supportsQ: boolean }>;
  selectedRef: EqStageRef | null;
  interactive: boolean;
  onSelectStage: (ref: EqStageRef | null) => void;
  onPreview: (ref: EqStageRef, patch: PreviewPatch) => void;
  onCommit: (ref: EqStageRef, patch: PreviewPatch) => void;
  onDraggingChange: (dragging: boolean) => void;
  onStageMenu: (ref: EqStageRef, clientX: number, clientY: number) => void;
  freqRange: ParamRange;
  gainRange: ParamRange;
  qRange: ParamRange;
}) {
  const xScale = useXAxisScale();
  const yScale = useYAxisScale();
  const xInverse = useXAxisInverseScale();
  const yInverse = useYAxisInverseScale();
  const plot = usePlotArea();
  const dragRef = useRef<DragState | null>(null);
  const frameRef = useRef(0);
  const pendingRef = useRef<{ ref: EqStageRef; patch: PreviewPatch } | null>(null);
  useEffect(() => () => cancelAnimationFrame(frameRef.current), []);
  if (!xScale || !yScale || !xInverse || !yInverse || !plot) return null;

  const toX = (hz: number) => xScale(hz) ?? 0;
  const toY = (db: number) => yScale(db) ?? 0;
  const xToFreq = (x: number) => Math.min(GRAPH_MAX_HZ, Math.max(GRAPH_MIN_HZ, Number(xInverse(x)) || GRAPH_MIN_HZ));
  const yToDb = (y: number) => Math.min(GRAPH_MAX_DB, Math.max(GRAPH_MIN_DB, Number(yInverse(y)) || 0));

  const stages: EqStageRef[] = [
    { kind: "hp" },
    ...eq.bands.map((_, i) => ({ kind: "band", bandIndex: i }) as const),
    { kind: "lp" },
  ];

  /** The patch a drag proposes at `vb` (the pointer, in chart pixels). */
  function patchFor(drag: DragState, vb: { x: number; y: number }, clientX: number): PreviewPatch {
    const info = stageInfo(eq, drag.ref, capsByType);
    if (drag.mode === "xy") {
      const patch: PreviewPatch = { freqHz: xToFreq(vb.x) };
      if (info.supportsGain) patch.gainDb = yToDb(vb.y);
      return patch;
    }
    if (drag.mode === "x") {
      return { freqHz: drag.startFreqHz * 10 ** (((vb.x - drag.startViewX) / plot!.width) * LOG_HZ_SPAN) };
    }
    if (drag.mode === "y") {
      if (!info.supportsGain) return {};
      const gainDelta = ((drag.startViewY - vb.y) / plot!.height) * (GRAPH_MAX_DB - GRAPH_MIN_DB);
      return { gainDb: drag.startGainDb + gainDelta };
    }
    // qLeft / qRight — mapped from raw client-pixel delta, not chart distance,
    // matching the reference's Q-drag (see Q_DRAG_SENSITIVITY).
    if (!info.supportsQ) return {};
    const qDirection = drag.mode === "qLeft" ? 1 : -1;
    return { q: drag.startQ + qDirection * (clientX - drag.startClientX) * Q_DRAG_SENSITIVITY };
  }

  function beginDrag(event: React.PointerEvent<SVGElement>, ref: EqStageRef, mode: DragMode) {
    if (!interactive) return;
    const info = stageInfo(eq, ref, capsByType);
    if (!info.active) return;
    if (mode === "y" && !info.supportsGain) return;
    if ((mode === "qLeft" || mode === "qRight") && !info.supportsQ) return;

    const svg = event.currentTarget.ownerSVGElement;
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
    onDraggingChange(true);
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

  function handlePointerMove(event: React.PointerEvent<SVGGElement>) {
    const drag = dragRef.current;
    const svg = event.currentTarget.ownerSVGElement;
    if (!drag || !svg || drag.pointerId !== event.pointerId) return;
    pendingRef.current = {
      ref: drag.ref,
      patch: patchFor(drag, toViewBoxPoint(svg, event.clientX, event.clientY), event.clientX),
    };
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending) onPreview(pending.ref, pending.patch);
    });
  }

  function endDrag(event: React.PointerEvent<SVGGElement>) {
    const drag = dragRef.current;
    const svg = event.currentTarget.ownerSVGElement;
    if (!drag || !svg || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
    pendingRef.current = null;
    onDraggingChange(false);

    const info = stageInfo(eq, drag.ref, capsByType);
    const proposed = patchFor(drag, toViewBoxPoint(svg, event.clientX, event.clientY), event.clientX);
    const patch: PreviewPatch = {};
    if (proposed.freqHz !== undefined) patch.freqHz = roundFreq(clampToRange(proposed.freqHz, freqRange));
    if (proposed.gainDb !== undefined && info.supportsGain) patch.gainDb = roundGain(clampToRange(proposed.gainDb, gainRange));
    if (proposed.q !== undefined && info.supportsQ) patch.q = roundQ(clampToRange(proposed.q, qRange));

    if (Object.keys(patch).length > 0) onCommit(drag.ref, patch);
    onSelectStage(drag.ref);
  }

  return (
    <g onPointerMove={handlePointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
      {stages.map((ref) => {
        const info = stageInfo(eq, ref, capsByType);
        if (!info.active) return null;
        const cx = toX(info.freqHz);
        const cy = toY(info.gainDb);
        const selected = sameStage(selectedRef, ref);
        const label = ref.kind === "hp" ? "HP" : ref.kind === "lp" ? "LP" : String(ref.bandIndex + 1);
        const axisOffset = 14;
        const qFreqLeft = info.freqHz / Math.pow(2, 1 / Math.max(info.q, 0.1));
        const qFreqRight = info.freqHz * Math.pow(2, 1 / Math.max(info.q, 0.1));
        const qLeftX = toX(qFreqLeft);
        const qRightX = toX(qFreqRight);
        const mainCursor = interactive ? "grab" : "pointer";
        const axisCursor = interactive ? "ew-resize" : "default";
        const gainCursor = interactive ? "ns-resize" : "default";

        return (
          <g key={stageKey(ref)} data-eq-handle>
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
                onStageMenu(ref, e.clientX, e.clientY);
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
    </g>
  );
}

/** Frequency-response graph, drawn entirely by Recharts: log-Hz x-axis, dB
 * y-axis, the whole chain's response (from core, see `filterResponse.ts`), the
 * selected stage on its own, and a hover readout. `StageHandles` sits inside
 * the chart for the interaction. The graph fills the height its dialog leaves;
 * `ResponsiveContainer` follows the box. */
function ResponseGraph({
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
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ ref: EqStageRef; x: number; y: number } | null>(null);
  const contextMenuAnchorRef = useRef<HTMLDivElement>(null);

  const selectedActive = selectedRef !== null && stageInfo(eq, selectedRef, capsByType).active;
  const curvePoints = dragging ? DRAG_CURVE_POINTS : REST_CURVE_POINTS;
  const total = useResponseCurve(eq, null, curvePoints);
  // The isolated stage is left out while a handle moves: half the work per frame.
  const isolated = useResponseCurve(selectedActive && !dragging ? eq : null, selectedRef, curvePoints);
  // One row per frequency; both curves come from core on the same grid.
  const data = useMemo(
    () => (total ?? []).map((p, i) => ({ f: p.freqHz, total: p.db, stage: isolated?.[i]?.db ?? null })),
    [total, isolated],
  );
  const stageLabel =
    selectedRef === null ? null : selectedRef.kind === "band" ? `Band ${selectedRef.bandIndex + 1}` : selectedRef.kind.toUpperCase();

  return (
    // Fills the height the dialog leaves (the strip below keeps its own).
    <div
      ref={containerRef}
      className="min-h-[190px] flex-1 overflow-hidden rounded-xl border border-[var(--amp-color-default-border)]"
      style={{ position: "relative", backgroundColor: "var(--amp-graph-bg)" }}
      onPointerDown={(event) => {
        // A press on the plot itself (not on a handle) clears the selection.
        if (
          event.button === 0 &&
          event.target instanceof Element &&
          event.target.closest(".recharts-wrapper") &&
          !event.target.closest("[data-eq-handle]")
        ) {
          onSelectStage(null);
        }
      }}
    >
      <span
        className="pointer-events-none absolute left-3 top-2 z-10"
        style={{ fontSize: 10, color: "var(--amp-color-dimmed)" }}
      >
        dB
      </span>
      <div style={{ position: "absolute", inset: 12 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={data}
            margin={{ top: PLOT_TOP, right: PLOT_RIGHT, bottom: 0, left: 0 }}
            accessibilityLayer={false}
          >
            {/* Minor lines dashed, major lines (on the ticks) solid, as two grids. */}
            <CartesianGrid
              vertical={false}
              horizontalValues={GRAPH_DB_MINOR}
              stroke="var(--amp-graph-grid-minor)"
              strokeDasharray="2 4"
            />
            <CartesianGrid
              horizontalValues={GRAPH_DB_TICKS}
              stroke="var(--amp-graph-grid-major)"
              verticalFill={[]}
              vertical={(props: { x1?: number; y1?: number; x2?: number; y2?: number; key?: string }) => (
                <line
                  key={props.key}
                  x1={props.x1}
                  y1={props.y1}
                  x2={props.x2}
                  y2={props.y2}
                  stroke="var(--amp-graph-grid-minor)"
                />
              )}
            />
            <XAxis
              dataKey="f"
              type="number"
              scale="log"
              domain={[GRAPH_MIN_HZ, GRAPH_MAX_HZ]}
              ticks={GRAPH_FREQ_TICKS}
              tickFormatter={freqLabel}
              allowDataOverflow
              interval={0}
              height={PLOT_BOTTOM}
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 10, fill: "var(--amp-color-dimmed)" }}
            />
            <YAxis
              type="number"
              domain={[GRAPH_MIN_DB, GRAPH_MAX_DB]}
              ticks={GRAPH_DB_TICKS}
              tickFormatter={(db: number) => (db > 0 ? `+${db}` : String(db))}
              allowDataOverflow
              interval={0}
              width={PLOT_LEFT}
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 10, fill: "var(--amp-color-dimmed)" }}
            />
            <Line
              type="monotone"
              dataKey="stage"
              stroke="var(--amp-graph-stage)"
              strokeWidth={1.4}
              strokeDasharray="5 4"
              dot={false}
              activeDot={{ r: 4, fill: "var(--amp-graph-stage)", stroke: "var(--amp-color-body)", strokeWidth: 2 }}
              connectNulls
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="total"
              stroke="var(--accent)"
              strokeWidth={2.4}
              dot={false}
              activeDot={{ r: 4, fill: "var(--accent)", stroke: "var(--amp-color-body)", strokeWidth: 2 }}
              isAnimationActive={false}
            />
            <StageHandles
              eq={eq}
              capsByType={capsByType}
              selectedRef={selectedRef}
              interactive={interactive}
              onSelectStage={onSelectStage}
              onPreview={onPreview}
              onCommit={onCommit}
              onDraggingChange={setDragging}
              onStageMenu={(ref, clientX, clientY) => {
                const rect = containerRef.current?.getBoundingClientRect();
                setContextMenu({ ref, x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) });
              }}
              freqRange={freqRange}
              gainRange={gainRange}
              qRange={qRange}
            />
            <ChartTooltip
              content={<GraphTooltip stageLabel={stageLabel} />}
              cursor={{ stroke: "var(--amp-color-text)", strokeWidth: 1, opacity: 0.7 }}
              active={dragging ? false : undefined}
              offset={16}
              wrapperStyle={{ pointerEvents: "none", zIndex: 20 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

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

  // Always call the latest handlers (they close over the current actions and
  // lock state) through callbacks whose identity never changes.
  const latest = useRef({ band: handleBandChange, crossover: handleCrossoverChange });
  latest.current = { band: handleBandChange, crossover: handleCrossoverChange };
  const onBandChange = useCallback((bandIndex: number, patch: BandPatch) => latest.current.band(bandIndex, patch), []);
  const onCrossoverChange = useCallback(
    (slot: CrossoverSlotKind, patch: CrossoverPatch) => latest.current.crossover(slot, patch),
    [],
  );

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
      className="relative flex min-w-0 flex-1 flex-col gap-3 px-1"
      style={{
        width: "100%",
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
      {/* Over the graph's top-right corner rather than a row of its own. */}
      <div className="absolute top-2 right-3 z-10 flex justify-end">
        <ClipboardButtons
          actions={actions}
          channelIndex={channelIndex}
          section={direction === "input" ? "inputEq" : "outputEq"}
          label={`${assignment.deviceName ?? "Amp"} · ${
            direction === "input" ? `In ${channelIndex + 1}` : `Out ${String.fromCharCode(65 + channelIndex)}`
          } EQ`}
        />
      </div>
      <ResponseGraph
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
            kind="hp"
            slot={displayEq.hp}
            freqMin={freqRange.min}
            freqMax={freqRange.max}
            selected={sameStage(selectedStage, { kind: "hp" })}
            onSelectStage={setSelectedStage}
            onCrossoverChange={onCrossoverChange}
          />
          {displayEq.bands.map((band, i) => (
            <BandStrip
              key={i}
              label={String(i + 1)}
              index={i}
              band={band}
              capsByType={eqCapsByType}
              freqMin={freqRange.min}
              freqMax={freqRange.max}
              gainMin={gainRange.min}
              gainMax={gainRange.max}
              qMin={qRange.min}
              qMax={qRange.max}
              selected={sameStage(selectedStage, { kind: "band", bandIndex: i })}
              onSelectStage={setSelectedStage}
              onBandChange={onBandChange}
            />
          ))}
          <CrossoverStrip
            label="LP"
            kind="lp"
            slot={displayEq.lp}
            freqMin={freqRange.min}
            freqMax={freqRange.max}
            selected={sameStage(selectedStage, { kind: "lp" })}
            onSelectStage={setSelectedStage}
            onCrossoverChange={onCrossoverChange}
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
      className={`flex min-w-0 flex-col gap-1 rounded-lg border p-1 transition-opacity duration-150 ${
        dimmed && !selected ? "opacity-[0.55] hover:opacity-100" : ""
      }`}
      style={{
        borderColor: selected ? "var(--accent)" : "var(--amp-color-default-border)",
        background: selected ? "var(--accent-soft)" : "color-mix(in srgb, var(--amp-graph-bg) 60%, transparent)",
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

type CrossoverPatch = Partial<{ filterType: CrossoverFilterType; freqHz: number; active: boolean }>;
type BandPatch = Partial<{ filterType: EqFilterType; freqHz: number; gainDb: number; q: number; active: boolean }>;

// The strips are memoised and take stable callbacks, so a drag — which changes
// one stage on every pointer event — re-renders that stage's strip and not all
// ten.
const CrossoverStrip = memo(function CrossoverStrip({
  label,
  kind,
  slot,
  freqMin,
  freqMax,
  selected,
  onSelectStage,
  onCrossoverChange,
}: {
  label: string;
  kind: "hp" | "lp";
  slot: { filterType: CrossoverFilterType; freqHz: number | null; active: boolean };
  freqMin: number | null;
  freqMax: number | null;
  selected: boolean;
  onSelectStage: (ref: EqStageRef) => void;
  onCrossoverChange: (slot: CrossoverSlotKind, patch: CrossoverPatch) => void;
}) {
  const onChange = (patch: CrossoverPatch) => onCrossoverChange(kind, patch);
  return (
    <StripShell label={label} selected={selected} dimmed={!slot.active} onSelect={() => onSelectStage({ kind })}>
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
});

const BandStrip = memo(function BandStrip({
  label,
  index,
  band,
  capsByType,
  freqMin,
  freqMax,
  gainMin,
  gainMax,
  qMin,
  qMax,
  selected,
  onSelectStage,
  onBandChange,
}: {
  label: string;
  index: number;
  band: { filterType: EqFilterType; freqHz: number | null; gainDb: number | null; q: number | null; active: boolean };
  capsByType: Record<EqFilterType, { supportsGain: boolean; supportsQ: boolean }>;
  freqMin: number | null;
  freqMax: number | null;
  gainMin: number | null;
  gainMax: number | null;
  qMin: number | null;
  qMax: number | null;
  selected: boolean;
  onSelectStage: (ref: EqStageRef) => void;
  onBandChange: (bandIndex: number, patch: BandPatch) => void;
}) {
  const caps = capsByType[band.filterType];
  const onChange = (patch: BandPatch) => onBandChange(index, patch);
  return (
    <StripShell
      label={label}
      selected={selected}
      dimmed={!band.active}
      onSelect={() => onSelectStage({ kind: "band", bandIndex: index })}
    >
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
});
