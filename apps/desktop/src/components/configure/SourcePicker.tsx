import { useState } from "react";
import { Switch } from "@heroui/react";
import { CommitNumberInput } from "../CommitNumberInput";
import { SimpleSelect } from "../SimpleSelect";
import { StatEditorTile } from "../StatTiles";
import { useActionFeedback } from "../../hooks/useActionFeedback";
import type { ActionResult } from "../../lib/actionResult";
import type { AmpParamRanges, BackupPriority, ChannelSource, SourceChannelCount, SourceKind, SourceTrims } from "../../lib/bindings";
import { EditorRow, TilePopover } from "./parts";

const SOURCE_LABELS: Record<SourceKind, string> = {
  analog: "Analog",
  dante: "Dante",
  backup: "Backup",
  // Reported by the amp, never offered: shown so it isn't mistaken for Analog.
  aes3: "AES3",
};

/** Width of the Routing tab's Source column — wider than a strip tile, since
 * it holds a source name rather than a short number. The grid column reads
 * this too, so the tile always fills its column exactly. */
const SOURCE_TILE_WIDTH = 150;

/** The amp's own source-code space, shared by `FC_SOURCE_SELECT` (11) and the
 * backup priority struct (FC=80) — `BackupPriority.first`/`second` are raw
 * codes, not `SourceKind`s, because that is how the amp stores them. Backup
 * has no code of its own: it is the failover *state*, not a selectable
 * input. */
const SOURCE_CODES: Partial<Record<SourceKind, number>> = { analog: 0, dante: 1 };

const SOURCE_KIND_BY_CODE: Record<number, SourceKind> = { 0: "analog", 1: "dante" };

/** Source editor for one channel — the Routing tab's Source cell.
 *
 * A popover rather than extra grid columns: the matrix beside it already has
 * an irreducible width and scrolls sideways, so four more columns of Delay /
 * Trim / Backup would cost real horizontal room on a restored-down window.
 *
 * Every available source's trim and delay stay editable regardless of which
 * one is selected — that independence is the point of per-source values (the
 * amp keeps a pair per source, and the vendor UI lets you pre-trim a source
 * you are about to switch to). */
export function SourcePicker({
  source,
  sourceCounts,
  channelIndex,
  sourceTrims,
  backupPriority,
  paramRanges,
  onSelect,
  onTrimChange,
  onBackupChange,
}: {
  source: ChannelSource;
  sourceCounts: SourceChannelCount[];
  channelIndex: number;
  sourceTrims: SourceTrims;
  backupPriority: BackupPriority;
  paramRanges: AmpParamRanges;
  onSelect: (kind: SourceKind, index: number) => Promise<ActionResult>;
  onTrimChange: (kind: SourceKind, trimDb: number, delayMs: number) => Promise<ActionResult>;
  onBackupChange: (first: number, second: number, enabled: boolean, thresholdDb: number) => Promise<ActionResult>;
}) {
  const feedback = useActionFeedback();
  const [open, setOpen] = useState(false);

  const selectable = sourceCounts.filter((sc) => SOURCE_CODES[sc.kind] !== undefined);
  // `builtin_topology` only offers Dante on a Dante-fitted amp, so a second
  // selectable source is exactly the condition for backup being meaningful.
  const backupAvailable = selectable.length > 1;

  const trimFor = (kind: SourceKind) => (kind === "dante" ? sourceTrims.dante : sourceTrims.analog);
  const trimRange = (kind: SourceKind) =>
    kind === "analog" ? paramRanges.sourceTrimAnalogDb : paramRanges.sourceTrimDigitalDb;

  const primaryCode = backupPriority.first;
  // With two sources the fallback is never a free choice, so it is derived
  // rather than offered — matching the vendor, whose third priority slot is
  // likewise computed and never sent.
  const complementOf = (code: number) => (code === 0 ? 1 : 0);

  return (
    <TilePopover
      opened={open}
      onOpenChange={setOpen}
      width={260}
      placement="bottom"
      trigger={
        <StatEditorTile
          width={SOURCE_TILE_WIDTH}
          value={SOURCE_LABELS[source.kind]}
          label={`Input ${source.index + 1}`}
          visualValidation={feedback}
          onClick={() => setOpen((o) => !o)}
        />
      }
    >
      <div className="flex flex-col gap-3">
        {selectable.map((sc) => {
          const isActive = source.kind === sc.kind;
          const trim = trimFor(sc.kind);
          // A non-patchable kind is wired 1:1 to this slot (Dante channel N
          // feeds digital input N); only Analog is freely patchable.
          const fixedIndex = sc.patchable ? source.index : channelIndex;
          return (
            <div key={sc.kind} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  aria-label={`Select ${SOURCE_LABELS[sc.kind]}`}
                  onClick={() => void feedback.track(onSelect(sc.kind, fixedIndex))}
                  className="flex cursor-pointer items-center gap-2 border-0 bg-transparent p-0"
                >
                  <span
                    className="flex size-3.5 items-center justify-center rounded-full border border-solid"
                    style={{ borderColor: isActive ? "var(--accent)" : "var(--amp-color-default-border)" }}
                  >
                    {isActive && <span className="size-2 rounded-full" style={{ background: "var(--accent)" }} />}
                  </span>
                  <span style={{ fontWeight: isActive ? 600 : 400 }}>{SOURCE_LABELS[sc.kind]}</span>
                </button>
                {sc.patchable && sc.channelCount > 1 && (
                  <div className="ml-auto w-[88px]">
                    <SimpleSelect
                      data={Array.from({ length: sc.channelCount }).map((_, i) => ({
                        value: String(i),
                        label: `${SOURCE_LABELS[sc.kind]} ${i + 1}`,
                      }))}
                      value={String(isActive ? source.index : fixedIndex)}
                      onChange={(next) => next !== null && void feedback.track(onSelect(sc.kind, Number(next)))}
                    />
                  </div>
                )}
              </div>
              {/* The vendor's per-source "gain/delay matching" (FC=62): a
               * hardware preset recalls which source is used, not these. */}
              <div
                className="flex flex-col gap-1.5 rounded-md border border-dashed p-1.5"
                style={{ borderColor: "var(--amp-color-orange-6)" }}
              >
                <EditorRow label="Delay">
                  <CommitNumberInput
                    value={trim.delayMs ?? 0}
                    min={paramRanges.sourceDelayMs.min ?? 0}
                    max={paramRanges.sourceDelayMs.max ?? 30}
                    step={0.01}
                    suffix="ms"
                    onCommit={(delayMs) => void feedback.track(onTrimChange(sc.kind, trim.trimDb ?? 0, delayMs))}
                  />
                </EditorRow>
                <EditorRow label="Trim">
                  <CommitNumberInput
                    value={trim.trimDb ?? 0}
                    min={trimRange(sc.kind).min ?? -18}
                    max={trimRange(sc.kind).max ?? 18}
                    step={0.1}
                    suffix="dB"
                    onCommit={(trimDb) => void feedback.track(onTrimChange(sc.kind, trimDb, trim.delayMs ?? 0))}
                  />
                </EditorRow>
                <span style={{ fontSize: 10, color: "var(--amp-color-orange-6)" }}>Not in hardware presets.</span>
              </div>
            </div>
          );
        })}

        {backupAvailable && (
          <div
            className="flex flex-col gap-1.5 border-0 border-t border-solid pt-3"
            style={{ borderColor: "var(--amp-color-default-border)" }}
          >
            <div className="flex items-center justify-between gap-2">
              <span style={{ fontWeight: 500 }}>Backup</span>
              <Switch
                size="sm"
                isSelected={backupPriority.enabled}
                onChange={(enabled) =>
                  void feedback.track(
                    onBackupChange(primaryCode, complementOf(primaryCode), enabled, backupPriority.thresholdDb),
                  )
                }
              />
            </div>
            <EditorRow label="Primary">
              <SimpleSelect
                data={selectable.map((sc) => ({ value: String(SOURCE_CODES[sc.kind]), label: SOURCE_LABELS[sc.kind] }))}
                value={String(primaryCode)}
                onChange={(next) => {
                  if (next === null) return;
                  const first = Number(next);
                  void feedback.track(
                    onBackupChange(first, complementOf(first), backupPriority.enabled, backupPriority.thresholdDb),
                  );
                }}
              />
            </EditorRow>
            <EditorRow label="Threshold">
              <CommitNumberInput
                value={backupPriority.thresholdDb}
                integer
                min={paramRanges.backupThresholdDb.min ?? -80}
                max={paramRanges.backupThresholdDb.max ?? 0}
                step={1}
                suffix="dB"
                onCommit={(thresholdDb) =>
                  void feedback.track(
                    onBackupChange(primaryCode, complementOf(primaryCode), backupPriority.enabled, thresholdDb),
                  )
                }
              />
            </EditorRow>
            <span style={{ fontSize: 10, color: "var(--amp-color-dimmed)" }}>
              Falls back to {SOURCE_LABELS[SOURCE_KIND_BY_CODE[complementOf(primaryCode)] ?? "analog"]} when the primary
              drops below the threshold.
            </span>
          </div>
        )}
      </div>
    </TilePopover>
  );
}
