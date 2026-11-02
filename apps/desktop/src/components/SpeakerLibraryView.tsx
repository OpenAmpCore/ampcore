import { useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { Button, ButtonGroup, Chip, Modal, Spinner, Switch, toast } from "@heroui/react";
import { Copy, FileUp, Minus, Plus, Save, Trash2, Undo2, Upload } from "lucide-react";
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
  type SpeakerWay,
} from "../lib/bindings";
import { ACTION_OK, actionFailed, type ActionResult } from "../lib/actionResult";
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
import { useProjectSpeakers } from "./useProjectSpeakers";

const SECTION_TITLE =
  "text-[length:var(--amp-font-size-xs)] font-semibold uppercase tracking-widest text-[var(--amp-color-dimmed)]";

const POWER_MODE_LABELS: Record<PowerMode, string> = {
  lowOhm: "Low-Ω",
  v70: "70V",
  v100: "100V",
};

const REFUSED = "Not part of a speaker.";

const DEFAULT_OHMS = 8;

/** Most ways a speaker can have; `save_edit` refuses more. */
const MAX_WAYS = 4;

/** Unsaved edits, by speaker id: the whole entry as edited. Module-level, like
 * `JOINS` in `SpeakersTab.tsx`, so leaving the tab or picking another speaker
 * keeps them; Save stores one with a single `speakersSave`.
 * ponytail: lost when the app closes; persist them if that bites. */
const DRAFTS = new Map<string, SpeakerLibraryEntry>();

/** Way `i` of a draft was way `origins[i]` of the stored speaker (`null`: a
 * new way), so a save can move outputs along when a way is removed. Kept
 * beside `DRAFTS`; absent while the ways are the stored ones in order. */
const ORIGINS = new Map<string, (number | null)[]>();

const storedOrder = (entry: SpeakerLibraryEntry) => entry.ways.map((_, i): number | null => i);

const UNSAVED_DOT = "block size-2 shrink-0 rounded-full bg-[var(--amp-color-orange-6)]";

/** One way as the single output channel of a stand-in amp, so the Configure
 * tab's own editors (EQ, limiter, FIR) edit a speaker exactly as they edit an
 * output. `ohms` is the way's nominal impedance, which only the watt figures
 * use. */
function wayAssignment(
  p: SpeakerProcessing,
  ohms: number,
  ampModelId: string | null,
  firmwareVersion: string | null,
): AmpAssignment {
  return {
    id: "speaker-way",
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
        outputTrimDb: p.outputTrimDb,
        noiseGateEnabled: p.noiseGateEnabled,
        noiseGateThresholdDbu: p.noiseGateThresholdDbu,
        powerMode: p.powerMode,
        firBypassed: p.firBypassed,
        fir: p.fir,
      },
    ],
  };
}

/** `ConfigureActions` over one way's processing: each edit is the current
 * values with the patch applied, saved as the way's new processing. The Load
 * field saves the way's nominal impedance instead (`setOhms`), which is not
 * processing. Input-side and wiring actions don't exist for a speaker and are
 * left out (optional) or refused (required). */
function wayActions(
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

/** The Speaker Library tab: this machine's speaker library as a list beside an editor
 * for the selected speaker — its details, its ways, and every value a way
 * carries (output EQ, both limiters, delay, polarity, trim, noise gate, power
 * mode, FIR). Ranges come from a reference amp model, since a speaker itself
 * belongs to no amp. Edits stay a draft until Save, so tweaking never touches
 * `speakers.json` or the project's outputs. A save that changes values leaves
 * this project's outputs on the older revision, and the editor offers to
 * update them; applying a speaker to new outputs stays in the Workspace and
 * an amp's Speakers tab. */
export function SpeakerLibraryView({
  project,
  onProjectUpdate,
  ampModels,
}: {
  project: Project;
  onProjectUpdate: (project: Project) => void;
  ampModels: AmpModelCatalogEntry[] | null;
}) {
  const library = useSpeakerLibrary();
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const [saving, setSaving] = useState(false);
  const nameFor = (amp: AmpAssignment) => {
    const model = ampModels?.find((m) => m.id === amp.ampModelId);
    return amp.deviceName ?? (model ? `${model.brand} ${model.model}` : "Unnamed");
  };
  const projectSpeakers = useProjectSpeakers({ project, onProjectUpdate, nameFor });
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
    else toast.danger("Speaker not duplicated", { description: r.error.message });
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
    if (r.status !== "ok") toast.danger("Speaker not deleted", { description: r.error.message });
    else discard(entry.id);
  }

  /** Applies `change` to the speaker's draft, and `reorder` to its way
   * origins when ways are added or removed; a draft back at the stored values
   * is no draft. Reads `DRAFTS` itself, so edits made in one go build on each
   * other. */
  const updateDraft = (stored: SpeakerLibraryEntry): Update => (change, reorder) => {
    const next = change(DRAFTS.get(stored.id) ?? stored);
    const current = ORIGINS.get(stored.id) ?? storedOrder(stored);
    const origins = reorder ? reorder(current) : current;
    const inOrder = JSON.stringify(origins) === JSON.stringify(storedOrder(stored));
    if (inOrder && JSON.stringify(next) === JSON.stringify(stored)) {
      discard(stored.id);
      return;
    }
    DRAFTS.set(stored.id, next);
    if (inOrder) ORIGINS.delete(stored.id);
    else ORIGINS.set(stored.id, origins);
    redraw();
  };

  function discard(id: string) {
    DRAFTS.delete(id);
    ORIGINS.delete(id);
    redraw();
  }

  async function save(id: string) {
    const draft = DRAFTS.get(id);
    if (!draft || saving) return;
    setSaving(true);
    const r = await commands.speakersSave(id, draft, ORIGINS.get(id) ?? storedOrder(draft));
    setSaving(false);
    if (r.status !== "ok") {
      toast.danger("Speaker not saved", { description: r.error.message });
      return;
    }
    // Only what was saved: an edit made while the save was out stays a draft.
    if (DRAFTS.get(id) === draft) discard(id);
    else redraw();
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
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold">Speaker Library</h2>
          <Hint text="Import the old app's speaker preset files">
            <Button size="sm" variant="ghost" isIconOnly aria-label="Import speakers" onPress={() => setImportOpen(true)}>
              <FileUp size={14} />
            </Button>
          </Hint>
          <Button size="sm" variant="primary" onPress={() => setCreateOpen(true)}>
            <Plus size={14} /> New
          </Button>
        </div>
        <input
          type="search"
          aria-label="Search speakers"
          placeholder="Search brand, model, family…"
          value={search}
          className={FIELD_INPUT}
          onChange={(e) => setSearch(e.currentTarget.value)}
        />
        <div className="min-h-0 flex-1 overflow-y-auto">
          {library.length === 0 && (
            <span className={MUTED}>No speakers yet. Create one, import preset files, or save outputs from an amp's Speakers tab.</span>
          )}
          {library.length > 0 && shown.length === 0 && <span className={MUTED}>No speaker matches.</span>}
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
                  {DRAFTS.has(entry.id) && (
                    <Hint text="Unsaved changes" className="flex">
                      <span className={UNSAVED_DOT} />
                    </Hint>
                  )}
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
          <SpeakerEditor
            key={selected.id}
            entry={selected}
            draft={DRAFTS.get(selected.id) ?? selected}
            dirty={DRAFTS.has(selected.id)}
            saving={saving}
            update={updateDraft(selected)}
            onSave={() => void save(selected.id)}
            onDiscard={() => discard(selected.id)}
            behind={projectSpeakers.behindLibrary(selected.id)}
            updatingOutputs={projectSpeakers.busy}
            onUpdateOutputs={() => void projectSpeakers.updateFromLibrary(selected.id)}
            project={project}
            ampModels={ampModels}
            onDuplicate={() => void duplicate(selected)}
            onDelete={() => void remove(selected)}
          />
        ) : (
          <div className={`${MUTED} flex h-full items-center justify-center`}>Select or create a speaker.</div>
        )}
      </main>
      <CreateModal open={createOpen} onClose={() => setCreateOpen(false)} onCreated={(id) => setSelectedId(id)} />
      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} />
      {projectSpeakers.elements}
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

/** A labelled value of a way. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-9 items-center gap-3">
      <span className="w-36 shrink-0 text-sm">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
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

type Update = (
  change: (draft: SpeakerLibraryEntry) => SpeakerLibraryEntry,
  reorder?: (origins: (number | null)[]) => (number | null)[],
) => void;

function SpeakerEditor({
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
  ampModels,
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
  ampModels: AmpModelCatalogEntry[] | null;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const [wayIndex, setWayIndex] = useState(0);
  const [pane, setPane] = useState<WayPane>("output");
  const shownWay = Math.min(wayIndex, draft.ways.length - 1);
  const way = draft.ways[shownWay];
  const reference = useReferenceAmp(project, ampModels);
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

  const setWay = useMemo(
    () => (change: (w: SpeakerWay) => SpeakerWay) =>
      latest.current.update((d) => ({ ...d, ways: d.ways.map((w, i) => (i === shownWay ? change(w) : w)) })),
    [shownWay],
  );
  const edit = useMemo(
    () =>
      (change: (p: SpeakerProcessing) => SpeakerProcessing): Promise<ActionResult> => {
        setWay((w) => ({ ...w, processing: change(w.processing) }));
        return Promise.resolve(ACTION_OK);
      },
    [setWay],
  );
  const actions = useMemo(
    () =>
      wayActions(edit, async (ohms) => {
        setWay((w) => ({ ...w, nominalOhms: ohms }));
        return ACTION_OK;
      }),
    [edit, setWay],
  );
  // A way without a stored impedance reads as 8 Ω, a new output's default.
  const ohms = way.nominalOhms ?? DEFAULT_OHMS;

  const assignment = useMemo(
    () => wayAssignment(way.processing, ohms, reference.modelId, reference.firmware),
    [way.processing, ohms, reference.modelId, reference.firmware],
  );
  const capability = reference.capability;

  const full = draft.ways.length >= MAX_WAYS;

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
    setWayIndex(draft.ways.length);
  }

  /** Removes the shown way. On save, outputs set up from it lose their
   * speaker (values stay) and those on later ways move along with them. */
  function removeShownWay() {
    const keep = (_: unknown, i: number) => i !== shownWay;
    update((d) => ({ ...d, ways: d.ways.filter(keep) }), (origins) => origins.filter(keep));
    setWayIndex(Math.max(0, shownWay - 1));
  }

  return (
    <div className="mx-auto flex w-full max-w-[1180px] min-w-0 flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">{speakerName(draft)}</h2>
        <Hint text="Moves on each save that changes a way's values; outputs set up from an older revision show “Library updated”.">
          <Chip size="sm" color="default">
            Revision {entry.revision}
          </Chip>
        </Hint>
        {dirty && (
          <>
            <span className="flex items-center gap-1.5 text-sm">
              <span className={UNSAVED_DOT} /> Unsaved changes
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
        <Hint text={dirty ? "Copies the saved speaker, without the unsaved changes" : "Copy this speaker"}>
          <Button size="sm" variant="secondary" onPress={onDuplicate}>
            <Copy size={14} /> Duplicate
          </Button>
        </Hint>
        <Button size="sm" variant="danger" onPress={onDelete}>
          <Trash2 size={14} /> Delete
        </Button>
      </div>

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

      <DetailsSection draft={draft} update={update} />

      <Section
        title="Ways"
        trailing={
          <div className="flex items-center gap-1">
            <Hint text={full ? `A speaker has at most ${MAX_WAYS} ways` : "Append a way with flat values"}>
              <Button size="sm" variant="ghost" isDisabled={full} onPress={() => void addWay(null)}>
                <Plus size={14} /> Add way
              </Button>
            </Hint>
            <Hint text={full ? `A speaker has at most ${MAX_WAYS} ways` : `Append a copy of “${way.label}” as a new way`}>
              <Button size="sm" variant="ghost" isDisabled={full} onPress={() => void addWay(shownWay)}>
                <Copy size={14} /> Duplicate way
              </Button>
            </Hint>
            <Hint
              text={
                draft.ways.length <= 1
                  ? "A speaker needs at least one way"
                  : `Removes “${way.label}”. On save, outputs set up from it keep their values but lose this speaker; the other ways keep their outputs.`
              }
            >
              <Button size="sm" variant="ghost" isDisabled={draft.ways.length <= 1} onPress={removeShownWay}>
                <Minus size={14} /> Remove way
              </Button>
            </Hint>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <ButtonGroup size="sm">
              {draft.ways.map((w, i) => (
                <Button key={i} variant={i === shownWay ? "primary" : "ghost"} onPress={() => setWayIndex(i)}>
                  {w.label || `Way ${i + 1}`}
                </Button>
              ))}
            </ButtonGroup>
            <label className="flex items-center gap-2">
              <span className={MUTED}>Label</span>
              <input
                className={`${FIELD_INPUT} w-40`}
                aria-label="Way label"
                placeholder={draft.ways.length === 1 ? "Full" : `Way ${shownWay + 1}`}
                value={way.label}
                onChange={(e) => {
                  const label = e.currentTarget.value;
                  setWay((w) => ({ ...w, label }));
                }}
              />
            </label>
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
            <OutputPane processing={way.processing} capability={capability} edit={edit} />
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
              bypassed={way.processing.firBypassed}
              stored={way.processing.fir}
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
 * A speaker carries all of them; applying it writes every one (as far as the
 * target amp can hold it). */
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
            onCommit={(v) => set({ delayOutMs: v })}
          />
        </div>
      </Field>
      <Field label="Polarity inverted">
        <Toggle label="Polarity inverted" value={p.phaseInverted} onChange={(v) => set({ phaseInverted: v })} />
      </Field>
      <Field label="Output trim">
        <div className="w-40">
          <CommitNumberInput
            value={p.outputTrimDb ?? 0}
            min={ranges.outputTrimDb.min ?? undefined}
            max={ranges.outputTrimDb.max ?? undefined}
            step={0.1}
            suffix=" dB"
            onCommit={(v) => set({ outputTrimDb: v })}
          />
        </div>
      </Field>
      <Field label="Noise gate">
        <Toggle label="Noise gate" value={p.noiseGateEnabled} onChange={(v) => set({ noiseGateEnabled: v })} />
        {/* Always editable: a speaker carries it even for amps whose firmware has no threshold. */}
        <Hint
          text={
            capability.firmware.noiseGateThreshold
              ? "Noise gate threshold"
              : "The reference firmware has no threshold; amps without one keep their own"
          }
          className="w-40"
        >
          <CommitNumberInput
            value={p.noiseGateThresholdDbu ?? 0}
            min={ranges.noiseGateThresholdDbu.min ?? undefined}
            max={ranges.noiseGateThresholdDbu.max ?? undefined}
            step={1}
            suffix=" dBu"
            onCommit={(v) => set({ noiseGateThresholdDbu: v })}
          />
        </Hint>
      </Field>
      <Field label="Power mode">
        <div className="w-40">
          <SimpleSelect
            data={capability.topology.powerModes.map((mode) => ({ value: mode, label: POWER_MODE_LABELS[mode] }))}
            value={p.powerMode}
            onChange={(v) => v && set({ powerMode: v as PowerMode })}
          />
        </div>
      </Field>
      <Field label="FIR bypassed">
        <Toggle label="FIR bypassed" value={p.firBypassed} onChange={(v) => set({ firBypassed: v })} />
      </Field>
    </div>
  );
}

/** The amp model (and firmware) whose ranges the editors use. A speaker
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
      <Hint text="A speaker belongs to no amp: this model only sets the ranges, filter types and power modes offered here.">
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

/** The speaker's name and notes, edited in the same draft as the values.
 * Anything per way (its label) lives with the way, under Ways. */
function DetailsSection({ draft, update }: { draft: SpeakerLibraryEntry; update: Update }) {
  const set = (patch: Partial<SpeakerLibraryEntry>) => update((d) => ({ ...d, ...patch }));
  return (
    <Section title="Details">
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
        <label className="flex flex-col gap-1">
          <span className={MUTED}>Notes</span>
          <textarea className={FIELD_INPUT} rows={2} value={draft.notes} onChange={(e) => set({ notes: e.currentTarget.value })} />
        </label>
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

const EMPTY_DETAILS: SpeakerDetails = { brand: "", model: "", family: "", application: "", notes: "", wayLabels: [""] };

/** A new speaker from scratch: name and way count. Every way starts neutral
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
            <Modal.Heading>New speaker</Modal.Heading>
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
                data={Array.from({ length: MAX_WAYS }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))}
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
                  {saving ? <Spinner size="sm" /> : "Create speaker"}
                </Button>
              </div>
            </div>
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
