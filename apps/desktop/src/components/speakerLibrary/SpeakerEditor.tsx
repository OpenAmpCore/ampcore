import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Spinner } from "@heroui/react";
import { Copy, Pencil, Plus, Save, Trash2, Undo2, Upload } from "lucide-react";
import { commands, type Project, type SpeakerLibraryEntry } from "../../lib/bindings";
import { channelTelemetry } from "../../lib/channelTelemetry";
import { speakerName } from "../../lib/speakers";
import { ChannelEditorModal, type EditorTarget } from "../configure/ChannelEditorModal";
import { OutputChannelRow } from "../configure/OutputChannelRow";
import { TilePopover } from "../configure/parts";
import { Hint } from "../Hint";
import { CabinetIcon, MUTED, RowMenu } from "../speakers/SpeakerBench";
import { FIELD_INPUT } from "../fieldClasses";
import { MAX_WAYS, UNSAVED_DOT } from "./shared";
import { ReferenceChip, useReferenceFirmware } from "./referenceFirmware";
import { defaultWayLabel, speakerAssignment, wayActions } from "./wayAssignment";

export type Update = (
  change: (draft: SpeakerLibraryEntry) => SpeakerLibraryEntry,
  reorder?: (origins: (number | null)[]) => (number | null)[],
) => void;

/** The selected speaker: a compact header (name, details, ranges, save) over
 * one "pearl necklace" per way — the Output tab's own row of tiles for a
 * stand-in output (`OutputChannelRow` with `preset`), whose EQ / FIR / LIM
 * tiles open the Output tab's editor dialog with a way switcher. */
export function SpeakerEditor({
  entry,
  draft,
  dirty,
  saving,
  update,
  onSave,
  onDiscard,
  behind,
  updatingOutputs,
  onUpdateOutputs,
  project,
  onDuplicate,
  onDelete,
}: {
  /** The speaker as stored. */
  entry: SpeakerLibraryEntry;
  /** The speaker as edited here: `entry` itself while nothing is unsaved. */
  draft: SpeakerLibraryEntry;
  dirty: boolean;
  saving: boolean;
  update: Update;
  onSave: () => void;
  onDiscard: () => void;
  /** This project's outputs still on an older revision of this speaker. */
  behind: string[];
  updatingOutputs: boolean;
  onUpdateOutputs: () => void;
  project: Project;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const reference = useReferenceFirmware(project);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const invalid = !draft.brand.trim() || !draft.model.trim();
  const canSave = dirty && !saving && !invalid;

  // The editors get callbacks that stay put while the draft changes under
  // them (`ResponseGraph` is memoised on its props).
  const latest = useRef({ update, onSave, canSave });
  latest.current = { update, onSave, canSave };
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (latest.current.canSave) latest.current.onSave();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const actions = useMemo(
    () =>
      wayActions((index, change) =>
        latest.current.update((d) => ({ ...d, ways: d.ways.map((w, i) => (i === index ? change(w) : w)) })),
      ),
    [],
  );
  const assignment = useMemo(
    () => speakerAssignment(draft, null, reference.firmware),
    [draft, reference.firmware],
  );
  const capability = reference.capability;
  const count = draft.ways.length;
  const full = count >= MAX_WAYS;
  const wayName = (i: number) => draft.ways[i]?.label || defaultWayLabel(i, count);

  async function addWay(copyFrom: number | null) {
    const from = copyFrom === null ? null : draft.ways[copyFrom];
    const processing = from ? from.processing : await commands.speakersNeutralProcessing();
    update(
      (d) => ({
        ...d,
        ways: [...d.ways, { label: `Way ${d.ways.length + 1}`, processing, fc57Hex: null, nominalOhms: from?.nominalOhms ?? null }],
      }),
      (origins) => [...origins, null],
    );
  }

  /** On save, outputs set up from the removed way lose their speaker (values
   * stay) and those on later ways move along with them. */
  function removeWay(index: number) {
    const keep = (_: unknown, i: number) => i !== index;
    update((d) => ({ ...d, ways: d.ways.filter(keep) }), (origins) => origins.filter(keep));
    if (editor) setEditor(null);
  }

  return (
    // As wide as one necklace (eight tiles), so the header's buttons stay by
    // the rows they act on instead of drifting to the window's edge.
    <div className="mx-auto flex w-full max-w-[760px] min-w-0 flex-col gap-5">
      <header className="flex flex-wrap items-center gap-3">
        <span className="shrink-0 text-[var(--amp-color-dimmed)]">
          <CabinetIcon ways={count} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="truncate text-lg font-semibold">{speakerName(draft)}</h2>
          <div className={`${MUTED} flex flex-wrap items-center gap-x-2 gap-y-1`}>
            {draft.family || draft.application ? (
              <span>{[draft.family, draft.application].filter(Boolean).join(" · ")} ·</span>
            ) : null}
            <Hint text="Moves on each save that changes a way's values; outputs set up from an older revision show “Library updated”.">
              <span>Revision {entry.revision}</span>
            </Hint>
            <ReferenceChip reference={reference} />
          </div>
        </div>
        {dirty && (
          <>
            <span className="flex items-center gap-1.5 text-sm">
              <span className={UNSAVED_DOT} /> Unsaved
            </span>
            <Button size="sm" variant="ghost" isDisabled={saving} onPress={onDiscard}>
              <Undo2 size={14} /> Discard
            </Button>
          </>
        )}
        <Hint text={invalid ? "Brand and model are required" : "Save to the library (Ctrl+S)"}>
          <Button size="sm" variant="primary" isDisabled={!canSave} onPress={onSave}>
            {saving ? <Spinner size="sm" /> : <Save size={14} />} Save
          </Button>
        </Hint>
        <DetailsButton draft={draft} update={update} />
        <RowMenu
          label={`Actions for ${speakerName(draft)}`}
          items={[
            { id: "duplicate", label: dirty ? "Duplicate saved speaker" : "Duplicate" },
            { id: "delete", label: "Delete…", danger: true },
          ]}
          onAction={(id) => (id === "duplicate" ? onDuplicate() : onDelete())}
        />
      </header>

      {behind.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--accent)] bg-[var(--accent-soft)] px-3 py-2">
          <span className="min-w-0 flex-1 text-sm">
            {behind.length === 1 ? "1 output in this project still holds" : `${behind.length} outputs in this project still hold`} an
            older revision: {behind.join(", ")}
          </span>
          <Hint text={dirty ? "Save or discard your changes first" : "Write this speaker's saved values to them"}>
            <Button size="sm" variant="primary" isDisabled={dirty || updatingOutputs} onPress={onUpdateOutputs}>
              <Upload size={14} /> Update outputs
            </Button>
          </Hint>
        </div>
      )}

      {!capability ? (
        <div className={`${MUTED} flex items-center gap-2 py-6`}>
          <Spinner size="sm" />
        </div>
      ) : (
        <div className="flex min-w-0 flex-col gap-4">
          {draft.ways.map((way, i) => {
            const ranges = capability.paramRanges;
            return (
              <OutputChannelRow
                key={i}
                preset={{
                  defaultLabel: defaultWayLabel(i, count),
                  // Quiet icon buttons beside the name, so the label stays
                  // the row's heading; each says what it does on hover.
                  trailing: (
                    <div className="flex items-center">
                      <Hint text={full ? `A speaker has at most ${MAX_WAYS} ways` : `Duplicate “${wayName(i)}” as a new way`}>
                        <Button
                          size="sm"
                          variant="ghost"
                          isIconOnly
                          aria-label={`Duplicate ${wayName(i)}`}
                          isDisabled={full}
                          onPress={() => void addWay(i)}
                        >
                          <Copy size={14} />
                        </Button>
                      </Hint>
                      {count > 1 && (
                        <Hint text={`Remove “${wayName(i)}”. On save, outputs set up from it keep their values but lose this speaker.`}>
                          <Button size="sm" variant="ghost" isIconOnly aria-label={`Remove ${wayName(i)}`} onPress={() => removeWay(i)}>
                            <Trash2 size={14} />
                          </Button>
                        </Hint>
                      )}
                    </div>
                  ),
                }}
                channel={assignment.channels[i]}
                telemetry={channelTelemetry(undefined, i, null)}
                ratedRmsVoltage={capability.topology.ratedRmsVoltage}
                rmsThresholdRangeMax={ranges.rmsLimiterThresholdVrms.max}
                trimMin={ranges.outputTrimDb.min}
                trimMax={ranges.outputTrimDb.max}
                volumeMin={null}
                volumeMax={null}
                delayMin={ranges.delayOutMs.min}
                delayMax={ranges.delayOutMs.max}
                noiseGateThresholdMin={ranges.noiseGateThresholdDbu.min}
                noiseGateThresholdMax={ranges.noiseGateThresholdDbu.max}
                // As on the Output tab: firmware without a threshold (1.1.8)
                // gets a plain on/off Gate. The speaker keeps its threshold.
                noiseGateThresholdAdjustable={capability.firmware.noiseGateThreshold}
                nameMaxLength={ranges.channelNameMaxLength}
                powerModes={capability.topology.powerModes}
                onChange={(field, value) =>
                  actions.setChannelOutput(i, field === "trim" ? value : null, null, field === "delay" ? value : null)
                }
                onOpenEq={() => setEditor({ kind: "outputEq", channelIndex: i })}
                onOpenFir={() => setEditor({ kind: "fir", channelIndex: i })}
                onOpenLimiter={() => setEditor({ kind: "limiter", channelIndex: i })}
                onNoiseGateChange={(enabled, thresholdDbu) => actions.setChannelNoiseGate!(i, enabled, thresholdDbu)}
                onPhaseInvertToggle={() => actions.setChannelPhaseInvert(i, !way.processing.phaseInverted)}
                onPowerModeChange={(mode) => actions.setChannelPowerMode(i, mode)}
                onMuteToggle={actions.setChannelOutputMute.bind(null, i, false)}
                onRename={(name) => void actions.setChannelName!(i, "output", name)}
              />
            );
          })}
          <Hint text={full ? `A speaker has at most ${MAX_WAYS} ways` : "Append a way with flat values"} className="self-start">
            <Button size="sm" variant="ghost" isDisabled={full} onPress={() => void addWay(null)}>
              <Plus size={14} /> Add way
            </Button>
          </Hint>
          <ChannelEditorModal
            target={editor}
            onTargetChange={setEditor}
            assignment={assignment}
            capability={capability}
            actions={actions}
            locked={false}
            channelLabel={wayName}
            limiterMeters={false}
          />
        </div>
      )}
    </div>
  );
}

export const DETAIL_FIELDS = [
  ["brand", "Brand", true],
  ["model", "Model", true],
  ["family", "Family", false],
  ["application", "Application", false],
] as const;

/** The speaker's name and notes, in a popover off the header, edited in the
 * same draft as the values. A way's label lives on its own row. */
function DetailsButton({ draft, update }: { draft: SpeakerLibraryEntry; update: Update }) {
  const [open, setOpen] = useState(false);
  const set = (patch: Partial<SpeakerLibraryEntry>) => update((d) => ({ ...d, ...patch }));
  return (
    <TilePopover
      opened={open}
      onOpenChange={setOpen}
      width={360}
      trigger={
        <Button size="sm" variant="secondary" onPress={() => setOpen((o) => !o)}>
          <Pencil size={14} /> Details
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          {DETAIL_FIELDS.map(([key, label, required]) => (
            <label key={key} className="flex flex-col gap-1">
              <span className={MUTED}>
                {label}
                {required && " *"}
              </span>
              <input className={FIELD_INPUT} value={draft[key]} onChange={(e) => set({ [key]: e.currentTarget.value })} />
            </label>
          ))}
        </div>
        <label className="flex flex-col gap-1">
          <span className={MUTED}>Notes</span>
          <textarea className={FIELD_INPUT} rows={3} value={draft.notes} onChange={(e) => set({ notes: e.currentTarget.value })} />
        </label>
      </div>
    </TilePopover>
  );
}

export function WayLabelFields({ labels, onChange }: { labels: string[]; onChange: (labels: string[]) => void }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {labels.map((label, i) => (
        <label key={i} className="flex flex-col gap-1">
          <span className={MUTED}>Way {i + 1} label</span>
          <input
            className={FIELD_INPUT}
            placeholder={labels.length === 1 ? "Full" : `Way ${i + 1}`}
            value={label}
            onChange={(e) => onChange(labels.map((l, j) => (j === i ? e.currentTarget.value : l)))}
          />
        </label>
      ))}
    </div>
  );
}
