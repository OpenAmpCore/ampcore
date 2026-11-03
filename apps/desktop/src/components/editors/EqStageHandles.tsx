import { useEffect, useLayoutEffect, useRef } from "react";
import { pathD, toPlotPoints, type PlotScale } from "./FrequencyPlot";
import { responseCurve } from "../../lib/eqResponse";
import type { EqStageRef, ResponsePoint } from "../../lib/filterResponse";
import type { ChannelEq, EqFilterType } from "../../lib/bindings";
import { CURVE_EASE, CURVE_POINTS, type FilterCaps, GRAPH_DB, GRAPH_HZ, GRAPH_MAX_HZ, GRAPH_MIN_HZ, type PreviewPatch, type WriteStatus, applyPreview, clampToRange, sameStage, stageColor, stageInfo, stageKey, stagesOf } from "./eqStages";

export const GRAPH_MIN_DB = -24;

export const GRAPH_MAX_DB = 24;

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

/** Converts a pointer event's client coordinates into the plot SVG's own
 * coordinate space (the one its scale and the handles use). */
function toViewBoxPoint(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } {
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const point = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
  return { x: point.x, y: point.y };
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
export function StageHandles({
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
