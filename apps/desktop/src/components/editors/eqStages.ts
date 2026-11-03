import type { EqStageRef } from "../../lib/filterResponse";
import type { AmpCapability_Serialize as AmpCapability, ChannelEq, EqFilterType, ParamRange } from "../../lib/bindings";
import { GRAPH_MAX_DB, GRAPH_MIN_DB } from "./EqStageHandles";

/** What one filter type exposes: gain and/or Q, and a Q range narrower than
 * `paramRanges.eqBandQ` where the type has one (shelves — see
 * `EqFilterType::q_range` in core). */
export type FilterCaps = { supportsGain: boolean; supportsQ: boolean; qRange: ParamRange | null };

/** `filterType -> {supportsGain, supportsQ, qRange}` lookup, keyed for O(1) access —
 * built once from `AmpCapability.eqFilterCapabilities`, the backend-resolved
 * source of truth (`eq_filter_capabilities()` in
 * `src-tauri/src/data/capability/mod.rs`). Not hardcoded here: if a future
 * model/firmware ever needs a different gain/Q table, this stays correct
 * automatically, same as every other capability this app reads off
 * `AmpCapability` instead of assuming per-model.  */
export function indexEqFilterCapabilities(
  entries: AmpCapability["eqFilterCapabilities"],
): Record<EqFilterType, FilterCaps> {
  const map = {} as Record<EqFilterType, FilterCaps>;
  for (const entry of entries) {
    map[entry.filterType] = { supportsGain: entry.supportsGain, supportsQ: entry.supportsQ, qRange: entry.qRange };
  }
  return map;
}

export const GRAPH_MIN_HZ = 20;

export const GRAPH_MAX_HZ = 20000;

export const GRAPH_HZ = { min: GRAPH_MIN_HZ, max: GRAPH_MAX_HZ };

export const GRAPH_DB = { min: GRAPH_MIN_DB, max: GRAPH_MAX_DB };

/** Which of the 10 stages a `ref` and `b` name are the same one — `null`
 * only equals `null`. */
export function sameStage(a: EqStageRef | null, b: EqStageRef | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "band" && b.kind === "band") return a.bandIndex === b.bandIndex;
  return true;
}

export function stageKey(ref: EqStageRef): string {
  return ref.kind === "band" ? `band-${ref.bandIndex}` : ref.kind;
}

/** HP is 0, bands 1-8, LP 9 — the position in the chain and in the strip. */
function stageIndex(ref: EqStageRef): number {
  return ref.kind === "hp" ? 0 : ref.kind === "lp" ? 9 : ref.bandIndex + 1;
}

/** The stage's own colour (`--amp-band-*`): its handle, isolated curve and tile. */
export function stageColor(ref: EqStageRef): string {
  return `var(--amp-band-${stageIndex(ref)})`;
}

export function stageName(ref: EqStageRef): string {
  return ref.kind === "band" ? `Band ${ref.bandIndex + 1}` : ref.kind.toUpperCase();
}

/** HP, every band, LP — the chain in order. */
export function stagesOf(eq: ChannelEq): EqStageRef[] {
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
export function stageInfo(
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
export type PreviewPatch = Partial<{ freqHz: number; gainDb: number; q: number }>;

/** Splices a preview patch into a `ChannelEq` immutably — the value
 * `ResponseGraph` and the strip below both render from during an in-progress
 * drag, before anything is actually written. */
export function applyPreview(eq: ChannelEq, preview: { ref: EqStageRef; patch: PreviewPatch } | null): ChannelEq {
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
export type WriteStatus = "pending" | "ok" | "fail";

/** A written patch held on screen from the moment it is sent until the amp's
 * own reading agrees with it (or `WRITE_HOLD_MS` passes), so the point never
 * falls back to the old value while the write and the next poll are on
 * their way. */
export type StageWrite = { ref: EqStageRef; patch: PreviewPatch; acked: boolean; token: number };

/** A curve or ring easing back from a result flash to its own colour. */
export const CURVE_EASE = "transition-[stroke] duration-500";

/** The amp's reading matches what was written — f32 read-back included. */
export function writeConfirmed(eq: ChannelEq, write: StageWrite, capsByType: Record<EqFilterType, FilterCaps>): boolean {
  const info = stageInfo(eq, write.ref, capsByType);
  const { freqHz, gainDb, q } = write.patch;
  return (
    (freqHz === undefined || Math.abs(info.freqHz - freqHz) <= 0.5) &&
    (gainDb === undefined || Math.abs(info.gainDb - gainDb) <= 0.05) &&
    (q === undefined || Math.abs(info.q - q) <= 0.005)
  );
}

export function roundFreq(hz: number): number {
  return Math.round(hz);
}

export function roundGain(db: number): number {
  return Math.round(db * 10) / 10;
}

export function roundQ(q: number): number {
  return Math.round(q * 100) / 100;
}

export function clampToRange(value: number, range: { min: number | null; max: number | null }): number {
  let v = value;
  if (range.min != null) v = Math.max(range.min, v);
  if (range.max != null) v = Math.min(range.max, v);
  return v;
}

export function freqText(hz: number): string {
  return hz >= 1000 ? `${(hz / 1000).toFixed(2)} kHz` : `${Math.round(hz)} Hz`;
}

/** Points per curve. Computed locally in the same frame, so this is about
 * smoothness, not speed: 240 keeps a 48 dB/oct slope crisp. */
export const CURVE_POINTS = 240;
