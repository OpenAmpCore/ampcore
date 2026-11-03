import { useRef, useState } from "react";
import { Button, Chip } from "@heroui/react";
import { GripVertical, Info, ListFilter } from "lucide-react";
import type { SpeakerLibraryEntry } from "../../lib/bindings";
import { speakerName } from "../../lib/speakers";
import { Hint } from "../Hint";
import { SimpleSelect } from "../SimpleSelect";
import { MUTED, RowMenu } from "./SpeakerBench";
import { FIELD_INPUT } from "../fieldClasses";

/** The drag payload of a library row dropped onto an output (`SpeakersTab`). */
export const DRAG_TYPE = "application/x-ampcore-speaker-id";

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
export function LibraryTable({
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
