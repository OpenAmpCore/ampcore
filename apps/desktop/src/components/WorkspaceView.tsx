import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { Button, ButtonGroup, Input, Label, Modal, Spinner, Switch, TextField, toast } from "@heroui/react";
import { Controls, ReactFlow, useNodesState, type ColorMode, type Node, type NodeChange } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignHorizontalSpaceAround,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  Columns3,
  Group,
  Rows3,
} from "lucide-react";
import { GitCompare, Link, Link2, Link2Off, MousePointer2, Pencil, Plus, RotateCcw, SlidersHorizontal, Trash2 } from "lucide-react";
import { AmpCatalogueModal } from "./AmpCatalogueModal";
import { AmpLinkModal } from "./AmpLinkModal";
import { FingerprintMismatchModal, STATE_BADGE } from "./FingerprintMismatchModal";
import { useContextMenu } from "./ContextMenu";
import { HelperLines } from "./HelperLines";
import { Hint } from "./Hint";
import { SimpleSelect } from "./SimpleSelect";
import {
  AmpTile,
  NODE_TYPES,
  SpeakerCanvasContext,
  TILE_W,
  type Armed,
  type OutputBox,
  type SpeakerCanvas,
  type SpeakerNodeData,
  type Tool,
} from "./WorkspaceNodes";
import { useProjectSpeakers, type ProjectOutput } from "./useProjectSpeakers";
import { commands, type AmpAssignment, type AmpModelCatalogEntry, type Project } from "../lib/bindings";
import { firmwareOptionsFor } from "../lib/firmwareOptions";
import { useIsCompact } from "../lib/breakpoints";
import { arrange, type Arrangement, type Rect } from "../lib/arrange";
import { NO_GUIDES, snapToGuides, type Guides } from "../lib/helperLines";
import { speakerName } from "../lib/speakers";
import { useLiveDevices } from "../hooks/useLiveDevices";
import { useProjectLocks } from "../hooks/useProjectLocks";

const PANE_HEADING = { fontWeight: 500, fontSize: "var(--amp-font-size-sm)", color: "var(--amp-color-dimmed)" } as const;
const SPEAKER_GAP = 16;
// Wide enough for three tiles and for the amp bar's one row: Add, Live and five icons.
const AMP_PANE_W = 380;

/** The Workspace's third dimension, after amps and speakers: what is being
 * done to them. A mode owns the function bar under the panes. Only Design
 * exists so far, so the current mode is a constant, not state.
 * ponytail: make it state in `ProjectWorkspace` (this view unmounts on a tab
 * change) once a second mode is available. */
const WORKSPACE_MODES = [
  { id: "design", label: "Design", available: true },
  { id: "config", label: "Config", available: false },
  { id: "tune", label: "Tune", available: false },
] as const;
const MODE: (typeof WORKSPACE_MODES)[number]["id"] = "design";

/** An amp's sync state as its tile's dot. Fixed status colours, not the accent. */
const DOT_COLOR = {
  success: "var(--amp-color-green-filled)",
  danger: "var(--amp-color-red-filled)",
  warning: "var(--amp-color-orange-6)",
  default: null,
} as const;

interface WorkspaceViewProps {
  project: Project;
  onProjectUpdate: (project: Project) => void;
  ampModels: AmpModelCatalogEntry[] | null;
  onOpenDevice: (assignment: AmpAssignment) => void;
}

/** The project's two halves as tiles, a picture and a name each: the amp list
 * and a canvas of the project's speakers (React Flow — free drag, positions
 * saved). They are separate panes: only the speakers pan and zoom. What a tile
 * is goes in its tooltip; what can be done to it is in the mode bar below —
 * Design's Select tool acts on the selected tile, its Link tool shows outputs
 * and ways and joins them. There are no cables.
 *
 * Memoised: its parent re-renders at meter rate for the amp editor's sake,
 * and nothing here shows a meter. */
export const WorkspaceView = memo(function WorkspaceView({ project, onProjectUpdate, ampModels, onOpenDevice }: WorkspaceViewProps) {
  const compact = useIsCompact();
  const [catalogueOpen, setCatalogueOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AmpAssignment | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [editTarget, setEditTarget] = useState<AmpAssignment | null>(null);
  const [editDeviceName, setEditDeviceName] = useState("");
  const [editFirmwareVersion, setEditFirmwareVersion] = useState<string | null>(null);
  const [savingDeviceName, setSavingDeviceName] = useState(false);
  const [deviceNameError, setDeviceNameError] = useState<string | null>(null);
  // By id, so the modal sees the updated assignment (new MAC) after Assign/Unlink.
  const [linkTargetId, setLinkTargetId] = useState<string | null>(null);

  const { devices, ready: devicesReady } = useLiveDevices();

  const modelsById = useMemo(() => {
    const map = new Map<string, AmpModelCatalogEntry>();
    for (const model of ampModels ?? []) {
      map.set(model.id, model);
    }
    return map;
  }, [ampModels]);

  const assignments = project.ampAssignments;
  const linkTarget = assignments.find((a) => a.id === linkTargetId) ?? null;

  function modelNameFor(assignment: AmpAssignment) {
    const model = assignment.ampModelId ? modelsById.get(assignment.ampModelId) : undefined;
    return model ? `${model.brand} ${model.model}` : null;
  }

  function nameFor(assignment: AmpAssignment) {
    return assignment.deviceName ?? modelNameFor(assignment) ?? "Unnamed";
  }

  const speakers = useProjectSpeakers({ project, onProjectUpdate, nameFor });

  // Every linked amp is polled while the project is open (`ProjectWorkspace`),
  // so each tile can say how its amp stands against the project.
  const locks = useProjectLocks(project);
  const [compareId, setCompareId] = useState<string | null>(null);
  const linked = assignments.filter((a) => a.mac);
  const live = linked.length > 0 && linked.every((a) => !a.liveDisengaged);
  const [switching, setSwitching] = useState(false);
  const badgeOf = (a: AmpAssignment) => STATE_BADGE[locks.get(a.id)?.state ?? (a.mac ? "checking" : "unlinked")];
  const summary = Object.entries(
    linked.reduce<Record<string, number>>((counts, a) => {
      const state = locks.get(a.id)?.state ?? "checking";
      // "1 matches" doesn't read; every other label is fine after a count.
      const label = state === "matches" ? "in sync" : STATE_BADGE[state].label.toLowerCase();
      return { ...counts, [label]: (counts[label] ?? 0) + 1 };
    }, {}),
  )
    .map(([label, count]) => `${count} ${label}`)
    .join(" · ");

  /** The project-wide switch is Disengage applied to every linked amp: off,
   * nothing is written and edits stay in the project. */
  async function setLive(on: boolean) {
    setSwitching(true);
    for (const a of linked.filter((a) => !!a.liveDisengaged === on)) {
      const r = await commands.projectsSetAmpLiveDisengaged(project.id, a.id, !on);
      if (r.status === "ok") onProjectUpdate(r.data);
      else toast.danger(`${nameFor(a)} not ${on ? "engaged" : "disengaged"}`, { description: r.error.message });
    }
    setSwitching(false);
  }
  const entryOf = (libraryId: string | undefined) => speakers.library.find((e) => e.id === libraryId);

  const [tool, setTool] = useState<Tool>("select");
  /** Select tool: the amp the bar's actions apply to. Speakers are selected
   * by React Flow itself (Ctrl-click adds, Shift-drag boxes); the two exclude
   * each other, so there is one selection. */
  const [selectedAmpId, setSelectedAmpId] = useState<string | null>(null);
  const selectedAmp = assignments.find((a) => a.id === selectedAmpId);
  const [renaming, setRenaming] = useState<string | null>(null);

  /** Link tool: these ways wait for an output square to be picked. */
  const [armed, setArmed] = useState<Armed | null>(null);
  const armedSpeaker = speakers.speakers.find((s) => s.id === armed?.speakerId);
  const armedLinks = speakers.outputs.filter((o) => !!armed && o.speaker?.projectSpeakerId === armed.speakerId && armed.ways.includes(o.speaker.wayIndex));
  /** The output square under the pointer (or focused). */
  const [hoverBox, setHoverBox] = useState<string | null>(null);

  function pickTool(next: Tool) {
    setTool(next);
    if (next === "link") clearSpeakerSelection();
    setArmed(null);
    setRenaming(null);
  }

  // Esc backs out one step: what is armed first, then the Link tool itself.
  useEffect(() => {
    if (tool !== "link") return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (armed ? setArmed(null) : pickTool("select"));
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tool, armed]);

  /** The outputs a pick on `key` fills: that one for a single way, else one
   * per armed way on adjacent outputs of the same amp. `null` when they
   * don't fit. */
  function spanFrom(key: string): ProjectOutput[] | null {
    if (!armed) return null;
    const start = speakers.outputs.findIndex((o) => o.key === key);
    if (start < 0) return null;
    const span = speakers.outputs.slice(start, start + armed.ways.length);
    return span.length === armed.ways.length && span.every((o) => o.amp.id === span[0].amp.id) ? span : null;
  }

  async function pick(key: string) {
    const span = spanFrom(key);
    const entry = entryOf(armedSpeaker?.libraryId);
    if (!armed || !armedSpeaker || !entry || !span) return;
    const done = await speakers.link(armedSpeaker, entry, armed.ways.map((wayIndex, i) => ({ wayIndex, target: span[i] })));
    if (done) setArmed(null);
  }

  async function unlinkArmed() {
    for (const output of armedLinks) await speakers.unlink(output);
    setArmed(null);
  }

  const preview = new Set((hoverBox ? spanFrom(hoverBox) : null)?.map((o) => o.key));
  const hoveredBoxSpeaker = speakers.outputs.find((o) => o.key === hoverBox)?.speaker?.projectSpeakerId ?? null;

  /** What an output holds, as the user reads it; `null` when free. */
  function heldBy(o: ProjectOutput): string | null {
    const owner = speakers.speakers.find((s) => s.id === o.speaker?.projectSpeakerId);
    const way = owner && entryOf(owner.libraryId)?.ways[o.speaker!.wayIndex]?.label;
    return owner ? [owner.name, way].filter(Boolean).join(" · ") : (o.speaker?.label ?? null);
  }

  function boxesFor(assignment: AmpAssignment): OutputBox[] {
    return speakers.outputs
      .filter((o) => o.amp.id === assignment.id)
      .map((o) => ({
        key: o.key,
        label: o.row.label,
        text: heldBy(o),
        mode: !armed ? "idle" : spanFrom(o.key) && !speakers.busy ? "target" : "blocked",
        lit: preview.has(o.key),
      }));
  }

  function ampTooltip(assignment: AmpAssignment): Array<[string, ReactNode]> {
    return [
      ["Name", nameFor(assignment)],
      ["Model", modelNameFor(assignment) ?? "No model"],
      ["Firmware", assignment.firmwareVersion ?? "–"],
      ["Status", badgeOf(assignment).label],
      ...speakers.outputs
        .filter((o) => o.amp.id === assignment.id)
        .map((o): [string, ReactNode] => [`Output ${o.row.label}`, heldBy(o) ?? "free"]),
    ];
  }

  const built = useMemo(() => {
    return speakers.speakers.map((speaker, index): Node => {
      const entry = entryOf(speaker.libraryId);
      const links = speakers.outputs.filter((o) => o.speaker?.projectSpeakerId === speaker.id);
      const linkView = (o: ProjectOutput) => ({ output: { key: o.key, label: o.label }, state: speakers.states.get(o.key) });
      const ways: SpeakerNodeData["ways"] = entry
        ? entry.ways.map((way, wayIndex) => {
            const link = links.find((o) => o.speaker?.wayIndex === wayIndex);
            return { wayIndex, label: way.label, ...(link ? linkView(link) : { output: null }) };
          })
        : links.map((o) => ({ wayIndex: o.speaker!.wayIndex, label: o.speaker!.label, ...linkView(o) }));
      // A speaker that was never dragged sits in a cascade, so new ones don't hide each other.
      const position = speaker.position
        ? { x: speaker.position.x ?? 0, y: speaker.position.y ?? 0 }
        : { x: SPEAKER_GAP, y: SPEAKER_GAP + index * 40 };
      const data: SpeakerNodeData = {
        speaker,
        model: entry ? speakerName(entry) : speaker.label,
        application: entry ? [entry.family, entry.application].filter(Boolean).join(" · ") : "",
        linkable: !!entry,
        busy: speakers.busy === speaker.id || speakers.busy === "*",
        ways,
      };
      return { id: speaker.id, type: "speaker", position, width: TILE_W, deletable: false, data };
    });
    // `speakers.outputs` follows `project`; `nameFor` follows `modelsById`.
  }, [project, modelsById, speakers.library, speakers.states, speakers.busy]);

  // React Flow keeps what it measured (and what is being dragged) on the node
  // objects, so a rebuild is merged into them, not swapped in.
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(built);
  useEffect(() => {
    setNodes((prev) =>
      built.map((node) => {
        const old = prev.find((p) => p.id === node.id);
        return old ? { ...old, ...node, position: old.dragging ? old.position : node.position } : node;
      }),
    );
  }, [built, setNodes]);

  const selectedNodes = nodes.filter((n) => n.selected);
  const rectOf = (n: Node): Rect => ({ id: n.id, x: n.position.x, y: n.position.y, width: n.measured?.width ?? TILE_W, height: n.measured?.height ?? TILE_W });

  /** While one tile is dragged: where it lines up with another, it snaps
   * there and the line it snapped to is drawn (`HelperLines`). */
  const [guides, setGuides] = useState<Guides>(NO_GUIDES);
  function snap(id: string, position: { x: number; y: number }) {
    const moving = nodes.find((n) => n.id === id);
    if (!moving) return { ...position, guides: NO_GUIDES };
    return snapToGuides({ ...rectOf(moving), ...position }, nodes.filter((n) => n.id !== id).map(rectOf));
  }
  function withHelperLines(changes: NodeChange<Node>[]): NodeChange<Node>[] {
    const moves = changes.filter((c) => c.type === "position");
    if (moves.length === 0) return changes;
    const move = moves[0];
    if (moves.length > 1 || !move.position) {
      // Several tiles move together: no lines.
      setGuides(NO_GUIDES);
      return changes;
    }
    // The last change of a drag is snapped too, or the tile would drop where
    // the pointer was instead of where it was shown.
    const snapped = snap(move.id, move.position);
    setGuides(move.dragging ? snapped.guides : NO_GUIDES);
    move.position = { x: snapped.x, y: snapped.y };
    return changes;
  }
  const selectedSpeaker = selectedNodes.length === 1 ? speakers.speakers.find((s) => s.id === selectedNodes[0].id) : undefined;
  function clearSpeakerSelection() {
    setNodes((prev) => (prev.some((n) => n.selected) ? prev.map((n) => (n.selected ? { ...n, selected: false } : n)) : prev));
  }

  /** Where speakers now sit: shown at once, so no tile snaps back while its
   * save is under way.
   * ponytail: one save per speaker; a bulk command if arranging many gets slow. */
  function savePositions(moved: Array<{ id: string; position: { x: number; y: number } }>) {
    const at = new Map(moved.map((m) => [m.id, { x: m.position.x, y: m.position.y }]));
    onProjectUpdate({ ...project, speakers: speakers.speakers.map((s) => (at.has(s.id) ? { ...s, position: at.get(s.id)! } : s)) });
    for (const [id, position] of at) void commands.projectsSetSpeakerPosition(project.id, id, position.x, position.y);
  }

  const openMenu = useContextMenu();
  /** The canvas's right-click menu. A tile that isn't selected becomes the
   * selection first, as everywhere else. */
  function openArrangeMenu(event: Parameters<typeof openMenu>[0], under?: Node) {
    let targets = selectedNodes;
    if (under && !under.selected) {
      targets = [under];
      setNodes((prev) => prev.map((n) => ({ ...n, selected: n.id === under.id })));
      setSelectedAmpId(null);
    }
    const run = (op: Arrangement) => () => {
      const placed = arrange(
        op,
        targets.map(rectOf),
      );
      savePositions([...placed].map(([id, position]) => ({ id, position })));
    };
    const [few, fewer] = [targets.length < 2, targets.length < 3];
    openMenu(event, [
      {
        label: "Align",
        icon: <AlignStartVertical size={14} />,
        disabled: few,
        items: [
          { label: "Align Left", icon: <AlignStartVertical size={14} />, onAction: run("left") },
          { label: "Align Top", icon: <AlignStartHorizontal size={14} />, onAction: run("top") },
          { label: "Align Right", icon: <AlignEndVertical size={14} />, onAction: run("right") },
          { label: "Align Bottom", icon: <AlignEndHorizontal size={14} />, onAction: run("bottom") },
          { label: "Center Horizontally", icon: <AlignCenterVertical size={14} />, onAction: run("centerH") },
          { label: "Center Vertically", icon: <AlignCenterHorizontal size={14} />, onAction: run("centerV") },
        ],
      },
      {
        label: "Distribute",
        icon: <AlignHorizontalSpaceAround size={14} />,
        disabled: fewer,
        items: [
          { label: "Horizontally", icon: <AlignHorizontalDistributeCenter size={14} />, onAction: run("distributeH") },
          { label: "Vertically", icon: <AlignVerticalDistributeCenter size={14} />, onAction: run("distributeV") },
        ],
      },
      {
        label: "Pack",
        icon: <Group size={14} />,
        disabled: few,
        items: [
          { label: "Horizontally", icon: <Columns3 size={14} />, onAction: run("packH") },
          { label: "Vertically", icon: <Rows3 size={14} />, onAction: run("packV") },
        ],
      },
    ]);
  }

  const canvas: SpeakerCanvas = {
    tool,
    armed,
    renaming,
    highlighted: armed ? null : hoveredBoxSpeaker,
    // Arming what is already armed disarms it.
    arm: (next) => setArmed((prev) => (prev?.speakerId === next.speakerId && prev.ways.join() === next.ways.join() ? null : next)),
    rename: (speaker, name) => {
      setRenaming(null);
      void speakers.rename(speaker, name);
    },
  };

  function openEdit(assignment: AmpAssignment) {
    setDeviceNameError(null);
    setEditDeviceName(assignment.deviceName ?? "");
    setEditFirmwareVersion(assignment.firmwareVersion ?? null);
    setEditTarget(assignment);
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    const result = await commands.projectsRemoveAmpAssignment(project.id, deleteTarget.id);
    setDeleting(false);
    if (result.status === "ok") {
      onProjectUpdate(result.data);
      setDeleteTarget(null);
    }
  }

  async function handleSaveDeviceName() {
    if (!editTarget) return;
    setDeviceNameError(null);
    setSavingDeviceName(true);
    const result = await commands.projectsUpdate({
      ...project,
      ampAssignments: project.ampAssignments.map((a) =>
        a.id === editTarget.id
          ? { ...a, deviceName: editDeviceName.trim() || null, firmwareVersion: editFirmwareVersion }
          : a,
      ),
    });
    setSavingDeviceName(false);
    if (result.status === "ok") {
      onProjectUpdate(result.data);
      setEditTarget(null);
    } else {
      setDeviceNameError(result.error.message);
    }
  }

  const editModel = editTarget?.ampModelId ? modelsById.get(editTarget.ampModelId) : undefined;
  const editFirmwareOptions = firmwareOptionsFor(editModel?.protocol);

  if (ampModels === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size="sm" />
      </div>
    );
  }

  const armedWay = armed?.ways.length === 1 ? entryOf(armedSpeaker?.libraryId)?.ways[armed.ways[0]]?.label : null;
  /** One function of the bar: an icon and a word. */
  const action = (label: string, icon: ReactNode, onPress: () => void, variant: "secondary" | "danger" | "primary" = "secondary", disabled = false) => (
    <Button size="sm" variant={variant} isDisabled={disabled} onPress={onPress}>
      {icon} {label}
    </Button>
  );
  /** The same, without the word: for the amp pane, which is too narrow for five labels. */
  const iconAction = (label: string, icon: ReactNode, onPress: () => void, danger = false) => (
    <Hint text={label} className="flex">
      <Button size="sm" variant={danger ? "danger" : "ghost"} isIconOnly aria-label={label} onPress={onPress}>
        {icon}
      </Button>
    </Hint>
  );
  const divider = <span className="mx-1 h-5 w-px shrink-0 bg-[var(--amp-color-default-border)]" />;
  const BAR_EDGE = "border-0 border-solid border-[var(--amp-color-default-border)]";
  const selecting = tool === "select";

  return (
    <div className={`flex h-full min-h-0 min-w-0 flex-col ${compact ? "overflow-y-auto" : ""}`}>
     <div
      className={`flex min-w-0 ${
        // Side by side, the amp list would squeeze the canvas to nothing below
        // ~900px, so they stack and the page scrolls instead.
        compact ? "flex-none flex-col" : "min-h-0 flex-1 flex-row items-stretch"
      }`}
     >
      {/* Amplifiers pane: its bar, then its tiles */}
      <div className={`flex min-w-0 shrink-0 flex-col ${compact ? "" : "min-h-0"}`} style={{ width: compact ? "100%" : AMP_PANE_W }}>
        {/* One row, the same height as the speaker pane's bar. The selected amp's
            actions take the summary's place; the selected tile itself says which amp. */}
        <div className={`flex h-12 shrink-0 items-center gap-2 border-b px-3 ${BAR_EDGE}`}>
          {action("Amp", <Plus size={14} />, () => setCatalogueOpen(true))}
          {linked.length > 0 && (
            <Hint text={summary} className="flex shrink-0">
              <Switch isSelected={live} isDisabled={switching} onChange={(on) => void setLive(on)}>
                <Switch.Content>
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                  <span style={{ fontSize: "var(--amp-font-size-sm)" }}>Live</span>
                </Switch.Content>
              </Switch>
            </Hint>
          )}
          {selecting && selectedAmp ? (
            <div className="flex min-w-0 flex-1 items-center justify-end">
              {iconAction("Configure", <SlidersHorizontal size={14} />, () => onOpenDevice(selectedAmp))}
              {iconAction("Edit name and firmware", <Pencil size={14} />, () => openEdit(selectedAmp))}
              {iconAction("Link to a network amp", <Link size={14} />, () => setLinkTargetId(selectedAmp.id))}
              {locks.get(selectedAmp.id)?.live && iconAction("Compare with the network amp", <GitCompare size={14} />, () => setCompareId(selectedAmp.id))}
              {iconAction("Remove amp", <Trash2 size={14} />, () => setDeleteTarget(selectedAmp), true)}
            </div>
          ) : (
            <span className="min-w-0 flex-1 truncate text-right" style={PANE_HEADING}>{linked.length > 0 ? summary : ""}</span>
          )}
        </div>
        <div className={`flex min-w-0 flex-1 flex-col p-3 ${compact ? "" : "min-h-0 overflow-y-auto"}`} onClick={(e) => e.target === e.currentTarget && setSelectedAmpId(null)}>
          {assignments.length === 0 ? (
            <div className="flex flex-1 items-center justify-center py-6">
              <span style={{ color: "var(--amp-color-dimmed)", fontSize: "var(--amp-font-size-sm)", textAlign: "center" }}>
                No amps assigned yet — add one to get started.
              </span>
            </div>
          ) : (
            <div className="grid content-start gap-2" style={{ gridTemplateColumns: `repeat(auto-fill, ${TILE_W}px)` }}>
              {assignments.map((assignment) => (
                <AmpTile
                  key={assignment.id}
                  name={nameFor(assignment)}
                  isCvr={(assignment.ampModelId ? modelsById.get(assignment.ampModelId) : undefined)?.brand === "CVR"}
                  dot={DOT_COLOR[badgeOf(assignment).color]}
                  tooltip={ampTooltip(assignment)}
                  selected={selecting && selectedAmp?.id === assignment.id}
                  boxes={tool === "link" ? boxesFor(assignment) : null}
                  onSelect={() => {
                    if (!selecting) return;
                    setSelectedAmpId(assignment.id);
                    clearSpeakerSelection();
                  }}
                  onOpen={() => onOpenDevice(assignment)}
                  onPick={(key) => void pick(key)}
                  onBoxHover={setHoverBox}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <hr
        className={
          compact
            ? "m-0 w-full border-t border-[var(--amp-color-default-border)]"
            : "m-0 h-full border-l border-t-0 border-[var(--amp-color-default-border)]"
        }
      />

      {/* Speakers pane: its bar, then the canvas */}
      <div className={`flex min-w-0 flex-1 flex-col ${compact ? "" : "min-h-0"}`}>
        <div className={`flex h-12 shrink-0 items-center gap-2 border-b px-3 ${BAR_EDGE}`}>
          {action("Speaker", <Plus size={14} />, speakers.openAdd)}
          {speakers.staleSpeakers.length > 0 &&
            action("Re-apply all", <RotateCcw size={14} />, () => void speakers.reapply(speakers.staleSpeakers), "secondary", speakers.busy !== null)}
          {selecting && selectedNodes.length > 1 && (
            <>
              {divider}
              <span className="min-w-0 truncate text-sm font-semibold">{selectedNodes.length} speakers</span>
              <span className="min-w-0 truncate text-sm" style={{ color: "var(--amp-color-dimmed)" }}>Right-click to align or distribute</span>
            </>
          )}
          {selecting && selectedSpeaker && (
            <>
              {divider}
              <span className="min-w-0 truncate text-sm font-semibold">{selectedSpeaker.name}</span>
              {action("Rename", <Pencil size={14} />, () => setRenaming(selectedSpeaker.id))}
              {speakers.staleSpeakers.includes(selectedSpeaker) &&
                action("Re-apply", <RotateCcw size={14} />, () => void speakers.reapply([selectedSpeaker]), "secondary", speakers.busy !== null)}
              {action("Remove", <Trash2 size={14} />, () => void speakers.remove(selectedSpeaker), "danger", speakers.busy !== null)}
            </>
          )}
        </div>
        <div className="min-w-0" style={compact ? { height: 460 } : { flex: "1 1 0%", minHeight: 0 }}>
        <SpeakerCanvasContext.Provider value={canvas}>
          <ReactFlow
            nodes={nodes}
            nodeTypes={NODE_TYPES}
            onNodesChange={(changes) => {
              // Picking a speaker lets go of the amp: one selection at a time.
              if (changes.some((c) => c.type === "select" && c.selected)) setSelectedAmpId(null);
              onNodesChange(withHelperLines(changes));
            }}
            // Only the Select tool selects; in the Link tool a click arms.
            elementsSelectable={selecting}
            onPaneContextMenu={(event) => openArrangeMenu(event)}
            onNodeContextMenu={(event, node) => openArrangeMenu(event, node)}
            onSelectionContextMenu={(event) => openArrangeMenu(event)}
            // A few pixels of slack, so a slightly unsteady click selects rather than drags.
            nodeDragThreshold={4}
            onNodeDragStop={(_, __, dragged) =>
              // React Flow reports where the pointer left a tile; one tile alone is saved where it snapped.
              savePositions(dragged.length === 1 ? [{ id: dragged[0].id, position: snap(dragged[0].id, dragged[0].position) }] : dragged)
            }
            onPaneClick={() => {
              setSelectedAmpId(null);
              setArmed(null);
            }}
            nodesConnectable={false}
            // The top-left corner is the origin and a wall: no panning past it,
            // and no speaker dragged past it.
            defaultViewport={{ x: 0, y: 0, zoom: 1 }}
            translateExtent={[[0, 0], [Infinity, Infinity]]}
            nodeExtent={[[0, 0], [Infinity, Infinity]]}
            minZoom={0.4}
            maxZoom={1.5}
            zoomOnDoubleClick={false}
            proOptions={{ hideAttribution: true }}
            // No colour-mode class: React Flow would put `light` on its root, and
            // HeroUI reads that as "light theme from here down". The canvas takes
            // the app's tokens instead (`.react-flow` in `tailwind.css`).
            colorMode={"" as ColorMode}
          >
            <Controls showInteractive={false} position="bottom-right" />
            <HelperLines guides={guides} />
          </ReactFlow>
        </SpeakerCanvasContext.Provider>
        </div>
      </div>
     </div>

      {/* Bottom bar: the mode and its tool, nothing else. What a pane holds is acted on from that pane's own bar. */}
      <div className={`flex shrink-0 flex-wrap items-center gap-2 border-t px-3 py-2 ${BAR_EDGE}`}>
        {WORKSPACE_MODES.map((mode) => (
          <Hint key={mode.id} text={mode.available ? undefined : "Not available yet"} className="flex">
            <Button size="sm" variant={mode.id === MODE ? "primary" : "secondary"} aria-pressed={mode.id === MODE} isDisabled={!mode.available}>
              {mode.label}
            </Button>
          </Hint>
        ))}
        {divider}
        <ButtonGroup size="sm">
          <Button variant={selecting ? "primary" : "ghost"} aria-pressed={selecting} onPress={() => pickTool("select")}>
            <MousePointer2 size={14} /> Select
          </Button>
          <Button variant={tool === "link" ? "primary" : "ghost"} aria-pressed={tool === "link"} onPress={() => pickTool("link")}>
            <Link2 size={14} /> Link
          </Button>
        </ButtonGroup>
        {tool === "link" && (
          <>
            {divider}
            <span className="min-w-0 truncate text-sm" style={{ color: armedSpeaker ? undefined : "var(--amp-color-dimmed)" }}>
              {armedSpeaker
                ? `${armedSpeaker.name}${armedWay ? ` · ${armedWay}` : ""}: pick ${armed!.ways.length > 1 ? "the first output" : "an output"} on an amp`
                : "Click a speaker, or one of its ways, then an output on an amp"}
            </span>
            {armedLinks.length > 0 && action("Unlink", <Link2Off size={14} />, () => void unlinkArmed(), "secondary", speakers.busy !== null)}
            {action("Done", null, () => pickTool("select"))}
          </>
        )}
      </div>
      {speakers.elements}
      <FingerprintMismatchModal
        opened={compareId !== null}
        onClose={() => setCompareId(null)}
        lock={(compareId && locks.get(compareId)) || null}
        focusDifferences
        projectId={project.id}
        assignmentId={compareId ?? undefined}
        onProjectUpdate={onProjectUpdate}
      />

      <AmpCatalogueModal
        opened={catalogueOpen}
        onClose={() => setCatalogueOpen(false)}
        project={project}
        devices={devices}
        ampModels={ampModels}
        onProjectUpdate={onProjectUpdate}
      />

      <AmpLinkModal
        project={project}
        assignment={linkTarget}
        displayName={linkTarget ? nameFor(linkTarget) : ""}
        modelName={linkTarget ? modelNameFor(linkTarget) : null}
        devices={devices}
        devicesReady={devicesReady}
        onProjectUpdate={onProjectUpdate}
        onClose={() => setLinkTargetId(null)}
      />

      <Modal.Backdrop isOpen={editTarget !== null} onOpenChange={(open) => !open && setEditTarget(null)}>
        <Modal.Container placement="center" size="sm">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>Edit Amp</Modal.Heading>
              <Modal.CloseTrigger />
            </Modal.Header>
            <Modal.Body>
              <div className="flex flex-col gap-3">
                <TextField autoFocus>
                  <Label>Device Name</Label>
                  <Input
                    placeholder="Optional"
                    maxLength={32}
                    value={editDeviceName}
                    onChange={(e) => setEditDeviceName(e.target.value)}
                  />
                </TextField>
                {editFirmwareOptions.length > 0 && (
                  <SimpleSelect
                    label="Firmware Version"
                    description="Which parameter ranges/units to plan around — not detected, since there's no live device yet."
                    data={editFirmwareOptions.map((v) => ({ value: v, label: v }))}
                    value={editFirmwareVersion}
                    onChange={setEditFirmwareVersion}
                  />
                )}
                {deviceNameError && (
                  <span style={{ color: "var(--amp-color-red-6)", fontSize: "var(--amp-font-size-sm)" }}>
                    {deviceNameError}
                  </span>
                )}
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" onPress={() => setEditTarget(null)} isDisabled={savingDeviceName}>
                    Cancel
                  </Button>
                  <Button variant="primary" onPress={handleSaveDeviceName} isDisabled={savingDeviceName}>
                    {savingDeviceName ? <Spinner size="sm" /> : "Save"}
                  </Button>
                </div>
              </div>
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>

      <Modal.Backdrop isOpen={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <Modal.Container placement="center" size="sm">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>Remove Amp</Modal.Heading>
              <Modal.CloseTrigger />
            </Modal.Header>
            <Modal.Body>
              <div className="flex flex-col gap-3">
                <span style={{ fontSize: "var(--amp-font-size-sm)" }}>
                  Remove {deleteTarget ? nameFor(deleteTarget) : ""} from this project? This can't be undone.
                </span>
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" onPress={() => setDeleteTarget(null)} isDisabled={deleting}>
                    Cancel
                  </Button>
                  <Button variant="danger" onPress={handleConfirmDelete} isDisabled={deleting}>
                    {deleting ? <Spinner size="sm" /> : "Remove"}
                  </Button>
                </div>
              </div>
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </div>
  );
});
