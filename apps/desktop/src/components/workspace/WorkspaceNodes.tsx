import { createContext, useContext, type ReactNode } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import { Spinner } from "@heroui/react";
import { Boxes, Speaker } from "lucide-react";
import type { ChannelSpeakerState, ProjectSpeaker, SpeakerGroup } from "../../lib/bindings";
import { speakerFields } from "../../lib/speakers";
import { Hint } from "../Hint";
import { MUTED } from "../speakers/SpeakerBench";
import { FIELD_INPUT } from "../fieldClasses";

/** Width of a tile, amp or speaker: a picture and a name, like ArmoníaPlus's.
 * Everything else about it is in its tooltip, and what can be done to it is in
 * the mode bar. */
export const TILE_W = 96;
/** A parallel group's tile: wide enough for a row of four cabinets and their cables. */
export const GROUP_TILE_W = 136;
const CABINETS_PER_ROW = 4;

/** A speaker tile's picture: one cabinet, or a parallel group's cabinets in
 * rows of four with a little cable between neighbours — cosmetic, the group
 * is linked as one. */
function Cabinets({ count }: { count: number }) {
  if (count <= 1) return <Speaker size={30} className="text-[var(--amp-color-dimmed)]" />;
  return (
    // Exactly four cabinets and three cables wide (4 × 20 + 3 × 10), so the fifth wraps.
    <div className="flex w-[110px] flex-wrap justify-center gap-y-0.5" aria-label={`${count} cabinets in parallel`}>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className="flex items-center">
          {i % CABINETS_PER_ROW > 0 && (
            <svg width="10" height="8" viewBox="0 0 10 8" aria-hidden className="shrink-0">
              <path d="M0 3 Q5 9 10 3" fill="none" stroke="var(--amp-color-dimmed)" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          )}
          <Speaker size={20} className="text-[var(--amp-color-dimmed)]" />
        </span>
      ))}
    </div>
  );
}

/** A mode's tools. Design: Select moves and picks tiles, Link shows the
 * amps' outputs and the speakers' ways so they can be joined, Group arms a
 * group tile and adds or removes the speakers clicked. Tune: one tool per
 * value, acting on the selected speakers and groups. */
export type Tool = "select" | "link" | "group" | "mute" | "gain" | "delay" | "polarity";

/** Which ways of which speaker are waiting for an output to be picked. */
export interface Armed {
  speakerId: string;
  ways: number[];
}

const TILE =
  "relative flex w-full min-w-0 cursor-pointer flex-col items-center gap-1 rounded-xl border border-solid bg-background p-2 outline-none focus-visible:ring-2 focus-visible:ring-accent";
const NAME = "line-clamp-2 w-full text-center text-xs font-medium break-words";
const frame = (lit: boolean) => (lit ? "border-accent bg-accent-soft" : "border-[var(--amp-color-default-border)]");

/** The corner dot: a filled colour, or hollow for "nothing to say"; `blink`
 * for a state that wants attention (an amp out of step with the project). */
function Dot({ color, blink = false }: { color: string | null; blink?: boolean }) {
  return (
    <span
      className={`absolute top-1.5 right-1.5 size-2.5 rounded-full border border-solid ${blink ? "animate-pulse motion-reduce:animate-none" : ""}`}
      style={color ? { background: color, borderColor: color } : { borderColor: "var(--amp-color-dimmed)" }}
    />
  );
}

/** A tile's tooltip: labelled fields, one under the other. */
function TileTooltip({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <div className="flex max-w-[280px] flex-col gap-1.5 py-1 text-left">
      {rows.map(([label, value]) => (
        <div key={label} className="flex flex-col">
          <span className={`${MUTED} uppercase`}>{label}</span>
          <span className="text-sm">{value}</span>
        </div>
      ))}
    </div>
  );
}

function statusText(state: ChannelSpeakerState | undefined): string {
  const status = state?.status;
  if (!status) return "";
  const fields = speakerFields(status);
  const label = status.kind === "match" ? "Match" : status.kind === "edited" ? "Edited" : status.kind === "libraryUpdated" ? "Library updated" : "Detached";
  return ` · ${label}${fields.length ? ` (${fields.join(", ")})` : ""}`;
}

/** What a speaker tile needs to know beyond its own `data`. Handed down by
 * context, so node data stays plain values and a node never holds a stale
 * callback. */
export interface SpeakerCanvas {
  tool: Tool;
  armed: Armed | null;
  /** The speaker whose name is being edited on its tile. */
  renaming: string | null;
  /** The speaker whose output square is under the pointer in the amp list. */
  highlighted: string | null;
  /** Tiles outlined for group membership: the selected tile's groups or
   * members, or the armed group's members. */
  members: Set<string>;
  /** Group tool: the group whose members a click on a speaker toggles. */
  armedGroup: string | null;
  arm: (armed: Armed) => void;
  armGroup: (groupId: string) => void;
  toggleMember: (speakerId: string) => void;
  /** Ends renaming; an empty or unchanged name is left alone. */
  rename: (speaker: ProjectSpeaker, name: string) => void;
  renameGroup: (group: SpeakerGroup, name: string) => void;
}

export const SpeakerCanvasContext = createContext<SpeakerCanvas | null>(null);

export type SpeakerNodeData = {
  speaker: ProjectSpeaker;
  /** Its library entry's fields; just `model` (the stored label) when the
   * entry is not on this machine. */
  brand: string;
  family: string;
  model: string;
  application: string;
  /** Its library entry is on this machine, so its ways can be applied. */
  linkable: boolean;
  busy: boolean;
  /** Being written to its amp right now: blurred under a spinner. */
  pending: boolean;
  /** The groups it is in, by name, comma-separated. */
  groups: string;
  /** Tune: the current tool's value, as text; empty in Design. */
  tune: string;
  /** What mutes it (its outputs, its groups), as text; empty when nothing does. */
  muted: string;
  ways: Array<{
    wayIndex: number;
    label: string;
    /** The output this way is on: its key and "Amp · A". */
    output: { key: string; label: string } | null;
    state?: ChannelSpeakerState;
  }>;
};
export type SpeakerNodeType = Node<SpeakerNodeData, "speaker">;

/** One project speaker. In the Link tool a click arms all its ways and a way
 * chip arms one; the output is then picked on an amp tile. */
function SpeakerTile({ data, selected }: NodeProps<SpeakerNodeType>) {
  const canvas = useContext(SpeakerCanvasContext)!;
  const { speaker, ways } = data;
  const linking = canvas.tool === "link";
  const armed = canvas.armed?.speakerId === speaker.id ? canvas.armed.ways : [];
  const canArm = linking && data.linkable && !data.busy;
  const grouping = canvas.tool === "group";
  const lit = linking ? armed.length > 0 || canvas.highlighted === speaker.id : grouping ? canvas.members.has(speaker.id) : !!selected;
  const member = !lit && canvas.members.has(speaker.id);

  // The dot is for what needs doing (Re-apply), in every tool. Being linked
  // is not a status: it says nothing about the amp, which may be offline.
  const kinds = ways.map((w) => w.state?.status.kind);
  // In Tune, the dot is the mute: what an operator checks first.
  const dot = data.tune
    ? data.muted ? "var(--amp-color-red-filled)" : null
    : kinds.includes("edited") ? "var(--amp-color-orange-6)" : kinds.includes("libraryUpdated") ? "var(--accent)" : null;
  // Link state is the Link tool's subject, shown as on the amp card: green = linked.
  const allLinked = linking && ways.length > 0 && ways.every((w) => w.output);

  const field = (label: string, value: string): Array<[string, ReactNode]> => (value ? [[label, value]] : []);
  const tooltip = (
    <TileTooltip
      rows={[
        // The name only when it says more than the model it defaults to.
        ...field("Name", speaker.name === data.model ? "" : speaker.name),
        ...field("Brand", data.brand),
        ...field("Family", data.family),
        ...field("Model", data.model),
        ...field("Application", data.application),
        ...field("Groups", data.groups),
        ...field("Muted by", data.muted),
        ...field("Parallel", (speaker.parallel ?? 1) > 1 ? `${speaker.parallel} cabinets on the same outputs` : ""),
        ...ways.map((w): [string, ReactNode] => [
          ways.length > 1 ? `${w.label || `Way ${w.wayIndex + 1}`} output` : "Output",
          w.output ? `${w.output.label}${statusText(w.state)}` : "Not linked",
        ]),
        ...field("Library", data.linkable ? "" : "Not in this machine's library"),
      ]}
    />
  );

  return (
    <Hint text={tooltip} className="flex w-full">
      <div
        className={`${TILE} ${frame(lit)} ${member ? MEMBER : ""}`}
        style={
          allLinked && !lit
            ? { borderColor: "var(--amp-color-green-filled)", background: "color-mix(in srgb, var(--amp-color-green-filled) 22%, transparent)" }
            : undefined
        }
        onClick={() => {
          if (grouping) {
            if (canvas.armedGroup && !data.busy) canvas.toggleMember(speaker.id);
          } else if (canArm) canvas.arm({ speakerId: speaker.id, ways: ways.map((w) => w.wayIndex) });
        }}
      >
        {dot && <Dot color={dot} />}
        {/* Always mounted, so it fades in and out instead of popping. */}
        <div
          aria-hidden={!data.pending}
          className={`absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-background/40 backdrop-blur-sm transition-opacity duration-300 ${
            data.pending ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
        >
          <Spinner size="sm" />
        </div>
        <Cabinets count={speaker.parallel ?? 1} />
        {canvas.renaming === speaker.id ? (
          <input
            autoFocus
            aria-label="Speaker name"
            className={`${FIELD_INPUT} nodrag w-full text-center text-xs`}
            defaultValue={speaker.name}
            maxLength={40}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => canvas.rename(speaker, e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          />
        ) : (
          <span className={NAME}>{speaker.name}</span>
        )}
        {data.tune && <span className={TUNE}>{data.tune}</span>}
        {linking && ways.length > 1 && (
          <div className="flex flex-wrap justify-center gap-px">
            {ways.map((way) => (
              <button
                key={way.wayIndex}
                type="button"
                disabled={!canArm}
                aria-pressed={armed.length === 1 && armed[0] === way.wayIndex}
                aria-label={`Link only ${way.label || "this way"} of ${speaker.name}`}
                className={`${SQUARE} ${armed.includes(way.wayIndex) ? "border-accent bg-accent text-accent-foreground" : way.output ? HELD : FREE}`}
                onClick={(e) => {
                  e.stopPropagation();
                  canvas.arm({ speakerId: speaker.id, ways: [way.wayIndex] });
                }}
              >
                {way.label || "Full"}
              </button>
            ))}
          </div>
        )}
      </div>
    </Hint>
  );
}

const TUNE = "w-full truncate text-center text-[11px] tabular-nums text-[var(--amp-color-dimmed)]";
// Outlined, not filled: membership is a hint beside the selection, not a second one.
const MEMBER = "ring-2 ring-accent ring-offset-1 ring-offset-background";

export type GroupNodeData = {
  group: SpeakerGroup;
  /** Its members' names. */
  members: string[];
  /** Tune: the current tool's value, as text; empty in Design. */
  tune: string;
  busy: boolean;
};
export type GroupNodeType = Node<GroupNodeData, "group">;

/** A speaker group, as ArmoníaPlus shows them on the speaker side: a tile of
 * its own. Its gain, mute, delay and polarity sit on top of every output its
 * members are linked to. In the Group tool a click arms it, and clicking
 * speakers then adds or removes them. */
function GroupTile({ data, selected }: NodeProps<GroupNodeType>) {
  const canvas = useContext(SpeakerCanvasContext)!;
  const { group } = data;
  const grouping = canvas.tool === "group";
  const lit = grouping ? canvas.armedGroup === group.id : !!selected;
  const member = !lit && canvas.members.has(group.id);
  const gain = group.gainDb ?? 0;
  const tooltip = (
    <TileTooltip
      rows={[
        ["Group", group.name],
        ["Speakers", data.members.length ? data.members.join(", ") : "None yet"],
        ["Gain", `${gain > 0 ? "+" : ""}${gain.toFixed(1)} dB`],
        ["Delay", `${(group.delayMs ?? 0).toFixed(2)} ms`],
        ["Polarity", group.polarityInverted ? "Inverted" : "Normal"],
        ["Mute", group.muted ? "Muted" : "Off"],
      ]}
    />
  );
  return (
    <Hint text={tooltip} className="flex w-full">
      <div
        className={`${TILE} border-dashed ${frame(lit)} ${member ? MEMBER : ""}`}
        onClick={() => grouping && !data.busy && canvas.armGroup(group.id)}
      >
        {group.muted && <Dot color="var(--amp-color-red-filled)" />}
        <Boxes size={26} className="text-[var(--amp-color-dimmed)]" />
        {canvas.renaming === group.id ? (
          <input
            autoFocus
            aria-label="Group name"
            className={`${FIELD_INPUT} nodrag w-full text-center text-xs`}
            defaultValue={group.name}
            maxLength={40}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => canvas.renameGroup(group, e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          />
        ) : (
          <span className={NAME}>{group.name}</span>
        )}
        <span className={TUNE}>{data.tune || `${data.members.length} speaker${data.members.length === 1 ? "" : "s"}`}</span>
      </div>
    </Hint>
  );
}

// Module level: React Flow re-mounts every node when this changes identity.
export const NODE_TYPES = { speaker: SpeakerTile, group: GroupTile };

const SQUARE = "h-[18px] min-w-[18px] cursor-pointer rounded-sm border border-solid px-1 text-[10px] leading-none font-bold disabled:cursor-default";
// A linked way: the same fixed green as a linked output on the amp card.
const HELD = "border-[var(--amp-color-green-filled)] bg-[var(--amp-color-green-filled)] text-white";
const FREE = "border-[var(--amp-color-default-border)]";

/** One output of an amp card. In the Link tool a `target` can be picked, a
 * `blocked` one can't start the armed speaker's span, and `idle` means
 * nothing is armed — a click then selects it for bridging. */
export interface OutputBox {
  key: string;
  label: string;
  /** What it holds; `null` when free. */
  text: string | null;
  mode: "idle" | "target" | "blocked";
  /** Lit: its speaker is hovered, or a pick would fill it. */
  lit: boolean;
  /** Linked to a project speaker — green. An output holding a speaker set up
   * on the amp only (`text` without a link) is not. */
  linked: boolean;
  /** A bridged pair: one output, twice as wide. */
  bridged: boolean;
  /** Being written right now: spins. */
  pending: boolean;
  /** Selected for Bridge / Unbridge. */
  picked: boolean;
}

// The end sections take the card's corners, so an inset ring follows its radius instead of being clipped.
const SEGMENT_EDGE = "border-0 border-l border-solid border-[var(--amp-color-default-border)] first:border-l-0 first:rounded-l-md last:rounded-r-md";

/** One project amp in the Workspace's amp list: a rack card, its name in the
 * middle and its outputs across the whole width under it — a thin strip of
 * held/free in the Select tool, labelled sections to pick in the Link tool,
 * as in ArmoníaPlus. */
export function AmpTile({
  name,
  isCvr,
  dot,
  blink,
  tooltip,
  selected,
  linking,
  boxes,
  onSelect,
  onOpen,
  onPick,
  onBoxHover,
}: {
  name: string;
  isCvr: boolean;
  /** Its sync state as a colour; `null` when there is nothing to compare. */
  dot: string | null;
  /** The dot blinks: the amp differs from the project. */
  blink?: boolean;
  tooltip: Array<[string, ReactNode]>;
  selected: boolean;
  linking: boolean;
  boxes: OutputBox[];
  onSelect: () => void;
  onOpen: () => void;
  /** `additive`: Ctrl or Shift was held. */
  onPick: (key: string, additive: boolean) => void;
  onBoxHover: (key: string | null) => void;
}) {
  return (
    <Hint text={<TileTooltip rows={tooltip} />} className="flex min-w-0">
      <div
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        className={`relative flex h-10 w-full min-w-0 cursor-pointer overflow-hidden rounded-md border border-solid bg-background outline-none focus-visible:ring-2 focus-visible:ring-accent ${frame(
          selected || boxes.some((b) => b.lit),
        )}`}
        onClick={onSelect}
        onDoubleClick={onOpen}
        onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && onOpen()}
      >
        {/* The front panel as the card's background. */}
        {isCvr && <img src="/cvr_dsp_amp.png" alt="" className="pointer-events-none absolute inset-0 size-full object-cover opacity-35" />}
        {linking ? (
          // The outputs take the name's place, one section each across the whole card.
          <div className="relative flex min-w-0 flex-1">
            {boxes.map((box) => (
              <button
                key={box.key}
                type="button"
                disabled={box.mode === "blocked" || box.pending}
                aria-pressed={box.picked}
                aria-label={`Output ${box.label} of ${name}${box.text ? `, holds ${box.text}` : ", free"}`}
                style={{
                  flex: box.bridged ? 2 : 1,
                  // Linked: the fixed status green, translucent over the panel.
                  background: box.lit || box.picked || !box.linked ? undefined : "color-mix(in srgb, var(--amp-color-green-filled) 70%, transparent)",
                }}
                className={`relative flex min-w-0 cursor-pointer items-center justify-center text-xs font-bold disabled:cursor-default ${SEGMENT_EDGE} ${
                  box.lit || box.picked ? "bg-accent text-accent-foreground" : ""
                } ${box.linked && !box.lit && !box.picked ? "text-white" : ""} ${box.mode === "target" ? "ring-2 ring-accent ring-inset" : ""} ${
                  box.mode === "blocked" ? "opacity-40" : ""
                }`}
                onClick={(e) => {
                  e.stopPropagation();
                  onPick(box.key, e.ctrlKey || e.metaKey || e.shiftKey);
                }}
                // A double-click on an output is two picks, not "open the amp".
                onDoubleClick={(e) => e.stopPropagation()}
                onMouseEnter={() => onBoxHover(box.key)}
                onMouseLeave={() => onBoxHover(null)}
                onFocus={() => onBoxHover(box.key)}
                onBlur={() => onBoxHover(null)}
              >
                {/* Letter and spinner cross-fade; both stay mounted. */}
                <span className={`transition-opacity duration-300 ${box.pending ? "opacity-0" : "opacity-100"}`}>{box.label}</span>
                <span
                  aria-hidden={!box.pending}
                  className={`absolute inset-0 flex items-center justify-center transition-opacity duration-300 ${box.pending ? "opacity-100" : "opacity-0"}`}
                >
                  <Spinner size="sm" />
                </span>
              </button>
            ))}
          </div>
        ) : (
          <>
            <span className="relative min-w-0 flex-1 self-center truncate px-6 text-center text-sm font-semibold">{name}</span>
            <Dot color={dot} blink={blink} />
          </>
        )}
      </div>
    </Hint>
  );
}
