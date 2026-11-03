import { Fragment, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { Button, Modal, Spinner, toast } from "@heroui/react";
import { ChevronDown, ChevronRight, Copy, FileUp, Pencil, Plus, Save, Trash2, Undo2, Upload } from "lucide-react";
import {
  commands,
  type AmpAssignment,
  type AmpCapability_Serialize as AmpCapability,
  type AmpModelCatalogEntry,
  type Project,
  type SpeakerDetails,
  type SpeakerLibraryEntry,
  type SpeakerProcessing,
  type SpeakerWay,
} from "../lib/bindings";
import { ACTION_OK, actionFailed } from "../lib/actionResult";
import { useIsCompact } from "../lib/breakpoints";
import { channelTelemetry } from "../lib/channelTelemetry";
import type { ConfigureActions } from "../lib/configureActions";
import { firmwareOptionsFor } from "../lib/firmwareOptions";
import { speakerName, useSpeakerLibrary } from "../lib/speakers";
import { ChannelEditorModal, OutputChannelRow, TilePopover, type EditorTarget } from "./AmpConfigureView";
import { useConfirm } from "./ConfirmDialog";
import { Hint } from "./Hint";
import { SimpleSelect } from "./SimpleSelect";
import { CabinetIcon, MUTED, RowMenu } from "./SpeakerBench";
import { ImportModal } from "./SpeakersTab";
import { FIELD_INPUT } from "./fieldClasses";
import { useProjectSpeakers } from "./useProjectSpeakers";

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

const TREE_INDENT = 14;

/** The speaker tree's levels, top down: brand, then family. */
const TREE_LEVELS: ((entry: SpeakerLibraryEntry) => string)[] = [(e) => e.brand, (e) => e.family];

/** `items` grouped by `key`, in their order of first appearance. */
function groupBy<T>(items: T[], key: (item: T) => string): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return [...groups];
}

/** A foldable level of the speaker tree: its name, how many speakers it holds,
 * and those speakers while open. */
function TreeGroup({
  label,
  count,
  depth,
  open,
  onToggle,
  children,
}: {
  label: string;
  count: number;
  depth: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        style={{ paddingLeft: TREE_INDENT * depth + 2 }}
        className="flex w-full cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent py-1 pr-2 text-left text-inherit hover:bg-[var(--amp-color-gray-light)]"
      >
        <ChevronRight size={14} className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        <span className={`min-w-0 flex-1 truncate text-sm ${depth === 0 ? "font-semibold" : ""}`}>{label}</span>
        <span className={MUTED}>{count}</span>
      </button>
      {open && children}
    </div>
  );
}

const UNSAVED_DOT = "block size-2 shrink-0 rounded-full bg-[var(--amp-color-orange-6)]";

/** "Full" for a one-way speaker, else "Way N": what a way without a label is
 * called, as `speaker.rs::way_label` names it on save. */
function defaultWayLabel(index: number, count: number): string {
  return count === 1 ? "Full" : `Way ${index + 1}`;
}

/** The speaker as a stand-in amp with one output per way, so the Output tab's
 * own row and editors (EQ, limiter, FIR) edit a speaker exactly as they edit
 * outputs. A way's label is the output's name, and its nominal impedance the
 * Load, which only the watt figures use. */
function speakerAssignment(entry: SpeakerLibraryEntry, ampModelId: string | null, firmwareVersion: string | null): AmpAssignment {
  return {
    id: "speaker",
    mac: null,
    ampModelId,
    firmwareVersion,
    channels: entry.ways.map(({ label, processing: p, nominalOhms }, i) => ({
      channelIndex: i,
      outputName: label || null,
      // A way without a stored impedance reads as 8 Ω, a new output's default.
      ohms: nominalOhms ?? DEFAULT_OHMS,
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
    })),
  };
}

/** `ConfigureActions` over the speaker's ways: channel `i` is way `i`, and
 * every edit changes that way in the draft. Name and Load set the way's label
 * and nominal impedance. Input-side and wiring actions don't exist for a
 * speaker and are left out (optional) or refused (required). */
function wayActions(setWay: (index: number, change: (way: SpeakerWay) => SpeakerWay) => void): ConfigureActions {
  const refuse = async () => actionFailed(REFUSED);
  const edit = (index: number, change: (p: SpeakerProcessing) => SpeakerProcessing) => {
    setWay(index, (w) => ({ ...w, processing: change(w.processing) }));
    return Promise.resolve(ACTION_OK);
  };
  return {
    setChannelDelayIn: refuse,
    setChannelInputMute: refuse,
    setChannelOutputMute: refuse,
    setChannelOhms: (i, ohms) => {
      setWay(i, (w) => ({ ...w, nominalOhms: ohms }));
      return Promise.resolve(ACTION_OK);
    },
    setChannelName: (i, _, name) => {
      setWay(i, (w) => ({ ...w, label: name ?? "" }));
      return Promise.resolve(ACTION_OK);
    },
    // Volume is never part of a speaker (see `data/speaker.rs`).
    setChannelOutput: (i, trimDb, _volumeDb, delayOutMs) =>
      edit(i, (p) => ({
        ...p,
        outputTrimDb: trimDb ?? p.outputTrimDb,
        delayOutMs: delayOutMs ?? p.delayOutMs,
      })),
    setChannelPhaseInvert: (i, inverted) => edit(i, (p) => ({ ...p, phaseInverted: inverted })),
    setChannelNoiseGate: (i, enabled, thresholdDbu) =>
      edit(i, (p) => ({ ...p, noiseGateEnabled: enabled, noiseGateThresholdDbu: thresholdDbu })),
    setChannelFirBypass: (i, bypassed) => edit(i, (p) => ({ ...p, firBypassed: bypassed })),
    setChannelPowerMode: (i, mode) => edit(i, (p) => ({ ...p, powerMode: mode })),
    setChannelFirData: (i, name, coefficients) => edit(i, (p) => ({ ...p, fir: { name, coefficients } })),
    // What an amp holds after the vendor's Remove: a unit impulse.
    clearChannelFirData: (i) => edit(i, (p) => ({ ...p, fir: { name: "", coefficients: [1] } })),
    setCrossoverSlot: (i, __, slot, patch) =>
      edit(i, (p) => {
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
    setEqBand: (i, __, bandIndex, patch) =>
      edit(i, (p) => ({
        ...p,
        outputEq: {
          ...p.outputEq,
          bands: p.outputEq.bands.map((band, b) =>
            b !== bandIndex
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
    setChannelLimiter: (i, patch) =>
      edit(i, (p) => {
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
      .sort((a, b) =>
        a.brand.localeCompare(b.brand) ||
        a.family.localeCompare(b.family) ||
        a.model.localeCompare(b.model) ||
        a.application.localeCompare(b.application),
      );
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

  // Folded tree groups, by path: NUL + brand, or that + NUL + family.
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const searching = search.trim() !== "";
  function toggle(id: string) {
    setCollapsed((c) => {
      const next = new Set(c);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  /** The tree below `path`: `entries` grouped by level `level` of
   * `TREE_LEVELS`, each group foldable, down to the speakers. A layer with
   * a single group is no choice, so its contents show in its place; so do
   * speakers with no name at a level (no family). */
  function branches(entries: SpeakerLibraryEntry[], level: number, depth: number, path: string): ReactNode {
    if (level === TREE_LEVELS.length) return entries.map((entry) => leaf(entry, depth));
    const groups = groupBy(entries, TREE_LEVELS[level]);
    if (groups.length === 1) return branches(entries, level + 1, depth, `${path}\u0000${groups[0][0]}`);
    return groups.map(([name, members]) => {
      const id = `${path}\u0000${name}`;
      if (!name) return <Fragment key={id}>{branches(members, level + 1, depth, id)}</Fragment>;
      return (
        <TreeGroup
          key={id}
          label={name}
          count={members.length}
          depth={depth}
          open={searching || !collapsed.has(id)}
          onToggle={() => toggle(id)}
        >
          {branches(members, level + 1, depth + 1, id)}
        </TreeGroup>
      );
    });
  }

  /** One speaker in the tree: its model, and what tells it apart from its
   * siblings (application, way count). */
  function leaf(entry: SpeakerLibraryEntry, depth: number) {
    const active = entry.id === selected?.id;
    // One way is the usual case and says nothing; only a count above it does.
    const ways = entry.ways.length;
    const detail = [entry.application, ways > 1 && `${ways} ways`].filter(Boolean).join(" · ");
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
        style={{ paddingLeft: TREE_INDENT * depth + 8 }}
        className={`flex cursor-pointer items-center gap-2 rounded-md border py-1 pr-1 ${
          active ? "border-[var(--accent)] bg-[var(--accent-soft)]" : "border-transparent hover:bg-[var(--amp-color-gray-light)]"
        }`}
      >
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">{entry.model}</span>
          {detail && <span className={`${MUTED} truncate`}>{detail}</span>}
        </div>
        {DRAFTS.has(entry.id) && (
          <Hint text="Unsaved changes" className="flex">
            <span className={UNSAVED_DOT} />
          </Hint>
        )}
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
          {/* Brand › Family › speaker, as in the Add Speaker dialog. Groups
              start open and can be folded; a search shows every match. */}
          <div className="flex flex-col gap-0.5">{branches(shown, 0, 0, "")}</div>
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

type Update = (
  change: (draft: SpeakerLibraryEntry) => SpeakerLibraryEntry,
  reorder?: (origins: (number | null)[]) => (number | null)[],
) => void;

/** The selected speaker: a compact header (name, details, ranges, save) over
 * one "pearl necklace" per way — the Output tab's own row of tiles for a
 * stand-in output (`OutputChannelRow` with `preset`), whose EQ / FIR / LIM
 * tiles open the Output tab's editor dialog with a way switcher. */
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

/** The firmwares a speaker can be edited against: every CVR amp runs one. */
const FIRMWARES = firmwareOptionsFor("cvrUdp");

/** The firmware whose ranges and features the editors offer. A speaker
 * belongs to no amp, so there is no model: rated voltage only matters on
 * apply, where `fit` bounds the values to the real amp. Defaults to the
 * project's first amp's firmware, else the newest. */
function useReferenceFirmware(project: Project) {
  const fallback = useMemo(() => {
    const own = project.ampAssignments.map((a) => a.firmwareVersion).find((f) => f && FIRMWARES.includes(f));
    return own ?? FIRMWARES[0] ?? null;
  }, [project.ampAssignments]);
  const [choice, setChoice] = useState<string | null>(null);
  const firmware = choice ?? fallback;
  const [capability, setCapability] = useState<AmpCapability | null>(null);

  useEffect(() => {
    let cancelled = false;
    commands.ampCapabilityForFirmware(firmware).then((c) => !cancelled && setCapability(c));
    return () => {
      cancelled = true;
    };
  }, [firmware]);

  return { firmware, capability, choose: setChoice };
}

type ReferenceFirmware = ReturnType<typeof useReferenceFirmware>;

/** "Firmware 1.1.8" in the header; opens the firmware picker. */
function ReferenceChip({ reference }: { reference: ReferenceFirmware }) {
  const [open, setOpen] = useState(false);
  const noSpeakerManagement = reference.capability && !reference.capability.firmware.speakerManagement;
  return (
    <TilePopover
      opened={open}
      onOpenChange={setOpen}
      width={260}
      trigger={
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex cursor-pointer items-center gap-1 rounded-sm border border-[var(--amp-color-default-border)] bg-transparent px-1.5 py-0.5 text-inherit hover:bg-[var(--amp-color-gray-light)]"
        >
          <span>Firmware {reference.firmware ?? "—"}</span>
          {noSpeakerManagement && <span className="text-warning">!</span>}
          <ChevronDown size={12} />
        </button>
      }
    >
      <div className="flex flex-col gap-2">
        <span className={MUTED}>
          A speaker belongs to no amp: the firmware sets the ranges and features offered here. Applying it fits the values to
          each amp.
        </span>
        <SimpleSelect
          data={FIRMWARES.map((f) => ({ value: f, label: `Firmware ${f}` }))}
          value={reference.firmware}
          onChange={(firmware) => firmware && reference.choose(firmware)}
        />
        {noSpeakerManagement && <span className="text-sm text-warning">This firmware has no speaker management.</span>}
      </div>
    </TilePopover>
  );
}

const DETAIL_FIELDS = [
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
