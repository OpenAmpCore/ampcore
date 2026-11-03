import type { ReactNode } from "react";
import { Switch } from "@heroui/react";
import { CommitNumberInput } from "../CommitNumberInput";
import { SimpleSelect } from "../SimpleSelect";
import type { EqStageRef } from "../../lib/filterResponse";
import type { ChannelEq, CrossoverFilterType, CrossoverSlotKind, EqFilterType, ParamRange } from "../../lib/bindings";
import { type FilterCaps, type PreviewPatch, freqText, roundFreq, stageColor, stageInfo, stageName } from "./eqStages";

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

export type CrossoverPatch = Partial<{ filterType: CrossoverFilterType; freqHz: number; active: boolean }>;

export type BandPatch = Partial<{ filterType: EqFilterType; freqHz: number; gainDb: number; q: number; active: boolean }>;

const formatGain = (db: number) => `${db > 0 ? "+" : ""}${db.toFixed(1)} dB`;

/** The stage's filter type as the strip names it. */
function stageTypeLabel(eq: ChannelEq, ref: EqStageRef): string {
  if (ref.kind === "band") return EQ_FILTER_LABELS[eq.bands[ref.bandIndex].filterType];
  return CROSSOVER_FILTER_LABELS[(ref.kind === "hp" ? eq.hp : eq.lp).filterType];
}

/** One stage of the strip: its colour, name, type and values, as text. A
 * bypassed stage recedes so the stages shaping the signal read first. */
export function StageTile({
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
export function StageEditor({
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
