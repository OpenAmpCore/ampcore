import type { ChannelConfigSnapshot, PowerMode } from "./bindings";

/** One output's amplifier gain as the amp reports it (FC=27), the input
 * sensitivity that follows from it, and the span it may be set within. All
 * `null` without a reading — rendered as "—", never as a number. */
export interface AmpGainReading {
  gainDb: number | null;
  /** The input level (Vrms) that drives this output to the amp's full rated
   * output — the vendor app's "SEN". */
  sensitivityV: number | null;
  /** `null` when the base is unknown, which also means the gain can't be
   * edited — see `ampGainBaseDbv`. */
  range: { min: number; max: number } | null;
}

export const NO_AMP_GAIN: AmpGainReading = { gainDb: null, sensitivityV: null, range: null };

/** Mirrors `write_v118::AMP_GAIN_SPAN_DB`, which the backend enforces. */
const AMP_GAIN_SPAN_DB = 6;

/** The output's full rated level in dBV for its power mode — what its gain is
 * set against. Mirrors `write_v118::amp_gain_base_dbv`: discovery's `gainMax`
 * in low-ohm mode (a DSP-2004 reports 42, its 126.5 V rating; `0` when the amp
 * doesn't say), the line voltage in 70 V/100 V mode. `null` when unknown. */
export function ampGainBaseDbv(gainMax: number, powerMode: PowerMode | null): number | null {
  switch (powerMode) {
    case "lowOhm":
      return gainMax > 0 ? gainMax : null;
    case "v70":
      return 37;
    case "v100":
      return 40;
    default:
      return null;
  }
}

/** Sensitivity is derived, not read — full output less the gain,
 * `10^((base − gain) / 20)` V, the vendor's `MainVolGain::getSEN4Gain`. */
export function ampGainReading(
  snapshot: ChannelConfigSnapshot | undefined,
  channelIndex: number,
  gainMax: number,
): AmpGainReading {
  const channel = snapshot?.channels.find((c) => c.channelIndex === channelIndex);
  const gainDb = channel?.ampGainDb ?? null;
  if (gainDb === null) return NO_AMP_GAIN;
  const base = ampGainBaseDbv(gainMax, channel?.powerMode ?? null);
  if (base === null) return { gainDb, sensitivityV: null, range: null };
  return {
    gainDb,
    sensitivityV: 10 ** ((base - gainDb) / 20),
    range: { min: base - AMP_GAIN_SPAN_DB, max: base + AMP_GAIN_SPAN_DB },
  };
}
