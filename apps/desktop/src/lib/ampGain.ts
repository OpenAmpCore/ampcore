import type { ChannelConfigSnapshot } from "./bindings";

/** One output's amplifier gain as the amp reports it (FC=27), the input
 * sensitivity that follows from it, and the span it may be set within — all
 * computed by core (`capability::cvr::amp_gain_range_db`, filled in by
 * `driver.rs`). All `null` without a reading — rendered as "—", never as a
 * number. */
export interface AmpGainReading {
  gainDb: number | null;
  /** The input level (Vrms) that drives this output to the amp's full rated
   * output — the vendor app's "SEN". */
  sensitivityV: number | null;
  /** `null` when the amp's rated level is unknown, which also means the
   * gain can't be edited. */
  range: { min: number; max: number } | null;
}

export const NO_AMP_GAIN: AmpGainReading = { gainDb: null, sensitivityV: null, range: null };

export function ampGainReading(snapshot: ChannelConfigSnapshot | undefined, channelIndex: number): AmpGainReading {
  const channel = snapshot?.channels.find((c) => c.channelIndex === channelIndex);
  const gainDb = channel?.ampGainDb ?? null;
  if (gainDb === null) return NO_AMP_GAIN;
  const range = channel?.ampGainRangeDb;
  return {
    gainDb,
    sensitivityV: channel?.ampSensitivityV ?? null,
    range: range ? { min: range.min ?? 0, max: range.max ?? 0 } : null,
  };
}
