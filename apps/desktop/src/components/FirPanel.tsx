import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Spinner, Switch, Tooltip } from "@heroui/react";
import { RefreshCw } from "lucide-react";

import type { ActionResult } from "../lib/actionResult";
import { commands, type AmpCapability, type ChannelEq, type ChannelFir, type ChannelFirSnapshot } from "../lib/bindings";
import { responseCurve } from "../lib/eqResponse";
import { useFirResponseCurve } from "../lib/filterResponse";
import { usePreference } from "../lib/preferences";
import { useConfirm } from "./ConfirmDialog";
import { formatDb, FrequencyPlot, toPlotPoints, type PlotAxis, type PlotCurve } from "./FrequencyPlot";
import { RowMenu } from "./SpeakerBench";

/** Parses an imported FIR file: one coefficient per line, tolerating the
 * vendor's own `"index value"`/`"index, value"` export shapes by taking the
 * text after the last space or comma. Unparsable lines are skipped rather
 * than aborting the whole import — mirrors the vendor's `ReadFIR_file`. No
 * tap cap here: the backend rejects an over-long import instead of this
 * silently dropping its tail. */
function parseFirTextFile(text: string): number[] {
  const values: number[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    const lastSpace = line.lastIndexOf(" ");
    const lastComma = line.lastIndexOf(",");
    const cut = Math.max(lastSpace, lastComma);
    if (cut > -1) line = line.slice(cut + 1);
    const value = Number.parseFloat(line);
    if (Number.isFinite(value)) values.push(value);
  }
  return values;
}

/** The project's stored filter in the shape the amp's reading has, so one
 * view draws both. Order and zero-time follow `live/cvr/fir.rs`: taps minus
 * trailing zeros, and the peak-magnitude tap (the positive one on a tie).
 * Buffer size and rate are the amp's (`capability.firmware`). */
function storedSnapshot(stored: ChannelFir, channelIndex: number, capability: AmpCapability): ChannelFirSnapshot {
  const { firMaxTaps: maxTaps, firSampleRateHz: sampleRateHz } = capability.firmware;
  const coefficients = Array.from({ length: maxTaps }, (_, i) => stored.coefficients[i] ?? 0);
  let order = coefficients.length;
  while (order > 0 && coefficients[order - 1] === 0) order--;
  const [max, min] = [Math.max(...coefficients), Math.min(...coefficients)];
  const timeZeroIndex = Math.max(0, coefficients.indexOf(Math.abs(max) >= Math.abs(min) ? max : min));
  return {
    channelIndex,
    name: stored.name,
    sampleRateHz,
    maxTaps,
    order,
    timeZeroIndex,
    timeZeroMs: Math.round(((timeZeroIndex * 1000) / sampleRateHz) * 1000) / 1000,
    coefficients,
    bodyLen: 0,
    receivedAt: 0,
  };
}

/** Deliberately *not* the EQ graph's ±24 dB: a FIR stopband goes tens of dB
 * deeper than any parametric band, and clamping it would flatten exactly the
 * rejection the filter exists to provide. Also the curve's floor in core. */
const FIR_MIN_DB = -60;
const FIR_DB_AXIS: PlotAxis = { min: FIR_MIN_DB, max: 12, ticks: [-60, -48, -36, -24, -12, 0, 12], format: formatDb };
const CURVE_POINTS = 360;

/** Candidate millisecond grid spacings for the impulse axis, coarsened until
 * the axis holds at most 8 labels. A 512-tap buffer at 48 kHz spans ~10.6 ms
 * and lands on 2 ms. */
const MS_GRID_STEPS = [0.5, 1, 2, 5, 10, 20, 50];

function formatAmp(value: number): string {
  const abs = Math.abs(value);
  if (abs === 0) return "0";
  return abs >= 0.001 ? value.toFixed(3) : value.toExponential(1);
}

const EQ_IS_FLAT = (eq: ChannelEq) => !eq.hp.active && !eq.lp.active && eq.bands.every((b) => !b.active);

/** One output channel's FIR filter: what it does (magnitude, with the
 * channel's EQ beside it, and the impulse), what it is (taps,
 * rate, zero-time), whether it is engaged, and Import / Export / Clear.
 *
 * With a reachable device the plot is the amp's own reading (FC=43, see
 * `live/cvr/fir.rs`). Without one it is the filter the project prescribes
 * (`stored`, `AmpChannel.fir`); Import and Clear then edit the project, and
 * the next push writes the amp. The **bypass flag** (FC=44) is project state
 * as well.
 *
 * The decoded snapshot as JSON is a developer view: it appears only with
 * Settings → Debug → raw telemetry on.
 *
 * Pre-1.1.8 firmware has no FIR (`capability.firmware.firFilters`, which
 * gates FC=43 and FC=44 alike), and the panel says so rather than rendering
 * dead controls, per `configureActions.ts`'s "absence must explain itself". */
export function FirPanel({
  deviceId,
  channelIndex,
  label,
  capability,
  eq,
  bypassed = false,
  stored,
  onBypassChange,
  onImportData,
  onClearData,
}: {
  /** The filter the project prescribes for this output (`AmpChannel.fir`) —
   * what is plotted when there is no device to read. */
  stored?: ChannelFir;
  /** The live amp this editor can actually reach right now — Direct Edit's
   * own device, or the online amp a project amp is following. `undefined` for
   * an offline project amp, or one deliberately disengaged from its device. */
  deviceId?: string;
  channelIndex: number;
  /** Output channel letter (outputs are lettered — CLAUDE.md). */
  label: string;
  capability: AmpCapability;
  /** The channel's output EQ, drawn with the filter: they run in series. */
  eq?: ChannelEq;
  /** FC=44's current value — from the FC=27 poll when live, from the project
   * file when offline (see `AmpChannel.fir_bypassed`). */
  bypassed?: boolean;
  /** Omitted when the source cannot write the flag at all, in which case no
   * toggle renders rather than a dead one. */
  onBypassChange?: (bypassed: boolean) => Promise<ActionResult>;
  /** FC=43 Import. Omitted (no menu item) wherever coefficients can't be
   * written — Project mode, an offline amp, or edit-locked. */
  onImportData?: (name: string, coefficients: number[]) => Promise<ActionResult>;
  /** FC=43 Remove. Same absence rule as `onImportData`. */
  onClearData?: () => Promise<ActionResult>;
}) {
  const supported = capability.firmware.firFilters;
  const showRaw = usePreference("showRawTelemetry");
  const [read, setRead] = useState<ChannelFirSnapshot | null>(null);
  // With a device its reading is shown; without one, the project's filter.
  const fir = useMemo(
    () => read ?? (deviceId || !stored ? null : storedSnapshot(stored, channelIndex, capability)),
    [read, deviceId, stored, channelIndex, capability],
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<"graph" | "json">("graph");
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { confirm, dialog } = useConfirm();

  const fetchFir = useCallback(
    async (signal: { cancelled: boolean }) => {
      if (!deviceId || !supported) return;
      setLoading(true);
      setError(null);
      const result = await commands.liveControlFetchChannelFir(deviceId, channelIndex);
      if (signal.cancelled) return;
      setLoading(false);
      if (result.status === "ok") {
        setRead(result.data.fir);
      } else {
        // A fetch can genuinely fail — a busy device, an unknown firmware, a
        // reply of an unexpected length — so it must never fail in silence.
        setRead(null);
        setError(`Could not read the FIR filter: ${result.error.message}`);
      }
    },
    [deviceId, channelIndex, supported],
  );

  // The panel is remounted per channel (`key` at the call site), so this runs
  // once per channel selection.
  useEffect(() => {
    const signal = { cancelled: false };
    void fetchFir(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [fetchFir]);

  // specta types the wire coefficients as `(number | null)[]`; coalesced once.
  const taps = useMemo(() => fir?.coefficients.map((c) => c ?? 0) ?? null, [fir]);
  const firCurve = useFirResponseCurve(taps, fir?.sampleRateHz ?? capability.firmware.firSampleRateHz, FIR_MIN_DB, CURVE_POINTS);
  const eqShown = eq && !EQ_IS_FLAT(eq) ? eq : null;
  const eqCurve = useMemo(() => (eqShown ? responseCurve(eqShown, null, CURVE_POINTS) : null), [eqShown]);

  const magnitudeCurves = useMemo(() => {
    const list: PlotCurve[] = [];
    if (eqCurve) list.push({ key: "eq", points: toPlotPoints(eqCurve), color: "var(--amp-color-dimmed)", width: 1.5, dash: "5 4", label: "EQ" });
    if (firCurve) list.push({ key: "fir", points: toPlotPoints(firCurve), color: "var(--accent)", width: 2.2, label: "FIR" });
    return list;
  }, [eqCurve, firCurve]);

  const impulse = useMemo(() => {
    if (!taps || !fir) return null;
    const peak = taps.reduce((m, t) => Math.max(m, Math.abs(t)), 0) || 1;
    const perMs = fir.sampleRateHz / 1000;
    const totalMs = Math.max(taps.length - 1, 1) / perMs;
    const step = MS_GRID_STEPS.find((s) => totalMs / s <= 8) ?? MS_GRID_STEPS[MS_GRID_STEPS.length - 1];
    const ticks: number[] = [];
    for (let ms = 0; ms <= totalMs + 1e-9; ms += step) ticks.push(Number(ms.toFixed(3)));
    const x: PlotAxis = { min: 0, max: totalMs, ticks, format: (ms) => `${Number(ms.toFixed(2))} ms` };
    // Symmetric around the peak tap: coefficients have no natural scale (a
    // smoothing filter's may all sit near 0.002).
    const y: PlotAxis = { min: -peak, max: peak, ticks: [-peak, 0, peak], format: formatAmp };
    const curve: PlotCurve = { key: "taps", points: taps.map((t, i) => ({ x: i / perMs, y: t })), color: "var(--accent)", width: 1.5, label: "Tap" };
    return { x, y, curve, t0Ms: fir.timeZeroIndex / perMs };
  }, [taps, fir]);

  if (!supported) {
    return (
      <p className="m-0 p-4 text-center text-[length:var(--amp-font-size-sm)] text-[var(--amp-color-dimmed)]">
        FIR filters require firmware 1.1.8 or newer
        {capability.firmware.vNum != null ? ` — this amp reports ${capability.firmware.vNum}.` : "."}
      </p>
    );
  }

  async function run(action: () => Promise<ActionResult>) {
    setBusy(true);
    setError(null);
    const result = await action();
    setBusy(false);
    if (result.ok) void fetchFir({ cancelled: false });
    else setError(result.message);
  }

  async function handleImportFile(file: File) {
    if (!onImportData) return;
    const coefficients = parseFirTextFile(await file.text());
    const name = file.name.replace(/\.[^./\\]+$/, "");
    // An empty parse would still write a buffer of zero taps — silencing the output.
    if (coefficients.length === 0) return setError(`"${file.name}" contains no FIR coefficients.`);
    const replace = await confirm({
      title: "Import FIR filter",
      description: `Replace the FIR filter on Out ${label} with ${coefficients.length} taps from "${file.name}"?`,
      confirmLabel: "Import",
    });
    if (replace) await run(() => onImportData(name, coefficients));
  }

  async function handleMenu(id: string) {
    if (id === "import") fileInputRef.current?.click();
    else if (id === "export" && fir) {
      // One coefficient per line — the vendor's own `ExportFIR_file` shape.
      const text = fir.coefficients.map((c) => c ?? 0).join("\n");
      const result = await commands.saveTextFile(`${fir.name?.trim() || `out${label}-fir`}.txt`, text, "Text", ["txt"]);
      if (result.status === "error") setError(result.error.message);
    } else if (id === "clear" && onClearData) {
      const clear = await confirm({
        title: "Clear FIR filter",
        description: `Remove the FIR filter loaded on Out ${label}?`,
        confirmLabel: "Clear",
        tone: "danger",
      });
      if (clear) await run(onClearData);
    } else if (id === "copy" && fir) await navigator.clipboard.writeText(JSON.stringify(fir, null, 2));
    else if (id === "json") setView((v) => (v === "json" ? "graph" : "json"));
  }

  const menu = [
    ...(onImportData ? [{ id: "import", label: "Import from file…" }] : []),
    ...(fir ? [{ id: "export", label: "Export to file…" }] : []),
    ...(fir && onClearData ? [{ id: "clear", label: "Clear filter", danger: true }] : []),
    ...(fir && showRaw ? [{ id: "copy", label: "Copy as JSON" }, { id: "json", label: view === "json" ? "Show graphs" : "Show JSON" }] : []),
  ];

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-semibold">{fir?.name?.trim() || (fir ? "Unnamed filter" : "No filter read")}</span>
          {fir && (
            <span className="text-[length:var(--amp-font-size-xs)] text-[var(--amp-color-dimmed)] tabular-nums">
              {fir.order} of {fir.maxTaps} taps · {fir.sampleRateHz / 1000} kHz · zero-time {fir.timeZeroMs ?? 0} ms
              {deviceId ? "" : " · the project's filter, written with the next push"}
              {showRaw && deviceId ? ` · ${fir.bodyLen}-byte reply` : ""}
            </span>
          )}
        </div>
        {onBypassChange && <BypassSwitch bypassed={bypassed} onChange={onBypassChange} onError={setError} />}
        {deviceId && (
          <Tooltip delay={300}>
            <Tooltip.Trigger>
              <Button isIconOnly size="sm" variant="ghost" aria-label="Re-read from the amp" onPress={() => void fetchFir({ cancelled: false })}>
                {loading ? <Spinner size="sm" /> : <RefreshCw size={16} />}
              </Button>
            </Tooltip.Trigger>
            <Tooltip.Content showArrow>Re-read from the amp</Tooltip.Content>
          </Tooltip>
        )}
        <RowMenu label="FIR actions" items={menu} disabled={busy} onAction={(id) => void handleMenu(id)} />
        <input
          ref={fileInputRef}
          type="file"
          accept=".txt,.csv"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void handleImportFile(file);
          }}
        />
      </div>

      {error && <p className="m-0 text-[length:var(--amp-font-size-sm)] text-danger">{error}</p>}
      {dialog}

      {loading && !fir && (
        <div className="flex justify-center py-6">
          <Spinner size="sm" />
        </div>
      )}

      {fir && view === "graph" && (
        <>
          <FrequencyPlot
            y={FIR_DB_AXIS}
            curves={magnitudeCurves}
            ariaLabel="FIR magnitude response"
            className="h-[clamp(200px,34vh,340px)] overflow-hidden rounded-xl border border-[var(--amp-color-default-border)]"
          />
          {impulse && (
            <FrequencyPlot
              x={impulse.x}
              y={impulse.y}
              curves={[impulse.curve]}
              readoutFormat={formatAmp}
              ariaLabel="FIR impulse response"
              className="h-[clamp(140px,20vh,200px)] overflow-hidden rounded-xl border border-[var(--amp-color-default-border)]"
              overlay={(scale) => (
                // Zero-time marker — ties the plot to the zero-time stat above.
                <g pointerEvents="none">
                  <line
                    x1={scale.toX(impulse.t0Ms)}
                    x2={scale.toX(impulse.t0Ms)}
                    y1={scale.plot.top}
                    y2={scale.plot.top + scale.plot.height}
                    stroke="var(--amp-graph-stage)"
                    strokeWidth={1.5}
                    strokeDasharray="4 3"
                  />
                  <text x={scale.toX(impulse.t0Ms) + 4} y={scale.plot.top + 10} style={{ fontSize: "var(--amp-font-size-xs)", fill: "var(--amp-graph-stage)" }}>
                    t0
                  </text>
                </g>
              )}
            />
          )}
        </>
      )}

      {fir && view === "json" && (
        /* Its own scroll container: the coefficients are far wider and taller
           than the pane (CLAUDE.md: an irreducible width scrolls inside itself). */
        <pre className="m-0 max-h-[60vh] min-w-0 overflow-auto rounded-md bg-[var(--amp-color-default)] p-2 font-mono text-[11px] whitespace-pre">
          {JSON.stringify(fir, null, 2)}
        </pre>
      )}
    </div>
  );
}

/** FC=44 is delivery-ACKed only, like every other write in this app, so this
 * never flips itself optimistically — the displayed state comes from the next
 * FC=27 poll (live) or the returned project (offline). It only disables while
 * a write is in flight and hands a failure back to the panel. */
function BypassSwitch({
  bypassed,
  onChange,
  onError,
}: {
  bypassed: boolean;
  onChange: (bypassed: boolean) => Promise<ActionResult>;
  onError: (message: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);

  return (
    <Switch
      isSelected={bypassed}
      isDisabled={busy}
      onChange={(isSelected) => {
        void (async () => {
          setBusy(true);
          onError(null);
          const result = await onChange(isSelected);
          setBusy(false);
          if (!result.ok) onError(result.message);
        })();
      }}
    >
      {/* `Switch.Content` is the actual checkable element — see the note at
          the noise-gate switch in `AmpConfigureView`. */}
      <Switch.Content>
        <Switch.Control>
          <Switch.Thumb />
        </Switch.Control>
        <span className="text-[length:var(--amp-font-size-sm)]">Bypass</span>
      </Switch.Content>
    </Switch>
  );
}
