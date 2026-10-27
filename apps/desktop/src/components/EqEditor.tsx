import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Switch } from "@heroui/react";
import { Power, RotateCcw } from "lucide-react";
import { ClipboardButtons } from "./ClipboardButtons";
import { CommitNumberInput, STEP_COMMIT_DELAY_MS, stepSizeOf, stepped } from "./CommitNumberInput";
import { useContextMenu } from "./ContextMenu";
import { formatDb, FrequencyPlot, pathD, toPlotPoints, type PlotAxis, type PlotCurve, type PlotScale } from "./FrequencyPlot";
import { SimpleSelect } from "./SimpleSelect";
import { checkAgainstCore, responseCurve } from "../lib/eqResponse";
import type { EqStageRef, ResponsePoint } from "../lib/filterResponse";
import {
  type AmpAssignment,
  type AmpCapability_Serialize as AmpCapability,
  type ChannelEq,
  type CrossoverFilterType,
  type CrossoverSlotKind,
  type EqDirection,
  type EqFilterType,
  type ParamRange,
} from "../lib/bindings";
import type { ConfigureActions } from "../lib/configureActions";
import { ACTION_UNAVAILABLE, type ActionResult } from "../lib/actionResult";
import { outputLetter } from "../lib/channelTelemetry";

/** What one filter type exposes: gain and/or Q, and a Q range narrower than
 * `paramRanges.eqBandQ` where the type has one (shelves — see
 * `EqFilterType::q_range` in core). */
type FilterCaps = { supportsGain: boolean; supportsQ: boolean; qRange: ParamRange | null };

/** `filterType -> {supportsGain, supportsQ, qRange}` lookup, keyed for O(1) access —
 * built once from `AmpCapability.eqFilterCapabilities`, the backend-resolved
 * source of truth (`eq_filter_capabilities()` in
 * `src-tauri/src/data/capability/mod.rs`). Not hardcoded here: if a future
 * model/firmware ever needs a different gain/Q table, this stays correct
 * automatically, same as every other capability this app reads off
 * `AmpCapability` instead of assuming per-model.  */
function indexEqFilterCapabilities(
  entries: AmpCapability["eqFilterCapabilities"],
): Record<EqFilterType, FilterCaps> {
  const map = {} as Record<EqFilterType, FilterCaps>;
  for (const entry of entries) {
    map[entry.filterType] = { supportsGain: entry.supportsGain, supportsQ: entry.supportsQ, qRange: entry.qRange };
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

const GRAPH_MIN_DB = -24;
const GRAPH_MAX_DB = 24;
const GRAPH_MIN_HZ = 20;
const GRAPH_MAX_HZ = 20000;
/** ±24 dB, labelled every 6, a dashed line every 2. */
const EQ_DB_AXIS: PlotAxis = {
  min: GRAPH_MIN_DB,
  max: GRAPH_MAX_DB,
  ticks: [-24, -18, -12, -6, 0, 6, 12, 18, 24],
  minorTicks: Array.from({ length: 25 }, (_, i) => -24 + i * 2).filter((db) => db % 6 !== 0),
  format: formatDb,
};
const LOG_HZ_SPAN = Math.log10(GRAPH_MAX_HZ) - Math.log10(GRAPH_MIN_HZ);
const GRAPH_HZ = { min: GRAPH_MIN_HZ, max: GRAPH_MAX_HZ };
const GRAPH_DB = { min: GRAPH_MIN_DB, max: GRAPH_MAX_DB };

/** Q-drag pixel-to-Q sensitivity — ported from the old app's
 * `cvr-amp-controller-web` reference (`qDirection * deltaClientX * 0.02`),
 * which was tuned against its 800px-wide graph viewBox. That constant is
 * "ΔQ per raw client pixel," so holding it fixed on this app's wider
 * 1000px viewBox would make the same physical mouse drag cover a smaller
 * fraction of the chart — less sensitive, purely from geometry, not intent.
 * Rescaled by the viewBox width ratio so drag *feel* stays comparable:
 * 0.02 * (1000 / 800) = 0.025. */
const Q_DRAG_SENSITIVITY = 0.025;

/** Converts a pointer event's client coordinates into the plot SVG's own
 * coordinate space (the one its scale and the handles use). */
function toViewBoxPoint(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } {
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const point = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
  return { x: point.x, y: point.y };
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

/** HP is 0, bands 1-8, LP 9 — the position in the chain and in the strip. */
function stageIndex(ref: EqStageRef): number {
  return ref.kind === "hp" ? 0 : ref.kind === "lp" ? 9 : ref.bandIndex + 1;
}

/** The stage's own colour (`--amp-band-*`): its handle, isolated curve and tile. */
function stageColor(ref: EqStageRef): string {
  return `var(--amp-band-${stageIndex(ref)})`;
}

function stageName(ref: EqStageRef): string {
  return ref.kind === "band" ? `Band ${ref.bandIndex + 1}` : ref.kind.toUpperCase();
}

/** HP, every band, LP — the chain in order. */
function stagesOf(eq: ChannelEq): EqStageRef[] {
  return [{ kind: "hp" }, ...eq.bands.map((_, i) => ({ kind: "band", bandIndex: i }) as const), { kind: "lp" }];
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
  capsByType: Record<EqFilterType, FilterCaps>,
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

/** Where a stage's last freq/gain/Q write stands: in flight, acknowledged
 * (shown green for a moment), or refused (shown red for a moment). */
type WriteStatus = "pending" | "ok" | "fail";

/** A written patch held on screen from the moment it is sent until the amp's
 * own reading agrees with it (or `WRITE_HOLD_MS` passes), so the point never
 * falls back to the old value while the write and the next poll are on
 * their way. */
type StageWrite = { ref: EqStageRef; patch: PreviewPatch; acked: boolean; token: number };

const WRITE_HOLD_MS = 3000;
/** A curve or ring easing back from a result flash to its own colour. */
const CURVE_EASE = "transition-[stroke] duration-500";
const WRITE_FLASH_MS = 700;

/** The amp's reading matches what was written — f32 read-back included. */
function writeConfirmed(eq: ChannelEq, write: StageWrite, capsByType: Record<EqFilterType, FilterCaps>): boolean {
  const info = stageInfo(eq, write.ref, capsByType);
  const { freqHz, gainDb, q } = write.patch;
  return (
    (freqHz === undefined || Math.abs(info.freqHz - freqHz) <= 0.5) &&
    (gainDb === undefined || Math.abs(info.gainDb - gainDb) <= 0.05) &&
    (q === undefined || Math.abs(info.q - q) <= 0.005)
  );
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

type DragMode = "xy" | "x" | "y" | "qLeft" | "qRight";

/** How much of the pointer's movement a drag follows while Shift is held. */
const FINE_DRAG_SCALE = 0.25;

/** A drag measures the pointer's movement from an anchor — where it began,
 * or where Shift was last pressed or released, so switching to fine never
 * makes the point jump. */
type DragState = {
  pointerId: number;
  ref: EqStageRef;
  mode: DragMode;
  fine: boolean;
  startClientX: number;
  startViewX: number;
  startViewY: number;
  startFreqHz: number;
  startGainDb: number;
  startQ: number;
  /** The elements a drag writes to directly, and where the handle was drawn. */
  els: { body: SVGGElement | null; q: SVGGElement[]; total: SVGPathElement | null; stage: SVGPathElement | null };
  baseCx: number;
  baseCy: number;
  last: PreviewPatch | null;
};

function freqText(hz: number): string {
  return hz >= 1000 ? `${(hz / 1000).toFixed(2)} kHz` : `${Math.round(hz)} Hz`;
}

/** Points per curve. Computed locally in the same frame, so this is about
 * smoothness, not speed: 240 keeps a 48 dB/oct slope crisp. */
const CURVE_POINTS = 240;
/** How often a drag tells the rest of the editor (strip, editor row) where
 * the point is; the graph itself follows every frame. */
const PARENT_PREVIEW_MS = 100;

/** The draggable handles of the 10 stages (HP, 8 parametric bands, LP), drawn
 * in the plot with its own scale: a main dot for free XY
 * drag (freq+gain), small side handles for freq-only/gain-only drag, and (once
 * selected) a pair of Q-width handles — matching the old app's reference
 * (`components/monitor/amp-tabs/eq-curve-chart.tsx` in `cvr-amp-controller-web`).
 * HP/LP only ever expose the main dot + freq handles — a `CrossoverSlot` has no
 * gain/Q to drag.
 *
 * A drag never goes through React. Once per animation frame it computes the
 * curves for the moved point (`lib/eqResponse.ts`) and writes them, the
 * handle's offset and the Q dots straight to the SVG (`paint`); React renders
 * once, on release, when `onCommit` hands over the final patch. A render that
 * lands mid-drag (a poll) is painted over again before the screen updates. */
function StageHandles({
  scale,
  eq,
  capsByType,
  selectedRef,
  writeStatus,
  stageCurve,
  interactive,
  onSelectStage,
  onCommit,
  onStageMenu,
}: {
  scale: PlotScale;
  eq: ChannelEq;
  capsByType: Record<EqFilterType, FilterCaps>;
  selectedRef: EqStageRef | null;
  writeStatus: Record<string, WriteStatus>;
  /** The selected stage's own curve — where its Q handles sit. */
  stageCurve: ResponsePoint[] | null;
  interactive: boolean;
  onSelectStage: (ref: EqStageRef | null) => void;
  onCommit: (ref: EqStageRef, patch: PreviewPatch) => void;
  onStageMenu: (ref: EqStageRef, event: React.MouseEvent) => void;
}) {
  const dragRef = useRef<DragState | null>(null);
  const frameRef = useRef(0);
  const pendingRef = useRef<PreviewPatch | null>(null);
  useEffect(() => () => cancelAnimationFrame(frameRef.current), []);
  const { toX, toY, plot } = scale;

  /** Where a stage's Q dots sit: an octave span either side of its centre,
   * on its own curve. */
  function qDots(info: { freqHz: number; q: number }, curve: ResponsePoint[] | null, fallbackY: number) {
    const octaves = 1 / Math.max(info.q, 0.1);
    return [info.freqHz / 2 ** octaves, info.freqHz * 2 ** octaves].map((hz) => {
      const f = clampToRange(hz, GRAPH_HZ);
      if (!curve?.length) return { x: toX(f), y: fallbackY };
      const t = (Math.log10(f) - Math.log10(GRAPH_MIN_HZ)) / LOG_HZ_SPAN;
      return { x: toX(f), y: toY(curve[Math.round(t * (curve.length - 1))].db) };
    });
  }

  /** One drag frame, written straight to the SVG. */
  function paint(drag: DragState, patch: PreviewPatch) {
    drag.last = patch;
    const next = applyPreview(eq, { ref: drag.ref, patch });
    const info = stageInfo(next, drag.ref, capsByType);
    const stage = responseCurve(next, drag.ref, CURVE_POINTS);
    drag.els.total?.setAttribute("d", pathD(toPlotPoints(responseCurve(next, null, CURVE_POINTS)), scale));
    drag.els.stage?.setAttribute("d", pathD(toPlotPoints(stage), scale));
    const cx = toX(info.freqHz);
    const cy = toY(info.gainDb);
    drag.els.body?.setAttribute("transform", `translate(${(cx - drag.baseCx).toFixed(1)} ${(cy - drag.baseCy).toFixed(1)})`);
    qDots(info, stage, cy).forEach((dot, i) => {
      drag.els.q[i]?.querySelectorAll("circle").forEach((circle) => {
        circle.setAttribute("cx", dot.x.toFixed(1));
        circle.setAttribute("cy", dot.y.toFixed(1));
      });
    });
  }

  // A render during a drag (a poll's new chain) resets what `paint` wrote;
  // put it back before the screen updates.
  useLayoutEffect(() => {
    const drag = dragRef.current;
    if (!drag?.last) return;
    drag.els.body?.removeAttribute("transform");
    const body = drag.els.body?.querySelector<SVGCircleElement>("circle[data-main]");
    if (body) {
      drag.baseCx = Number(body.getAttribute("cx"));
      drag.baseCy = Number(body.getAttribute("cy"));
    }
    paint(drag, drag.last);
  });

  /** The patch a drag proposes at `vb` (the pointer, in chart pixels): the
   * anchor's values moved by the pointer's travel since the anchor, a quarter
   * of it while fine. */
  function patchFor(drag: DragState, vb: { x: number; y: number }, clientX: number): PreviewPatch {
    const info = stageInfo(eq, drag.ref, capsByType);
    const fine = drag.fine ? FINE_DRAG_SCALE : 1;
    const freqHz = () =>
      clampToRange(drag.startFreqHz * 10 ** ((((vb.x - drag.startViewX) * fine) / plot.width) * LOG_HZ_SPAN), GRAPH_HZ);
    const gainDb = () =>
      clampToRange(drag.startGainDb + (((drag.startViewY - vb.y) * fine) / plot.height) * (GRAPH_MAX_DB - GRAPH_MIN_DB), GRAPH_DB);
    if (drag.mode === "xy") {
      const patch: PreviewPatch = { freqHz: freqHz() };
      if (info.supportsGain) patch.gainDb = gainDb();
      return patch;
    }
    if (drag.mode === "x") return { freqHz: freqHz() };
    if (drag.mode === "y") return info.supportsGain ? { gainDb: gainDb() } : {};
    // qLeft / qRight — mapped from raw client-pixel delta, not chart distance,
    // matching the reference's Q-drag (see Q_DRAG_SENSITIVITY).
    if (!info.supportsQ) return {};
    const qDirection = drag.mode === "qLeft" ? 1 : -1;
    return { q: drag.startQ + qDirection * (clientX - drag.startClientX) * fine * Q_DRAG_SENSITIVITY };
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
    const handle = event.currentTarget.closest("[data-eq-handle]");

    dragRef.current = {
      pointerId: event.pointerId,
      ref,
      mode,
      fine: event.shiftKey,
      startClientX: event.clientX,
      startViewX: vb.x,
      startViewY: vb.y,
      startFreqHz: info.freqHz,
      startGainDb: info.gainDb,
      startQ: info.q,
      els: {
        body: handle?.querySelector<SVGGElement>("[data-body]") ?? null,
        q: Array.from(handle?.querySelectorAll<SVGGElement>("[data-q]") ?? []),
        total: svg.querySelector<SVGPathElement>('path[data-curve="total"]'),
        stage: svg.querySelector<SVGPathElement>('path[data-curve="stage"]'),
      },
      baseCx: toX(info.freqHz),
      baseCy: toY(info.gainDb),
      last: null,
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

  function handlePointerMove(event: React.PointerEvent<SVGGElement>) {
    const drag = dragRef.current;
    const svg = event.currentTarget.ownerSVGElement;
    if (!drag || !svg || drag.pointerId !== event.pointerId) return;
    const vb = toViewBoxPoint(svg, event.clientX, event.clientY);
    if (event.shiftKey !== drag.fine) {
      // Re-anchor where the point is now, so it carries on from here.
      const here = patchFor(drag, vb, event.clientX);
      dragRef.current = {
        ...drag,
        fine: event.shiftKey,
        startClientX: event.clientX,
        startViewX: vb.x,
        startViewY: vb.y,
        startFreqHz: here.freqHz ?? drag.startFreqHz,
        startGainDb: here.gainDb ?? drag.startGainDb,
        startQ: here.q ?? drag.startQ,
      };
    }
    pendingRef.current = patchFor(dragRef.current!, vb, event.clientX);
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending && dragRef.current) paint(dragRef.current, pending);
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
    // React draws the final position from here on.
    drag.els.body?.removeAttribute("transform");

    // `patchFor` only proposes what the stage supports; `onCommit` rounds and clamps.
    const patch = patchFor(drag, toViewBoxPoint(svg, event.clientX, event.clientY), event.clientX);
    if (Object.keys(patch).length > 0) onCommit(drag.ref, patch);
    onSelectStage(drag.ref);
  }

  return (
    <g onPointerMove={handlePointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
      {stagesOf(eq).map((ref) => {
        const info = stageInfo(eq, ref, capsByType);
        if (!info.active) return null;
        const cx = toX(info.freqHz);
        const cy = toY(info.gainDb);
        const selected = sameStage(selectedRef, ref);
        const color = stageColor(ref);
        const label = ref.kind === "hp" ? "H" : ref.kind === "lp" ? "L" : String(ref.bandIndex + 1);
        const dots = selected && info.supportsQ ? qDots(info, stageCurve, cy) : [];
        const status = writeStatus[stageKey(ref)];
        const ring = status === "ok" ? "var(--amp-color-green-6)" : status === "fail" ? "var(--amp-color-red-6)" : selected ? color : null;

        return (
          <g key={stageKey(ref)} data-eq-handle className={status === "pending" ? "eq-write-pending" : undefined}>
            <g data-body>
            {ring && (
              <circle
                cx={cx}
                cy={cy}
                r={14}
                fill="none"
                stroke={ring}
                strokeOpacity={status === "ok" || status === "fail" ? 0.9 : 0.45}
                strokeWidth={4}
                pointerEvents="none"
                className={CURVE_EASE}
              />
            )}
            <circle
              data-main
              cx={cx}
              cy={cy}
              r={9}
              fill={color}
              stroke={selected ? "var(--amp-color-text)" : "var(--amp-graph-bg)"}
              strokeWidth={selected ? 2 : 1.5}
              style={{ cursor: interactive ? "grab" : "pointer" }}
              onPointerDown={(e) => beginDragIfActivated(e, ref, "xy")}
              onContextMenu={(e) => {
                if (!interactive) return;
                e.stopPropagation();
                onStageMenu(ref, e);
              }}
            />
            <text
              x={cx}
              y={cy}
              textAnchor="middle"
              dominantBaseline="central"
              pointerEvents="none"
              style={{ fontSize: 10, fontWeight: 700, fill: "var(--amp-graph-bg)" }}
            >
              {label}
            </text>
            {selected && interactive && (
              <g>
                {[180, 0].map((angle) => (
                  <ArrowHandle
                    key={angle}
                    cx={cx}
                    cy={cy}
                    angle={angle}
                    color={color}
                    cursor="ew-resize"
                    onPointerDown={(e) => beginDragIfActivated(e, ref, "x")}
                  />
                ))}
                {info.supportsGain &&
                  [-90, 90].map((angle) => (
                    <ArrowHandle
                      key={angle}
                      cx={cx}
                      cy={cy}
                      angle={angle}
                      color={color}
                      cursor="ns-resize"
                      onPointerDown={(e) => beginDragIfActivated(e, ref, "y")}
                    />
                  ))}
              </g>
            )}
            </g>
            {selected && interactive && info.supportsQ &&
                  (["qLeft", "qRight"] as const).map((mode, i) => {
                    const qx = dots[i].x;
                    const qy = dots[i].y;
                    return (
                      <g
                        key={mode}
                        data-q
                        className="group"
                        style={{ cursor: "ew-resize" }}
                        onPointerDown={(e) => beginDragIfActivated(e, ref, mode)}
                      >
                        <circle cx={qx} cy={qy} r={10} fill="transparent" />
                        <circle
                          cx={qx}
                          cy={qy}
                          r={4.5}
                          fill={color}
                          stroke="var(--amp-graph-bg)"
                          strokeWidth={1.5}
                          className="origin-center [transform-box:fill-box] group-hover:scale-125"
                        />
                      </g>
                    );
                  })}
          </g>
        );
      })}
    </g>
  );
}

/** How far a drag arrow sits from its point's centre. */
const ARROW_OFFSET = 21;

/** One drag arrow beside a selected point: a small triangle pointing away from
 * it (`angle` in degrees, 0 = right), inside a finger-sized hit area. */
function ArrowHandle({
  cx,
  cy,
  angle,
  color,
  cursor,
  onPointerDown,
}: {
  cx: number;
  cy: number;
  angle: number;
  color: string;
  cursor: string;
  onPointerDown: (event: React.PointerEvent<SVGElement>) => void;
}) {
  return (
    <g
      className="group"
      transform={`translate(${cx} ${cy}) rotate(${angle})`}
      style={{ cursor }}
      onPointerDown={onPointerDown}
    >
      <circle cx={ARROW_OFFSET} cy={0} r={10} fill="transparent" />
      <path
        d={`M${ARROW_OFFSET - 4},-5 L${ARROW_OFFSET + 5},0 L${ARROW_OFFSET - 4},5 Z`}
        fill={color}
        className="opacity-70 group-hover:opacity-100"
      />
    </g>
  );
}

/** Frequency-response graph on `FrequencyPlot`: the whole chain's response,
 * the selected stage on its own in its colour, and the handles. A drag keeps
 * its position in this component's own state and the curves are computed
 * from it in the same render (`lib/eqResponse.ts`), so the point, its Q dots
 * and the curve move together every frame, and only this graph re-renders
 * for it.
 *
 * Memoised, and every prop is stable while nothing about the EQ changes: its
 * dialog re-renders at meter rate, and the graph must not. */
const ResponseGraph = memo(function ResponseGraph({
  eq,
  capsByType,
  selectedRef,
  writeStatus,
  interactive,
  onSelectStage,
  onPreview,
  onCommit,
  onToggleActive,
  onResetGain,
}: {
  eq: ChannelEq;
  capsByType: Record<EqFilterType, FilterCaps>;
  selectedRef: EqStageRef | null;
  writeStatus: Record<string, WriteStatus>;
  interactive: boolean;
  onSelectStage: (ref: EqStageRef | null) => void;
  onPreview: (ref: EqStageRef, patch: PreviewPatch) => void;
  onCommit: (ref: EqStageRef, patch: PreviewPatch) => void;
  onToggleActive: (ref: EqStageRef) => void;
  onResetGain: (ref: EqStageRef) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const openMenu = useContextMenu();
  // The point being moved, every frame. Only this graph re-renders for it;
  // the strip and editor row hear about it every `PARENT_PREVIEW_MS`.
  const [live, setLive] = useState<{ ref: EqStageRef; patch: PreviewPatch } | null>(null);
  const lastSent = useRef(0);
  const previewLive = (ref: EqStageRef, patch: PreviewPatch) => {
    setLive({ ref, patch });
    const now = performance.now();
    if (now - lastSent.current >= PARENT_PREVIEW_MS) {
      lastSent.current = now;
      onPreview(ref, patch);
    }
  };
  // The final position goes to the editor before the write, so nothing
  // shows the last throttled one in between.
  const commitLive = (ref: EqStageRef, patch: PreviewPatch) => {
    onPreview(ref, patch);
    setLive(null);
    onCommit(ref, patch);
  };
  const graphEq = useMemo(() => applyPreview(eq, live), [eq, live]);
  // Arrow-key nudges preview at once and are written once the keys go quiet,
  // as a drag is written once on release.
  const keyNudge = useRef<{ ref: EqStageRef; patch: PreviewPatch; timer: ReturnType<typeof setTimeout> } | null>(null);
  const flushKeyNudge = () => {
    const pending = keyNudge.current;
    if (!pending) return;
    clearTimeout(pending.timer);
    keyNudge.current = null;
    commitLive(pending.ref, pending.patch);
  };
  useEffect(() => () => flushKeyNudge(), []);

  /** ←/→ move the selected point's frequency by an octave fraction, ↑/↓ its
   * gain (types with gain only); Shift fine, Ctrl/Cmd coarse, as in the
   * number fields. Esc deselects. */
  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && selectedRef) {
      flushKeyNudge();
      onSelectStage(null);
      return;
    }
    const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
    const vertical = event.key === "ArrowUp" || event.key === "ArrowDown";
    if (!interactive || !selectedRef || (!horizontal && !vertical)) return;
    const info = stageInfo(graphEq, selectedRef, capsByType);
    if (!info.active || (vertical && !info.supportsGain)) return;
    event.preventDefault();
    if (keyNudge.current && !sameStage(keyNudge.current.ref, selectedRef)) flushKeyNudge();
    const patch: PreviewPatch = { ...keyNudge.current?.patch };
    const direction = event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : -1;
    const size = stepSizeOf(event);
    if (horizontal) {
      patch.freqHz = clampToRange(stepped(patch.freqHz ?? info.freqHz, direction, size, 1, "log"), GRAPH_HZ);
    } else {
      patch.gainDb = clampToRange(stepped(patch.gainDb ?? info.gainDb, direction, size, 0.1), GRAPH_DB);
    }
    if (keyNudge.current) clearTimeout(keyNudge.current.timer);
    const ref = selectedRef;
    keyNudge.current = { ref, patch, timer: setTimeout(flushKeyNudge, STEP_COMMIT_DELAY_MS) };
    previewLive(ref, patch);
  }

  const selectedActive = selectedRef !== null && stageInfo(graphEq, selectedRef, capsByType).active;
  const total = useMemo(() => responseCurve(graphEq, null, CURVE_POINTS), [graphEq]);
  const isolated = useMemo(
    () => (selectedActive && selectedRef ? responseCurve(graphEq, selectedRef, CURVE_POINTS) : null),
    [graphEq, selectedActive, selectedRef],
  );
  const plotCurves = useMemo(() => {
    const statuses = Object.values(writeStatus);
    // Pending greys and breathes; a result flashes, then eases back.
    const look = (status: WriteStatus | undefined, color: string) =>
      status === "pending"
        ? { color: "var(--amp-color-dimmed)", className: "eq-write-pending" }
        : status === "ok"
          ? { color: "var(--amp-color-green-6)", className: CURVE_EASE }
          : status === "fail"
            ? { color: "var(--amp-color-red-6)", className: CURVE_EASE }
            : { color, className: CURVE_EASE };
    const overall = statuses.includes("pending") ? "pending" : statuses.includes("fail") ? "fail" : statuses.includes("ok") ? "ok" : undefined;
    const list: PlotCurve[] = [];
    if (isolated && selectedRef) {
      list.push({
        key: "stage",
        points: toPlotPoints(isolated),
        width: 1.5,
        dash: "5 4",
        label: stageName(selectedRef),
        ...look(writeStatus[stageKey(selectedRef)], stageColor(selectedRef)),
      });
    }
    list.push({ key: "total", points: toPlotPoints(total), width: 2.4, label: "Total", ...look(overall, "var(--accent)") });
    return list;
  }, [total, isolated, selectedRef, writeStatus]);

  const stageMenu = (ref: EqStageRef, event: React.MouseEvent) => {
    const info = stageInfo(graphEq, ref, capsByType);
    openMenu(event, [
      { label: info.active ? "Bypass" : "Enable", icon: <Power size={14} />, onAction: () => onToggleActive(ref) },
      { label: "Reset gain", icon: <RotateCcw size={14} />, disabled: !info.supportsGain, onAction: () => onResetGain(ref) },
    ]);
  };

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      aria-label="EQ graph — arrow keys move the selected point"
      className="shrink-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      onKeyDown={handleKeyDown}
      onPointerDown={(event) => {
        containerRef.current?.focus({ preventScroll: true });
        // A press on the plot itself (not on a handle) clears the selection.
        if (event.button === 0 && event.target instanceof Element && !event.target.closest("[data-eq-handle]")) {
          onSelectStage(null);
        }
      }}
    >
      <FrequencyPlot
        y={EQ_DB_AXIS}
        curves={plotCurves}
        ariaLabel="EQ frequency response"
        className="h-[clamp(220px,42vh,440px)] overflow-hidden rounded-xl border border-[var(--amp-color-default-border)]"
        overlay={(scale) => (
          <StageHandles
            scale={scale}
            eq={graphEq}
            capsByType={capsByType}
            selectedRef={selectedRef}
            writeStatus={writeStatus}
            stageCurve={isolated}
            interactive={interactive}
            onSelectStage={onSelectStage}
            onCommit={commitLive}
            onStageMenu={stageMenu}
          />
        )}
      />
    </div>
  );
});

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
  const currentEq = (direction === "input" ? channel.inputEq : channel.outputEq) ?? FALLBACK_CHANNEL_EQ;
  // Held by value: a live amp's assignment is a new object on every poll, and
  // a new `eq` would re-render the graph and all ten strips each time.
  const eqKey = JSON.stringify(currentEq);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const eq = useMemo(() => currentEq, [eqKey]);

  const capsKey = JSON.stringify(capability.eqFilterCapabilities);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const eqCapsByType = useMemo(() => indexEqFilterCapabilities(capability.eqFilterCapabilities), [capsKey]);

  const [selectedStage, setSelectedStage] = useState<EqStageRef | null>(null);
  const [preview, setPreview] = useState<{ ref: EqStageRef; patch: PreviewPatch } | null>(null);
  const [writes, setWrites] = useState<Record<string, StageWrite>>({});
  const [flash, setFlash] = useState<Record<string, "ok" | "fail">>({});
  const writeToken = useRef(0);

  // Switching channel or direction (Input EQ <-> Output EQ) reuses the same
  // mounted component in some callers — clear transient selection/preview
  // rather than leave it pointing at a stage from the previous chain.
  useEffect(() => {
    setSelectedStage(null);
    setPreview(null);
    setWrites({});
  }, [channelIndex, direction]);

  const displayEq = useMemo(
    () => applyPreview(Object.values(writes).reduce((chain, w) => applyPreview(chain, w), eq), preview),
    [eq, writes, preview],
  );
  // An acknowledged write is let go once the amp's own reading shows it.
  useEffect(() => {
    setWrites((current) => {
      const confirmed = Object.keys(current).filter((k) => current[k].acked && writeConfirmed(eq, current[k], eqCapsByType));
      if (confirmed.length === 0) return current;
      const next = { ...current };
      for (const k of confirmed) delete next[k];
      return next;
    });
  }, [eq, writes, eqCapsByType]);

  /** Each stage's write state as the graph shows it — stable while nothing changes. */
  const writeStatus = useMemo(() => {
    const status: Record<string, WriteStatus> = { ...flash };
    for (const [k, w] of Object.entries(writes)) if (!w.acked) status[k] = "pending";
    return status;
  }, [writes, flash]);
  useEffect(() => checkAgainstCore(eq), [eq]);

  const freqRange = capability.paramRanges.crossoverFreqHz;
  const gainRange = capability.paramRanges.eqBandGainDb;
  const qRange = capability.paramRanges.eqBandQ;
  /** The Q range a band of `filterType` takes — what the backend checks too. */
  const qRangeFor = (filterType: EqFilterType) => eqCapsByType[filterType]?.qRange ?? qRange;

  const interactive = Boolean(actions.setEqBand && actions.setCrossoverSlot);

  async function handleCrossoverChange(
    slot: CrossoverSlotKind,
    patch: Partial<{ filterType: CrossoverFilterType; freqHz: number; active: boolean }>,
  ): Promise<ActionResult> {
    if (!actions.setCrossoverSlot) return ACTION_UNAVAILABLE;
    return actions.setCrossoverSlot(channelIndex, direction, slot, {
      filterType: patch.filterType ?? null,
      freqHz: patch.freqHz ?? null,
      active: patch.active ?? null,
    });
  }

  async function handleBandChange(
    bandIndex: number,
    patch: Partial<{ filterType: EqFilterType; freqHz: number; gainDb: number; q: number; active: boolean }>,
  ): Promise<ActionResult> {
    if (!actions.setEqBand) return ACTION_UNAVAILABLE;
    // A type with a narrower Q range (a shelf) takes the band's Q along,
    // fitted into it — the backend refuses a type change that would leave Q
    // outside the new type's range.
    const current = eq.bands[bandIndex];
    let q = patch.q;
    if (patch.filterType !== undefined && q === undefined && current && eqCapsByType[patch.filterType]?.supportsQ) {
      const fitted = roundQ(clampToRange(current.q ?? 1, qRangeFor(patch.filterType)));
      if (fitted !== current.q) q = fitted;
    }
    return actions.setEqBand(channelIndex, direction, bandIndex, {
      filterType: patch.filterType ?? null,
      freqHz: patch.freqHz ?? null,
      gainDb: patch.gainDb ?? null,
      q: q ?? null,
      active: patch.active ?? null,
    });
  }

  /** A finished drag: rounded and clamped to what the amp accepts, written once. */
  async function handleCommit(ref: EqStageRef, proposed: PreviewPatch) {
    const patch: PreviewPatch = {};
    if (proposed.freqHz !== undefined) patch.freqHz = roundFreq(clampToRange(proposed.freqHz, freqRange));
    if (proposed.gainDb !== undefined) patch.gainDb = roundGain(clampToRange(proposed.gainDb, gainRange));
    if (proposed.q !== undefined) {
      const type = ref.kind === "band" ? eq.bands[ref.bandIndex]?.filterType : undefined;
      patch.q = roundQ(clampToRange(proposed.q, type ? qRangeFor(type) : qRange));
    }
    await write(ref, patch);
  }

  /** Sends a freq/gain/Q patch and keeps it on screen while it is in flight:
   * pending until acknowledged, then held until the amp's reading agrees
   * (green flash), or dropped at once on failure — back to the old value —
   * with a red flash. */
  async function write(ref: EqStageRef, patch: PreviewPatch) {
    const key = stageKey(ref);
    const token = ++writeToken.current;
    setWrites((w) => ({ ...w, [key]: { ref, patch, acked: false, token } }));
    setPreview((p) => (p && sameStage(p.ref, ref) ? null : p));
    const result = ref.kind === "band" ? await handleBandChange(ref.bandIndex, patch) : await handleCrossoverChange(ref.kind, patch);
    const settle = (keep: boolean) =>
      setWrites((w) => {
        if (w[key]?.token !== token) return w;
        if (keep) return { ...w, [key]: { ...w[key], acked: true } };
        const next = { ...w };
        delete next[key];
        return next;
      });
    settle(result.ok);
    if (result.ok) window.setTimeout(() => settle(false), WRITE_HOLD_MS);
    setFlash((f) => ({ ...f, [key]: result.ok ? "ok" : "fail" }));
    window.setTimeout(
      () =>
        setFlash((f) => {
          const next = { ...f };
          delete next[key];
          return next;
        }),
      WRITE_FLASH_MS,
    );
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

  // Always call the latest handlers (they close over the current actions and
  // lock state) through callbacks whose identity never changes.
  const handlers = {
    write,
    band: handleBandChange,
    crossover: handleCrossoverChange,
    commit: handleCommit,
    toggleActive: handleToggleActive,
    resetGain: handleResetGain,
  };
  const latest = useRef(handlers);
  latest.current = handlers;
  const onBandChange = useCallback((bandIndex: number, patch: BandPatch) => latest.current.band(bandIndex, patch), []);
  const onCrossoverChange = useCallback(
    (slot: CrossoverSlotKind, patch: CrossoverPatch) => latest.current.crossover(slot, patch),
    [],
  );
  const onPreview = useCallback((ref: EqStageRef, patch: PreviewPatch) => setPreview({ ref, patch }), []);
  const onWrite = useCallback((ref: EqStageRef, patch: PreviewPatch) => void latest.current.write(ref, patch), []);
  const onCommit = useCallback((ref: EqStageRef, patch: PreviewPatch) => void latest.current.commit(ref, patch), []);
  const onToggleActive = useCallback((ref: EqStageRef) => latest.current.toggleActive(ref), []);
  const onResetGain = useCallback((ref: EqStageRef) => latest.current.resetGain(ref), []);

  const hint = interactive
    ? "Drag a point to move it · Shift for fine · arrow keys nudge the selected point · right-click to bypass"
    : "Read-only — EQ can't be edited here right now. Select a band to see its own response.";

  return (
    <div className="flex w-full min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <span className="min-w-0 flex-1 text-[length:var(--amp-font-size-xs)] text-[var(--amp-color-dimmed)]">{hint}</span>
        <ClipboardButtons
          actions={actions}
          channelIndex={channelIndex}
          section={direction === "input" ? "inputEq" : "outputEq"}
          label={`${assignment.deviceName ?? "Amp"} · ${
            direction === "input" ? `In ${channelIndex + 1}` : `Out ${outputLetter(channelIndex)}`
          } EQ`}
        />
      </div>
      <ResponseGraph
        eq={displayEq}
        capsByType={eqCapsByType}
        selectedRef={selectedStage}
        writeStatus={writeStatus}
        interactive={interactive}
        onSelectStage={setSelectedStage}
        onPreview={onPreview}
        onCommit={onCommit}
        onToggleActive={onToggleActive}
        onResetGain={onResetGain}
      />
      {/* One tile per stage, values as text; the selected stage gets the
       * real controls in the row below. Tiles keep a floor and the row
       * scrolls sideways below it. */}
      <div className="min-w-0 overflow-x-auto">
        <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${displayEq.bands.length + 2}, minmax(68px, 1fr))` }}>
          {stagesOf(displayEq).map((ref) => (
            <StageTile
              key={stageKey(ref)}
              stage={ref}
              eq={displayEq}
              capsByType={eqCapsByType}
              selected={sameStage(selectedStage, ref)}
              onSelect={() => setSelectedStage(sameStage(selectedStage, ref) ? null : ref)}
            />
          ))}
        </div>
      </div>
      {selectedStage ? (
        <StageEditor
          stage={selectedStage}
          eq={displayEq}
          capsByType={eqCapsByType}
          freqRange={freqRange}
          gainRange={gainRange}
          qRange={selectedStage.kind === "band" ? qRangeFor(displayEq.bands[selectedStage.bandIndex].filterType) : qRange}
          interactive={interactive}
          onBandChange={onBandChange}
          onCrossoverChange={onCrossoverChange}
          onWrite={onWrite}
        />
      ) : (
        <div className="rounded-lg border border-dashed border-[var(--amp-color-default-border)] px-3 py-2.5 text-center text-[length:var(--amp-font-size-xs)] text-[var(--amp-color-dimmed)]">
          Select a band in the graph or above to edit it.
        </div>
      )}
    </div>
  );
}

type CrossoverPatch = Partial<{ filterType: CrossoverFilterType; freqHz: number; active: boolean }>;
type BandPatch = Partial<{ filterType: EqFilterType; freqHz: number; gainDb: number; q: number; active: boolean }>;

const formatGain = (db: number) => `${db > 0 ? "+" : ""}${db.toFixed(1)} dB`;

/** The stage's filter type as the strip names it. */
function stageTypeLabel(eq: ChannelEq, ref: EqStageRef): string {
  if (ref.kind === "band") return EQ_FILTER_LABELS[eq.bands[ref.bandIndex].filterType];
  return CROSSOVER_FILTER_LABELS[(ref.kind === "hp" ? eq.hp : eq.lp).filterType];
}

/** One stage of the strip: its colour, name, type and values, as text. A
 * bypassed stage recedes so the stages shaping the signal read first. */
function StageTile({
  stage,
  eq,
  capsByType,
  selected,
  onSelect,
}: {
  stage: EqStageRef;
  eq: ChannelEq;
  capsByType: Record<EqFilterType, FilterCaps>;
  selected: boolean;
  onSelect: () => void;
}) {
  const info = stageInfo(eq, stage, capsByType);
  const blank = "\u00a0";
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`flex min-w-0 flex-col gap-0.5 rounded-md border px-2 pt-1.5 pb-2 text-left tabular-nums transition-colors ${
        selected
          ? "border-accent bg-accent-soft"
          : "border-[var(--amp-color-default-border)] hover:bg-[var(--amp-color-default-hover)]"
      } ${info.active || selected ? "" : "opacity-50"}`}
    >
      <span className="flex items-center gap-1.5">
        <span className="size-2 shrink-0 rounded-full" style={{ background: stageColor(stage) }} />
        <span className="text-[length:var(--amp-font-size-sm)] font-semibold">
          {stage.kind === "band" ? stage.bandIndex + 1 : stage.kind.toUpperCase()}
        </span>
      </span>
      <span className="truncate text-[length:var(--amp-font-size-xs)] text-[var(--amp-color-dimmed)]">
        {info.active ? stageTypeLabel(eq, stage) : "Bypassed"}
      </span>
      <span className="text-[length:var(--amp-font-size-xs)]">{freqText(info.freqHz)}</span>
      <span className="text-[length:var(--amp-font-size-xs)]">{info.supportsGain ? formatGain(info.gainDb) : blank}</span>
      <span className="text-[length:var(--amp-font-size-xs)]">{info.supportsQ ? `Q ${info.q.toFixed(2)}` : blank}</span>
    </button>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex w-[136px] flex-col gap-1">
      <span className="text-[length:var(--amp-font-size-xs)] font-medium text-[var(--amp-color-dimmed)]">{label}</span>
      {children}
    </label>
  );
}

/** The selected stage's real controls: type, frequency, gain and Q where the
 * type has them, and whether it is engaged. */
function StageEditor({
  stage,
  eq,
  capsByType,
  freqRange,
  gainRange,
  qRange,
  interactive,
  onBandChange,
  onCrossoverChange,
  onWrite,
}: {
  stage: EqStageRef;
  eq: ChannelEq;
  capsByType: Record<EqFilterType, FilterCaps>;
  freqRange: ParamRange;
  gainRange: ParamRange;
  qRange: ParamRange;
  interactive: boolean;
  onBandChange: (bandIndex: number, patch: BandPatch) => void;
  onCrossoverChange: (slot: CrossoverSlotKind, patch: CrossoverPatch) => void;
  /** Freq/gain/Q: held on screen while written, like a drag. */
  onWrite: (ref: EqStageRef, patch: PreviewPatch) => void;
}) {
  const info = stageInfo(eq, stage, capsByType);
  const change = (patch: BandPatch) =>
    stage.kind === "band" ? onBandChange(stage.bandIndex, patch) : onCrossoverChange(stage.kind, patch as CrossoverPatch);
  return (
    <div
      className="flex min-w-0 flex-wrap items-end gap-3 rounded-lg border px-3 py-2.5"
      style={{ borderColor: stageColor(stage), background: "var(--amp-graph-bg)" }}
    >
      <div className="flex h-8 w-[88px] items-center gap-2">
        <span className="size-2.5 shrink-0 rounded-full" style={{ background: stageColor(stage) }} />
        <span className="font-semibold">{stageName(stage)}</span>
      </div>
      <Field label="Type">
        {stage.kind === "band" ? (
          <SimpleSelect
            data={EQ_FILTER_OPTIONS}
            value={eq.bands[stage.bandIndex].filterType}
            onChange={(value) => value && change({ filterType: value as EqFilterType })}
          />
        ) : (
          <SimpleSelect
            data={CROSSOVER_FILTER_OPTIONS}
            value={(stage.kind === "hp" ? eq.hp : eq.lp).filterType}
            onChange={(value) => value && onCrossoverChange(stage.kind as CrossoverSlotKind, { filterType: value as CrossoverFilterType })}
          />
        )}
      </Field>
      <Field label="Frequency">
        <CommitNumberInput
          aria-label={`${stageName(stage)} frequency`}
          suffix=" Hz"
          scale="log"
          min={freqRange.min ?? undefined}
          max={freqRange.max ?? undefined}
          value={roundFreq(info.freqHz)}
          onCommit={(value) => onWrite(stage, { freqHz: value })}
        />
      </Field>
      {info.supportsGain && (
        <Field label="Gain">
          <CommitNumberInput
            aria-label={`${stageName(stage)} gain`}
            suffix=" dB"
            step={0.1}
            min={gainRange.min ?? undefined}
            max={gainRange.max ?? undefined}
            value={info.gainDb}
            onCommit={(value) => onWrite(stage, { gainDb: value })}
          />
        </Field>
      )}
      {info.supportsQ && (
        <Field label="Q">
          <CommitNumberInput
            aria-label={`${stageName(stage)} Q`}
            step={0.01}
            min={qRange.min ?? undefined}
            max={qRange.max ?? undefined}
            value={info.q}
            onCommit={(value) => onWrite(stage, { q: value })}
          />
        </Field>
      )}
      <div className="flex-1" />
      <Switch isSelected={info.active} isDisabled={!interactive} onChange={(active) => change({ active })}>
        {/* `Switch.Content` is the actual checkable element — see the note at
            the noise-gate switch in `AmpConfigureView`. */}
        <Switch.Content>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
          <span className="text-[length:var(--amp-font-size-sm)]">Active</span>
        </Switch.Content>
      </Switch>
    </div>
  );
}
