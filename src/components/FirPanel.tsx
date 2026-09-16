import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Spinner, Tooltip } from "@heroui/react";
import { Copy, RefreshCw } from "lucide-react";

import { commands, type AmpCapability, type ChannelFirSnapshot } from "../lib/bindings";

/** Read-only view of one output channel's FIR filter, as read from the amp
 * with FC=43 (see `live/cvr/fir.rs`).
 *
 * The data is rendered as raw JSON on purpose. This phase is about
 * establishing *what the amp actually returns*, and almost nothing the vendor
 * software displays on its FIR page comes off the wire — its sample rate and
 * "(Max 512)" are hardcoded literals, its tap count and zero-time are derived
 * from the coefficient array. Showing the decoded snapshot verbatim keeps that
 * distinction visible instead of burying it under a chart. The impulse /
 * frequency / phase graphs are a later rendering pass over this same data.
 *
 * Three things this panel cannot do, each for a different reason:
 * - **Import / Remove** — writing coefficients is a 2093-byte frame needing
 *   outbound fragmentation the write path doesn't have yet.
 * - **Read an offline amp** — FIR is not in FC=27 and is not persisted in the
 *   project file, so there is nothing to show without a reachable device.
 * - **Read pre-1.1.8 firmware** — `capability.firmware.firFilters` is false.
 *
 * All three say so rather than rendering a dead control, per
 * `configureActions.ts`'s "absence must explain itself" rule. */
export function FirPanel({
  deviceId,
  channelIndex,
  label,
  capability,
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
}) {
  const supported = capability.firmware.firFilters;
  const [fir, setFir] = useState<ChannelFirSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

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

  if (!supported) {
    return (
      <Centered>
        FIR filters require firmware 1.1.8 or newer
        {capability.firmware.vNum != null ? ` — this amp reports ${capability.firmware.vNum}.` : "."}
      </Centered>
    );
  }

  if (!deviceId) {
    return (
      <Centered>
        FIR data lives on the amp — it isn&apos;t part of the project file.
        Connect to this device to read Out{label}&apos;s filter.
      </Centered>
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

      {loading && !fir && (
        <div className="flex justify-center py-6">
          <Spinner size="sm" />
        </div>
      )}

      {fir && (
        /* Its own scroll container: 512 coefficients are far wider and taller
           than the pane, and per CLAUDE.md a grid with an irreducible width
           scrolls inside itself rather than pushing the window sideways. */
        <pre
          className="min-h-0 min-w-0 flex-1 overflow-auto rounded-[var(--amp-radius-sm)] bg-[var(--amp-color-default)] p-2 font-mono"
          style={{ whiteSpace: "pre", fontSize: 11 }}
        >
          {JSON.stringify(fir, null, 2)}
        </pre>
      )}
    </div>
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
