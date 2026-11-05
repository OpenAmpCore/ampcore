import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { Button, ButtonGroup, Spinner, Switch, toast } from "@heroui/react";
import { Controls, ReactFlow, useNodesState, type ColorMode, type Node, type NodeChange } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignHorizontalDistributeCenter, AlignHorizontalSpaceAround, AlignStartHorizontal, AlignStartVertical, AlignVerticalDistributeCenter, Columns3, Group, Rows3 } from "lucide-react";
import { GitCompare, Link, Link2, Link2Off, MousePointer2, Pencil, Plus, RotateCcw, SlidersHorizontal, SplitSquareVertical, Trash2 } from "lucide-react";
import { AudioLines, Boxes, FlipVertical2, Timer, Volume2, VolumeX } from "lucide-react";
import { AmpCatalogueModal } from "./AmpCatalogueModal";
import { AmpLinkModal } from "./AmpLinkModal";
import { FingerprintMismatchModal, STATE_BADGE } from "../sync/FingerprintMismatchModal";
import { useContextMenu } from "../ContextMenu";
import { HelperLines } from "./HelperLines";
import { Hint } from "../Hint";
import { useConfirm } from "../ConfirmDialog";
import { EditAmpModal } from "./EditAmpModal";
import { CommitNumberInput } from "../CommitNumberInput";
import { AmpTile, NODE_TYPES, SpeakerCanvasContext, GROUP_TILE_W, TILE_W, type Armed, type GroupNodeData, type OutputBox, type SpeakerCanvas, type SpeakerNodeData, type Tool } from "./WorkspaceNodes";
import { useProjectSpeakers, type ProjectOutput } from "../speakers/useProjectSpeakers";
import { commands, type AmpAssignment, type AmpEditLock, type AmpModelCatalogEntry, type Project, type ProjectSpeaker, type SpeakerGroup } from "../../lib/bindings";
import { useIsCompact } from "../../lib/breakpoints";
import { arrange, freeSpot, type Arrangement, type Rect } from "../../lib/arrange";
import { NO_GUIDES, snapToGuides, type Guides } from "../../lib/helperLines";
import { useLiveDevices } from "../../hooks/useLiveDevices";

const PANE_HEADING = { fontWeight: 500, fontSize: "var(--amp-font-size-sm)", color: "var(--amp-color-dimmed)" } as const;
const SPEAKER_GAP = 16;
/** Where new speakers wrap to the next row on the canvas. */
const PLACE_ROW_W = 600;
// Wide enough for an amp card with four outputs and for the amp bar's one row: Add, Live and five icons.
const AMP_PANE_W = 380;

/** The Workspace's third dimension, after amps and speakers: what is being
 * done to them, as ArmoníaPlus's workflow. A mode owns the tools in the
 * bottom bar; the first is picked on entering it. Kept by `ProjectWorkspace`,
 * since this view unmounts on a tab change. */
const WORKSPACE_MODES = [
  { id: "design", label: "Design", available: true },
  { id: "config", label: "Config", available: false },
  { id: "tune", label: "Tune", available: true },
] as const;
export type WorkspaceMode = (typeof WORKSPACE_MODES)[number]["id"];

const MODE_TOOLS: Record<WorkspaceMode, Array<{ id: Tool; label: string; icon: ReactNode }>> = {
  design: [
    { id: "select", label: "Select", icon: <MousePointer2 size={14} /> },
    { id: "link", label: "Link", icon: <Link2 size={14} /> },
    { id: "group", label: "Group", icon: <Boxes size={14} /> },
  ],
  config: [],
  tune: [
    { id: "mute", label: "Mute", icon: <VolumeX size={14} /> },
    { id: "gain", label: "Gain", icon: <AudioLines size={14} /> },
    { id: "delay", label: "Delay", icon: <Timer size={14} /> },
    { id: "polarity", label: "Polarity", icon: <FlipVertical2 size={14} /> },
  ],
};

/** What a speaker's groups add to its outputs — core's `GroupOffset`. */
function groupOffset(groups: SpeakerGroup[], speakerId: string) {
  return groups
    .filter((g) => g.speakerIds.includes(speakerId))
    .reduce(
      (o, g) => ({ gain: o.gain + (g.gainDb ?? 0), delay: o.delay + (g.delayMs ?? 0), muted: o.muted || g.muted, inverted: o.inverted !== !!g.polarityInverted }),
      { gain: 0, delay: 0, muted: false, inverted: false },
    );
}
const dB = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;

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
  /** Every amp's edit lock (`ProjectWorkspace`, which also follows the amps with it). */
  locks: Map<string, AmpEditLock>;
  mode: WorkspaceMode;
  onModeChange: (mode: WorkspaceMode) => void;
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
export const WorkspaceView = memo(function WorkspaceView({ project, onProjectUpdate, ampModels, onOpenDevice, locks, mode, onModeChange }: WorkspaceViewProps) {
  const compact = useIsCompact();
  const [catalogueOpen, setCatalogueOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<AmpAssignment | null>(null);
  const { confirm, dialog: confirmDialog } = useConfirm();
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
  // so each tile can say how its amp stands against the project (`locks`).
  const [compareId, setCompareId] = useState<string | null>(null);
  const linked = assignments.filter((a) => a.mac);
  const live = linked.length > 0 && linked.every((a) => !a.liveDisengaged);
  const [switching, setSwitching] = useState(false);
  /** Out of step with the project: its dot blinks orange, asking to be compared. */
  const mismatched = (a: AmpAssignment) => locks.get(a.id)?.state === "mismatch";
  const badgeOf = (a: AmpAssignment) =>STATE_BADGE[locks.get(a.id)?.state ?? (a.mac ? "checking" : "unlinked")];
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

  const [tool, setTool] = useState<Tool>(MODE_TOOLS[mode][0].id);
  const tuning = mode === "tune";
  const groups = project.groups ?? [];

  /** Group tool: the group a click on a speaker adds it to or removes it from. */
  const [armedGroup, setArmedGroup] = useState<string | null>(null);
  const [groupBusy, setGroupBusy] = useState(false);
  /** Every group edit sends the whole list; the backend writes what changes
   * on the amps (`regroup`) and refuses all of it when one output can't take it. */
  async function saveGroups(next: SpeakerGroup[], failure = "Groups not changed") {
    setGroupBusy(true);
    const r = await commands.projectsSetGroups(project.id, next);
    setGroupBusy(false);
    if (r.status === "ok") onProjectUpdate(r.data);
    else toast.danger(failure, { description: r.error.message });
    return r.status === "ok";
  }
  const editGroups = (ids: string[], patch: (g: SpeakerGroup) => Partial<SpeakerGroup>, failure?: string) =>
    saveGroups(groups.map((g) => (ids.includes(g.id) ? { ...g, ...patch(g) } : g)), failure);
  function toggleMember(speakerId: string) {
    if (!armedGroup) return;
    void editGroups([armedGroup], (g) => ({
      speakerIds: g.speakerIds.includes(speakerId) ? g.speakerIds.filter((id) => id !== speakerId) : [...g.speakerIds, speakerId],
    }), "Membership not changed");
  }
  function addGroup(speakerIds: string[]) {
    // ArmoníaPlus names them in order; the user renames from the bar.
    const taken = new Set(groups.map((g) => g.name));
    let n = groups.length + 1;
    while (taken.has(`Group ${n}`)) n++;
    void saveGroups([...groups, { id: crypto.randomUUID(), name: `Group ${n}`, speakerIds, gainDb: 0, muted: false, delayMs: 0, polarityInverted: false, position: null }]);
  }
  async function removeGroup(group: SpeakerGroup) {
    const ok = await confirm({
      title: `Delete “${group.name}”?`,
      description: "Its gain, mute, delay and polarity come off its speakers' outputs.",
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (ok) await saveGroups(groups.filter((g) => g.id !== group.id), "Group not deleted");
  }

  function pickMode(next: WorkspaceMode) {
    onModeChange(next);
    pickTool(MODE_TOOLS[next][0].id);
  }
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
  /** The output under the pointer (or focused). */
  const [hoverBox, setHoverBox] = useState<string | null>(null);
  /** Link tool, nothing armed: outputs of one amp selected for Bridge / Unbridge. */
  const [picked, setPicked] = useState<string[]>([]);

  function pickTool(next: Tool) {
    setTool(next);
    if (next === "link" || next === "group") clearSpeakerSelection();
    setArmed(null);
    setArmedGroup(null);
    setPicked([]);
    setRenaming(null);
  }

  // Esc backs out one step: what is armed or selected first, then the Link or Group tool itself.
  useEffect(() => {
    if (tool !== "link" && tool !== "group") return;
    const onKey = (e: KeyboardEvent) =>
      e.key === "Escape" &&
      (armed ? setArmed(null) : armedGroup ? setArmedGroup(null) : picked.length ? setPicked([]) : pickTool("select"));
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tool, armed, armedGroup, picked]);

  /** In outputs order, so the first is the pair's leader. */
  const pickedOutputs = speakers.outputs.filter((o) => picked.includes(o.key));
  // One bridged output unbridges; the two outputs of a pair (A and B) bridge.
  const [p1, p2] = pickedOutputs;
  const bridgeTarget =
    pickedOutputs.length === 1 && p1.row.bridged ? { amp: p1.amp, leader: p1.row.leader, bridged: false }
    : pickedOutputs.length === 2 && p1.row.leader % 2 === 0 && !p1.row.bridged && p2.row.leader === p1.row.leader + 1
      ? { amp: p1.amp, leader: p1.row.leader, bridged: true }
      : null;
  // Two outputs that hold a speaker are not merged into one behind the user's back.
  const bridgeBlocked = !!bridgeTarget?.bridged && pickedOutputs.some((o) => o.speaker);

  /** A click on an output with nothing armed: select it (Ctrl/Shift adds,
   * within one amp). */
  function select(key: string, additive: boolean) {
    const amp = speakers.outputs.find((o) => o.key === key)?.amp.id;
    setPicked((prev) => {
      const sameAmp = prev.length > 0 && speakers.outputs.find((o) => o.key === prev[0])?.amp.id === amp;
      if (additive && sameAmp) return prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
      return prev.length === 1 && prev[0] === key ? [] : [key];
    });
  }

  async function toggleBridge() {
    if (!bridgeTarget || bridgeBlocked) return;
    if (await speakers.bridge(bridgeTarget.amp, bridgeTarget.leader, bridgeTarget.bridged)) setPicked([]);
  }

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

  /** What Unlink acts on: the armed speaker's linked ways, else the selected
   * outputs that hold any speaker — a project speaker's way or one set up on the amp. */
  const unlinkTargets = armed ? armedLinks : speakers.outputs.filter((o) => picked.includes(o.key) && o.speaker);
  async function unlink() {
    for (const output of unlinkTargets) await speakers.unlink(output);
    setArmed(null);
    setPicked([]);
  }

  const preview = new Set((hoverBox ? spanFrom(hoverBox) : null)?.map((o) => o.key));
  const hoveredBoxSpeaker = speakers.outputs.find((o) => o.key === hoverBox)?.speaker?.projectSpeakerId ?? null;

  /** What an output holds, as the user reads it; `null` when free. */
  function heldBy(o: ProjectOutput): string | null {
    const owner = speakers.speakers.find((s) => s.id === o.speaker?.projectSpeakerId);
    // A one-way speaker's way says nothing its name doesn't.
    const ways = owner ? (entryOf(owner.libraryId)?.ways ?? []) : [];
    const way = ways.length > 1 ? ways[o.speaker!.wayIndex]?.label : undefined;
    return owner ? [owner.name, way].filter(Boolean).join(" · ") : (o.speaker?.label ?? null);
  }

  const outputsOf = (assignment: AmpAssignment) => speakers.outputs.filter((o) => o.amp.id === assignment.id);

  function boxesFor(assignment: AmpAssignment): OutputBox[] {
    return outputsOf(assignment).map((o) => ({
      key: o.key,
      label: o.row.label,
      text: heldBy(o),
      mode: !armed ? "idle" : spanFrom(o.key) && !speakers.busy ? "target" : "blocked",
      lit: preview.has(o.key),
      bridged: o.row.bridged,
      linked: !!o.speaker?.projectSpeakerId,
      picked: picked.includes(o.key),
      pending: speakers.pending.outputs.includes(o.key),
    }));
  }

  function ampTooltip(assignment: AmpAssignment): Array<[string, ReactNode]> {
    return [
      ["Name", nameFor(assignment)],
      ["Model", modelNameFor(assignment) ?? "No model"],
      ["Firmware", assignment.firmwareVersion ?? "–"],
      ["Status", badgeOf(assignment).label],
      ...outputsOf(assignment).map((o): [string, ReactNode] => [`Output ${o.row.label}`, heldBy(o) ?? "free"]),
    ];
  }

  const built = useMemo(() => {
    // A parallel group is one tile, wider for its row of cabinets and taller per row of four.
    const sizeOf = (speaker: ProjectSpeaker) => {
      const count = speaker.parallel ?? 1;
      return count > 1 ? { width: GROUP_TILE_W, height: TILE_W + 22 * Math.floor((count - 1) / 4) } : { width: TILE_W, height: TILE_W };
    };
    const GROUP_SIZE = { width: TILE_W, height: TILE_W };
    const taken: Rect[] = [
      ...speakers.speakers.flatMap((s) => (s.position ? [{ id: s.id, x: s.position.x ?? 0, y: s.position.y ?? 0, ...sizeOf(s) }] : [])),
      ...groups.flatMap((g) => (g.position ? [{ id: g.id, x: g.position.x ?? 0, y: g.position.y ?? 0, ...GROUP_SIZE }] : [])),
    ];
    // Groups first, so they take the top row: they sit over the speakers they hold.
    const groupNodes = groups.map((group): Node => {
      let position = group.position ? { x: group.position.x ?? 0, y: group.position.y ?? 0 } : null;
      if (!position) {
        position = freeSpot(GROUP_SIZE, taken, SPEAKER_GAP, PLACE_ROW_W);
        taken.push({ id: group.id, ...position, ...GROUP_SIZE });
      }
      const gain = group.gainDb ?? 0;
      const tune =
        tool === "gain" ? dB(gain)
        : tool === "delay" ? `${(group.delayMs ?? 0).toFixed(2)} ms`
        : tool === "polarity" ? (group.polarityInverted ? "Inverted" : "Normal")
        : tool === "mute" ? (group.muted ? "Muted" : "On")
        : "";
      const data: GroupNodeData = {
        group,
        members: speakers.speakers.filter((s) => group.speakerIds.includes(s.id)).map((s) => s.name),
        tune,
        busy: groupBusy,
      };
      return { id: group.id, type: "group", position, width: TILE_W, deletable: false, data };
    });
    return [...groupNodes, ...speakers.speakers.map((speaker): Node => {
      const entry = entryOf(speaker.libraryId);
      const links = speakers.outputs.filter((o) => o.speaker?.projectSpeakerId === speaker.id);
      const linkView = (o: ProjectOutput) => ({ output: { key: o.key, label: o.label }, state: speakers.states.get(o.key) });
      const ways: SpeakerNodeData["ways"] = entry
        ? entry.ways.map((way, wayIndex) => {
            const link = links.find((o) => o.speaker?.wayIndex === wayIndex);
            return { wayIndex, label: way.label, ...(link ? linkView(link) : { output: null }) };
          })
        : links.map((o) => ({ wayIndex: o.speaker!.wayIndex, label: o.speaker!.label, ...linkView(o) }));
      // A speaker with no position yet takes the first free spot (saved below, so it stays there).
      let position = speaker.position ? { x: speaker.position.x ?? 0, y: speaker.position.y ?? 0 } : null;
      if (!position) {
        position = freeSpot(sizeOf(speaker), taken, SPEAKER_GAP, PLACE_ROW_W);
        taken.push({ id: speaker.id, ...position, ...sizeOf(speaker) });
      }
      // What its groups add, and its outputs' own values under them.
      const offset = groupOffset(groups, speaker.id);
      const channels = links.flatMap((o) => o.amp.channels.filter((c) => c.channelIndex === o.row.leader));
      const volume = channels[0]?.outputVolumeDb ?? 0;
      const mutedBy = [
        ...(channels.some((c) => c.outputMuted) && !offset.muted ? ["its output"] : []),
        ...groups.filter((g) => g.muted && g.speakerIds.includes(speaker.id)).map((g) => g.name),
      ].join(", ");
      // ArmoníaPlus's brackets: the speaker's own value, then with its groups.
      const tune = !channels.length && tuning ? "Not linked"
        : tool === "gain" ? `${dB(volume - offset.gain)}${offset.gain ? ` [${dB(volume)}]` : ""}`
        : tool === "delay" ? (offset.delay ? `[+${offset.delay.toFixed(2)} ms]` : "Preset")
        : tool === "polarity" ? (offset.inverted ? "[Inverted]" : "Preset")
        : tool === "mute" ? (mutedBy ? "Muted" : "On")
        : "";
      const data: SpeakerNodeData = {
        speaker,
        tune,
        muted: mutedBy,
        brand: entry?.brand ?? "",
        family: entry?.family ?? "",
        model: entry?.model ?? speaker.label,
        application: entry?.application ?? "",
        linkable: !!entry,
        busy: speakers.busy,
        pending: speakers.pending.speakers.includes(speaker.id),
        groups: groups.filter((g) => g.speakerIds.includes(speaker.id)).map((g) => g.name).join(", "),
        ways,
      };
      return { id: speaker.id, type: "speaker", position, width: sizeOf(speaker).width, deletable: false, data };
    })];
    // `speakers.outputs` and `groups` follow `project`; `nameFor` follows `modelsById`.
  }, [project, modelsById, speakers.library, speakers.states, speakers.busy, speakers.pending, tool, tuning, groupBusy]);

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
  // Speakers just given a free spot keep it: it no longer depends on the others.
  useEffect(() => {
    const unplaced = built.filter((n) => !(n.type === "group" ? groups : speakers.speakers).find((s) => s.id === n.id)?.position);
    if (unplaced.length) savePositions(unplaced.map((n) => ({ id: n.id, position: n.position })));
  }, [built]);

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
  const selectedGroup = selectedNodes.length === 1 ? groups.find((g) => g.id === selectedNodes[0].id) : undefined;
  const selectedSpeakerIds = selectedNodes.filter((n) => n.type === "speaker").map((n) => n.id);
  const selectedGroupIds = selectedNodes.filter((n) => n.type === "group").map((n) => n.id);

  /** Membership highlight, as ArmoníaPlus 2.8: a selected speaker outlines its
   * groups, a selected group its speakers; in the Group tool, the armed
   * group's speakers are lit instead. */
  const members = new Set<string>(
    tool === "group"
      ? (groups.find((g) => g.id === armedGroup)?.speakerIds ?? [])
      : [
          ...groups.filter((g) => selectedSpeakerIds.some((id) => g.speakerIds.includes(id))).map((g) => g.id),
          ...groups.filter((g) => selectedGroupIds.includes(g.id)).flatMap((g) => g.speakerIds),
        ],
  );
  function clearSpeakerSelection() {
    setNodes((prev) => (prev.some((n) => n.selected) ? prev.map((n) => (n.selected ? { ...n, selected: false } : n)) : prev));
  }

  /** Where speakers now sit: shown at once, so no tile snaps back while its
   * save is under way.
   * ponytail: one save per speaker; a bulk command if arranging many gets slow. */
  function savePositions(moved: Array<{ id: string; position: { x: number; y: number } }>) {
    const at = new Map(moved.map((m) => [m.id, { x: m.position.x, y: m.position.y }]));
    const place = <T extends { id: string }>(items: T[]) => items.map((s) => (at.has(s.id) ? { ...s, position: at.get(s.id)! } : s));
    const movedGroups = groups.some((g) => at.has(g.id));
    onProjectUpdate({ ...project, speakers: place(speakers.speakers), groups: place(groups) });
    for (const [id, position] of at) {
      if (!groups.some((g) => g.id === id)) void commands.projectsSetSpeakerPosition(project.id, id, position.x, position.y);
    }
    // Positions change no offset, so this writes nothing to an amp.
    if (movedGroups) void commands.projectsSetGroups(project.id, place(groups));
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
    arm: (next) => {
      setPicked([]);
      setArmed((prev) => (prev?.speakerId === next.speakerId && prev.ways.join() === next.ways.join() ? null : next));
    },
    rename: (speaker, name) => {
      setRenaming(null);
      void speakers.rename(speaker, name);
    },
    members,
    armedGroup,
    armGroup: (id) => setArmedGroup((prev) => (prev === id ? null : id)),
    toggleMember,
    renameGroup: (group, name) => {
      setRenaming(null);
      const next = name.trim();
      if (next && next !== group.name) void editGroups([group.id], () => ({ name: next }), "Group not renamed");
    },
  };

  /** Tune: the selected speakers' linked outputs, each with its groups' offset. */
  const tuneOutputs = selectedSpeakerIds.flatMap((id) => {
    const offset = groupOffset(groups, id);
    return speakers.outputs
      .filter((o) => o.speaker?.projectSpeakerId === id)
      .flatMap((o) => o.amp.channels.filter((c) => c.channelIndex === o.row.leader).map((channel) => ({ o, channel, offset })));
  });
  const tuneGroups = groups.filter((g) => selectedGroupIds.includes(g.id));
  const tuneCount = selectedSpeakerIds.length + tuneGroups.length;
  const [relative, setRelative] = useState(false);
  /** Remounts the number field after a relative step, so it reads 0 again. */
  const [tuneKey, setTuneKey] = useState(0);
  const [tuneBusy, setTuneBusy] = useState(false);

  /** A speaker's gain is its outputs' own volume (volume minus its groups'
   * gain); its delay and polarity are its preset's, so only groups take them. */
  async function tuneValue(value: number) {
    setTuneBusy(true);
    const step = (current: number) => (relative ? current + value : value);
    if (tool === "gain") {
      for (const { o, channel, offset } of tuneOutputs) {
        const own = (channel.outputVolumeDb ?? 0) - offset.gain;
        const r = await commands.projectsSetChannelOutput(project.id, o.amp.id, channel.channelIndex, null, step(own) + offset.gain, null);
        if (r.status === "ok") onProjectUpdate(r.data);
        else toast.danger(`${o.label}: gain not set`, { description: r.error.message });
      }
    }
    if (tuneGroups.length) {
      const field = tool === "gain" ? "gainDb" : "delayMs";
      await editGroups(selectedGroupIds, (g) => ({ [field]: step(g[field] ?? 0) }), `Group ${tool} not set`);
    }
    setTuneBusy(false);
    if (relative) setTuneKey((k) => k + 1);
  }

  /** What the selection reads: all muted, all inverted. */
  const allMuted = tuneCount > 0 && tuneGroups.every((g) => g.muted) && tuneOutputs.every(({ channel }) => channel.outputMuted);
  const allInverted = tuneGroups.length > 0 && tuneGroups.every((g) => g.polarityInverted);
  // The amp has one mute bit per output: unmuting a speaker its group mutes would unmute the group's hold too.
  const heldByGroup = tuneOutputs.some(({ offset }) => offset.muted);
  async function tuneToggle() {
    setTuneBusy(true);
    if (tool === "mute") {
      const muted = !allMuted;
      for (const { o, channel } of tuneOutputs.filter(({ channel }) => channel.outputMuted !== muted)) {
        const r = await commands.projectsSetChannelOutputMute(project.id, o.amp.id, channel.channelIndex, muted);
        if (r.status === "ok") onProjectUpdate(r.data);
        else toast.danger(`${o.label}: not ${muted ? "muted" : "unmuted"}`, { description: r.error.message });
      }
      if (tuneGroups.length) await editGroups(selectedGroupIds, () => ({ muted }), `Group not ${muted ? "muted" : "unmuted"}`);
    } else {
      await editGroups(selectedGroupIds, () => ({ polarityInverted: !allInverted }), "Polarity not changed");
    }
    setTuneBusy(false);
  }

  /** Tune's pane bar: the selection and the current tool's control for it. */
  function tuneBar(): ReactNode {
    if (tuneCount === 0) {
      return <span className="min-w-0 truncate text-sm" style={{ color: "var(--amp-color-dimmed)" }}>Select speakers or groups to tune them</span>;
    }
    const name = selectedSpeaker?.name ?? selectedGroup?.name ?? `${tuneCount} selected`;
    const speakerOnly = (tool === "delay" || tool === "polarity") && selectedSpeakerIds.length > 0;
    const busy = tuneBusy || groupBusy;
    let control: ReactNode;
    if (speakerOnly) {
      control = (
        <span className="min-w-0 truncate text-sm" style={{ color: "var(--amp-color-dimmed)" }}>
          A speaker's {tool} is its preset's — tune it with a group
        </span>
      );
    } else if (tool === "mute" || tool === "polarity") {
      const on = tool === "mute" ? allMuted : allInverted;
      const blocked = tool === "mute" && on && heldByGroup && selectedSpeakerIds.length > 0;
      control = (
        <Hint text={blocked ? "A group mutes these speakers: unmute the group." : undefined} className="flex">
          {action(
            tool === "mute" ? (on ? "Unmute" : "Mute") : on ? "Normal" : "Invert",
            tool === "mute" ? (on ? <Volume2 size={14} /> : <VolumeX size={14} />) : <FlipVertical2 size={14} />,
            () => void tuneToggle(),
            tool === "mute" && !on ? "danger" : "secondary",
            busy || blocked,
          )}
        </Hint>
      );
    } else {
      const first = tuneGroups[0];
      const current =
        tool === "gain"
          ? (tuneOutputs[0] ? (tuneOutputs[0].channel.outputVolumeDb ?? 0) - tuneOutputs[0].offset.gain : (first?.gainDb ?? 0))
          : (first?.delayMs ?? 0);
      // Wide on purpose: what an output can actually take is checked by the backend, which names it.
      const [min, max] = tool === "gain" ? (relative ? [-40, 40] : [-80, 18]) : [-20, 20];
      control = (
        <>
          <ButtonGroup size="sm">
            <Button variant={relative ? "ghost" : "primary"} aria-pressed={!relative} onPress={() => setRelative(false)}>Absolute</Button>
            <Button variant={relative ? "primary" : "ghost"} aria-pressed={relative} onPress={() => setRelative(true)}>Relative</Button>
          </ButtonGroup>
          <CommitNumberInput
            key={`${tool}:${relative}:${tuneKey}:${selectedNodes.map((n) => n.id).join()}`}
            className="w-[110px] shrink-0"
            value={relative ? 0 : current}
            min={min}
            max={max}
            step={tool === "gain" ? 0.5 : 0.01}
            suffix={tool === "gain" ? " dB" : " ms"}
            aria-label={tool === "gain" ? "Gain" : "Delay"}
            disabled={busy}
            onCommit={(v) => void tuneValue(v)}
          />
        </>
      );
    }
    return (
      <>
        <span className="min-w-0 truncate text-sm font-semibold">{name}</span>
        {control}
      </>
    );
  }

  async function removeAmp(assignment: AmpAssignment) {
    const ok = await confirm({
      title: "Remove Amp",
      description: `Remove ${nameFor(assignment)} from this project? This can't be undone.`,
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (!ok) return;
    const result = await commands.projectsRemoveAmpAssignment(project.id, assignment.id);
    if (result.status === "ok") onProjectUpdate(result.data);
    else toast.danger("Amp not removed", { description: result.error.message });
  }

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
        {/* One row, the same height as the speaker pane's bar, owned by the tool: Add, Live
            and the selected amp's actions in Select (the selected tile itself says
            which amp), only Bridge and Unlink in Link. */}
        <div className={`flex h-12 shrink-0 items-center gap-2 border-b px-3 ${BAR_EDGE}`}>
          {selecting && action("Amp", <Plus size={14} />, () => setCatalogueOpen(true))}
          {selecting && linked.length > 0 && (
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
              {iconAction("Edit name and firmware", <Pencil size={14} />, () => setEditTarget(selectedAmp))}
              {iconAction("Link to a network amp", <Link size={14} />, () => setLinkTargetId(selectedAmp.id))}
              {locks.get(selectedAmp.id)?.live && iconAction("Compare with the network amp", <GitCompare size={14} />, () => setCompareId(selectedAmp.id))}
              {iconAction("Remove amp", <Trash2 size={14} />, () => void removeAmp(selectedAmp), true)}
            </div>
          ) : selecting ? (
            <span className="min-w-0 flex-1 truncate text-right" style={PANE_HEADING}>{linked.length > 0 ? summary : ""}</span>
          ) : tool !== "link" ? null : (
            // Link: always both, disabled with a hint saying why when they can't act.
            <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
              <Hint
                text={
                  bridgeBlocked ? "Remove the speakers from both outputs first."
                  : bridgeTarget ? undefined
                  : "Select both outputs of a pair (A and B) to bridge them, or a bridged output to unbridge it."
                }
                className="flex"
              >
                {action(
                  bridgeTarget && !bridgeTarget.bridged ? "Unbridge" : "Bridge",
                  <SplitSquareVertical size={14} />,
                  () => void toggleBridge(),
                  "secondary",
                  !bridgeTarget || bridgeBlocked || speakers.busy,
                )}
              </Hint>
              <Hint text={unlinkTargets.length > 0 ? undefined : "Select outputs that hold a speaker, or arm a linked speaker, to unlink it."} className="flex">
                {action("Unlink", <Link2Off size={14} />, () => void unlink(), "secondary", unlinkTargets.length === 0 || speakers.busy)}
              </Hint>
            </div>
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
            <div className="flex flex-col gap-2">
              {assignments.map((assignment) => (
                <AmpTile
                  key={assignment.id}
                  name={nameFor(assignment)}
                  isCvr={(assignment.ampModelId ? modelsById.get(assignment.ampModelId) : undefined)?.brand === "CVR"}
                  dot={mismatched(assignment) ? DOT_COLOR.warning : DOT_COLOR[badgeOf(assignment).color]}
                  blink={mismatched(assignment)}
                  tooltip={ampTooltip(assignment)}
                  selected={selecting && selectedAmp?.id === assignment.id}
                  linking={tool === "link"}
                  boxes={boxesFor(assignment)}
                  onSelect={() => {
                    if (!selecting) return;
                    setSelectedAmpId(assignment.id);
                    clearSpeakerSelection();
                  }}
                  onOpen={() => onOpenDevice(assignment)}
                  onPick={(key, additive) => (armed ? void pick(key) : select(key, additive))}
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
          {selecting && action("Speaker", <Plus size={14} />, speakers.openAdd)}
          {(selecting || tool === "group") && (
            <Hint text={selectedSpeakerIds.length ? `A new group holding the ${selectedSpeakerIds.length} selected speaker${selectedSpeakerIds.length === 1 ? "" : "s"}` : "A new, empty group"} className="flex">
              {action("Group", <Plus size={14} />, () => addGroup(selectedSpeakerIds), "secondary", groupBusy)}
            </Hint>
          )}
          {!tuning && speakers.staleSpeakers.length > 0 &&
            action("Re-apply all", <RotateCcw size={14} />, () => void speakers.reapply(speakers.staleSpeakers), "secondary", speakers.busy)}
          {tuning && (
            <>
              {divider}
              {tuneBar()}
            </>
          )}
          {tool === "group" && (
            <>
              {divider}
              <span className="min-w-0 truncate text-sm" style={{ color: "var(--amp-color-dimmed)" }}>
                {armedGroup
                  ? `${groups.find((g) => g.id === armedGroup)?.name}: click speakers to add or remove them`
                  : "Click a group, then the speakers it holds"}
              </span>
            </>
          )}
          {selecting && selectedNodes.length > 1 && (
            <>
              {divider}
              <span className="min-w-0 truncate text-sm font-semibold">{selectedNodes.length} selected</span>
              <span className="min-w-0 truncate text-sm" style={{ color: "var(--amp-color-dimmed)" }}>Right-click to align or distribute</span>
            </>
          )}
          {selecting && selectedGroup && (
            <>
              {divider}
              <span className="min-w-0 truncate text-sm font-semibold">{selectedGroup.name}</span>
              {action("Rename", <Pencil size={14} />, () => setRenaming(selectedGroup.id))}
              {action("Delete", <Trash2 size={14} />, () => void removeGroup(selectedGroup), "danger", groupBusy)}
            </>
          )}
          {selecting && selectedSpeaker && (
            <>
              {divider}
              <span className="min-w-0 truncate text-sm font-semibold">{selectedSpeaker.name}</span>
              {action("Rename", <Pencil size={14} />, () => setRenaming(selectedSpeaker.id))}
              {speakers.staleSpeakers.includes(selectedSpeaker) &&
                action("Re-apply", <RotateCcw size={14} />, () => void speakers.reapply([selectedSpeaker]), "secondary", speakers.busy)}
              {action("Remove", <Trash2 size={14} />, () => void speakers.remove(selectedSpeaker), "danger", speakers.busy)}
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
            // Select and Tune select; in the Link and Group tools a click arms.
            elementsSelectable={selecting || tuning}
            // Tune changes values, not the layout.
            nodesDraggable={!tuning}
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
              setArmedGroup(null);
              setPicked([]);
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
        {WORKSPACE_MODES.map((m) => (
          <Hint key={m.id} text={m.available ? undefined : "Not available yet"} className="flex">
            <Button
              size="sm"
              variant={m.id === mode ? "primary" : "secondary"}
              aria-pressed={m.id === mode}
              isDisabled={!m.available}
              onPress={() => m.id !== mode && pickMode(m.id)}
            >
              {m.label}
            </Button>
          </Hint>
        ))}
        {divider}
        <ButtonGroup size="sm">
          {MODE_TOOLS[mode].map((t) => (
            <Button key={t.id} variant={tool === t.id ? "primary" : "ghost"} aria-pressed={tool === t.id} onPress={() => pickTool(t.id)}>
              {t.icon} {t.label}
            </Button>
          ))}
        </ButtonGroup>
        {tool === "link" && (
          <>
            {divider}
            <span className="min-w-0 truncate text-sm" style={{ color: armedSpeaker ? undefined : "var(--amp-color-dimmed)" }}>
              {armedSpeaker
                ? `${armedSpeaker.name}${armedWay ? ` · ${armedWay}` : ""}: pick ${armed!.ways.length > 1 ? "the first output" : "an output"} on an amp`
                : "Click a speaker, or one of its ways, then an output on an amp — or select two outputs of an amp to bridge them"}
            </span>
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

      <EditAmpModal
        projectId={project.id}
        assignment={editTarget}
        model={editTarget?.ampModelId ? modelsById.get(editTarget.ampModelId) : undefined}
        onClose={() => setEditTarget(null)}
        onProjectUpdate={onProjectUpdate}
      />
      {confirmDialog}
    </div>
  );
});
