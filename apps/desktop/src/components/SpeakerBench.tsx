import { useRef, useState } from "react";
import { Button, Chip, Dropdown, dropdownVariants } from "@heroui/react";
import { MoreHorizontal } from "lucide-react";
import type { AmpAssignment, ChannelSpeakerState, ProjectSpeaker, SpeakerLibraryEntry } from "../lib/bindings";
import { speakerFields, speakerName } from "../lib/speakers";
import { Hint } from "./Hint";

const DROPDOWN_SLOTS = dropdownVariants();
export const MUTED = "text-[length:var(--amp-font-size-xs)] text-[var(--amp-color-dimmed)]";

/** One output as the Speakers tab sees it: a bridged pair is one output,
 * driven by its leader — the follower is inert, as in the Output tab. */
export interface OutputRow {
  leader: number;
  label: string;
  bridged: boolean;
}

function letter(channelIndex: number): string {
  return String.fromCharCode(65 + channelIndex);
}

export function outputRows(assignment: AmpAssignment): OutputRow[] {
  const channels = [...assignment.channels].sort((a, b) => a.channelIndex - b.channelIndex);
  const bridged = new Set(channels.filter((c) => c.outputBridged && c.channelIndex % 2 === 0).map((c) => c.channelIndex));
  return channels
    .filter((c) => !(c.channelIndex % 2 === 1 && bridged.has(c.channelIndex - 1)))
    .map((c) => {
      const pair = bridged.has(c.channelIndex) && c.channelIndex + 1 < channels.length;
      return {
        leader: c.channelIndex,
        label: pair ? `${letter(c.channelIndex)}+${letter(c.channelIndex + 1)}` : letter(c.channelIndex),
        bridged: pair,
      };
    });
}

function splitLabel(label: string): [string, string | null] {
  const i = label.lastIndexOf(" · ");
  return i < 0 ? [label, null] : [label.slice(0, i), label.slice(i + 3)];
}

export interface CabinetPort {
  label: string;
  wayIndex: number;
  /** Index into the output rows; `null` for a way no output holds. */
  rowIndex: number | null;
  state?: ChannelSpeakerState;
}

/** One speaker on the bench. Not stored anywhere: derived from the outputs'
 * `SpeakerRef`s, or a pending join that has no speaker yet. */
export interface Cabinet {
  key: string;
  /** Missing for a detached speaker and for a pending join. */
  entry?: SpeakerLibraryEntry;
  title: string;
  subtitle: string;
  /** A join waiting for its speaker: `joinLeaders` are its outputs. */
  pending: boolean;
  joinLeaders?: number[];
  /** Set when the cabinet is a project speaker's ways on this amp. */
  projectSpeakerId?: string;
  ports: CabinetPort[];
}

/** Outputs in order: one joins the open cabinet of its library entry unless
 * that cabinet already holds its way — then it is a second speaker of the
 * same model. An output linked to a project speaker joins that speaker's
 * cabinet instead, which shows only the ways this amp drives. `joins` are
 * groups of output leaders joined without a speaker. */
export function buildCabinets(
  rows: OutputRow[],
  states: Map<number, ChannelSpeakerState>,
  library: SpeakerLibraryEntry[],
  joins: number[][],
  projectSpeakers: ProjectSpeaker[],
): Cabinet[] {
  const cabinets: Cabinet[] = [];
  const open = new Map<string, Cabinet>();
  rows.forEach((row, rowIndex) => {
    const state = states.get(row.leader);
    if (!state) return;
    const { libraryId, wayIndex, label } = state.speaker;
    const projectSpeaker = projectSpeakers.find((s) => s.id === state.speaker.projectSpeakerId);
    const openKey = projectSpeaker?.id ?? libraryId;
    let cabinet = open.get(openKey);
    if (!cabinet || cabinet.ports.some((p) => p.wayIndex === wayIndex && p.rowIndex !== null)) {
      const entry = library.find((e) => e.id === libraryId);
      cabinet = {
        key: `${libraryId}:${row.leader}`,
        entry,
        title: projectSpeaker?.name ?? (entry ? speakerName(entry) : splitLabel(label)[0]),
        subtitle: !entry ? "Not in this library"
          : projectSpeaker ? speakerName(entry)
          : [entry.family, entry.application].filter(Boolean).join(" · "),
        pending: false,
        projectSpeakerId: projectSpeaker?.id,
        ports: entry?.ways.map((w, i) => ({ label: w.label, wayIndex: i, rowIndex: null })) ?? [],
      };
      open.set(openKey, cabinet);
      cabinets.push(cabinet);
    }
    let port = cabinet.ports.find((p) => p.wayIndex === wayIndex);
    if (!port) {
      port = { label: splitLabel(label)[1] ?? "Full", wayIndex, rowIndex: null };
      cabinet.ports.push(port);
    }
    port.rowIndex = rowIndex;
    port.state = state;
  });
  for (const join of joins) {
    cabinets.push({
      key: `join:${join.join("-")}`,
      title: "New speaker",
      subtitle: `Drop a ${join.length}-way speaker here`,
      pending: true,
      joinLeaders: join,
      ports: join.map((leader, i) => ({
        label: `Way ${i + 1}`,
        wayIndex: i,
        rowIndex: rows.findIndex((r) => r.leader === leader),
      })),
    });
  }
  const first = (c: Cabinet) => Math.min(...c.ports.map((p) => p.rowIndex ?? Infinity));
  return cabinets.sort((a, b) => first(a) - first(b));
}

/** A ⋯ button with its menu — the standalone-overlay pattern of the preset
 * rows (`triggerRef` + `isOpen`), since `Dropdown.Menu` is a RAC collection
 * and its items must be direct children. */
export function RowMenu({ label, items, disabled, onAction }: {
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
      <div ref={ref} className="flex shrink-0">
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
  const fields = speakerFields(s);
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
    <Hint text={title} className="shrink-0">
      <Chip size="sm" color={color}>{text}</Chip>
    </Hint>
  );
}

// The bench is laid out on fixed sizes so every cable end is computed, not
// measured. Outputs and a cabinet's ports share one pitch (`ROW_H`), and a
// cabinet sits level with its first output, so a speaker on adjacent outputs
// gets straight cables.
const TOP = 30;
const ROW_H = 64;
const PANEL_W = 170;
const GUTTER_W = 80;
const CAB_GAP = 8;
/** How far a socket's centre sits inside the panel's outer edge. A cabinet's
 * port sits on the card's own left edge, i.e. exactly at the gutter's end.
 * Both are measured to the outer edge: the 1px borders are subtracted where
 * the HTML is laid out, or the plugs land a pixel off their sockets. */
const CONNECTOR_INSET = 26;
const SOCKET = 26;
const PORT = 18;

/** Fixed status colours, never the accent for a warning (see CLAUDE.md). */
function cableColor(port: CabinetPort, pending: boolean): { stroke: string; dashed: boolean } {
  const kind = port.state?.status.kind;
  if (pending) return { stroke: "var(--amp-color-dimmed)", dashed: true };
  if (kind === "match") return { stroke: "var(--amp-color-green-filled)", dashed: false };
  if (kind === "edited") return { stroke: "var(--amp-color-orange-6)", dashed: false };
  if (kind === "libraryUpdated") return { stroke: "var(--accent)", dashed: false };
  return { stroke: "var(--amp-color-gray-filled)", dashed: true };
}

function cablePath(x1: number, y1: number, x2: number, y2: number): string {
  const mid = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
}

/** A loudspeaker cabinet, front view: one driver per way, largest at the bottom. */
function CabinetIcon({ ways }: { ways: number }) {
  const drivers = ways <= 1 ? [[26, 15]] : ways === 2 ? [[13, 6], [35, 13]] : [[9, 4], [22, 7], [39, 10]];
  return (
    <svg width={34} height={44} viewBox="0 0 40 52" className="shrink-0" aria-hidden>
      <rect x={1} y={1} width={38} height={50} rx={5} fill="var(--amp-color-gray-light)" stroke="var(--amp-color-default-border)" />
      {drivers.map(([cy, r]) => (
        <g key={cy}>
          <circle cx={20} cy={cy} r={r} fill="none" stroke="var(--amp-color-dimmed)" strokeWidth={1.5} />
          <circle cx={20} cy={cy} r={r / 3} fill="var(--amp-color-dimmed)" />
        </g>
      ))}
    </svg>
  );
}

export type RowHighlight = "fits" | "overflow" | "start" | null;

/** The patch bench: the amp's outputs as rear-panel connectors on the left,
 * its speakers as cabinets on the right, a cable per linked way between
 * them. Presentation and pointer handling only — every command stays with
 * `SpeakersTab`. */
export function SpeakerBench({
  rows,
  states,
  cabinets,
  selected,
  disabled,
  highlightFor,
  onSelect,
  onRowDragOver,
  onRowDrop,
  onLink,
  menuFor,
  onCabinetAction,
}: {
  rows: OutputRow[];
  states: Map<number, ChannelSpeakerState>;
  cabinets: Cabinet[];
  /** Selected output leaders. */
  selected: Set<number>;
  disabled: boolean;
  highlightFor: (rowIndex: number) => RowHighlight;
  /** `null` = a click on the bench itself, which clears the selection. */
  onSelect: (rowIndex: number | null, modifiers: { toggle: boolean; range: boolean }) => void;
  onRowDragOver: (rowIndex: number, e: React.DragEvent) => void;
  onRowDrop: (rowIndex: number, e: React.DragEvent) => void;
  /** A cable was dragged from a cabinet's way port onto an output. */
  onLink: (cabinet: Cabinet, wayIndex: number, rowIndex: number) => void;
  menuFor: (cabinet: Cabinet) => Array<{ id: string; label: string; danger?: boolean }>;
  onCabinetAction: (cabinet: Cabinet, action: string) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  /** The cable being dragged: its fixed end and where the pointer is, in the
   * gutter's coordinates, plus the output under the pointer. */
  const [drag, setDrag] = useState<{ cabinet: Cabinet; wayIndex: number; portY: number; x: number; y: number; over: number | null } | null>(null);

  const rowY = (rowIndex: number) => TOP + rowIndex * ROW_H + ROW_H / 2;
  let bottom = TOP;
  const placed = cabinets.map((cabinet) => {
    const firstRow = Math.min(...cabinet.ports.map((p) => (p.rowIndex !== null && p.rowIndex >= 0 ? p.rowIndex : Infinity)));
    const top = Math.max(TOP + (Number.isFinite(firstRow) ? firstRow : 0) * ROW_H + CAB_GAP / 2, bottom);
    const height = cabinet.ports.length * ROW_H - CAB_GAP;
    bottom = top + height + CAB_GAP;
    return { cabinet, top, height };
  });
  const portY = (cabinetTop: number, portIndex: number) => cabinetTop - CAB_GAP / 2 + portIndex * ROW_H + ROW_H / 2;
  const panelHeight = TOP + rows.length * ROW_H + 8;
  const height = Math.max(panelHeight, bottom);

  function rowUnder(e: React.PointerEvent): number | null {
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-output-row]");
    return el instanceof HTMLElement ? Number(el.dataset.outputRow) : null;
  }

  function dragTo(e: React.PointerEvent) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    setDrag((d) => d && { ...d, x: e.clientX - rect.left, y: e.clientY - rect.top, over: rowUnder(e) });
  }

  return (
    <div
      className="relative flex min-w-[490px] select-none"
      style={{ height }}
      onClick={(e) => e.target === e.currentTarget && onSelect(null, { toggle: false, range: false })}
    >
      {/* Rear panel */}
      <div
        className="relative shrink-0 rounded-xl border border-[var(--amp-color-default-border)] bg-[var(--amp-color-gray-light)]"
        style={{ width: PANEL_W, height: panelHeight }}
      >
        <span className={`${MUTED} absolute left-3 top-2 font-semibold uppercase tracking-widest`}>Amp outputs</span>
        <div style={{ paddingTop: TOP - 1 }}>
          {rows.map((row, rowIndex) => {
            const state = states.get(row.leader);
            const isSelected = selected.has(row.leader);
            const highlight = drag?.over === rowIndex ? "fits" : highlightFor(rowIndex);
            const ring =
              highlight === "overflow" ? "var(--amp-color-red-filled)"
              : highlight === "fits" || isSelected ? "var(--accent)"
              : "var(--amp-color-dimmed)";
            return (
              <div
                key={row.leader}
                data-output-row={rowIndex}
                role="button"
                tabIndex={0}
                aria-pressed={isSelected}
                aria-label={`Output ${row.label}`}
                onClick={(e) => onSelect(rowIndex, { toggle: e.ctrlKey || e.metaKey, range: e.shiftKey })}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  onSelect(rowIndex, { toggle: e.ctrlKey || e.metaKey, range: e.shiftKey });
                }}
                onDragOver={(e) => onRowDragOver(rowIndex, e)}
                onDrop={(e) => onRowDrop(rowIndex, e)}
                className="flex cursor-pointer items-center gap-2 pl-3 transition-colors"
                style={{
                  height: ROW_H,
                  paddingRight: CONNECTOR_INSET - SOCKET / 2 - 1,
                  background:
                    highlight === "fits" || isSelected ? "var(--accent-soft)"
                    : highlight === "start" ? "color-mix(in srgb, var(--accent-soft) 40%, transparent)"
                    : undefined,
                }}
              >
                <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                  <span className="text-sm font-bold tabular-nums">{row.label}</span>
                  {state ? <StatusChip state={state} /> : <span className={MUTED}>{row.bridged ? "bridged" : "free"}</span>}
                </div>
                {/* The socket; a linked cable's plug is drawn over it by the SVG. */}
                <div
                  className="flex shrink-0 items-center justify-center rounded-full border-2 bg-[var(--amp-color-body)] transition-colors"
                  style={{ width: SOCKET, height: SOCKET, borderColor: ring, boxShadow: row.bridged ? `0 0 0 3px var(--amp-color-body), 0 0 0 5px ${ring}` : undefined }}
                >
                  <div className="size-1.5 rounded-full bg-[var(--amp-color-dimmed)]" />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Cables. Drawn past both edges of the gutter so each end lands on the
          centre of its connector / port. */}
      <svg ref={svgRef} width={GUTTER_W} height={height} className="pointer-events-none relative z-10 shrink-0 overflow-visible">
        {placed.flatMap(({ cabinet, top: cabinetTop }) =>
          cabinet.ports.map((port, portIndex) => {
            if (port.rowIndex === null || port.rowIndex < 0) return null;
            if (drag && drag.cabinet.key === cabinet.key && drag.wayIndex === port.wayIndex) return null;
            const { stroke, dashed } = cableColor(port, cabinet.pending);
            const [y1, y2] = [rowY(port.rowIndex), portY(cabinetTop, portIndex)];
            const d = cablePath(-CONNECTOR_INSET, y1, GUTTER_W, y2);
            return (
              <g key={`${cabinet.key}:${port.wayIndex}`}>
                <path d={d} fill="none" stroke="var(--amp-color-body)" strokeWidth={7} strokeLinecap="round" />
                <path d={d} fill="none" stroke={stroke} strokeWidth={3} strokeLinecap="round" strokeDasharray={dashed ? "7 6" : undefined} />
                {/* Plugs fill their socket up to its ring. */}
                <circle cx={-CONNECTOR_INSET} cy={y1} r={SOCKET / 2 - 4} fill={stroke} />
                <circle cx={GUTTER_W} cy={y2} r={PORT / 2 - 3} fill={stroke} />
              </g>
            );
          }),
        )}
        {drag && (
          <path
            d={cablePath(drag.x, drag.y, GUTTER_W, drag.portY)}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={3}
            strokeLinecap="round"
            strokeDasharray="7 6"
          />
        )}
      </svg>

      {/* Cabinets */}
      <div className="relative min-w-0 flex-1" style={{ height }}>
        <span className={`${MUTED} absolute left-3 top-2 font-semibold uppercase tracking-widest`}>Speakers</span>
        {placed.length === 0 && (
          <span className={`${MUTED} absolute left-3 italic`} style={{ top: TOP + 8 }}>
            No speakers yet. Drag one from the library onto an output, or double-click it.
          </span>
        )}
        {placed.map(({ cabinet, top: cabinetTop, height: cabinetHeight }) => (
          <div
            key={cabinet.key}
            className={`absolute left-0 flex w-full max-w-[440px] items-center gap-3 rounded-xl border border-[var(--amp-color-default-border)] bg-[var(--amp-color-body)] pr-2 ${
              cabinet.pending ? "border-dashed" : ""
            }`}
            style={{ top: cabinetTop, height: cabinetHeight }}
          >
            {/* Ports keep the outputs' pitch, so the column overhangs the card by half the gap. */}
            <div className={`flex shrink-0 flex-col self-start ${cabinet.ports.length > 1 ? "w-[84px]" : "w-3"}`} style={{ marginTop: -CAB_GAP / 2 - 1 }}>
              {cabinet.ports.map((port, portIndex) => {
                const canDrag = !disabled && !!cabinet.entry;
                return (
                  <div key={port.wayIndex} className="flex items-center gap-2" style={{ height: ROW_H }}>
                    {/* Centred on the card's left border, where the cable ends. */}
                    <div
                      aria-label={`${cabinet.title} · ${port.label}: drag to an output`}
                      className={`shrink-0 rounded-full border-2 border-[var(--amp-color-dimmed)] bg-[var(--amp-color-body)] ${canDrag ? "cursor-grab touch-none" : ""}`}
                      style={{ width: PORT, height: PORT, marginLeft: -PORT / 2 - 1 }}
                      onPointerDown={(e) => {
                        if (!canDrag) return;
                        e.currentTarget.setPointerCapture(e.pointerId);
                        const rect = svgRef.current?.getBoundingClientRect();
                        if (!rect) return;
                        setDrag({
                          cabinet,
                          wayIndex: port.wayIndex,
                          portY: portY(cabinetTop, portIndex),
                          x: e.clientX - rect.left,
                          y: e.clientY - rect.top,
                          over: null,
                        });
                      }}
                      onPointerMove={(e) => drag && dragTo(e)}
                      onPointerUp={(e) => {
                        if (!drag) return;
                        const target = rowUnder(e);
                        setDrag(null);
                        if (target !== null && target !== port.rowIndex) onLink(cabinet, port.wayIndex, target);
                      }}
                      onPointerCancel={() => setDrag(null)}
                    />
                    {cabinet.ports.length > 1 && <span className="truncate text-xs">{port.label}</span>}
                  </div>
                );
              })}
            </div>
            <CabinetIcon ways={cabinet.ports.length} />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-sm font-semibold">{cabinet.title}</span>
              {cabinet.subtitle && <span className={`${MUTED} truncate`}>{cabinet.subtitle}</span>}
              {cabinet.ports.length > 1 && <span className={MUTED}>{cabinet.ports.length}-way</span>}
            </div>
            <RowMenu
              label={`Actions for ${cabinet.title}`}
              items={menuFor(cabinet)}
              disabled={disabled}
              onAction={(action) => onCabinetAction(cabinet, action)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
