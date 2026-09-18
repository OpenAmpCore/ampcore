import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Button, ButtonGroup, Spinner, Switch, Tooltip } from "@heroui/react";
import { Copy, RefreshCw } from "lucide-react";

import type { ActionResult } from "../lib/actionResult";
import { commands, type AmpCapability, type ChannelFirSnapshot } from "../lib/bindings";
import { buildFirResponseCurve } from "../lib/filterResponse";
import { FIR_MIN_DB, FirFrequencyGraph, FirImpulseGraph } from "./FirGraph";

const CAPTION_STYLE = {
  color: "var(--amp-color-dimmed)",
  fontSize: "var(--amp-font-size-xs)",
  textAlign: "center",
} as const;

/** Read-only view of one output channel's FIR filter, as read from the amp
 * with FC=43 (see `live/cvr/fir.rs`).
 *
 * Two views over one snapshot. The graphs (magnitude, then impulse) are what
 * the filter *does*; the raw JSON stays one click away because almost nothing
 * the vendor software displays on its FIR page comes off the wire — its sample
 * rate and "(Max 512)" are hardcoded literals, its tap count and zero-time are
 * derived from the coefficient array — and seeing the decoded snapshot
 * verbatim is what keeps that distinction visible rather than buried under a
 * chart.
 *
 * The **bypass flag** is editable here (FC=44, a one-byte write) and is the one
 * piece of FIR state that also lives in the project file, so it stays settable
 * on an offline amp even though the coefficients do not.
 *
 * Three things this panel cannot do, each for a different reason:
 * - **Import / Remove coefficients** — a 2093-byte frame needing outbound
 *   fragmentation the write path doesn't have yet.
 * - **Plot an offline amp** — the coefficients are not in FC=27 and are not
 *   persisted, so there is nothing to draw without a reachable device.
 * - **Anything on pre-1.1.8 firmware** — `capability.firmware.firFilters` is
 *   false, which gates the FC=43 read and the FC=44 write alike.
 *
 * All three say so rather than rendering a dead control, per
 * `configureActions.ts`'s "absence must explain itself" rule. */
export function FirPanel({
  deviceId,
  channelIndex,
  label,
  capability,
  bypassed = false,
  onBypassChange,
}: {
  /** The live amp this editor can actually reach right now — Direct Edit's
   * own device, or the online amp a project amp is following. `undefined` for
   * an offline project amp, or one deliberately disengaged from its device. */
  deviceId?: string;
  channelIndex: number;
  /** Output channel letter, for the heading (outputs are lettered — see
   * CLAUDE.md's labeling convention). */
  label: string;
  capability: AmpCapability;
  /** FC=44's current value — from the FC=27 poll when live, from the project
   * file when offline (see `AmpChannel.fir_bypassed`). */
  bypassed?: boolean;
  /** Omitted when the source cannot write the flag at all, in which case no
   * toggle renders rather than a dead one. */
  onBypassChange?: (bypassed: boolean) => Promise<ActionResult>;
}) {
  const supported = capability.firmware.firFilters;
  const [fir, setFir] = useState<ChannelFirSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [view, setView] = useState<"graph" | "json">("graph");
  const [writeError, setWriteError] = useState<string | null>(null);

  const fetchFir = useCallback(
    async (signal: { cancelled: boolean }) => {
      if (!deviceId || !supported) return;
      setLoading(true);
      setError(null);
      const result = await commands.liveControlFetchChannelFir(deviceId, channelIndex);
      if (signal.cancelled) return;
      setLoading(false);
      if (result.status === "ok") {
        setFir(result.data.fir);
      } else {
        // A fetch can genuinely fail — a busy device, an unknown firmware, a
        // reply of an unexpected length — so it must never fail in silence.
        setFir(null);
        setError(result.error.message);
      }
    },
    [deviceId, channelIndex, supported],
  );

  // Same cancelled-flag effect shape as `AmpConfigureView`'s capability
  // resolve. The panel is remounted per channel (`key` at the call site), so
  // this runs once per channel selection.
  useEffect(() => {
    const signal = { cancelled: false };
    void fetchFir(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [fetchFir]);

  // specta types the wire coefficients as `(number | null)[]`, so they are
  // coalesced once here rather than at each plot. Both derivations are
  // memoised because the magnitude curve is 800 points x up to 512 taps.
  const taps = useMemo(() => fir?.coefficients.map((c) => c ?? 0) ?? [], [fir]);
  const responseCurve = useMemo(
    () => (fir ? buildFirResponseCurve(taps, fir.sampleRateHz, FIR_MIN_DB) : []),
    [fir, taps],
  );

  const bypassToggle = onBypassChange ? (
    <BypassSwitch bypassed={bypassed} onChange={onBypassChange} onError={setWriteError} />
  ) : null;

  if (!supported) {
    return (
      <Centered>
        FIR filters require firmware 1.1.8 or newer
        {capability.firmware.vNum != null ? ` — this amp reports ${capability.firmware.vNum}.` : "."}
      </Centered>
    );
  }

  // The coefficients need a device, but the bypass flag is project state — so
  // this branch explains the missing plot and still offers the toggle.
  if (!deviceId) {
    return (
      <div className="flex h-full min-w-0 flex-col items-center justify-center gap-3 p-4">
        <span
          style={{
            color: "var(--amp-color-dimmed)",
            fontSize: "var(--amp-font-size-sm)",
            textAlign: "center",
            maxWidth: 420,
          }}
        >
          FIR coefficients live on the amp — they aren&apos;t part of the project
          file, so there is nothing to plot for Out{label} without a reachable
          device.
          {bypassToggle
            ? " The bypass flag below is stored in the project and applied on the next push."
            : ""}
        </span>
        {bypassToggle}
        {writeError && (
          <span style={{ color: "var(--amp-color-red-6)", fontSize: "var(--amp-font-size-xs)" }}>
            {writeError}
          </span>
        )}
      </div>
    );
  }

  async function handleCopy() {
    if (!fir) return;
    await navigator.clipboard.writeText(JSON.stringify(fir, null, 2));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-2 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span style={{ fontWeight: 600, fontSize: "var(--amp-font-size-sm)" }}>Out{label} FIR</span>
        {fir && (
          <span style={{ color: "var(--amp-color-dimmed)", fontSize: "var(--amp-font-size-xs)" }}>
            {fir.order} of {fir.maxTaps} taps · {fir.sampleRateHz / 1000} kHz · zero-time{" "}
            {fir.timeZeroMs ?? 0} ms · {fir.bodyLen}-byte reply
          </span>
        )}
        <div className="flex-1" />
        {bypassToggle}
        {fir && (
          <ButtonGroup size="sm" aria-label="FIR view">
            <Button variant={view === "graph" ? "primary" : "ghost"} onPress={() => setView("graph")}>
              Graph
            </Button>
            <Button variant={view === "json" ? "primary" : "ghost"} onPress={() => setView("json")}>
              JSON
            </Button>
          </ButtonGroup>
        )}
        <Tooltip delay={300}>
          <Tooltip.Trigger>
            <Button
              isIconOnly
              variant="ghost"
              aria-label="Refresh FIR data"
              onPress={() => void fetchFir({ cancelled: false })}
            >
              {loading ? <Spinner size="sm" /> : <RefreshCw size={16} />}
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content showArrow>Re-read from the amp</Tooltip.Content>
        </Tooltip>
        <Button size="sm" variant="secondary" isDisabled={!fir} onPress={() => void handleCopy()}>
          <Copy size={14} /> {copied ? "Copied" : "Copy JSON"}
        </Button>
      </div>

      {error && (
        <Alert status="danger">
          <Alert.Content>
            <Alert.Title>Could not read FIR data</Alert.Title>
            <Alert.Description>{error}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      {writeError && (
        <Alert status="danger">
          <Alert.Content>
            <Alert.Title>Could not change FIR bypass</Alert.Title>
            <Alert.Description>{writeError}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      {loading && !fir && (
        <div className="flex justify-center py-6">
          <Spinner size="sm" />
        </div>
      )}

      {fir && view === "graph" && (
        /* Centers while both charts fit and scrolls once they don't — the
           `CenteredScrollPane` idiom from `AmpConfigureView`, which is
           module-private there and too small to be worth exporting. */
        <div className="min-h-0 min-w-0 flex-1 overflow-auto">
          <div className="flex min-h-full min-w-0 flex-col justify-center gap-4">
            <figure className="m-0 flex min-w-0 flex-col gap-1">
              <FirFrequencyGraph points={responseCurve} />
              <figcaption style={CAPTION_STYLE}>
                Magnitude response — dB against frequency, floored at {FIR_MIN_DB} dB
              </figcaption>
            </figure>
            <figure className="m-0 flex min-w-0 flex-col gap-1">
              <FirImpulseGraph
                taps={taps}
                sampleRateHz={fir.sampleRateHz}
                timeZeroIndex={fir.timeZeroIndex}
              />
              <figcaption style={CAPTION_STYLE}>
                Impulse response — tap amplitude against time, t0 at tap {fir.timeZeroIndex}
              </figcaption>
            </figure>
          </div>
        </div>
      )}

      {fir && view === "json" && (
        /* Its own scroll container: 512 coefficients are far wider and taller
           than the pane, and per CLAUDE.md a grid with an irreducible width
           scrolls inside itself rather than pushing the window sideways. */
        <pre
          className="min-h-0 min-w-0 flex-1 overflow-auto rounded-md bg-[var(--amp-color-default)] p-2 font-mono"
          style={{ whiteSpace: "pre", fontSize: 11 }}
        >
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
        <span style={{ fontSize: "var(--amp-font-size-sm)" }}>Bypass</span>
      </Switch.Content>
    </Switch>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-4">
      <span
        style={{
          color: "var(--amp-color-dimmed)",
          fontSize: "var(--amp-font-size-sm)",
          textAlign: "center",
          maxWidth: 420,
        }}
      >
        {children}
      </span>
    </div>
  );
}
