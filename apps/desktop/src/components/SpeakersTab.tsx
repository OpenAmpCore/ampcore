import { useMemo, useRef, useState, type ReactNode } from "react";
import { Button, ButtonGroup, Chip, Dropdown, Modal, Spinner, dropdownVariants, toast } from "@heroui/react";
import { FileUp, GripVertical, MoreHorizontal } from "lucide-react";
import {
  commands,
  type AmpAssignment,
  type ChannelSpeakerState,
  type Project,
  type SlImportResult,
  type SpeakerDetails,
  type SpeakerLibraryEntry,
} from "../lib/bindings";
import type { ConfigureActions } from "../lib/configureActions";
import { useIsCompact } from "../lib/breakpoints";
import { applySpeakerProcessing, speakerName } from "../lib/speakers";
import { useConfirm } from "./ConfirmDialog";
import { SimpleSelect } from "./SimpleSelect";
import { FIELD_INPUT } from "./fieldClasses";

const DROPDOWN_SLOTS = dropdownVariants();
const DRAG_TYPE = "application/x-ampcore-speaker-id";
const MUTED = "text-[length:var(--amp-font-size-xs)] text-[var(--amp-color-dimmed)]";

/** One output as this tab sees it: a bridged pair is one output, driven by
 * its leader — the follower is inert, as in the Output tab. */
interface OutputRow {
  leader: number;
  label: string;
}

function letter(channelIndex: number): string {
  return String.fromCharCode(65 + channelIndex);
}

function outputRows(assignment: AmpAssignment): OutputRow[] {
  const channels = [...assignment.channels].sort((a, b) => a.channelIndex - b.channelIndex);
  const bridged = new Set(channels.filter((c) => c.outputBridged && c.channelIndex % 2 === 0).map((c) => c.channelIndex));
  return channels
    .filter((c) => !(c.channelIndex % 2 === 1 && bridged.has(c.channelIndex - 1)))
    .map((c) => ({
      leader: c.channelIndex,
      label: bridged.has(c.channelIndex) && c.channelIndex + 1 < channels.length
        ? `${letter(c.channelIndex)}+${letter(c.channelIndex + 1)}`
        : letter(c.channelIndex),
    }));
}

type Assignment = { row: OutputRow; wayIndex: number };

/** The Speakers tab: this project amp's outputs on one side, this machine's
 * speaker library on the other. Assigning writes the way's values through
 * `actions` — the same path as any hand edit, so a linked amp in a live
 * session is written directly — and then records the reference in the
 * project. Project amps only; see `data/speaker.rs` for the model. */
export function SpeakersTab({
  project,
  assignment,
  library,
  states,
  actions,
  locked,
  onProjectUpdate,
}: {
  project: Project;
  assignment: AmpAssignment;
  /** `useSpeakerLibrary` / `useSpeakerStates`, owned by `AmpConfigureView`,
   * which also shows the states on the Output tab. */
  library: SpeakerLibraryEntry[];
  states: Map<number, ChannelSpeakerState>;
  actions: ConfigureActions;
  locked: boolean;
  onProjectUpdate: (project: Project) => void;
}) {
  const compact = useIsCompact();
  const rows = useMemo(() => outputRows(assignment), [assignment]);
  const { confirm, dialog } = useConfirm();
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState<SpeakerLibraryEntry | null>(null);
  const [dropRow, setDropRow] = useState<number | null>(null);
  const [assignTarget, setAssignTarget] = useState<SpeakerLibraryEntry | null>(null);
  const [details, setDetails] = useState<DetailsTarget | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  async function assign(entry: SpeakerLibraryEntry, items: Assignment[]) {
    if (locked || busy || items.length === 0) return;
    const outputs = items.map((i) => i.row.label).join(", ");
    const ok = await confirm({
      title: `Set up ${items.length === 1 ? "output" : "outputs"} ${outputs} as ${speakerName(entry)}?`,
      description: "Their output EQ, limiters, delay and polarity are replaced with the speaker's.",
      confirmLabel: "Apply",
    });
    if (!ok) return;
    setBusy(true);
    for (const { row, wayIndex } of items) {
      const applied = await applySpeakerProcessing(actions, row.leader, entry.ways[wayIndex].processing);
      if (!applied.ok) {
        toast.danger(`Output ${row.label}: speaker not applied`, { description: applied.message });
        break;
      }
      const r = await commands.projectsSetChannelSpeaker(project.id, assignment.id, row.leader, entry.id, wayIndex);
      if (r.status !== "ok") {
        toast.danger(`Output ${row.label}: speaker not recorded`, { description: r.error.message });
        break;
      }
      onProjectUpdate(r.data);
    }
    setBusy(false);
  }

  /** A drop on `rowIndex` fills one output per way, starting there. */
  function dropSpan(entry: SpeakerLibraryEntry, rowIndex: number): Assignment[] | null {
    if (rowIndex + entry.ways.length > rows.length) return null;
    return entry.ways.map((_, wayIndex) => ({ row: rows[rowIndex + wayIndex], wayIndex }));
  }

  async function runProjectCommand(call: Promise<{ status: "ok"; data: Project } | { status: "error"; error: { message: string } }>, failure: string) {
    const r = await call;
    if (r.status === "ok") onProjectUpdate(r.data);
    else toast.danger(failure, { description: r.error.message });
  }

  async function handleRowAction(row: OutputRow, rowIndex: number, action: string) {
    const state = states.get(row.leader);
    const entry = state && library.find((e) => e.id === state.speaker.libraryId);
    if (action === "reapply" && entry && state) {
      await assign(entry, [{ row, wayIndex: state.speaker.wayIndex }]);
    } else if (action === "update" && state) {
      const ok = await confirm({
        title: `Update ${state.speaker.label} from output ${row.label}?`,
        description: "The library way takes this output's values. Other outputs set up from it will show \"Library updated\".",
        confirmLabel: "Update library",
      });
      if (ok) await runProjectCommand(commands.speakersUpdateFromOutput(project.id, assignment.id, row.leader), "Library not updated");
    } else if (action === "remove") {
      await runProjectCommand(
        commands.projectsSetChannelSpeaker(project.id, assignment.id, row.leader, null, 0),
        "Speaker not removed",
      );
    } else if (action === "save") {
      setDetails({ kind: "save", rowIndex });
    }
  }

  async function handleLibraryAction(entry: SpeakerLibraryEntry, action: string) {
    if (action === "assign") setAssignTarget(entry);
    else if (action === "edit") setDetails({ kind: "edit", entry });
    else if (action === "delete") {
      const ok = await confirm({
        title: `Delete ${speakerName(entry)}?`,
        description: "Outputs set up from it keep their values and show as detached.",
        confirmLabel: "Delete",
        tone: "danger",
      });
      if (ok) {
        const r = await commands.speakersDelete(entry.id);
        if (r.status !== "ok") toast.danger("Speaker not deleted", { description: r.error.message });
      }
    }
  }

  const span = dragging && dropRow !== null ? dropSpan(dragging, dropRow) : null;
  const spanRows = new Set(span?.map((s) => s.row.leader) ?? (dragging && dropRow !== null ? [rows[dropRow].leader] : []));

  return (
    <div className={`flex h-full min-h-0 min-w-0 gap-4 p-4 ${compact ? "flex-col overflow-auto" : ""}`}>
      <Pane title="Outputs" compact={compact}>
        {rows.map((row, rowIndex) => (
          <OutputSpeakerRow
            key={row.leader}
            row={row}
            state={states.get(row.leader)}
            continues={isSameSpeaker(states.get(rows[rowIndex - 1]?.leader), states.get(row.leader))}
            highlight={spanRows.has(row.leader) ? (span ? "fits" : "overflow") : null}
            disabled={locked || busy}
            onDragOver={(e) => {
              if (!dragging || locked) return;
              e.preventDefault();
              setDropRow(rowIndex);
            }}
            onDrop={(e) => {
              e.preventDefault();
              const entry = library.find((l) => l.id === e.dataTransfer.getData(DRAG_TYPE));
              setDragging(null);
              setDropRow(null);
              const items = entry && dropSpan(entry, rowIndex);
              if (entry && items) void assign(entry, items);
            }}
            onAction={(action) => void handleRowAction(row, rowIndex, action)}
          />
        ))}
        {busy && (
          <div className="flex items-center gap-2">
            <Spinner size="sm" />
            <span className={MUTED}>Applying…</span>
          </div>
        )}
      </Pane>

      <Pane
        title="Library"
        compact={compact}
        actions={
          <Button size="sm" variant="secondary" isDisabled={locked} onPress={() => setImportOpen(true)}>
            <FileUp size={14} /> Import .sl…
          </Button>
        }
      >
        <LibraryList
          library={library}
          disabled={locked}
          onDragStart={setDragging}
          onDragEnd={() => {
            setDragging(null);
            setDropRow(null);
          }}
          onAction={(entry, action) => void handleLibraryAction(entry, action)}
        />
      </Pane>

      <AssignModal entry={assignTarget} rows={rows} onClose={() => setAssignTarget(null)} onAssign={(e, items) => void assign(e, items)} />
      <DetailsModal
        target={details}
        rows={rows}
        onClose={() => setDetails(null)}
        onSave={async (target, value) => {
          if (target.kind === "edit") {
            const r = await commands.speakersUpdateDetails(target.entry.id, value);
            return r.status === "ok" ? null : r.error.message;
          }
          const channels = rows.slice(target.rowIndex, target.rowIndex + value.wayLabels.length).map((r) => r.leader);
          const r = await commands.speakersSaveFromOutputs(project.id, assignment.id, channels, value);
          if (r.status !== "ok") return r.error.message;
          onProjectUpdate(r.data);
          return null;
        }}
      />
      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} />
      {dialog}
    </div>
  );
}

function isSameSpeaker(prev: ChannelSpeakerState | undefined, cur: ChannelSpeakerState | undefined): boolean {
  return !!prev && !!cur && prev.speaker.libraryId === cur.speaker.libraryId && cur.speaker.wayIndex === prev.speaker.wayIndex + 1;
}

function Pane({ title, compact, actions, children }: { title: string; compact: boolean; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className={`flex min-w-0 flex-1 flex-col gap-2 ${compact ? "" : "min-h-0"}`}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {actions}
      </div>
      <div className={`flex min-w-0 flex-col gap-1 ${compact ? "" : "min-h-0 flex-1 overflow-auto"}`}>{children}</div>
    </section>
  );
}

/** A ⋯ button with its menu — the standalone-overlay pattern of the preset
 * rows (`triggerRef` + `isOpen`), since `Dropdown.Menu` is a RAC collection
 * and its items must be direct children. */
function RowMenu({ label, items, disabled, onAction }: {
  label: string;
  items: Array<{ id: string; label: string; danger?: boolean }>;
  disabled?: boolean;
  onAction: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  if (items.length === 0) return null;
  return (
    <>
      <div ref={ref} className="flex">
        <Button size="sm" variant="ghost" isIconOnly aria-label={label} isDisabled={disabled} onPress={() => setOpen((o) => !o)}>
          <MoreHorizontal size={16} />
        </Button>
      </div>
      <Dropdown.Popover triggerRef={ref} isOpen={open} onOpenChange={setOpen} placement="bottom end" className={`${DROPDOWN_SLOTS.popover()} min-w-[200px]`}>
        <Dropdown.Menu
          className={DROPDOWN_SLOTS.menu()}
          onAction={(key) => {
            setOpen(false);
            onAction(String(key));
          }}
        >
          {items.map((item) => (
            <Dropdown.Item key={item.id} id={item.id} className={item.danger ? "text-danger" : undefined}>
              {item.label}
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </>
  );
}

export function StatusChip({ state }: { state: ChannelSpeakerState }) {
  const s = state.status;
  const fields = s.kind === "edited" || s.kind === "libraryUpdated" ? s.fields : [];
  const [text, color] =
    s.kind === "match" ? ["Match", "success"] as const
    : s.kind === "edited" ? ["Edited", "warning"] as const
    : s.kind === "libraryUpdated" ? ["Library updated", "accent"] as const
    : ["Detached", "default"] as const;
  const title =
    s.kind === "detached" ? "No longer in this machine's library — the output keeps its values."
    : fields.length > 0 ? `Differs: ${fields.join(", ")}`
    : s.kind === "match" ? "Matches the library." : undefined;
  return (
    <span title={title} className="shrink-0">
      <Chip size="sm" color={color}>{text}</Chip>
    </span>
  );
}

function OutputSpeakerRow({
  row,
  state,
  continues,
  highlight,
  disabled,
  onDragOver,
  onDrop,
  onAction,
}: {
  row: OutputRow;
  state: ChannelSpeakerState | undefined;
  /** The previous output holds the previous way of the same speaker. */
  continues: boolean;
  highlight: "fits" | "overflow" | null;
  disabled: boolean;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onAction: (action: string) => void;
}) {
  const status = state?.status.kind;
  const items = [
    ...(state && status !== "match" && status !== "detached" ? [{ id: "reapply", label: "Re-apply from library" }] : []),
    ...(status === "edited" ? [{ id: "update", label: "Update library from this output…" }] : []),
    { id: "save", label: "Save as new speaker…" },
    ...(state ? [{ id: "remove", label: "Remove speaker (keep values)" }] : []),
  ];
  const [name, way] = state ? splitLabel(state.speaker.label) : [null, null];
  return (
    <div
      onDragOver={onDragOver}
      onDrop={onDrop}
      className="flex min-w-0 items-center gap-2 rounded-md border px-2 py-1.5 transition-colors"
      style={{
        borderColor: highlight === "fits" ? "var(--accent)" : highlight === "overflow" ? "var(--amp-color-red)" : "var(--amp-color-gray-light)",
        background: highlight === "fits" ? "var(--accent-soft)" : undefined,
        marginTop: continues ? -2 : undefined,
      }}
    >
      <span className="w-9 shrink-0 text-sm font-bold tabular-nums">{row.label}</span>
      <span className="min-w-0 flex-1 truncate text-sm" title={state?.speaker.label}>
        {state ? (
          <>
            <span className={continues ? "text-[var(--amp-color-dimmed)]" : undefined}>{name}</span>
            {way && <span className="text-[var(--amp-color-dimmed)]"> · {way}</span>}
          </>
        ) : (
          <span className={`${MUTED} italic`}>No speaker — drop one here</span>
        )}
      </span>
      {state && <StatusChip state={state} />}
      <RowMenu label={`Speaker actions for output ${row.label}`} items={items} disabled={disabled} onAction={onAction} />
    </div>
  );
}

function splitLabel(label: string): [string, string | null] {
  const i = label.lastIndexOf(" · ");
  return i < 0 ? [label, null] : [label.slice(0, i), label.slice(i + 3)];
}

const WAY_FILTERS = [
  { id: "all", label: "All" },
  { id: "1", label: "1" },
  { id: "2", label: "2" },
  { id: "3", label: "3+" },
];

function LibraryList({
  library,
  disabled,
  onDragStart,
  onDragEnd,
  onAction,
}: {
  library: SpeakerLibraryEntry[];
  disabled: boolean;
  onDragStart: (entry: SpeakerLibraryEntry) => void;
  onDragEnd: () => void;
  onAction: (entry: SpeakerLibraryEntry, action: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [ways, setWays] = useState("all");
  const q = query.trim().toLowerCase();
  const shown = library.filter((e) => {
    const n = e.ways.length;
    if (ways !== "all" && (ways === "3" ? n < 3 : n !== Number(ways))) return false;
    if (!q) return true;
    return [e.brand, e.family, e.model, e.application, ...e.ways.map((w) => w.label)].some((t) => t.toLowerCase().includes(q));
  });
  const brands = [...new Set(shown.map((e) => e.brand))].sort((a, b) => a.localeCompare(b));

  if (library.length === 0) {
    return <span className={MUTED}>No speakers yet. Import .sl files, or save an output as a speaker from its ⋯ menu.</span>;
  }
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          placeholder="Search brand, model, way…"
          value={query}
          className={`${FIELD_INPUT} min-w-0 flex-1`}
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
        <ButtonGroup size="sm" aria-label="Filter by number of ways">
          {WAY_FILTERS.map((f) => (
            <Button key={f.id} variant={ways === f.id ? "primary" : "ghost"} onPress={() => setWays(f.id)}>
              {f.label}
            </Button>
          ))}
        </ButtonGroup>
      </div>
      {shown.length === 0 && <span className={MUTED}>No speaker matches.</span>}
      {brands.map((brand) => (
        <div key={brand} className="flex flex-col gap-0.5">
          <span className={`${MUTED} mt-2 font-semibold uppercase`}>{brand}</span>
          {shown
            .filter((e) => e.brand === brand)
            .sort((a, b) => a.model.localeCompare(b.model))
            .map((entry) => (
              <div
                key={entry.id}
                draggable={!disabled}
                onDragStart={(e) => {
                  e.dataTransfer.setData(DRAG_TYPE, entry.id);
                  e.dataTransfer.effectAllowed = "copy";
                  onDragStart(entry);
                }}
                onDragEnd={onDragEnd}
                className={`flex min-w-0 items-center gap-2 rounded-md px-1 py-1 hover:bg-[var(--amp-color-gray-light)] ${disabled ? "" : "cursor-grab"}`}
                title={entry.notes || undefined}
              >
                <GripVertical size={14} className="shrink-0 text-[var(--amp-color-dimmed)]" />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {entry.model}
                  {entry.family && <span className="text-[var(--amp-color-dimmed)]"> · {entry.family}</span>}
                </span>
                <span className={`${MUTED} hidden truncate sm:inline`} style={{ maxWidth: 160 }}>
                  {entry.ways.map((w) => w.label).join(" · ")}
                </span>
                <Chip size="sm" color="default" className="shrink-0">
                  {entry.ways.length} way
                </Chip>
                <RowMenu
                  label={`Actions for ${speakerName(entry)}`}
                  disabled={disabled}
                  items={[
                    { id: "assign", label: "Assign to outputs…" },
                    { id: "edit", label: "Edit details…" },
                    { id: "delete", label: "Delete…", danger: true },
                  ]}
                  onAction={(action) => onAction(entry, action)}
                />
              </div>
            ))}
        </div>
      ))}
    </>
  );
}

/** The keyboard-reachable, precise alternative to dragging: pick a way per
 * output. Each output records the way it was given. */
function AssignModal({
  entry,
  rows,
  onClose,
  onAssign,
}: {
  entry: SpeakerLibraryEntry | null;
  rows: OutputRow[];
  onClose: () => void;
  onAssign: (entry: SpeakerLibraryEntry, items: Assignment[]) => void;
}) {
  const [picks, setPicks] = useState<Record<number, string>>({});
  const options = [
    { value: "", label: "No change" },
    ...(entry?.ways.map((w, i) => ({ value: String(i), label: entry.ways.length === 1 ? "Full range" : `Way ${i + 1}: ${w.label}` })) ?? []),
  ];
  const items = rows.flatMap((row) => (picks[row.leader] ? [{ row, wayIndex: Number(picks[row.leader]) }] : []));
  function close() {
    setPicks({});
    onClose();
  }
  return (
    <Modal.Backdrop isOpen={entry !== null} onOpenChange={(open) => !open && close()}>
      <Modal.Container placement="center" size="md">
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Heading>{entry ? `Assign ${speakerName(entry)}` : "Assign"}</Modal.Heading>
            <Modal.CloseTrigger />
          </Modal.Header>
          <Modal.Body>
            <div className="flex flex-col gap-2">
              {rows.map((row) => (
                <div key={row.leader} className="flex items-center gap-3">
                  <span className="w-12 shrink-0 text-sm font-bold">Out {row.label}</span>
                  <SimpleSelect
                    data={options}
                    value={picks[row.leader] ?? ""}
                    onChange={(v) => setPicks((p) => ({ ...p, [row.leader]: v ?? "" }))}
                  />
                </div>
              ))}
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="secondary" onPress={close}>Cancel</Button>
                <Button
                  variant="primary"
                  isDisabled={items.length === 0}
                  onPress={() => {
                    if (entry) onAssign(entry, items);
                    close();
                  }}
                >
                  Assign
                </Button>
              </div>
            </div>
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

type DetailsTarget = { kind: "edit"; entry: SpeakerLibraryEntry } | { kind: "save"; rowIndex: number };

const EMPTY_DETAILS: SpeakerDetails = { brand: "", family: "", model: "", application: "", notes: "", wayLabels: [""] };

/** Edit an entry's metadata, or save outputs as a new entry. Editing never
 * touches processing — "Update library from this output" does that. */
function DetailsModal({
  target,
  rows,
  onClose,
  onSave,
}: {
  target: DetailsTarget | null;
  rows: OutputRow[];
  onClose: () => void;
  onSave: (target: DetailsTarget, details: SpeakerDetails) => Promise<string | null>;
}) {
  const compact = useIsCompact();
  const [draft, setDraft] = useState<SpeakerDetails>(EMPTY_DETAILS);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const seeded = useRef<DetailsTarget | null>(null);
  if (target !== seeded.current) {
    seeded.current = target;
    if (target) {
      setError(null);
      setDraft(
        target.kind === "edit"
          ? { ...target.entry, wayLabels: target.entry.ways.map((w) => w.label) }
          : EMPTY_DETAILS,
      );
    }
  }
  const maxWays = target?.kind === "save" ? rows.length - target.rowIndex : 0;
  const set = (patch: Partial<SpeakerDetails>) => setDraft((d) => ({ ...d, ...patch }));

  async function save() {
    if (!target || saving) return;
    setSaving(true);
    const message = await onSave(target, draft);
    setSaving(false);
    if (message) setError(message);
    else onClose();
  }

  const field = (key: "brand" | "family" | "model" | "application", label: string, required = false) => (
    <label className="flex flex-col gap-1">
      <span className={MUTED}>{label}{required && " *"}</span>
      <input className={FIELD_INPUT} value={draft[key]} onChange={(e) => set({ [key]: e.currentTarget.value })} />
    </label>
  );

  return (
    <Modal.Backdrop isOpen={target !== null} onOpenChange={(open) => !open && onClose()}>
      <Modal.Container placement="center" size={compact ? "full" : "lg"}>
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Heading>
              {target?.kind === "edit" ? "Speaker details" : `Save output ${target ? rows[target.rowIndex]?.label : ""} as speaker`}
            </Modal.Heading>
            <Modal.CloseTrigger />
          </Modal.Header>
          <Modal.Body>
            <div className="flex flex-col gap-3">
              {target?.kind === "save" && (
                <span className={MUTED}>
                  Captures this project's output EQ, limiters, delay and polarity. A multi-way speaker takes one way
                  per output, starting here.
                </span>
              )}
              <div className="grid grid-cols-2 gap-3">
                {field("brand", "Brand", true)}
                {field("model", "Model", true)}
                {field("family", "Family")}
                {field("application", "Application")}
              </div>
              <label className="flex flex-col gap-1">
                <span className={MUTED}>Notes</span>
                <textarea className={FIELD_INPUT} rows={2} value={draft.notes} onChange={(e) => set({ notes: e.currentTarget.value })} />
              </label>
              {target?.kind === "save" && maxWays > 1 && (
                <SimpleSelect
                  label="Ways"
                  data={Array.from({ length: maxWays }, (_, i) => ({
                    value: String(i + 1),
                    label: `${i + 1} — outputs ${rows[target.rowIndex].label}–${rows[target.rowIndex + i].label}`,
                  }))}
                  value={String(draft.wayLabels.length)}
                  onChange={(v) => {
                    const n = Number(v ?? 1);
                    set({ wayLabels: Array.from({ length: n }, (_, i) => draft.wayLabels[i] ?? "") });
                  }}
                />
              )}
              {draft.wayLabels.length > 1 && (
                <div className="grid grid-cols-2 gap-3">
                  {draft.wayLabels.map((label, i) => (
                    <label key={i} className="flex flex-col gap-1">
                      <span className={MUTED}>Way {i + 1}{target?.kind === "save" ? ` (output ${rows[target.rowIndex + i]?.label})` : ""}</span>
                      <input
                        className={FIELD_INPUT}
                        placeholder={i === 0 ? "e.g. Low" : "e.g. High"}
                        value={label}
                        onChange={(e) => {
                          const next = [...draft.wayLabels];
                          next[i] = e.currentTarget.value;
                          set({ wayLabels: next });
                        }}
                      />
                    </label>
                  ))}
                </div>
              )}
              {error && <span className="text-sm text-danger">{error}</span>}
              <div className="flex justify-end gap-2">
                <Button variant="secondary" isDisabled={saving} onPress={onClose}>Cancel</Button>
                <Button
                  variant="primary"
                  isDisabled={saving || !draft.brand.trim() || !draft.model.trim()}
                  onPress={() => void save()}
                >
                  {saving ? <Spinner size="sm" /> : target?.kind === "edit" ? "Save details" : "Save to library"}
                </Button>
              </div>
            </div>
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

/** Pick any number of `.sl` files, preview every one (with the reason a file
 * can't be read), then import all readable ones at once. */
function ImportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const compact = useIsCompact();
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<{ fileName: string; bytes: number[] }[]>([]);
  const [preview, setPreview] = useState<SlImportResult[] | null>(null);
  const [busy, setBusy] = useState(false);

  function close() {
    setFiles([]);
    setPreview(null);
    onClose();
  }

  async function pick(list: File[]) {
    setBusy(true);
    const next = await Promise.all(
      list.map(async (f) => ({ fileName: f.name, bytes: [...new Uint8Array(await f.arrayBuffer())] })),
    );
    const r = await commands.speakersImportSl(next, false);
    setBusy(false);
    if (r.status !== "ok") {
      toast.danger("Could not read the files", { description: r.error.message });
      return;
    }
    setFiles(next);
    setPreview(r.data);
  }

  async function commit() {
    setBusy(true);
    const r = await commands.speakersImportSl(files, true);
    setBusy(false);
    if (r.status !== "ok") {
      toast.danger("Import failed", { description: r.error.message });
      return;
    }
    close();
  }

  const readable = preview?.filter((p) => p.entry).length ?? 0;
  return (
    <Modal.Backdrop isOpen={open} onOpenChange={(o) => !o && close()}>
      <Modal.Container placement="center" size={compact ? "full" : "lg"}>
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Heading>Import .sl files</Modal.Heading>
            <Modal.CloseTrigger />
          </Modal.Header>
          <Modal.Body>
            <div className="flex flex-col gap-3">
              <input
                ref={inputRef}
                type="file"
                accept=".sl"
                multiple
                style={{ display: "none" }}
                onChange={(e) => {
                  // Copied before the reset: a `FileList` is live, and
                  // clearing `value` empties it.
                  const list = [...(e.target.files ?? [])];
                  e.target.value = "";
                  if (list.length) void pick(list);
                }}
              />
              <div className="flex items-center gap-2">
                <Button size="sm" variant="secondary" isDisabled={busy} onPress={() => inputRef.current?.click()}>
                  <FileUp size={14} /> Choose files…
                </Button>
                <span className={MUTED}>Vendor speaker files. Details can be edited after importing.</span>
              </div>
              {preview && (
                <div className="flex max-h-[50vh] flex-col gap-0.5 overflow-auto">
                  {preview.map((p) => (
                    <div key={p.fileName} className="flex min-w-0 items-center gap-2 text-sm" style={{ opacity: p.entry ? 1 : 0.6 }}>
                      <span className={p.entry ? "text-success" : "text-danger"}>{p.entry ? "✓" : "✗"}</span>
                      <span className="min-w-0 flex-1 truncate" title={p.fileName}>{p.fileName}</span>
                      {p.entry ? (
                        <span className={`${MUTED} truncate`}>
                          {speakerName(p.entry)} · {p.entry.ways.length} way{p.duplicate && " · already in library"}
                        </span>
                      ) : (
                        <span className="truncate text-xs text-danger" title={p.error ?? undefined}>{p.error}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="secondary" isDisabled={busy} onPress={close}>Cancel</Button>
                <Button variant="primary" isDisabled={busy || readable === 0} onPress={() => void commit()}>
                  {busy ? <Spinner size="sm" /> : `Import ${readable || ""}`.trim()}
                </Button>
              </div>
            </div>
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
