import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, ButtonGroup, Chip, Modal, Spinner, Switch, toast } from "@heroui/react";
import { Copy, FileUp, Minus, Plus, Trash2, X } from "lucide-react";
import {
  commands,
  type AmpAssignment,
  type AmpCapability_Serialize as AmpCapability,
  type AmpModelCatalogEntry,
  type PowerMode,
  type Project,
  type SpeakerDetails,
  type SpeakerLibraryEntry,
  type SpeakerProcessing,
} from "../lib/bindings";
import { actionFailed, toActionResult, type ActionResult } from "../lib/actionResult";
import { useIsCompact } from "../lib/breakpoints";
import type { ConfigureActions } from "../lib/configureActions";
import { firmwareOptionsFor } from "../lib/firmwareOptions";
import { speakerName, useSpeakerLibrary } from "../lib/speakers";
import { CommitNumberInput } from "./CommitNumberInput";
import { useConfirm } from "./ConfirmDialog";
import { EqEditor } from "./EqEditor";
import { FirPanel } from "./FirPanel";
import { Hint } from "./Hint";
import { LimiterEditor } from "./LimiterEditor";
import { SimpleSelect } from "./SimpleSelect";
import { MUTED, RowMenu } from "./SpeakerBench";
import { ImportModal } from "./SpeakersTab";
import { FIELD_INPUT } from "./fieldClasses";

const SECTION_TITLE =
  "text-[length:var(--amp-font-size-xs)] font-semibold uppercase tracking-widest text-[var(--amp-color-dimmed)]";

const POWER_MODE_LABELS: Record<PowerMode, string> = {
  lowOhm: "Low-Ω",
  v70: "70V",
  v100: "100V",
};

const REFUSED = "Not part of a speaker preset.";

const DEFAULT_OHMS = 8;

/** One way as the single output channel of a stand-in amp, so the Configure
 * tab's own editors (EQ, limiter, FIR) edit a preset exactly as they edit an
 * output. A field the preset leaves out (`None`) shows the new-output value.
 * `ohms` is the way's nominal impedance, which only the watt figures use. */
function presetAssignment(
  p: SpeakerProcessing,
  ohms: number,
  ampModelId: string | null,
  firmwareVersion: string | null,
): AmpAssignment {
  return {
    id: "preset",
    mac: null,
    ampModelId,
    firmwareVersion,
    channels: [
      {
        channelIndex: 0,
        ohms,
        source: { kind: "analog", index: 0 },
        outputEq: p.outputEq,
        limiter: p.limiter,
        delayOutMs: p.delayOutMs,
        outputPhaseInverted: p.phaseInverted,
        outputTrimDb: p.outputTrimDb ?? 0,
        noiseGateEnabled: p.noiseGateEnabled ?? false,
        noiseGateThresholdDbu: p.noiseGateThresholdDbu ?? 0,
        powerMode: p.powerMode ?? "lowOhm",
        firBypassed: p.firBypassed ?? false,
        fir: p.fir ?? undefined,
      },
    ],
  };
}

/** `ConfigureActions` over one way's processing: each edit is the current
 * values with the patch applied, saved as the way's new processing. The Load
 * field saves the way's nominal impedance instead (`setOhms`), which is not
 * processing. Input-side and wiring actions don't exist for a speaker and are
 * left out (optional) or refused (required). */
function presetActions(
  edit: (change: (p: SpeakerProcessing) => SpeakerProcessing) => Promise<ActionResult>,
  setOhms: (ohms: number) => Promise<ActionResult>,
): ConfigureActions {
  const refuse = async () => actionFailed(REFUSED);
  return {
    setChannelDelayIn: refuse,
    setChannelInputMute: refuse,
    setChannelOutputMute: refuse,
    setChannelOhms: (_, ohms) => setOhms(ohms),
    // Volume is never part of a speaker (see `data/speaker.rs`).
    setChannelOutput: (_, trimDb, _volumeDb, delayOutMs) =>
      edit((p) => ({
        ...p,
        outputTrimDb: trimDb ?? p.outputTrimDb,
        delayOutMs: delayOutMs ?? p.delayOutMs,
      })),
    setChannelPhaseInvert: (_, inverted) => edit((p) => ({ ...p, phaseInverted: inverted })),
    setChannelFirBypass: (_, bypassed) => edit((p) => ({ ...p, firBypassed: bypassed })),
    setChannelPowerMode: (_, mode) => edit((p) => ({ ...p, powerMode: mode })),
    setChannelFirData: (_, name, coefficients) => edit((p) => ({ ...p, fir: { name, coefficients } })),
    // What an amp holds after the vendor's Remove: a unit impulse.
    clearChannelFirData: () => edit((p) => ({ ...p, fir: { name: "", coefficients: [1] } })),
    setCrossoverSlot: (_, __, slot, patch) =>
      edit((p) => {
        const current = p.outputEq[slot];
        return {
          ...p,
          outputEq: {
            ...p.outputEq,
            [slot]: {
              filterType: patch.filterType ?? current.filterType,
              freqHz: patch.freqHz ?? current.freqHz,
              active: patch.active ?? current.active,
            },
          },
        };
      }),
    setEqBand: (_, __, bandIndex, patch) =>
      edit((p) => ({
        ...p,
        outputEq: {
          ...p.outputEq,
          bands: p.outputEq.bands.map((band, i) =>
            i !== bandIndex
              ? band
              : {
                  filterType: patch.filterType ?? band.filterType,
                  freqHz: patch.freqHz ?? band.freqHz,
                  gainDb: patch.gainDb ?? band.gainDb,
                  q: patch.q ?? band.q,
                  active: patch.active ?? band.active,
                },
          ),
        },
      })),
    setChannelLimiter: (_, patch) =>
      edit((p) => {
        const { rms, peak } = p.limiter;
        return {
          ...p,
          limiter: {
            rms: {
              ...rms,
              enabled: patch.rmsEnabled ?? rms.enabled,
              thresholdVrms: patch.rmsThresholdVrms ?? rms.thresholdVrms,
              attackMs: patch.rmsAttackMs ?? rms.attackMs,
              releaseMultiplier: patch.rmsReleaseMultiplier ?? rms.releaseMultiplier,
            },
            peak: {
              ...peak,
              enabled: patch.peakEnabled ?? peak.enabled,
              thresholdVp: patch.peakThresholdVp ?? peak.thresholdVp,
              holdMs: patch.peakHoldMs ?? peak.holdMs,
              releaseMs: patch.peakReleaseMs ?? peak.releaseMs,
            },
          },
        };
      }),
  };
}

/** The Presets tab: this machine's speaker library as a list beside an editor
 * for the selected preset — its details, its ways, and every value a way
 * carries (output EQ, both limiters, delay, polarity, trim, noise gate, power
 * mode, FIR). Ranges come from a reference amp model, since a preset itself
 * belongs to no amp. Applying a preset to outputs stays in an amp's Speakers
 * tab. */
export function PresetsView({ project, ampModels }: { project: Project; ampModels: AmpModelCatalogEntry[] | null }) {
  const library = useSpeakerLibrary();
  const compact = useIsCompact();
  const { confirm, dialog } = useConfirm();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return library
      .filter((e) => !needle || [e.brand, e.model, e.family, e.application].some((v) => v.toLowerCase().includes(needle)))
      .sort((a, b) => a.brand.localeCompare(b.brand) || a.model.localeCompare(b.model));
  }, [library, search]);

  // Keep a selection while the library has entries; a deleted one hands over
  // to the first in the list.
  const selected = library.find((e) => e.id === selectedId) ?? null;
  useEffect(() => {
    if (!selected && shown.length > 0) setSelectedId(shown[0].id);
  }, [selected, shown]);

  async function duplicate(entry: SpeakerLibraryEntry) {
    const r = await commands.speakersDuplicate(entry.id);
    if (r.status === "ok") setSelectedId(r.data.id);
    else toast.danger("Preset not duplicated", { description: r.error.message });
  }

  async function remove(entry: SpeakerLibraryEntry) {
    const ok = await confirm({
      title: `Delete ${speakerName(entry)}?`,
      description: "Outputs set up from it keep their values and show as detached.",
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    const r = await commands.speakersDelete(entry.id);
    if (r.status !== "ok") toast.danger("Preset not deleted", { description: r.error.message });
  }

  function handleAction(entry: SpeakerLibraryEntry, action: string) {
    if (action === "duplicate") void duplicate(entry);
    else if (action === "delete") void remove(entry);
  }

  return (
    <div className={`flex h-full min-h-0 ${compact ? "flex-col" : ""}`}>
      <aside
        className={`flex min-h-0 shrink-0 flex-col gap-2 border-[var(--amp-color-default-border)] p-3 ${
          compact ? "max-h-[40%] border-b" : "w-80 border-r"
        }`}
      >
        <div className="flex items-center gap-2">
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold">Presets</h2>
          <Hint text="Import the old app's speaker preset files">
            <Button size="sm" variant="ghost" isIconOnly aria-label="Import presets" onPress={() => setImportOpen(true)}>
              <FileUp size={14} />
            </Button>
          </Hint>
          <Button size="sm" variant="primary" onPress={() => setCreateOpen(true)}>
            <Plus size={14} /> New
          </Button>
        </div>
        <input
          type="search"
          aria-label="Search presets"
          placeholder="Search brand, model, family…"
          value={search}
          className={FIELD_INPUT}
          onChange={(e) => setSearch(e.currentTarget.value)}
        />
        <div className="min-h-0 flex-1 overflow-y-auto">
          {library.length === 0 && (
            <span className={MUTED}>No presets yet. Create one, import preset files, or save outputs from an amp's Speakers tab.</span>
          )}
          {library.length > 0 && shown.length === 0 && <span className={MUTED}>No preset matches.</span>}
          <div className="flex flex-col gap-0.5">
            {shown.map((entry) => {
              const active = entry.id === selected?.id;
              return (
                <div
                  key={entry.id}
                  role="button"
                  tabIndex={0}
                  aria-pressed={active}
                  onClick={() => setSelectedId(entry.id)}
                  onKeyDown={(e) => {
                    if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                      e.preventDefault();
                      setSelectedId(entry.id);
                    }
                  }}
                  className={`flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 ${
                    active
                      ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                      : "border-transparent hover:bg-[var(--amp-color-gray-light)]"
                  }`}
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">{speakerName(entry)}</span>
                    <span className={`${MUTED} truncate`}>
                      {[entry.family, entry.application].filter(Boolean).join(" · ") || "—"}
                    </span>
                  </div>
                  <Chip size="sm" color="default">
                    {entry.ways.length} way
                  </Chip>
                  <RowMenu
                    label={`Actions for ${speakerName(entry)}`}
                    items={[
                      { id: "duplicate", label: "Duplicate" },
                      { id: "delete", label: "Delete…", danger: true },
                    ]}
                    onAction={(action) => handleAction(entry, action)}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </aside>
      <main className="min-h-0 min-w-0 flex-1 overflow-auto p-4">
        {selected ? (
          <PresetEditor
            key={selected.id}
            entry={selected}
            project={project}
            ampModels={ampModels}
            onDuplicate={() => void duplicate(selected)}
            onDelete={() => void remove(selected)}
          />
        ) : (
          <div className={`${MUTED} flex h-full items-center justify-center`}>Select or create a preset.</div>
        )}
      </main>
      <CreateModal open={createOpen} onClose={() => setCreateOpen(false)} onCreated={(id) => setSelectedId(id)} />
      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} />
      {dialog}
    </div>
  );
}

function Section({ title, trailing, children }: { title: string; trailing?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-h-7 items-center gap-2">
        <h3 className={`${SECTION_TITLE} flex-1`}>{title}</h3>
        {trailing}
      </div>
      <div className="min-w-0 rounded-xl border border-[var(--amp-color-default-border)] p-3">{children}</div>
    </section>
  );
}

function Toggle({ value, onChange, label }: { value: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <Switch isSelected={value} onChange={onChange} aria-label={label}>
      <Switch.Content>
        <Switch.Control>
          <Switch.Thumb />
        </Switch.Control>
      </Switch.Content>
    </Switch>
  );
}

/** A labelled value of a way. `onUnset` marks a field the preset may leave
 * out: unset, applying the preset leaves the amp's own value. */
function Field({
  label,
  set = true,
  onSet,
  onUnset,
  children,
}: {
  label: string;
  set?: boolean;
  onSet?: () => void;
  onUnset?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-9 items-center gap-3">
      <span className="w-36 shrink-0 text-sm">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {set ? (
          children
        ) : (
          <>
            <span className={`${MUTED} flex-1`}>Not in preset — the amp keeps its own value</span>
            <Button size="sm" variant="secondary" onPress={onSet}>
              Set
            </Button>
          </>
        )}
      </div>
      {set && onUnset && (
        <Hint text="Leave out of the preset: the amp keeps its own value" className="flex">
          <Button size="sm" variant="ghost" isIconOnly aria-label={`Leave ${label} out of the preset`} onPress={onUnset}>
            <X size={14} />
          </Button>
        </Hint>
      )}
    </div>
  );
}

type WayPane = "output" | "eq" | "limiter" | "fir";

const WAY_PANES: { id: WayPane; label: string }[] = [
  { id: "output", label: "Output" },
  { id: "eq", label: "EQ" },
  { id: "limiter", label: "Limiter" },
  { id: "fir", label: "FIR" },
];

function PresetEditor({
  entry,
  project,
  ampModels,
  onDuplicate,
  onDelete,
}: {
  entry: SpeakerLibraryEntry;
  project: Project;
  ampModels: AmpModelCatalogEntry[] | null;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const [wayIndex, setWayIndex] = useState(0);
  const [pane, setPane] = useState<WayPane>("output");
  const way = entry.ways[Math.min(wayIndex, entry.ways.length - 1)];
  const reference = useReferenceAmp(project, ampModels);

  // The way's values as last edited here. Edits apply at once and are saved in
  // order; the library's echo only takes over once none is in flight, so a
  // second edit never builds on values older than the first.
  const [draft, setDraft] = useState(way.processing);
  const draftRef = useRef(draft);
  const pending = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const shownWay = Math.min(wayIndex, entry.ways.length - 1);
  const wayKey = JSON.stringify(way.processing);
  const draftWay = useRef(shownWay);
  useEffect(() => {
    // Another way always takes over; the same way's echo only when idle.
    if (draftWay.current !== shownWay || pending.current === 0) {
      draftWay.current = shownWay;
      draftRef.current = way.processing;
      setDraft(way.processing);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wayKey, shownWay]);

  const edit = useMemo(
    () =>
      (change: (p: SpeakerProcessing) => SpeakerProcessing): Promise<ActionResult> => {
        const next = change(draftRef.current);
        draftRef.current = next;
        setDraft(next);
        pending.current += 1;
        const saved = queue.current.then(() => commands.speakersSetWayProcessing(entry.id, shownWay, next));
        queue.current = saved;
        return saved.then((r) => {
          pending.current -= 1;
          if (r.status !== "ok") {
            toast.danger("Preset not saved", { description: r.error.message, timeout: 0 });
          }
          return toActionResult(r);
        });
      },
    [entry.id, shownWay],
  );
  // A way without a stored impedance reads as 8 Ω, a new output's default.
  const storedOhms = way.nominalOhms ?? DEFAULT_OHMS;
  const [ohms, setOhms] = useState(storedOhms);
  useEffect(() => setOhms(storedOhms), [storedOhms, shownWay]);
  const saveOhms = useMemo(
    () =>
      async (next: number): Promise<ActionResult> => {
        setOhms(next);
        const r = await commands.speakersSetWayNominalOhms(entry.id, shownWay, next);
        if (r.status !== "ok") {
          setOhms(storedOhms);
          toast.danger("Impedance not saved", { description: r.error.message });
        }
        return toActionResult(r);
      },
    [entry.id, shownWay, storedOhms],
  );
  const actions = useMemo(() => presetActions(edit, saveOhms), [edit, saveOhms]);

  const assignment = useMemo(
    () => presetAssignment(draft, ohms, reference.modelId, reference.firmware),
    [draft, ohms, reference.modelId, reference.firmware],
  );
  const capability = reference.capability;

  async function addWay(copyFrom: number | null) {
    const r = await commands.speakersAddWay(entry.id, copyFrom);
    if (r.status === "ok") setWayIndex(r.data.ways.length - 1);
    else toast.danger("Way not added", { description: r.error.message });
  }

  async function removeLastWay() {
    const r = await commands.speakersRemoveLastWay(entry.id);
    if (r.status === "ok") setWayIndex((i) => Math.min(i, r.data.ways.length - 1));
    else toast.danger("Way not removed", { description: r.error.message });
  }

  return (
    <div className="mx-auto flex w-full max-w-[1180px] min-w-0 flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">{speakerName(entry)}</h2>
        <Hint text="Bumped on every change to a way's values; outputs set up from an older revision show “Library updated”.">
          <Chip size="sm" color="default">
            Revision {entry.revision}
          </Chip>
        </Hint>
        <Button size="sm" variant="secondary" onPress={onDuplicate}>
          <Copy size={14} /> Duplicate
        </Button>
        <Button size="sm" variant="danger" onPress={onDelete}>
          <Trash2 size={14} /> Delete
        </Button>
      </div>

      <DetailsSection entry={entry} />

      <Section
        title="Ways"
        trailing={
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" onPress={() => void addWay(null)}>
              <Plus size={14} /> Add way
            </Button>
            <Hint text={`Append a copy of “${way.label}” as a new way`}>
              <Button size="sm" variant="ghost" onPress={() => void addWay(shownWay)}>
                <Copy size={14} /> Copy way
              </Button>
            </Hint>
            <Hint text="Only the last way can be removed, so the others keep their place on every output">
              <Button
                size="sm"
                variant="ghost"
                isIconOnly
                aria-label="Remove the last way"
                isDisabled={entry.ways.length <= 1}
                onPress={() => void removeLastWay()}
              >
                <Minus size={14} />
              </Button>
            </Hint>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <ButtonGroup size="sm">
              {entry.ways.map((w, i) => (
                <Button key={i} variant={i === shownWay ? "primary" : "ghost"} onPress={() => setWayIndex(i)}>
                  {w.label}
                </Button>
              ))}
            </ButtonGroup>
            <div className="flex-1" />
            <ButtonGroup size="sm">
              {WAY_PANES.map((p) => (
                <Button key={p.id} variant={p.id === pane ? "primary" : "ghost"} onPress={() => setPane(p.id)}>
                  {p.label}
                </Button>
              ))}
            </ButtonGroup>
          </div>
          <ReferenceAmpPicker reference={reference} ampModels={ampModels} />
          {!capability ? (
            <div className={`${MUTED} flex items-center gap-2 py-6`}>
              {reference.loading ? <Spinner size="sm" /> : "Pick a reference amp model to edit the values."}
            </div>
          ) : pane === "output" ? (
            <OutputPane processing={draft} capability={capability} edit={edit} />
          ) : pane === "eq" ? (
            <EqEditor
              key={`eq:${shownWay}`}
              assignment={assignment}
              channelIndex={0}
              direction="output"
              capability={capability}
              actions={actions}
            />
          ) : pane === "limiter" ? (
            <LimiterEditor
              key={`lim:${shownWay}`}
              assignment={assignment}
              channelIndex={0}
              capability={capability}
              actions={actions}
            />
          ) : (
            <FirPanel
              key={`fir:${shownWay}`}
              channelIndex={0}
              label={way.label}
              capability={capability}
              bypassed={draft.firBypassed ?? false}
              stored={draft.fir ?? undefined}
              onBypassChange={(next) => actions.setChannelFirBypass(0, next)}
              onImportData={(name, coefficients) => actions.setChannelFirData!(0, name, coefficients)}
              onClearData={() => actions.clearChannelFirData!(0)}
            />
          )}
        </div>
      </Section>
    </div>
  );
}

type Edit = (change: (p: SpeakerProcessing) => SpeakerProcessing) => Promise<ActionResult>;

/** Delay, polarity, trim, noise gate, power mode and FIR bypass of one way.
 * The fields after polarity are optional in a preset. */
function OutputPane({ processing: p, capability, edit }: { processing: SpeakerProcessing; capability: AmpCapability; edit: Edit }) {
  const ranges = capability.paramRanges;
  const set = (patch: Partial<SpeakerProcessing>) => void edit((current) => ({ ...current, ...patch }));
  return (
    <div className="flex max-w-[640px] flex-col gap-1">
      <Field label="Delay">
        <div className="w-40">
          <CommitNumberInput
            value={p.delayOutMs ?? 0}
            min={ranges.delayOutMs.min ?? undefined}
            max={ranges.delayOutMs.max ?? undefined}
            step={0.01}
            suffix=" ms"
            showStepper
            onCommit={(v) => set({ delayOutMs: v })}
          />
        </div>
      </Field>
      <Field label="Polarity inverted">
        <Toggle label="Polarity inverted" value={p.phaseInverted} onChange={(v) => set({ phaseInverted: v })} />
      </Field>
      <Field
        label="Output trim"
        set={p.outputTrimDb != null}
        onSet={() => set({ outputTrimDb: 0 })}
        onUnset={() => set({ outputTrimDb: null })}
      >
        <div className="w-40">
          <CommitNumberInput
            value={p.outputTrimDb ?? 0}
            min={ranges.outputTrimDb.min ?? undefined}
            max={ranges.outputTrimDb.max ?? undefined}
            step={0.1}
            suffix=" dB"
            showStepper
            onCommit={(v) => set({ outputTrimDb: v })}
          />
        </div>
      </Field>
      <Field
        label="Noise gate"
        set={p.noiseGateEnabled != null}
        onSet={() =>
          set({ noiseGateEnabled: false, noiseGateThresholdDbu: p.noiseGateThresholdDbu ?? ranges.noiseGateThresholdDbu.min ?? 0 })
        }
        onUnset={() => set({ noiseGateEnabled: null, noiseGateThresholdDbu: null })}
      >
        <Toggle label="Noise gate" value={p.noiseGateEnabled ?? false} onChange={(v) => set({ noiseGateEnabled: v })} />
        {capability.firmware.noiseGateThreshold && (
          <div className="w-40">
            <CommitNumberInput
              value={p.noiseGateThresholdDbu ?? 0}
              min={ranges.noiseGateThresholdDbu.min ?? undefined}
              max={ranges.noiseGateThresholdDbu.max ?? undefined}
              step={1}
              suffix=" dBu"
              onCommit={(v) => set({ noiseGateThresholdDbu: v })}
            />
          </div>
        )}
      </Field>
      <Field
        label="Power mode"
        set={p.powerMode != null}
        onSet={() => set({ powerMode: capability.topology.powerModes[0] ?? "lowOhm" })}
        onUnset={() => set({ powerMode: null })}
      >
        <div className="w-40">
          <SimpleSelect
            data={capability.topology.powerModes.map((mode) => ({ value: mode, label: POWER_MODE_LABELS[mode] }))}
            value={p.powerMode ?? null}
            onChange={(v) => v && set({ powerMode: v as PowerMode })}
          />
        </div>
      </Field>
      <Field
        label="FIR bypassed"
        set={p.firBypassed != null}
        onSet={() => set({ firBypassed: false })}
        onUnset={() => set({ firBypassed: null })}
      >
        <Toggle label="FIR bypassed" value={p.firBypassed ?? false} onChange={(v) => set({ firBypassed: v })} />
      </Field>
    </div>
  );
}

/** The amp model (and firmware) whose ranges the editors use. A preset
 * belongs to no amp; this one only bounds the fields. Defaults to the
 * project's first modelled amp, else the first model in the catalogue. */
function useReferenceAmp(project: Project, ampModels: AmpModelCatalogEntry[] | null) {
  const models = useMemo(() => (ampModels ?? []).filter((m) => !m.archived), [ampModels]);
  const fallback = useMemo(() => {
    const amp = project.ampAssignments.find((a) => a.ampModelId && models.some((m) => m.id === a.ampModelId));
    const model = models.find((m) => m.id === amp?.ampModelId) ?? models[0];
    return model
      ? { modelId: model.id, firmware: amp?.firmwareVersion ?? firmwareOptionsFor(model.protocol)[0] ?? null }
      : null;
  }, [project.ampAssignments, models]);
  const [choice, setChoice] = useState<{ modelId: string; firmware: string | null } | null>(null);
  const picked = choice ?? fallback;
  const [capability, setCapability] = useState<AmpCapability | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!picked) return;
    let cancelled = false;
    setLoading(true);
    commands.ampCapabilityResolve(picked.modelId, picked.firmware).then((r) => {
      if (cancelled) return;
      setLoading(false);
      setCapability(r.status === "ok" ? r.data : null);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked?.modelId, picked?.firmware]);

  return {
    models,
    modelId: picked?.modelId ?? null,
    firmware: picked?.firmware ?? null,
    capability: picked ? capability : null,
    loading,
    choose: setChoice,
  };
}

type ReferenceAmp = ReturnType<typeof useReferenceAmp>;

function ReferenceAmpPicker({ reference, ampModels }: { reference: ReferenceAmp; ampModels: AmpModelCatalogEntry[] | null }) {
  const model = reference.models.find((m) => m.id === reference.modelId);
  const firmwares = firmwareOptionsFor(model?.protocol);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Hint text="A preset belongs to no amp: this model only sets the ranges, filter types and power modes offered here.">
        <span className={MUTED}>Ranges from</span>
      </Hint>
      <div className="w-64">
        <SimpleSelect
          data={reference.models.map((m) => ({ value: m.id, label: `${m.brand} ${m.model}` }))}
          value={reference.modelId}
          placeholder={ampModels === null ? "Loading…" : "No amp models"}
          onChange={(id) => {
            const next = reference.models.find((m) => m.id === id);
            if (next) reference.choose({ modelId: next.id, firmware: firmwareOptionsFor(next.protocol)[0] ?? null });
          }}
        />
      </div>
      {firmwares.length > 0 && (
        <div className="w-32">
          <SimpleSelect
            data={firmwares.map((f) => ({ value: f, label: `FW ${f}` }))}
            value={reference.firmware}
            onChange={(firmware) => reference.modelId && reference.choose({ modelId: reference.modelId, firmware })}
          />
        </div>
      )}
      {reference.capability && !reference.capability.firmware.speakerManagement && (
        <span className="text-sm text-warning">This firmware has no speaker management.</span>
      )}
    </div>
  );
}

const DETAIL_FIELDS = [
  ["brand", "Brand", true],
  ["model", "Model", true],
  ["family", "Family", false],
  ["application", "Application", false],
] as const;

function detailsOf(entry: SpeakerLibraryEntry): SpeakerDetails {
  const { brand, model, family, application, notes } = entry;
  return { brand, model, family, application, notes, wayLabels: entry.ways.map((w) => w.label) };
}

/** Name, notes and way labels. Saved together, never touching the values. */
function DetailsSection({ entry }: { entry: SpeakerLibraryEntry }) {
  const [draft, setDraft] = useState(() => detailsOf(entry));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saved = JSON.stringify(detailsOf(entry));
  // Follows the library (a way added or removed) without dropping unsaved
  // edits; with nothing unsaved it simply takes the new details.
  const [base, setBase] = useState(saved);
  if (saved !== base) {
    setBase(saved);
    if (JSON.stringify(draft) === base) setDraft(detailsOf(entry));
    else setDraft((d) => ({ ...d, wayLabels: entry.ways.map((w, i) => d.wayLabels[i] ?? w.label) }));
  }
  const dirty = JSON.stringify(draft) !== saved;
  const set = (patch: Partial<SpeakerDetails>) => setDraft((d) => ({ ...d, ...patch }));

  async function save() {
    setSaving(true);
    const r = await commands.speakersUpdateDetails(entry.id, draft);
    setSaving(false);
    setError(r.status === "ok" ? null : r.error.message);
  }

  return (
    <Section
      title="Details"
      trailing={
        <>
          {dirty && (
            <Button size="sm" variant="ghost" isDisabled={saving} onPress={() => setDraft(detailsOf(entry))}>
              Revert
            </Button>
          )}
          <Button
            size="sm"
            variant="primary"
            isDisabled={!dirty || saving || !draft.brand.trim() || !draft.model.trim()}
            onPress={() => void save()}
          >
            {saving ? <Spinner size="sm" /> : "Save details"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
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
        <WayLabelFields labels={draft.wayLabels} onChange={(wayLabels) => set({ wayLabels })} />
        <label className="flex flex-col gap-1">
          <span className={MUTED}>Notes</span>
          <textarea className={FIELD_INPUT} rows={2} value={draft.notes} onChange={(e) => set({ notes: e.currentTarget.value })} />
        </label>
        {error && <span className="text-sm text-danger">{error}</span>}
      </div>
    </Section>
  );
}

function WayLabelFields({ labels, onChange }: { labels: string[]; onChange: (labels: string[]) => void }) {
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

const MAX_NEW_WAYS = 4;
const EMPTY_DETAILS: SpeakerDetails = { brand: "", model: "", family: "", application: "", notes: "", wayLabels: [""] };

/** A new preset from scratch: name and way count. Every way starts neutral
 * (flat EQ, limiters off) and is edited in the tab. */
function CreateModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const compact = useIsCompact();
  const [draft, setDraft] = useState(EMPTY_DETAILS);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<SpeakerDetails>) => setDraft((d) => ({ ...d, ...patch }));

  function close() {
    setDraft(EMPTY_DETAILS);
    setError(null);
    onClose();
  }

  async function create() {
    setSaving(true);
    const r = await commands.speakersCreate(draft);
    setSaving(false);
    if (r.status !== "ok") {
      setError(r.error.message);
      return;
    }
    onCreated(r.data.id);
    close();
  }

  return (
    <Modal.Backdrop isOpen={open} onOpenChange={(o) => !o && close()}>
      <Modal.Container placement="center" size={compact ? "full" : "md"}>
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Heading>New preset</Modal.Heading>
            <Modal.CloseTrigger />
          </Modal.Header>
          <Modal.Body>
            <div className="flex flex-col gap-3">
              <span className={MUTED}>Every way starts flat — EQ bypassed, limiters off, no delay. Edit the values afterwards.</span>
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
              <SimpleSelect
                label="Ways"
                data={Array.from({ length: MAX_NEW_WAYS }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))}
                value={String(draft.wayLabels.length)}
                onChange={(v) => {
                  const n = Number(v ?? 1);
                  set({ wayLabels: Array.from({ length: n }, (_, i) => draft.wayLabels[i] ?? "") });
                }}
              />
              {draft.wayLabels.length > 1 && (
                <WayLabelFields labels={draft.wayLabels} onChange={(wayLabels) => set({ wayLabels })} />
              )}
              {error && <span className="text-sm text-danger">{error}</span>}
              <div className="flex justify-end gap-2">
                <Button variant="secondary" isDisabled={saving} onPress={close}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  isDisabled={saving || !draft.brand.trim() || !draft.model.trim()}
                  onPress={() => void create()}
                >
                  {saving ? <Spinner size="sm" /> : "Create preset"}
                </Button>
              </div>
            </div>
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
