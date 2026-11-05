import { Fragment, useEffect, useMemo, useReducer, useState, type ReactNode } from "react";
import { Button, toast } from "@heroui/react";
import { ChevronRight, FileUp, FolderOpen, Plus } from "lucide-react";
import { commands, type AmpAssignment, type AmpModelCatalogEntry, type Project, type SpeakerLibraryEntry } from "../../lib/bindings";
import { useIsCompact } from "../../lib/breakpoints";
import { speakerName, useSpeakerLibrary } from "../../lib/speakers";
import { useConfirm } from "../ConfirmDialog";
import { Hint } from "../Hint";
import { MUTED, RowMenu } from "../speakers/SpeakerBench";
import { ImportModal } from "../speakers/ImportModal";
import { FIELD_INPUT } from "../fieldClasses";
import { useProjectSpeakers } from "../speakers/useProjectSpeakers";
import { CreateModal } from "./CreateModal";
import { SpeakerEditor, type Update } from "./SpeakerEditor";
import { UNSAVED_DOT } from "./shared";

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

  async function openFolder() {
    const r = await commands.speakersOpenFolder();
    if (r.status === "error") toast.danger("Folder not opened", { description: r.error.message });
  }

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
          <Hint text="Import preset files">
            <Button size="sm" variant="ghost" isIconOnly aria-label="Import preset files" onPress={() => setImportOpen(true)}>
              <FileUp size={14} />
            </Button>
          </Hint>
          <Hint text="Open the library folder">
            <Button size="sm" variant="ghost" isIconOnly aria-label="Open the library folder" onPress={() => void openFolder()}>
              <FolderOpen size={14} />
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
