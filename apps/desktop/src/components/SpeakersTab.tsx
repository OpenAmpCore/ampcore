import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, Chip, Modal, Spinner, toast } from "@heroui/react";
import { listen } from "@tauri-apps/api/event";
import { FileUp, GripVertical, Info, Link2, ListFilter, RotateCcw, Save, SplitSquareVertical, Trash2, Upload } from "lucide-react";
import {
  commands,
  type AmpAssignment,
  type ChannelSpeakerState,
  type Project,
  type FitRow,
  type ProfileImportResult,
  type SpeakerDetails,
  type SpeakerLibraryEntry,
  type SpeakerProcessing,
} from "../lib/bindings";
import { useIsCompact } from "../lib/breakpoints";
import type { ConfigureActions } from "../lib/configureActions";
import { usePreference } from "../lib/preferences";
import { speakerName } from "../lib/speakers";
import type { PushProgress } from "./AmpPushSteps";
import { useConfirm } from "./ConfirmDialog";
import { Hint } from "./Hint";
import { SimpleSelect } from "./SimpleSelect";
import {
  MUTED,
  RowMenu,
  SpeakerBench,
  buildCabinets,
  outputRows,
  type Cabinet,
  type OutputRow,
  type RowHighlight,
} from "./SpeakerBench";
import { FIELD_INPUT } from "./fieldClasses";

const DRAG_TYPE = "application/x-ampcore-speaker-id";

type Assignment = { row: OutputRow; wayIndex: number };
/** One output to set up; entries may differ between the items of one apply. */
type ApplyItem = Assignment & { entry: SpeakerLibraryEntry };
/** Joined output groups (leaders) waiting for their speaker, per project amp.
 * Outside the component so a join outlives the tab unmounting.
 * ponytail: session only; move onto AmpAssignment (schema bump) if joins must
 * survive an app restart. */
const JOINS = new Map<string, number[][]>();
type ProjectResult ={ status: "ok"; data: Project } | { status: "error"; error: { message: string } };

/** A way's limiter thresholds, delay, polarity and FIR filter on one line. */
function waySummary(p: SpeakerProcessing): string {
  const { rms, peak } = p.limiter;
  return [
    rms.enabled ? `${(rms.thresholdVrms ?? 0).toFixed(1)} Vrms` : "RMS off",
    peak.enabled ? `${(peak.thresholdVp ?? 0).toFixed(1)} Vp` : "peak off",
    `${(p.delayOutMs ?? 0).toFixed(2)} ms`,
    ...(p.phaseInverted ? ["inverted"] : []),
    // Anything but a unit impulse is a real filter.
    ...(p.fir?.coefficients.some((c, i) => (c ?? 0) !== (i === 0 ? 1 : 0)) ? [`FIR ${p.fir.name.trim() || "unnamed"}`] : []),
  ].join(" · ");
}

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
  const cabinets = buildCabinets(rows, states, library, liveJoins);
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
    const pairs = items.map(({ row, entry, wayIndex }) => ({ channelIndex: row.leader, libraryId: entry.id, wayIndex }));
    // What this amp can't take as stored is shown first; the user decides.
    const fit = await commands.speakersFit(project.id, assignment.id, pairs);
    if (fit.status !== "ok") {
      toast.danger(`Speaker can't be applied to ${outputs}`, { description: fit.error.message });
      return false;
    }
    const issues = fit.data.flatMap((f) => {
      const label = items.find((i) => i.row.leader === f.channelIndex)?.row.label;
      return f.issues.map((issue) => `${label}: ${issue}`);
    });
    const issueList = issues.length > 0 && (
      <ul className="max-h-48 list-disc overflow-auto pl-5">
        {issues.map((issue) => (
          <li key={issue}>{issue}</li>
        ))}
      </ul>
    );
    if (!ui.preconfirmed || issues.length > 0 || showComparator) {
      const ok = await confirm({
        title: ui.title,
        description: showComparator ? (
          <div className="flex max-h-[60vh] flex-col gap-3 overflow-auto">
            {issueList}
            {fit.data.map((f) => {
              const item = items.find((i) => i.row.leader === f.channelIndex);
              const way = item?.entry.ways[item.wayIndex];
              return (
                <FitDiff
                  key={f.channelIndex}
                  title={`Out ${item?.row.label}${way && item && item.entry.ways.length > 1 ? ` · ${way.label}` : ""}`}
                  rows={f.rows}
                />
              );
            })}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {ui.intro}
            {issueList && <span>This amp can't take everything exactly as stored. Applying writes these adjusted values:</span>}
            {issueList}
          </div>
        ),
        confirmLabel: issues.length ? "Apply anyway" : ui.confirmLabel,
      });
      if (!ok) return false;
    }
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
    if (!(await assign(cabinet.entry, [{ row: rows[rowIndex], wayIndex }]))) return;
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
    const [a, b] = [String.fromCharCode(65 + leader), String.fromCharCode(66 + leader)];
    // The Output tab's own wording (`handleBridgeToggle`).
    const ok = await confirm(
      bridged
        ? {
            title: `Bridge outputs ${a} and ${b}?`,
            description: `${b} will follow ${a} at combined power. Make sure it's wired for bridge mode first.`,
            image: { light: "/bridged_graphic_b.png", dark: "/bridged_graphic_w.png" },
            confirmLabel: "Bridge",
          }
        : {
            title: `Unbridge outputs ${a} and ${b}?`,
            description: `${a} and ${b} go back to driving separate speakers. Rewire them first.`,
            confirmLabel: "Unbridge",
          },
    );
    if (!ok) return;
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
          <Button size="sm" variant="secondary" isDisabled={locked} onPress={() => setImportOpen(true)}>
            <FileUp size={14} /> Import presets…
          </Button>
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

const DIFF_CELL = "px-2 py-0.5 font-mono text-xs whitespace-nowrap";

/** Debug comparator: every compared value of one output, GitHub-diff style.
 * Red − what the output loses, green + what it gets, orange where `fit`
 * changed the preset's value to suit this amp. */
function FitDiff({ title, rows }: { title: string; rows: FitRow[] }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-sm font-semibold">{title}</span>
      <div className="overflow-x-auto rounded-md border border-[var(--amp-color-default-border)]">
        <table className="w-full border-collapse">
          <thead>
            <tr className={`${MUTED} text-left`}>
              <th className={DIFF_CELL}>Field</th>
              <th className={DIFF_CELL}>Amp now</th>
              <th className={DIFF_CELL}>Preset</th>
              <th className={DIFF_CELL}>Will write</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const changes = r.current !== r.written;
              const adjusted = r.preset !== r.written;
              return (
                <tr key={r.label} style={{ opacity: changes || adjusted ? 1 : 0.5 }}>
                  <td className={DIFF_CELL}>{r.label}</td>
                  <td className={DIFF_CELL} style={changes ? { background: "var(--amp-color-red-light)" } : undefined}>
                    {changes && "− "}{r.current}
                  </td>
                  <td className={DIFF_CELL}>{r.preset}</td>
                  <td
                    className={DIFF_CELL}
                    style={
                      adjusted
                        ? { background: "var(--amp-color-orange-light)" }
                        : changes
                          ? { background: "var(--amp-color-green-light)" }
                          : undefined
                    }
                  >
                    {changes && "+ "}{r.written}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** grip, note, Brand, Model, Family, Application, Ways, menu. Way labels are
 * left to the drag card and the Load dialog: the table sits in half the tab. */
const LIBRARY_COLS =
  "grid min-w-[480px] grid-cols-[20px_24px_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,1fr)_72px_36px] items-center gap-2 px-2";

const WAY_OPTIONS = [
  { value: "1", label: "1" },
  { value: "2", label: "2" },
  { value: "3", label: "3+" },
];

const NO_FILTERS = { brand: "", family: "", model: "", application: "" };

/** A library this long opens with its filter row showing. */
const FILTERS_FROM = 9;

/** The library as a table: a row is dragged onto an output, or double-clicked
 * (Enter) to pick its outputs in the Load dialog. A filter per column sits
 * behind the header's filter button. */
function LibraryTable({
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
  const [filters, setFilters] = useState(NO_FILTERS);
  const [ways, setWays] = useState<string | null>(null);
  const [filtering, setFiltering] = useState(library.length >= FILTERS_FROM);
  /** The row under the pointer when a press starts: its drag card has to be
   * in the DOM before `dragstart` can hand it to `setDragImage`. */
  const [armed, setArmed] = useState<SpeakerLibraryEntry | null>(null);
  const card = useRef<HTMLDivElement>(null);

  const has = (value: string, needle: string) => value.toLowerCase().includes(needle.trim().toLowerCase());
  const shown = library
    .filter((e) => {
      const n = e.ways.length;
      if (ways && (ways === "3" ? n < 3 : n !== Number(ways))) return false;
      return has(e.brand, filters.brand) && has(e.family, filters.family) && has(e.model, filters.model) && has(e.application, filters.application);
    })
    .sort((a, b) => a.brand.localeCompare(b.brand) || a.model.localeCompare(b.model));

  if (library.length === 0) {
    return <span className={MUTED}>No speakers yet. Import speaker preset files, or select outputs and save them as a speaker.</span>;
  }
  const filter = (key: keyof typeof NO_FILTERS, label: string) => (
    <input
      type="search"
      aria-label={`Filter by ${label}`}
      placeholder="Filter"
      value={filters[key]}
      className={FIELD_INPUT}
      onChange={(e) => setFilters({ ...filters, [key]: e.currentTarget.value })}
    />
  );
  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-auto rounded-lg border border-[var(--amp-color-default-border)]">
      <div className="sticky top-0 z-10 flex min-w-[480px] flex-col gap-1 border-b border-[var(--amp-color-default-border)] bg-background py-1.5">
        <div className={`${LIBRARY_COLS} ${MUTED} font-semibold uppercase`}>
          <span />
          <span />
          <span>Brand</span>
          <span>Model</span>
          <span>Family</span>
          <span>Application</span>
          <span>Ways</span>
          <Hint text={filtering ? "Hide and clear the filters" : "Filter the library"} className="flex">
            <Button
              size="sm"
              variant={filtering ? "secondary" : "ghost"}
              isIconOnly
              aria-label="Filter the library"
              aria-pressed={filtering}
              onPress={() => {
                // Hidden filters must not keep filtering.
                setFilters(NO_FILTERS);
                setWays(null);
                setFiltering(!filtering);
              }}
            >
              <ListFilter size={14} />
            </Button>
          </Hint>
        </div>
        {filtering && (
          <div className={LIBRARY_COLS}>
            <span />
            <span />
            {filter("brand", "brand")}
            {filter("model", "model")}
            {filter("family", "family")}
            {filter("application", "application")}
            <SimpleSelect data={WAY_OPTIONS} value={ways} onChange={setWays} placeholder="Any" clearable />
            <span />
          </div>
        )}
      </div>
      {shown.length === 0 && <div className={`${MUTED} p-2`}>No speaker matches.</div>}
      {shown.map((entry) => (
          <div
            key={entry.id}
            draggable={!disabled}
            role="button"
            tabIndex={0}
            aria-label={`${speakerName(entry)}: load onto outputs`}
            onPointerDown={() => setArmed(entry)}
            onDragStart={(e) => {
              e.dataTransfer.setData(DRAG_TYPE, entry.id);
              e.dataTransfer.effectAllowed = "copy";
              if (card.current) e.dataTransfer.setDragImage(card.current, 12, 12);
              onDragStart(entry);
            }}
            onDragEnd={onDragEnd}
            onDoubleClick={() => !disabled && onAction(entry, "assign")}
            onKeyDown={(e) => {
              if (!disabled && e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                e.preventDefault();
                onAction(entry, "assign");
              }
            }}
            className={`${LIBRARY_COLS} py-1 text-sm hover:bg-[var(--amp-color-gray-light)] ${disabled ? "" : "cursor-grab"}`}
          >
            <GripVertical size={14} className="text-[var(--amp-color-dimmed)]" />
            <Hint text={entry.notes} className="flex">
              <Info size={14} className={entry.notes ? "" : "opacity-25"} />
            </Hint>
            <span className="truncate font-medium">{entry.brand}</span>
            <span className="truncate">{entry.model}</span>
            <span className="truncate">{entry.family || "–"}</span>
            <span className="truncate">{entry.application || "–"}</span>
            <span className="tabular-nums">{entry.ways.length}</span>
            <RowMenu
              label={`Actions for ${speakerName(entry)}`}
              disabled={disabled}
              items={[
                { id: "assign", label: "Load to outputs…" },
                { id: "edit", label: "Edit details…" },
                { id: "delete", label: "Delete…", danger: true },
              ]}
              onAction={(action) => onAction(entry, action)}
            />
          </div>
      ))}
      {/* The drag image: off screen, but rendered, or the browser has nothing to snapshot. */}
      {armed && (
        <div
          ref={card}
          className="fixed top-0 -left-[9999px] flex w-64 flex-col gap-1.5 rounded-xl border border-[var(--accent)] bg-background p-3"
        >
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">{speakerName(armed)}</span>
            <Chip size="sm" color="default">{armed.ways.length} way</Chip>
          </div>
          <span className={`${MUTED} truncate`}>{[armed.family, armed.application].filter(Boolean).join(" · ") || "Speaker preset"}</span>
          <div className="flex flex-wrap gap-1">
            {armed.ways.map((w, i) => (
              <Chip key={i} size="sm" color="default">{w.label}</Chip>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** The precise, keyboard-reachable alternative to dragging, under the
 * speaker's details: a one-way speaker is toggled per output, a multi-way one
 * gets a way picked per output. Each output records the way it was given. */
function LoadModal({
  entry,
  rows,
  states,
  onClose,
  onAssign,
}: {
  entry: SpeakerLibraryEntry | null;
  rows: OutputRow[];
  states: Map<number, ChannelSpeakerState>;
  onClose: () => void;
  onAssign: (entry: SpeakerLibraryEntry, items: Assignment[]) => void;
}) {
  const compact = useIsCompact();
  const [picks, setPicks] = useState<Record<number, string>>({});
  const options = [
    { value: "", label: "No change" },
    ...(entry?.ways.map((w, i) => ({ value: String(i), label: `Way ${i + 1}: ${w.label}` })) ?? []),
  ];
  const items = rows.flatMap((row) => (picks[row.leader] ? [{ row, wayIndex: Number(picks[row.leader]) }] : []));
  function close() {
    setPicks({});
    onClose();
  }
  return (
    <Modal.Backdrop isOpen={entry !== null} onOpenChange={(open) => !open && close()}>
      <Modal.Container placement="center" size={compact ? "full" : "lg"}>
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Heading>{entry ? `Load ${speakerName(entry)}` : "Load"}</Modal.Heading>
            <Modal.CloseTrigger />
          </Modal.Header>
          <Modal.Body>
            <div className="flex flex-col gap-4">
              {entry && (
                <div className="flex min-w-0 flex-col gap-1 rounded-xl border border-[var(--amp-color-default-border)] p-3">
                  {(entry.family || entry.application) && (
                    <span className={MUTED}>{[entry.family, entry.application].filter(Boolean).join(" · ")}</span>
                  )}
                  {entry.ways.map((w, i) => (
                    <div key={i} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                      <span className="text-sm font-medium">{w.label}</span>
                      <span className={MUTED}>{waySummary(w.processing)}</span>
                    </div>
                  ))}
                  {entry.notes && <span className={`${MUTED} italic`}>{entry.notes}</span>}
                </div>
              )}
              {entry?.ways.length === 1 ? (
                // One way: an output either gets the speaker or it doesn't.
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className={`${MUTED} font-semibold uppercase`}>Load onto</span>
                    <div className="flex gap-1">
                      <Button size="sm" variant="ghost" onPress={() => setPicks(Object.fromEntries(rows.map((r) => [r.leader, "0"])))}>All</Button>
                      <Button size="sm" variant="ghost" onPress={() => setPicks({})}>None</Button>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {rows.map((row) => {
                      const on = !!picks[row.leader];
                      const current = states.get(row.leader)?.speaker.label;
                      return (
                        <div key={row.leader} className="flex w-[104px] flex-col gap-1">
                          <Button
                            variant={on ? "primary" : "secondary"}
                            aria-pressed={on}
                            onPress={() => setPicks((p) => ({ ...p, [row.leader]: on ? "" : "0" }))}
                          >
                            {row.label}
                          </Button>
                          <Hint text={current} className="min-w-0">
                            <span className={`${MUTED} block truncate text-center`}>{current ?? "free"}</span>
                          </Hint>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="grid min-w-0 grid-cols-[56px_minmax(0,1fr)_200px] items-center gap-x-3 gap-y-2">
                  <span className={`${MUTED} font-semibold uppercase`}>Out</span>
                  <span className={`${MUTED} font-semibold uppercase`}>Current</span>
                  <span className={`${MUTED} font-semibold uppercase`}>Way to load</span>
                  {rows.map((row) => {
                    const current = states.get(row.leader)?.speaker.label;
                    return (
                      <div key={row.leader} className="contents">
                        <span className="text-sm font-bold">{row.label}</span>
                        <Hint text={current} className="min-w-0">
                          <span className={`block truncate text-sm ${current ? "" : "text-[var(--amp-color-dimmed)]"}`}>{current ?? "free"}</span>
                        </Hint>
                        <SimpleSelect
                          className="whitespace-nowrap"
                          data={options}
                          value={picks[row.leader] ?? ""}
                          onChange={(v) => setPicks((p) => ({ ...p, [row.leader]: v ?? "" }))}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onPress={close}>Cancel</Button>
                <Button
                  variant="primary"
                  isDisabled={items.length === 0}
                  onPress={() => {
                    if (entry) onAssign(entry, items);
                    close();
                  }}
                >
                  {items.length ? `Load onto ${items.map((i) => i.row.label).join(", ")}` : "Load"}
                </Button>
              </div>
            </div>
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

type DetailsTarget = { kind: "edit"; entry: SpeakerLibraryEntry } | { kind: "save"; rowIndex: number; ways: number };

const EMPTY_DETAILS: SpeakerDetails = { brand: "", family: "", model: "", application: "", notes: "", wayLabels: [""] };

/** Edit an entry's metadata, or save outputs as a new entry. Editing never
 * touches processing — "Update library from these outputs" does that. */
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
          : { ...EMPTY_DETAILS, wayLabels: Array.from({ length: target.ways }, () => "") },
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

/** Pick any number of speaker preset files (the old app's `.json`), preview
 * every one (with the reason a file can't be read), then import all readable
 * ones at once. */
function ImportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const compact = useIsCompact();
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<{ fileName: string; text: string }[]>([]);
  const [preview, setPreview] = useState<ProfileImportResult[] | null>(null);
  const [busy, setBusy] = useState(false);

  function close() {
    setFiles([]);
    setPreview(null);
    onClose();
  }

  async function pick(list: File[]) {
    setBusy(true);
    const next = await Promise.all(list.map(async (f) => ({ fileName: f.name, text: await f.text() })));
    const r = await commands.speakersImportProfiles(next, false);
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
    const r = await commands.speakersImportProfiles(files, true);
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
            <Modal.Heading>Import speaker preset files</Modal.Heading>
            <Modal.CloseTrigger />
          </Modal.Header>
          <Modal.Body>
            <div className="flex flex-col gap-3">
              <input
                ref={inputRef}
                type="file"
                accept=".json,application/json"
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
                <span className={MUTED}>Speaker preset files (.json). Details can be edited after importing.</span>
              </div>
              {preview && (
                <div className="flex max-h-[50vh] flex-col gap-0.5 overflow-auto">
                  {preview.map((p) => (
                    <div key={p.fileName} className="flex min-w-0 items-center gap-2 text-sm" style={{ opacity: p.entry ? 1 : 0.6 }}>
                      <span className={p.entry ? "text-success" : "text-danger"}>{p.entry ? "✓" : "✗"}</span>
                      <Hint text={p.fileName} className="min-w-0 flex-1"><span className="block truncate">{p.fileName}</span></Hint>
                      {p.entry ? (
                        <span className={`${MUTED} truncate`}>
                          {speakerName(p.entry)} · {p.entry.ways.length} way{p.duplicate && " · already in library"}
                        </span>
                      ) : (
                        <Hint text={p.error} className="min-w-0"><span className="block truncate text-xs text-danger">{p.error}</span></Hint>
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
