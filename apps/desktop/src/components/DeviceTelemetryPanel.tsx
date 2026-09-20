import type { ReactNode } from "react";
import { Chip } from "@heroui/react";
import type { ChannelConfig, ChannelConfigSnapshot, ChannelEq, DiscoveredDevice, Telemetry } from "../lib/bindings";
import { ChannelStateBadge } from "./ChannelStateBadge";
import { InputClipPill } from "./InputClipPill";
import { CHANNEL_STATE_LABEL } from "../lib/channelState";

export interface DeviceTelemetryPanelProps {
  device: DiscoveredDevice;
  telemetry?: Telemetry;
  channelConfig?: ChannelConfigSnapshot;
}

/** This app's live telemetry only ever comes from one function code today —
 * see `live/cvr/protocol.rs`'s `FC_HEARTBEAT = 6`. Shown as its own field so
 * it's visible in the UI, not just something stated in chat. */
const TELEMETRY_FUNCTION_CODE = "6 (HEARTBEAT)";
const CHANNEL_CONFIG_FUNCTION_CODE = "27 (SYNC_DATA)";

const DIMMED = "var(--amp-color-dimmed)";

function Divider() {
  return <hr className="m-0 border-t border-[var(--amp-color-default-border)]" />;
}

/** Compact label/value pair for the summary sections — several per row via
 * the wrapping flex row they sit in, not one row per field. */
function InfoField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: DIMMED, textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: "var(--amp-font-size-xs)", fontFamily: "monospace" }}>{value}</div>
    </div>
  );
}

function msAgo(timestamp: number | null): string {
  if (timestamp === null) return "—";
  return `${((Date.now() - timestamp) / 1000).toFixed(1)}s ago`;
}

function fmtNum(value: number | null, unit: string, decimals = 1): string {
  return value === null ? "—" : `${value.toFixed(decimals)}${unit}`;
}

/** "lowShelf" -> "Low Shelf", "butterworth12" -> "Butterworth 12" — display
 * nicety only, the raw enum value is what's actually parsed. */
function formatEnum(value: string): string {
  const spaced = value.replace(/([A-Z])/g, " $1").replace(/(\d+)/g, " $1");
  return (spaced.charAt(0).toUpperCase() + spaced.slice(1)).trim();
}

function EqTable({ label, eq }: { label: string; eq: ChannelEq }) {
  const rows = [
    { pos: "HP", filterType: eq.hp.filterType as string, freqHz: eq.hp.freqHz, gainDb: null as number | null, q: null as number | null, active: eq.hp.active },
    ...eq.bands.map((b, i) => ({ pos: String(i + 1), filterType: b.filterType as string, freqHz: b.freqHz, gainDb: b.gainDb, q: b.q, active: b.active })),
    { pos: "LP", filterType: eq.lp.filterType as string, freqHz: eq.lp.freqHz, gainDb: null as number | null, q: null as number | null, active: eq.lp.active },
  ];
  return (
    <div>
      <div style={{ fontSize: "var(--amp-font-size-xs)", color: DIMMED, marginBottom: 4 }}>{label}</div>
      <div className="overflow-x-auto" style={{ minWidth: 380 }}>
        <table className="mb-3 w-full border-collapse text-xs">
          <thead>
            <tr>
              <th className="p-1 text-left">Band</th>
              <th className="p-1 text-left">Type</th>
              <th className="p-1 text-left">Freq</th>
              <th className="p-1 text-left">Gain</th>
              <th className="p-1 text-left">Q</th>
              <th className="p-1 text-left">Active</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.pos} style={{ opacity: r.active ? 1 : 0.5 }}>
                <td className="p-1 font-mono font-semibold">{r.pos}</td>
                <td className="p-1">{formatEnum(r.filterType)}</td>
                <td className="p-1 font-mono">{fmtNum(r.freqHz, "Hz", 0)}</td>
                <td className="p-1 font-mono">{r.gainDb === null ? "—" : fmtNum(r.gainDb, "dB")}</td>
                <td className="p-1 font-mono">{r.q === null ? "—" : r.q.toFixed(2)}</td>
                <td className="p-1">{r.active ? "yes" : "no"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ChannelConfigBlock({ channel }: { channel: ChannelConfig }) {
  const label = String.fromCharCode(65 + channel.channelIndex);
  return (
    <div>
      <div style={{ fontWeight: 600, fontSize: "var(--amp-font-size-sm)", marginBottom: 8 }}>
        Channel {label}
      </div>
      <div className="mb-3 flex flex-wrap gap-4">
        <InfoField label="input name" value={channel.inputName ?? `In${channel.channelIndex + 1}`} />
        <InfoField label="output name" value={channel.outputName ?? `Out${label}`} />
        <InfoField label="load" value={fmtNum(channel.loadOhms, "Ω")} />
        <InfoField
          label="backup"
          value={
            channel.backupPriority.enabled
              ? `${channel.backupPriority.first}/${channel.backupPriority.second} @ ${channel.backupPriority.thresholdDb}dB`
              : "off"
          }
        />
        <InfoField label="delay in" value={fmtNum(channel.delayInMs, "ms")} />
        <InfoField label="input muted" value={channel.inputMuted ? "yes" : "no"} />
        <InfoField label="output trim" value={fmtNum(channel.outputTrimDb, "dB")} />
        <InfoField label="output volume" value={fmtNum(channel.outputVolumeDb, "dB")} />
        <InfoField label="output muted" value={channel.outputMuted ? "yes" : "no"} />
        <InfoField label="delay out" value={fmtNum(channel.delayOutMs, "ms")} />
        <InfoField label="phase inverted" value={channel.outputPhaseInverted ? "yes" : "no"} />
        <InfoField label="noise gate" value={channel.noiseGateEnabled ? "enabled" : "disabled"} />
        <InfoField label="FIR" value={channel.firBypassed ? "bypassed" : "enabled"} />
        <InfoField label="power mode" value={channel.powerMode ? formatEnum(channel.powerMode) : "—"} />
        <InfoField
          label="source"
          value={channel.source ? `${formatEnum(channel.source.kind)} ${channel.source.index}` : "—"}
        />
      </div>

      <div style={{ fontSize: "var(--amp-font-size-xs)", color: DIMMED, marginBottom: 4 }}>
        Per-source trim/delay
      </div>
      <table className="mb-3 w-full border-collapse text-xs">
        <thead>
          <tr>
            <th className="p-1 text-left">Source</th>
            <th className="p-1 text-left">Trim</th>
            <th className="p-1 text-left">Delay</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="p-1">Analog</td>
            <td className="p-1 font-mono">{fmtNum(channel.analogTrimDb, "dB")}</td>
            <td className="p-1 font-mono">{fmtNum(channel.analogDelayMs, "ms")}</td>
          </tr>
          <tr>
            <td className="p-1">Dante</td>
            <td className="p-1 font-mono">{fmtNum(channel.danteTrimDb, "dB")}</td>
            <td className="p-1 font-mono">{fmtNum(channel.danteDelayMs, "ms")}</td>
          </tr>
        </tbody>
      </table>

      <div style={{ fontSize: "var(--amp-font-size-xs)", color: DIMMED, marginBottom: 4 }}>
        Matrix crosspoints
      </div>
      <table className="mb-3 w-full border-collapse text-xs">
        <thead>
          <tr>
            <th className="p-1 text-left">Src</th>
            <th className="p-1 text-left">Gain</th>
            <th className="p-1 text-left">Active</th>
          </tr>
        </thead>
        <tbody>
          {channel.matrixCrosspoints.map((mx) => (
            <tr key={mx.sourceIndex}>
              <td className="p-1 font-mono">{mx.sourceIndex}</td>
              <td className="p-1 font-mono">{fmtNum(mx.gainDb, "dB")}</td>
              <td className="p-1">{mx.active ? "yes" : "no"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <EqTable label="Input EQ" eq={channel.inputEq} />
      <EqTable label="Output EQ" eq={channel.outputEq} />

      <div style={{ fontSize: "var(--amp-font-size-xs)", color: DIMMED, marginBottom: 4 }}>Limiter</div>
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr>
            <th className="p-1 text-left"></th>
            <th className="p-1 text-left">Enabled</th>
            <th className="p-1 text-left">Threshold</th>
            <th className="p-1 text-left">Attack/Hold</th>
            <th className="p-1 text-left">Release</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="p-1">RMS</td>
            <td className="p-1">{channel.limiter.rms.enabled ? "yes" : "no"}</td>
            <td className="p-1 font-mono">{fmtNum(channel.limiter.rms.thresholdVrms, "Vrms")}</td>
            <td className="p-1 font-mono">{fmtNum(channel.limiter.rms.attackMs, "ms")}</td>
            <td className="p-1 font-mono">
              {channel.limiter.rms.releaseMultiplier === null ? "—" : `${channel.limiter.rms.releaseMultiplier}×`}
            </td>
          </tr>
          <tr>
            <td className="p-1">Peak</td>
            <td className="p-1">{channel.limiter.peak.enabled ? "yes" : "no"}</td>
            <td className="p-1 font-mono">{fmtNum(channel.limiter.peak.thresholdVp, "Vp")}</td>
            <td className="p-1 font-mono">{fmtNum(channel.limiter.peak.holdMs, "ms")}</td>
            <td className="p-1 font-mono">{fmtNum(channel.limiter.peak.releaseMs, "ms")}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function ChannelConfigSection({ snapshot }: { snapshot: ChannelConfigSnapshot }) {
  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-4">
        <InfoField label="function code" value={CHANNEL_CONFIG_FUNCTION_CODE} />
        <InfoField label="received" value={msAgo(snapshot.receivedAt)} />
        <InfoField
          label="rotary locked"
          value={snapshot.rotaryLocked === null ? "— (unknown)" : snapshot.rotaryLocked ? "yes" : "no"}
        />
        <InfoField
          label="standby"
          value={
            snapshot.standby === null
              ? "— (unknown)"
              : snapshot.standby
                ? snapshot.standbyLocked
                  ? "yes (locked out)"
                  : "yes"
                : "no"
          }
        />
        <InfoField label="preset" value={snapshot.presetName ?? "—"} />
      </div>
      <div className="flex flex-col gap-6">
        {snapshot.channels.map((ch) => (
          <ChannelConfigBlock key={ch.channelIndex} channel={ch} />
        ))}
      </div>
    </div>
  );
}

/** Standalone-device telemetry view for the Live Control tab — deliberately
 * not `AmpConfigureView` (that component is `AmpAssignment`/Project-shaped;
 * a bare `DiscoveredDevice` has no project link this phase). No meters — one
 * row per channel with every field as a column, not one row per value. */
export function DeviceTelemetryPanel({ device, telemetry, channelConfig }: DeviceTelemetryPanelProps) {
  const outputCount = telemetry?.outputVoltages.length ?? device.outputChannels ?? 0;
  const inputCount = telemetry?.inputVoltages.length ?? device.analogInputChannels ?? 0;
  const firmwareSupported = device.firmwareFamily === "1.1.8" || device.firmwareFamily === "1.1.9";

  return (
    <div className="h-full overflow-y-auto">
      <div className="flex min-w-0 flex-col gap-4 p-4">
        <div className="flex items-start justify-between">
          <span style={{ fontWeight: 600 }}>{device.name || device.mac}</span>
          <Chip color={device.online ? "success" : "default"}>{device.online ? "Online" : "Offline"}</Chip>
        </div>

        <div className="flex flex-wrap gap-4">
          <InfoField label="id" value={device.id} />
          <InfoField label="driver" value={device.driverId} />
          <InfoField label="brand" value={device.brand} />
          <InfoField label="mac" value={device.mac} />
          <InfoField label="ip" value={device.ip} />
          <InfoField label="firmware version" value={device.firmwareVersion || "unknown"} />
          <InfoField label="firmware family" value={device.firmwareFamily ?? "unknown"} />
          <InfoField label="gain max" value={device.gainMax} />
          <InfoField label="analog in ch" value={device.analogInputChannels} />
          <InfoField label="digital in ch" value={device.digitalInputChannels} />
          <InfoField label="output ch" value={device.outputChannels} />
          <InfoField
            label="machine state"
            value={
              device.machineStateDecoded === null
                ? `— (raw ${device.machineState})`
                : `${CHANNEL_STATE_LABEL[device.machineStateDecoded]} (raw ${device.machineState})`
            }
          />
          <InfoField label="last seen" value={msAgo(device.lastSeenAt)} />
        </div>

        <Divider />

        <span style={{ fontWeight: 500, fontSize: "var(--amp-font-size-sm)", color: DIMMED }}>Telemetry</span>

        {!telemetry ? (
          <span style={{ color: DIMMED, fontSize: "var(--amp-font-size-sm)" }}>
            {firmwareSupported ? "Waiting for telemetry…" : "Telemetry isn't supported on this device's firmware yet."}
          </span>
        ) : (
          <>
            <div className="flex flex-wrap gap-4">
              <InfoField label="function code" value={TELEMETRY_FUNCTION_CODE} />
              <InfoField
                label="machine mode"
                value={
                  telemetry.machineStateDecoded === null
                    ? `— (raw ${telemetry.machineMode})`
                    : `${CHANNEL_STATE_LABEL[telemetry.machineStateDecoded]} (raw ${telemetry.machineMode})`
                }
              />
              <InfoField label="received" value={msAgo(telemetry.receivedAt)} />
              <InfoField
                label="rated RMS voltage"
                value={telemetry.ratedRmsVoltage === null ? "unknown model" : `${telemetry.ratedRmsVoltage}V`}
              />
            </div>

            <div>
              <div style={{ fontWeight: 500, fontSize: "var(--amp-font-size-sm)", color: DIMMED, marginBottom: 8 }}>
                Outputs
              </div>
              {/* Seven columns of monospace readings don't compress; below
                * their natural width the table scrolls sideways in place
                * instead of widening the whole panel. */}
              <div className="overflow-x-auto" style={{ minWidth: 420 }}>
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr>
                      <th className="p-1 text-left">Ch</th>
                      <th className="p-1 text-left">V</th>
                      <th className="p-1 text-left">A</th>
                      <th className="p-1 text-left">Ω</th>
                      <th className="p-1 text-left">Level</th>
                      <th className="p-1 text-left">Limiter</th>
                      <th className="p-1 text-left">State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from({ length: outputCount }, (_, i) => {
                      const voltage = telemetry.outputVoltages[i] ?? 0;
                      const current = telemetry.outputCurrents[i] ?? 0;
                      const impedance = telemetry.outputImpedance[i] ?? 0;
                      const levelDb = telemetry.outputLevelDb[i] ?? null;
                      const limiter = telemetry.limiters[i] ?? 0;
                      const state = telemetry.outputChannelStates[i] ?? null;
                      const stateRaw = telemetry.outputStates[i] ?? null;
                      return (
                        <tr key={i}>
                          <td className="p-1 font-mono font-semibold">{String.fromCharCode(65 + i)}</td>
                          <td className="p-1 font-mono">{voltage.toFixed(1)}</td>
                          <td className="p-1 font-mono">{current.toFixed(2)}</td>
                          <td className="p-1 font-mono">{impedance.toFixed(0)}</td>
                          <td className="p-1 font-mono">{levelDb === null ? "—" : levelDb.toFixed(1)}</td>
                          <td className="p-1 font-mono">{limiter.toFixed(1)}</td>
                          <td className="p-1">
                            <ChannelStateBadge state={state} raw={stateRaw} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div>
              <div style={{ fontWeight: 500, fontSize: "var(--amp-font-size-sm)", color: DIMMED, marginBottom: 8 }}>
                Inputs
              </div>
              <div className="overflow-x-auto" style={{ minWidth: 320 }}>
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr>
                      <th className="p-1 text-left">Ch</th>
                      <th className="p-1 text-left">Level</th>
                      <th className="p-1 text-left">V</th>
                      {/* Not "State": inputs have no operating state, only the
                          vendor's two-value `InStates` clip flag. */}
                      <th className="p-1 text-left">Clip</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from({ length: inputCount }, (_, i) => {
                      const dbfs = telemetry.inputDbfs[i] ?? null;
                      const voltage = telemetry.inputVoltages[i] ?? 0;
                      const clipping = telemetry.inputClipping[i] ?? null;
                      const clipRaw = telemetry.inputStates[i] ?? null;
                      return (
                        <tr key={i}>
                          <td className="p-1 font-mono font-semibold">{i + 1}</td>
                          <td className="p-1 font-mono">{dbfs === null ? "—" : `${dbfs.toFixed(1)}dB`}</td>
                          <td className="p-1 font-mono">{voltage.toFixed(3)}</td>
                          <td className="p-1">
                            {clipping === true ? (
                              <InputClipPill clipping raw={clipRaw} />
                            ) : (
                              <span style={{ fontSize: "var(--amp-font-size-xs)", color: DIMMED }}>
                                {clipping === false ? "no" : clipRaw === null ? "—" : `— (raw ${clipRaw})`}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="flex flex-wrap gap-4">
              {telemetry.temperatures.map((t, i) => (
                <InfoField key={i} label={i < 4 ? `ch ${i + 1} temp` : "psu temp"} value={`${(t ?? 0).toFixed(1)}°C`} />
              ))}
              <InfoField
                label="fan"
                value={telemetry.fanVoltage === null ? "— (not in this packet size)" : `${telemetry.fanVoltage.toFixed(1)}V`}
              />
            </div>
          </>
        )}

        <Divider />

        <span style={{ fontWeight: 500, fontSize: "var(--amp-font-size-sm)", color: DIMMED }}>
          Channel Config
        </span>

        {!channelConfig ? (
          <span style={{ color: DIMMED, fontSize: "var(--amp-font-size-sm)" }}>
            {firmwareSupported
              ? "Waiting for channel config…"
              : "Channel config isn't supported on this device's firmware yet."}
          </span>
        ) : (
          <ChannelConfigSection snapshot={channelConfig} />
        )}
      </div>
    </div>
  );
}
