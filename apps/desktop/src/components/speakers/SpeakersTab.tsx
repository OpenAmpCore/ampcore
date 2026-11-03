import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, Spinner, toast } from "@heroui/react";
import { listen } from "@tauri-apps/api/event";
import { FileDown, FileUp, Link2, RotateCcw, Save, SplitSquareVertical, Trash2, Upload } from "lucide-react";
import { commands, type AmpAssignment, type ChannelSpeakerState, type Project, type SpeakerLibraryEntry } from "../../lib/bindings";
import { useIsCompact } from "../../lib/breakpoints";
import type { ConfigureActions } from "../../lib/configureActions";
import { usePreference } from "../../lib/preferences";
import { speakerName } from "../../lib/speakers";
import type { PushProgress } from "../sync/AmpPushSteps";
import { useConfirm } from "../ConfirmDialog";
import { Hint } from "../Hint";
import { MUTED, SpeakerBench, buildCabinets, outputRows, type Cabinet, type OutputRow, type RowHighlight } from "./SpeakerBench";
import { bridgeConfirm, confirmFit } from "./speakerApply";
import { DetailsModal, type DetailsTarget } from "./DetailsModal";
import { ImportModal } from "./ImportModal";
import { DRAG_TYPE, LibraryTable } from "./LibraryTable";
import { LoadModal } from "./LoadModal";


/** `projectSpeakerId` links the output to a project speaker (`SpeakerItem`). */
export type Assignment = { row: OutputRow; wayIndex: number; projectSpeakerId?: string };

/** One output to set up; entries may differ between the items of one apply. */
type ApplyItem = Assignment & { entry: SpeakerLibraryEntry };

/** Joined output groups (leaders) waiting for their speaker, per project amp.
 * Outside the component so a join outlives the tab unmounting.
 * ponytail: session only; move onto AmpAssignment (schema bump) if joins must
 * survive an app restart. */
const JOINS = new Map<string, number[][]>();

type ProjectResult ={ status: "ok"; data: Project } | { status: "error"; error: { message: string } };

/** The Speakers tab: a patch bench (`SpeakerBench`) of this project amp's
 * outputs and speakers over this machine's speaker library. Assigning is one
 * `speakersApply` — values and reference together; the backend pushes them to
 * the linked amp through the sync endpoint when it is online. Project amps
 * only; see `data/speaker.rs`. */
export function SpeakersTab({
  project,
  assignment,
  library,
  states,
  locked,
  actions,
  onProjectUpdate,
}: {
  project: Project;
  assignment: AmpAssignment;
  /** `useSpeakerLibrary` / `useSpeakerStates`, owned by `AmpConfigureView`,
   * which also shows the states on the Output tab. */
  library: SpeakerLibraryEntry[];
  states: Map<number, ChannelSpeakerState>;
  locked: boolean;
  /** For bridging only — everything else here goes through `commands`. */
  actions: ConfigureActions | undefined;
  onProjectUpdate: (project: Project) => void;
}) {
  const compact = useIsCompact();
  const rows = useMemo(() => outputRows(assignment), [assignment]);
  const { confirm, dialog } = useConfirm();
  const showComparator = usePreference("showSpeakerComparator");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState<SpeakerLibraryEntry | null>(null);
  const [dropRow, setDropRow] = useState<number | null>(null);
  const [loadTarget, setLoadTarget] = useState<SpeakerLibraryEntry | null>(null);
  const [details, setDetails] = useState<DetailsTarget | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  /** Selected output leaders, and the row a Shift-click ranges from. */
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const anchor = useRef<number | null>(null);
  /** The running apply's last push event; `null` until its first write. */
  const [progress, setProgress] = useState<PushProgress | null>(null);

  // The push reports each packet; an apply to an offline amp reports nothing
  // and is over at once.
  useEffect(() => {
    if (!busy) return;
    let cancelled = false;
    let stop: (() => void) | undefined;
    void listen<PushProgress>("amp_push:progress", ({ payload: p }) => {
      if (p.assignmentId === assignment.id && p.stagesTotal > 0) setProgress(p);
    }).then((unlisten) => (cancelled ? unlisten() : (stop = unlisten)));
    return () => {
      cancelled = true;
      stop?.();
      setProgress(null);
    };
  }, [busy, assignment.id]);

  const progressFraction = progress ? (progress.stageIndex + progress.packetsDone / (progress.packetsTotal || 1)) / progress.stagesTotal : 0;
  const progressText = !progress ? "Applying…"
    : progress.state === "done" && progress.stageIndex + 1 === progress.stagesTotal ? "Checking the amp…"
    : `Writing ${progress.stageIndex + 1}/${progress.stagesTotal}`;

  const [, rerender] = useState(0);
  const joins = JOINS.get(assignment.id) ?? [];
  function setJoins(next: number[][]) {
    JOINS.set(assignment.id, next);
    rerender((n) => n + 1);
  }
  // A join ends by itself once its outputs hold a speaker (or are bridged away).
  const liveJoins = joins.filter((j) => j.every((leader) => rows.some((r) => r.leader === leader) && !states.has(leader)));
  useEffect(() => {
    // Forgotten for good, so it doesn't come back when the speaker is removed.
    if (liveJoins.length !== joins.length) JOINS.set(assignment.id, liveJoins);
  });
  const inJoin = (leader: number) => liveJoins.find((j) => j.includes(leader));

  const off = locked || busy;
  const cabinets = buildCabinets(rows, states, library, liveJoins, project.speakers ?? []);
  const selectedRows = rows.flatMap((row, i) => (selected.has(row.leader) ? [i] : []));
  const adjacent = selectedRows.every((r, i) => i === 0 || r === selectedRows[i - 1] + 1);

  async function run(call: Promise<ProjectResult>, failure: string): Promise<boolean> {
    const r = await call;
    if (r.status === "ok") onProjectUpdate(r.data);
    else toast.danger(failure, { description: r.error.message });
    return r.status === "ok";
  }

  /** Removes the outputs' speaker references; their values stay. */
  async function release(leaders: number[]) {
    for (const leader of leaders) {
      await run(commands.projectsSetChannelSpeaker(project.id, assignment.id, leader), "Speaker not removed");
    }
  }

  /** The one way a speaker gets onto an output: fit, let the user decide,
   * apply — every item in one `speakersApply`, so the amp gets one push.
   * `preconfirmed` (the Load dialog, where the outputs were just picked) skips
   * the question unless the amp has to adjust something. */
  async function apply(
    items: ApplyItem[],
    ui: { title: string; intro: ReactNode; confirmLabel: string; preconfirmed?: boolean },
  ): Promise<boolean> {
    if (off || items.length === 0) return false;
    const outputs = items.map((i) => i.row.label).join(", ");
    const pairs = await confirmFit({
      projectId: project.id,
      assignmentId: assignment.id,
      items: items.map(({ row, ...item }) => ({ ...item, channelIndex: row.leader, outputLabel: row.label })),
      confirm,
      showComparator,
      ui,
    });
    if (!pairs) return false;
    setBusy(true);
    const r = await commands.speakersApply(project.id, assignment.id, pairs, true);
    setBusy(false);
    if (r.status === "ok") onProjectUpdate(r.data);
    // Stays up: it says what the amp does and doesn't hold now.
    else toast.danger(`Speaker not applied to ${outputs}`, { description: r.error.message, timeout: 0 });
    return r.status === "ok";
  }

  function assign(entry: SpeakerLibraryEntry, items: Assignment[], preconfirmed = false): Promise<boolean> {
    return apply(
      items.map((item) => ({ ...item, entry })),
      {
        title: `Set up ${items.length === 1 ? "output" : "outputs"} ${items.map((i) => i.row.label).join(", ")} as ${speakerName(entry)}?`,
        intro: <span>Their output EQ, limiters, delay, polarity and FIR filter are replaced with the speaker's.</span>,
        confirmLabel: "Apply",
        preconfirmed,
      },
    );
  }

  /** A drop on `rowIndex` fills one output per way, starting there. On an
   * output of a join it fills exactly that join, and only a speaker with as
   * many ways fits; a span elsewhere may not cut into a join. */
  function dropSpan(entry: SpeakerLibraryEntry, rowIndex: number): Assignment[] | null {
    const join = inJoin(rows[rowIndex].leader);
    if (join) {
      if (join.length !== entry.ways.length) return null;
      return join.map((leader, wayIndex) => ({ row: rows.find((r) => r.leader === leader)!, wayIndex }));
    }
    if (rowIndex + entry.ways.length > rows.length) return null;
    const span = entry.ways.map((_, wayIndex) => ({ row: rows[rowIndex + wayIndex], wayIndex }));
    return span.some((s) => inJoin(s.row.leader)) ? null : span;
  }

  function select(rowIndex: number | null, { toggle, range }: { toggle: boolean; range: boolean }) {
    if (rowIndex === null) {
      setSelected(new Set());
      anchor.current = null;
      return;
    }
    const leader = rows[rowIndex].leader;
    if (range && anchor.current !== null) {
      const [lo, hi] = [Math.min(anchor.current, rowIndex), Math.max(anchor.current, rowIndex)];
      setSelected(new Set(rows.slice(lo, hi + 1).map((r) => r.leader)));
      return;
    }
    if (toggle) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (!next.delete(leader)) next.add(leader);
        return next;
      });
    } else {
      setSelected(new Set([leader]));
    }
    anchor.current = rowIndex;
  }

  /** A cable dragged from a cabinet's way to an output: that way moves there. */
  async function link(cabinet: Cabinet, wayIndex: number, rowIndex: number) {
    if (!cabinet.entry) return;
    const from = cabinet.ports.find((p) => p.wayIndex === wayIndex)?.rowIndex ?? null;
    const oldLeader = from !== null ? rows[from].leader : null;
    if (!(await assign(cabinet.entry, [{ row: rows[rowIndex], wayIndex, projectSpeakerId: cabinet.projectSpeakerId }]))) return;
    if (oldLeader !== null) await release([oldLeader]);
  }

  // One unbridged pair (A and B) selected bridges it; one bridged output selected unbridges it.
  const [first, second] = [rows[selectedRows[0]], rows[selectedRows[1]]];
  const bridgeTarget =
    selectedRows.length === 1 && first.bridged ? { leader: first.leader, bridged: false }
    : selectedRows.length === 2 && first.leader % 2 === 0 && second.leader === first.leader + 1 ? { leader: first.leader, bridged: true }
    : null;
  // Two outputs that hold a speaker, or sit in a join, are not merged into one
  // behind the user's back: they are split first.
  const taken = (leader: number) => states.has(leader) || !!inJoin(leader);
  const bridgeBlocked = !!bridgeTarget?.bridged && (taken(first.leader) || taken(second.leader));

  async function toggleBridge() {
    if (!bridgeTarget || bridgeBlocked || !actions?.setOutputBridge) return;
    const { leader, bridged } = bridgeTarget;
    if (!(await confirm(bridgeConfirm(leader, bridged)))) return;
    setBusy(true);
    const r = await actions.setOutputBridge(leader, bridged);
    setBusy(false);
    if (!r.ok) toast.danger(bridged ? "Outputs not bridged" : "Outputs not unbridged", { description: r.message });
    setSelected(new Set());
  }

  function join() {
    setJoins([...liveJoins, selectedRows.map((i) => rows[i].leader)]);
    setSelected(new Set());
  }

  const heldRows = selectedRows.map((i) => rows[i]).filter((row) => states.has(row.leader));

  /** Dissolves the selected outputs' joins and removes their speakers. */
  async function splitReset() {
    if (heldRows.length) {
      const ok = await confirm({
        title: `Remove the speaker from ${heldRows.length === 1 ? "output" : "outputs"} ${heldRows.map((r) => r.label).join(", ")}?`,
        description: "The outputs keep their values; only the link to the library is removed.",
        confirmLabel: "Remove",
      });
      if (!ok) return;
    }
    setJoins(liveJoins.filter((j) => !j.some((leader) => selected.has(leader))));
    setBusy(true);
    await release(heldRows.map((r) => r.leader));
    setBusy(false);
    setSelected(new Set());
  }

  /** Outputs that no longer hold what their library way says, and can be re-applied. */
  const stale = rows.flatMap((row) => {
    const state = states.get(row.leader);
    const kind = state?.status.kind;
    const entry = state && library.find((e) => e.id === state.speaker.libraryId);
    return state && entry && (kind === "edited" || kind === "libraryUpdated") ? [{ row, state, entry }] : [];
  });

  async function applyAll() {
    const done = await apply(
      stale.map(({ row, state, entry }) => ({ row, entry, wayIndex: state.speaker.wayIndex })),
      {
        title: `Re-apply ${stale.length} ${stale.length === 1 ? "output" : "outputs"} from the library?`,
        intro: (
          <>
            <span>These outputs get their library values back. Edits made on them are lost.</span>
            <ul className="max-h-48 list-disc overflow-auto pl-5">
              {stale.map(({ row, state }) => (
                <li key={row.leader}>
                  {row.label}: {state.speaker.label} ({state.status.kind === "edited" ? "edited" : "library updated"})
                </li>
              ))}
            </ul>
          </>
        ),
        confirmLabel: "Apply all",
      },
    );
    if (done) toast.success(`${stale.length} ${stale.length === 1 ? "output" : "outputs"} re-applied`);
  }

  const bridgedRows = rows.filter((r) => r.bridged);

  async function clearAll() {
    const setBridge = actions?.setOutputBridge;
    const pairs = bridgedRows.map((r) => r.label).join(", ");
    const ok = await confirm({
      title: "Remove every speaker from this amp?",
      description:
        "All outputs keep their values; only their links to the library are removed." +
        (bridgedRows.length === 0 ? ""
          : setBridge ? ` ${pairs} ${bridgedRows.length === 1 ? "is" : "are"} unbridged — rewire first.`
          : ` Bridging (${pairs}) can't be changed here and is left as it is.`),
      confirmLabel: "Clear all",
      tone: "danger",
    });
    if (!ok) return;
    setJoins([]);
    setSelected(new Set());
    setBusy(true);
    await release([...states.keys()]);
    if (setBridge) {
      for (const row of bridgedRows) {
        const r = await setBridge(row.leader, false);
        if (!r.ok) toast.danger(`Outputs ${row.label} not unbridged`, { description: r.message });
      }
    }
    setBusy(false);
  }

  function cabinetMenu(cabinet: Cabinet) {
    if (cabinet.pending) {
      return [
        { id: "save", label: "Save as new speaker…" },
        { id: "split", label: "Split" },
      ];
    }
    const kinds = cabinet.ports.map((p) => p.state?.status.kind);
    return [
      ...(cabinet.entry && kinds.some((k) => k === "edited" || k === "libraryUpdated") ? [{ id: "reapply", label: "Re-apply from library" }] : []),
      ...(kinds.includes("edited") ? [{ id: "update", label: "Update library from these outputs…" }] : []),
      ...(cabinet.entry ? [{ id: "edit", label: "Edit details…" }] : []),
      { id: "remove", label: "Remove speaker (keep values)" },
    ];
  }

  async function handleCabinetAction(cabinet: Cabinet, action: string) {
    const linked = cabinet.ports.flatMap((p) => (p.rowIndex !== null && p.rowIndex >= 0 ? [{ ...p, row: rows[p.rowIndex] }] : []));
    if (action === "save" && linked.length) {
      setDetails({ kind: "save", rowIndex: linked[0].rowIndex!, ways: linked.length });
    } else if (action === "split") {
      setJoins(liveJoins.filter((j) => j !== cabinet.joinLeaders));
    } else if (action === "reapply" && cabinet.entry) {
      await assign(cabinet.entry, linked.map(({ row, wayIndex }) => ({ row, wayIndex })));
    } else if (action === "update") {
      const edited = linked.filter((p) => p.state?.status.kind === "edited");
      const ok = await confirm({
        title: `Update ${cabinet.title} from ${edited.length === 1 ? "output" : "outputs"} ${edited.map((p) => p.row.label).join(", ")}?`,
        description: "The library takes these outputs' values. Other outputs set up from it will show \"Library updated\".",
        confirmLabel: "Update library",
      });
      if (!ok) return;
      for (const p of edited) {
        await run(commands.speakersUpdateFromOutput(project.id, assignment.id, p.row.leader), "Library not updated");
      }
    } else if (action === "edit" && cabinet.entry) {
      setDetails({ kind: "edit", entry: cabinet.entry });
    } else if (action === "remove") {
      setBusy(true);
      await release(linked.map((p) => p.row.leader));
      setBusy(false);
    }
  }

  async function handleLibraryAction(entry: SpeakerLibraryEntry, action: string) {
    if (action === "assign") setLoadTarget(entry);
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
  // A drop that doesn't fit lights the hovered output red — its whole join, if it is in one.
  const hovered = dragging && dropRow !== null ? rows[dropRow].leader : null;
  const spanRows = new Set(span?.map((s) => s.row.leader) ?? (hovered !== null ? (inJoin(hovered) ?? [hovered]) : []));
  const highlightFor = (rowIndex: number): RowHighlight =>
    spanRows.has(rows[rowIndex].leader)
      ? span ? "fits" : "overflow"
      : dragging && !locked && dropSpan(dragging, rowIndex) ? "start" : null;

  const counts = [...states.values()].reduce<Record<string, number>>((acc, s) => {
    acc[s.status.kind] = (acc[s.status.kind] ?? 0) + 1;
    return acc;
  }, {});
  const summary = [
    counts.match && `${counts.match} match`,
    counts.edited && `${counts.edited} edited`,
    counts.libraryUpdated && `${counts.libraryUpdated} library updated`,
    counts.detached && `${counts.detached} detached`,
  ].filter(Boolean).join(" · ");

  const tool = (label: string, icon: ReactNode, hint: string, enabled: boolean, onPress: () => void) => (
    <Hint text={hint} className="shrink-0">
      <Button size="sm" variant="secondary" isDisabled={off || !enabled} onPress={onPress}>
        {icon} {label}
      </Button>
    </Hint>
  );

  return (
    // Bench and library side by side; stacked once neither would be usable.
    <div className={`flex h-full min-h-0 min-w-0 gap-4 p-4 ${compact ? "flex-col overflow-auto" : ""}`}>
     <div className={`flex min-w-0 flex-[3] flex-col gap-3 ${compact ? "" : "min-h-0"}`}>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {tool(
          "Join",
          <Link2 size={14} />,
          "Join two or more adjacent free outputs: a multi-way speaker dropped on any of them fills exactly that group.",
          selectedRows.length >= 2 && adjacent && selectedRows.every((i) => !taken(rows[i].leader)),
          join,
        )}
        {tool(
          bridgeTarget && !bridgeTarget.bridged ? "Unbridge" : "Bridge",
          <SplitSquareVertical size={14} />,
          bridgeBlocked ? "Split / Reset these outputs first."
            : actions?.setOutputBridge || locked
              ? "Select both outputs of a pair (A and B) to bridge them, or a bridged output to unbridge it."
              : "Bridging isn't available for this amp.",
          !!bridgeTarget && !bridgeBlocked && !!actions?.setOutputBridge,
          () => void toggleBridge(),
        )}
        {tool("Split / Reset", <RotateCcw size={14} />, "Undo a join and remove the speaker from the selected outputs. Their values stay.", selectedRows.some((i) => taken(rows[i].leader)), () => void splitReset())}
        {tool("Save as speaker…", <Save size={14} />, "Save the selected adjacent outputs to the library, one way per output.", selectedRows.length > 0 && adjacent, () =>
          setDetails({ kind: "save", rowIndex: selectedRows[0], ways: selectedRows.length }),
        )}
        <span className="mx-1 h-5 w-px shrink-0 bg-[var(--amp-color-default-border)]" />
        {tool("Apply all", <Upload size={14} />, "Re-apply every output that no longer matches its library speaker.", stale.length > 0, () => void applyAll())}
        {tool("Clear all", <Trash2 size={14} />, "Remove every speaker and every bridge from this amp. The outputs keep their values.", states.size > 0 || liveJoins.length > 0 || bridgedRows.length > 0, () => void clearAll())}
        <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
          {busy && <Spinner size="sm" />}
          <span className={`${MUTED} truncate`}>{busy ? progressText : summary}</span>
        </div>
      </div>
      {/* One bar for the whole apply; always laid out, so nothing jumps. */}
      <div className="h-1 shrink-0 overflow-hidden rounded-full bg-[var(--amp-color-gray-light)]" style={{ opacity: busy ? 1 : 0 }}>
        <div className="h-full bg-accent transition-[width] duration-150" style={{ width: `${Math.min(1, progressFraction) * 100}%` }} />
      </div>

      <div className={`min-w-0 overflow-auto ${compact ? "" : "min-h-0 flex-1"}`}>
        <SpeakerBench
          rows={rows}
          states={states}
          cabinets={cabinets}
          selected={selected}
          disabled={off}
          highlightFor={highlightFor}
          onSelect={select}
          onRowDragOver={(rowIndex, e) => {
            if (!dragging || locked) return;
            e.preventDefault();
            setDropRow(rowIndex);
          }}
          onRowDrop={(rowIndex, e) => {
            e.preventDefault();
            const entry = library.find((l) => l.id === e.dataTransfer.getData(DRAG_TYPE));
            setDragging(null);
            setDropRow(null);
            const items = entry && dropSpan(entry, rowIndex);
            if (entry && items) void assign(entry, items);
          }}
          onLink={(cabinet, wayIndex, rowIndex) => void link(cabinet, wayIndex, rowIndex)}
          menuFor={cabinetMenu}
          onCabinetAction={(cabinet, action) => void handleCabinetAction(cabinet, action)}
        />
      </div>
      <span className={`${MUTED} shrink-0`}>
        Click outputs to select (Ctrl / Shift for several) · drag a library speaker onto an output or a join · drag a speaker's port to move that way to another output
      </span>
     </div>

      <section
        className={`flex min-w-0 flex-[2] flex-col gap-2 ${
          compact ? "min-h-[260px]" : "min-h-0 border-l border-[var(--amp-color-default-border)] pl-4"
        }`}
      >
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">
            Library <span className={MUTED}>{library.length}</span>
          </h3>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" isDisabled={locked} onPress={() => setImportOpen(true)}>
              <FileUp size={14} /> Import…
            </Button>
            <Button size="sm" variant="secondary" isDisabled={library.length === 0} onPress={() => void exportLibrary()}>
              <FileDown size={14} /> Export…
            </Button>
          </div>
        </div>
        <LibraryTable
          library={library}
          disabled={locked}
          onDragStart={setDragging}
          onDragEnd={() => {
            setDragging(null);
            setDropRow(null);
          }}
          onAction={(entry, action) => void handleLibraryAction(entry, action)}
        />
      </section>

      <LoadModal entry={loadTarget} rows={rows} states={states} onClose={() => setLoadTarget(null)} onAssign={(e, items) => void assign(e, items, true)} />
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
          setSelected(new Set());
          return null;
        }}
      />
      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} />
      {dialog}
    </div>
  );
}

/** This machine's whole speaker library as one file, for another machine's
 * Import — see `data/exchange.rs`. */
async function exportLibrary() {
  const text = await commands.speakersExport();
  if (text.status !== "ok") {
    toast.danger("Export failed", { description: text.error.message });
    return;
  }
  const saved = await commands.saveTextFile("speaker-library.ampcore.json", text.data, "AmpCore speaker library", ["json"]);
  if (saved.status !== "ok") toast.danger("Export failed", { description: saved.error.message });
  else if (saved.data) toast.success("Speaker library exported");
}
