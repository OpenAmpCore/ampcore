import { createContext, useContext, type ReactNode } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import { Server, Speaker } from "lucide-react";
import type { ChannelSpeakerState, ProjectSpeaker } from "../lib/bindings";
import { speakerFields } from "../lib/speakers";
import { Hint } from "./Hint";
import { MUTED } from "./SpeakerBench";
import { FIELD_INPUT } from "./fieldClasses";

/** Width of a tile, amp or speaker: a picture and a name, like ArmoníaPlus's.
 * Everything else about it is in its tooltip, and what can be done to it is in
 * the mode bar. */
export const TILE_W = 96;

/** Design's two tools: Select moves and picks tiles, Link shows the amps'
 * outputs and the speakers' ways so they can be joined. */
export type Tool = "select" | "link";

/** Which ways of which speaker are waiting for an output to be picked. */
export interface Armed {
  speakerId: string;
  ways: number[];
}

const TILE =
  "relative flex w-full min-w-0 cursor-pointer flex-col items-center gap-1 rounded-xl border border-solid bg-background p-2 outline-none focus-visible:ring-2 focus-visible:ring-accent";
const NAME = "line-clamp-2 w-full text-center text-xs font-medium break-words";
const frame = (lit: boolean) => (lit ? "border-accent bg-accent-soft" : "border-[var(--amp-color-default-border)]");

/** The corner dot: a filled colour, or hollow for "nothing to say". */
function Dot({ color }: { color: string | null }) {
  return (
    <span
      className="absolute top-1.5 right-1.5 size-2.5 rounded-full border border-solid"
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
  arm: (armed: Armed) => void;
  /** Ends renaming; an empty or unchanged name is left alone. */
  rename: (speaker: ProjectSpeaker, name: string) => void;
}

export const SpeakerCanvasContext = createContext<SpeakerCanvas | null>(null);

export type SpeakerNodeData = {
  speaker: ProjectSpeaker;
  model: string;
  application: string;
  /** Its library entry is on this machine, so its ways can be applied. */
  linkable: boolean;
  busy: boolean;
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
  const lit = linking ? armed.length > 0 || canvas.highlighted === speaker.id : !!selected;

  const kinds = ways.map((w) => w.state?.status.kind);
  const dot = kinds.includes("edited") ? "var(--amp-color-orange-6)"
    : kinds.includes("libraryUpdated") ? "var(--accent)"
    : ways.length > 0 && ways.every((w) => w.output) ? "var(--amp-color-green-filled)"
    : null;

  const tooltip = (
    <TileTooltip
      rows={[
        ["Name", speaker.name],
        ["Model", data.model],
        ...(data.application ? ([["Application", data.application]] as Array<[string, ReactNode]>) : []),
        ...ways.map((w): [string, ReactNode] => [w.label || "Full", w.output ? `${w.output.label}${statusText(w.state)}` : "not linked"]),
        ...(data.linkable ? [] : ([["Library", "Not in this machine's library"]] as Array<[string, ReactNode]>)),
      ]}
    />
  );

  return (
    <Hint text={tooltip} className="flex w-full">
      <div
        className={`${TILE} ${frame(lit)} ${data.busy ? "opacity-60" : ""}`}
        onClick={() => canArm && canvas.arm({ speakerId: speaker.id, ways: ways.map((w) => w.wayIndex) })}
      >
        <Dot color={dot} />
        <Speaker size={30} className="text-[var(--amp-color-dimmed)]" />
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

// Module level: React Flow re-mounts every node when this changes identity.
export const NODE_TYPES = { speaker: SpeakerTile };

const SQUARE = "h-[18px] min-w-[18px] cursor-pointer rounded-sm border border-solid px-1 text-[10px] leading-none font-bold disabled:cursor-default";
const HELD = "border-[var(--amp-color-default-border)] bg-[var(--amp-color-gray-light)]";
const FREE = "border-[var(--amp-color-default-border)]";

/** One output of an amp tile, shown in the Link tool. A `target` can be
 * picked, a `blocked` one can't start the armed speaker's span, and `idle`
 * means nothing is armed yet. */
export interface OutputBox {
  key: string;
  label: string;
  /** What it holds; `null` when free. */
  text: string | null;
  mode: "idle" | "target" | "blocked";
  /** Lit: its speaker is hovered, or a pick would fill it. */
  lit: boolean;
}

/** One project amp in the Workspace's amp list. Its outputs appear as squares
 * only when `boxes` is given, i.e. in the Link tool. */
export function AmpTile({
  name,
  isCvr,
  dot,
  tooltip,
  selected,
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
  tooltip: Array<[string, ReactNode]>;
  selected: boolean;
  boxes: OutputBox[] | null;
  onSelect: () => void;
  onOpen: () => void;
  onPick: (key: string) => void;
  onBoxHover: (key: string | null) => void;
}) {
  return (
    <Hint text={<TileTooltip rows={tooltip} />} className="flex min-w-0">
      <div
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        className={`${TILE} ${frame(selected || !!boxes?.some((b) => b.lit))}`}
        onClick={onSelect}
        onDoubleClick={onOpen}
        onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && onOpen()}
      >
        <Dot color={dot} />
        <div className="flex h-[30px] items-center justify-center">
          {isCvr ? <img src="/cvr_dsp_amp.png" alt="" className="max-h-full max-w-full object-contain" /> : <Server size={26} className="text-[var(--amp-color-dimmed)]" />}
        </div>
        <span className={NAME}>{name}</span>
        {boxes && (
          <div className="flex flex-wrap justify-center gap-px">
            {boxes.map((box) => (
              <button
                key={box.key}
                type="button"
                disabled={box.mode !== "target"}
                aria-label={`Link to output ${box.label} of ${name}${box.text ? ` (holds ${box.text})` : ""}`}
                className={`${SQUARE} ${box.lit ? "border-accent bg-accent text-accent-foreground" : box.mode === "target" ? "border-accent" : box.text ? HELD : FREE} ${
                  box.mode === "blocked" ? "opacity-40" : ""
                }`}
                onClick={(e) => {
                  e.stopPropagation();
                  onPick(box.key);
                }}
                // A double-click on a square is two picks, not "open the amp".
                onDoubleClick={(e) => e.stopPropagation()}
                onMouseEnter={() => onBoxHover(box.key)}
                onMouseLeave={() => onBoxHover(null)}
                onFocus={() => onBoxHover(box.key)}
                onBlur={() => onBoxHover(null)}
              >
                {box.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </Hint>
  );
}
