import { useEffect, useState, type ReactNode } from "react";
import { Button, Modal, toast } from "@heroui/react";
import { Minus, Plus } from "lucide-react";
import { useIsCompact } from "../lib/breakpoints";
import {
  commands,
  type AmpAssignment,
  type AmpEditLock,
  type ChannelSpeakerState,
  type Project,
  type ProjectSpeaker,
  type SpeakerLibraryEntry,
} from "../lib/bindings";
import { usePreference } from "../lib/preferences";
import { useSpeakerLibrary } from "../lib/speakers";
import { useConfirm } from "./ConfirmDialog";
import { MUTED, outputRows } from "./SpeakerBench";
import { FIELD_INPUT } from "./fieldClasses";
import { bridgeConfirm, confirmFit } from "./speakerApply";

/** Nothing being written: the idle value of `pending`, and an operation still asking its question. */
const NOTHING: { outputs: string[]; speakers: string[] } = { outputs: [], speakers: [] };

/** The Workspace's speakers: library speakers placed in the project, each way
 * linked to an output of any amp. Linking is `speakersApply` with the
 * speaker's id — it replaces the output's speaker values, exactly as assigning
 * in the amp's own Speakers tab does, and records the link on the output. A
 * speaker set up in an amp's Speakers tab is not one of these. */
export function useProjectSpeakers({
  project,
  onProjectUpdate,
  nameFor,
}: {
  project: Project;
  onProjectUpdate: (project: Project) => void;
  nameFor: (assignment: AmpAssignment) => string;
}) {
  const library = useSpeakerLibrary();
  const { confirm, dialog } = useConfirm();
  const showComparator = usePreference("showSpeakerComparator");
  const [addOpen, setAddOpen] = useState(false);
  /** The operation under way, `null` when idle: what it is writing right now
   * (the Workspace shows those spinning), or `NOTHING` while its question is
   * still open. */
  const [pending, setPending] = useState<typeof NOTHING | null>(null);
  const busy = pending !== null;
  async function writing<T>(outputs: string[], speakerIds: string[], run: () => Promise<T>): Promise<T> {
    setPending({ outputs, speakers: speakerIds });
    try {
      return await run();
    } finally {
      setPending(null);
    }
  }
  const speakers = project.speakers ?? [];

  const outputs = project.ampAssignments.flatMap((amp) =>
    outputRows(amp).map((row) => ({
      amp,
      row,
      key: `${amp.id}:${row.leader}`,
      label: `${nameFor(amp)} · ${row.label}`,
      speaker: amp.channels.find((c) => c.channelIndex === row.leader)?.speaker ?? null,
    })),
  );
  type Output = (typeof outputs)[number];

  // Library status of every amp's outputs, keyed like `outputs`.
  const [states, setStates] = useState(new Map<string, ChannelSpeakerState>());
  const ampIds = project.ampAssignments.map((a) => a.id).join(",");
  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      ampIds.split(",").filter(Boolean).map(async (id) => {
        const r = await commands.speakersChannelStates(project.id, id);
        return r.status === "ok" ? r.data.map((s) => [`${id}:${s.channelIndex}`, s] as const) : [];
      }),
    ).then((all) => {
      if (!cancelled) setStates(new Map(all.flat()));
    });
    return () => {
      cancelled = true;
    };
  }, [project.id, project.updatedAt, ampIds, library]);

  type Way = { speaker: ProjectSpeaker; entry: SpeakerLibraryEntry; wayIndex: number; target: Output };

  /** Whether the project amp may be changed now. A linked, online amp must be
   * in step with the project first — the same rule its own tabs follow.
   * Says why not when it can't. */
  async function editable(amp: AmpAssignment): Promise<AmpEditLock | null> {
    const lock = await commands.projectsAmpEditLock(project.id, amp.id);
    if (lock.status === "ok" && !lock.data.locked) return lock.data;
    toast.danger(`${nameFor(amp)} can't be changed right now`, {
      description:
        lock.status !== "ok" ? lock.error.message
        : lock.data.state === "mismatch" ? "It differs from this project. Compare the two from its card first."
        : "It is still being read. Try again in a moment.",
    });
    return null;
  }

  /** Bridges the pair led by output `leader` of `amp`, or unbridges it. The
   * wiring warning is only for an amp that will really switch: an offline,
   * unlinked or disengaged amp is just planned. */
  async function bridge(amp: AmpAssignment, leader: number, bridged: boolean): Promise<boolean> {
    if (busy) return false;
    const lock = await editable(amp);
    if (!lock) return false;
    const planOnly = lock.state === "offline" || lock.state === "unlinked" || lock.state === "disengaged";
    if (!planOnly && !(await confirm(bridgeConfirm(leader, bridged)))) return false;
    // Bridging takes the follower too; unbridging gives it back.
    const pair = [`${amp.id}:${leader}`, `${amp.id}:${leader + 1}`];
    const owners = outputs.filter((o) => pair.includes(o.key)).flatMap((o) => o.speaker?.projectSpeakerId ?? []);
    const r = await writing(pair, owners, () => commands.projectsSetOutputBridge(project.id, amp.id, leader, bridged));
    if (r.status === "ok") onProjectUpdate(r.data);
    else toast.danger(bridged ? "Outputs not bridged" : "Outputs not unbridged", { description: r.error.message });
    return r.status === "ok";
  }

  /** Sets outputs of one amp up from library ways, as ways of their project
   * speakers, in one apply — so one push. Resolves to whether they hold them. */
  async function applyToAmp(
    ways: Way[],
    ui: { title: string; intro: ReactNode; confirmLabel: string },
    failure: string,
  ): Promise<boolean> {
    const amp = ways[0].target.amp;
    setPending(NOTHING);
    try {
      if (!(await editable(amp))) return false;
      const pairs = await confirmFit({
        projectId: project.id,
        assignmentId: amp.id,
        items: ways.map(({ speaker, entry, wayIndex, target }) => ({
          channelIndex: target.row.leader,
          outputLabel: target.label,
          entry,
          wayIndex,
          projectSpeakerId: speaker.id,
        })),
        confirm,
        showComparator,
        ui,
      });
      if (!pairs) return false;
      const r = await writing(
        ways.map((w) => w.target.key),
        [...new Set(ways.map((w) => w.speaker.id))],
        () => commands.speakersApply(project.id, amp.id, pairs, true),
      );
      if (r.status !== "ok") {
        // Stays up: it says what the amp does and doesn't hold now.
        toast.danger(failure, { description: r.error.message, timeout: 0 });
        return false;
      }
      onProjectUpdate(r.data);
      return true;
    } finally {
      setPending(null);
    }
  }

  /** Links ways of one speaker to outputs of one amp. The outputs those ways
   * were on before give up their speaker only once the new ones hold it.
   * Resolves to whether the ways are now there. */
  async function link(speaker: ProjectSpeaker, entry: SpeakerLibraryEntry, items: Array<{ wayIndex: number; target: Output }>): Promise<boolean> {
    if (busy || items.length === 0) return false;
    if (items.every((i) => i.target.speaker?.projectSpeakerId === speaker.id && i.target.speaker.wayIndex === i.wayIndex)) return true;
    const targets = items.map((i) => i.target.label).join(", ");
    const previous = outputs.filter(
      (o) =>
        o.speaker?.projectSpeakerId === speaker.id &&
        items.some((i) => i.wayIndex === o.speaker?.wayIndex) &&
        !items.some((i) => i.target.key === o.key),
    );
    const wayLabel = items.length === 1 && entry.ways.length > 1 ? ` · ${entry.ways[items[0].wayIndex].label}` : "";
    const done = await applyToAmp(
      items.map((i) => ({ ...i, speaker, entry })),
      {
        title: `Link ${speaker.name}${wayLabel} to ${targets}?`,
        intro: (
          <span>
            {items.length === 1 ? "The output's" : "The outputs'"} EQ, limiters, delay, polarity and FIR filter are replaced with the speaker's.
          </span>
        ),
        confirmLabel: "Link",
      },
      `${speaker.name} not linked to ${targets}`,
    );
    if (!done) return false;
    for (const old of previous) {
      const released = await commands.projectsSetChannelSpeaker(project.id, old.amp.id, old.row.leader);
      if (released.status === "ok") onProjectUpdate(released.data);
      else toast.danger(`${old.label} not unlinked`, { description: released.error.message });
    }
    return true;
  }

  /** The linked outputs that no longer hold what their library way says. */
  const stale: Way[] = outputs.flatMap((target) => {
    const speaker = speakers.find((s) => s.id === target.speaker?.projectSpeakerId);
    const entry = library.find((e) => e.id === speaker?.libraryId);
    const kind = states.get(target.key)?.status.kind;
    return speaker && entry && (kind === "edited" || kind === "libraryUpdated") ? [{ speaker, entry, wayIndex: target.speaker!.wayIndex, target }] : [];
  });

  /** Gives those speakers' stale outputs their library values back: one
   * question and one push per amp. */
  async function reapply(of: ProjectSpeaker[]) {
    if (busy) return;
    const ways = stale.filter((w) => of.includes(w.speaker));
    for (const ampId of new Set(ways.map((w) => w.target.amp.id))) {
      const onAmp = ways.filter((w) => w.target.amp.id === ampId);
      const outputsText = `${onAmp.length} ${onAmp.length === 1 ? "output" : "outputs"} of ${nameFor(onAmp[0].target.amp)}`;
      await applyToAmp(
        onAmp,
        {
          title: `Re-apply ${outputsText} from the library?`,
          intro: (
            <>
              <span>These outputs get their library values back. Edits made on them are lost.</span>
              <ul className="max-h-48 list-disc overflow-auto pl-5">
                {onAmp.map((w) => (
                  <li key={w.target.key}>
                    {w.target.row.label}: {w.speaker.name}
                  </li>
                ))}
              </ul>
            </>
          ),
          confirmLabel: "Re-apply",
        },
        `${outputsText} not re-applied`,
      );
    }
  }

  async function rename(speaker: ProjectSpeaker, name: string) {
    if (!name.trim() || name.trim() === speaker.name) return;
    const r = await commands.projectsRenameSpeaker(project.id, speaker.id, name);
    if (r.status === "ok") onProjectUpdate(r.data);
    else toast.danger("Speaker not renamed", { description: r.error.message });
  }

  async function remove(speaker: ProjectSpeaker) {
    const ok = await confirm({
      title: `Remove ${speaker.name} from this project?`,
      description: "Outputs linked to it keep their values and stay set up as speakers on their amps.",
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (!ok) return;
    const r = await commands.projectsRemoveSpeaker(project.id, speaker.id);
    if (r.status === "ok") onProjectUpdate(r.data);
    else toast.danger("Speaker not removed", { description: r.error.message });
  }

  return {
    library,
    speakers,
    outputs,
    states,
    /** An operation is under way: nothing else may start. */
    busy,
    /** Output keys and project speaker ids being written right now. */
    pending: pending ?? NOTHING,
    link,
    bridge,
    /** The project speakers with an output to re-apply. */
    staleSpeakers: speakers.filter((sp) => stale.some((w) => w.speaker === sp)),
    reapply,
    /** Removes the speaker from the output, so it is free again; its values stay. */
    unlink: async (output: Output) => {
      const owner = output.speaker?.projectSpeakerId;
      const r = await writing([output.key], owner ? [owner] : [], () =>
        commands.projectsSetChannelSpeaker(project.id, output.amp.id, output.row.leader),
      );
      if (r.status === "ok") onProjectUpdate(r.data);
      else toast.danger(`${output.label} not unlinked`, { description: r.error.message });
    },
    rename,
    remove,
    openAdd: () => setAddOpen(true),
    /** The Add dialog and the confirm dialog; render once. */
    elements: (
      <>
        <AddSpeakerModal
          open={addOpen}
          library={library}
          onClose={() => setAddOpen(false)}
          onAdd={async (entry, name, parallel) => {
            const r = await commands.projectsAddSpeaker(project.id, entry.id, name, parallel);
            if (r.status === "ok") onProjectUpdate(r.data);
            return r.status === "ok" ? null : r.error.message;
          }}
        />
        {dialog}
      </>
    ),
  };
}

export type ProjectOutput = ReturnType<typeof useProjectSpeakers>["outputs"][number];

/** The library's drill-down levels, left to right, as in ArmoníaPlus. */
const LEVELS = [
  { key: "brand", label: "Brand" },
  { key: "family", label: "Family" },
  { key: "model", label: "Model" },
  { key: "application", label: "Application" },
] as const;
type Level = (typeof LEVELS)[number]["key"];
const MAX_QUANTITY = 32;
const MAX_PARALLEL = 8;

/** A whole number from 1 to `max`: −, the value, +. */
function Stepper({ label, hint, value, max, onChange }: { label: string; hint?: string; value: number; max: number; onChange: (value: number) => void }) {
  return (
    <div className="flex flex-col gap-1">
      <span className={MUTED}>{label}</span>
      <div className="flex items-center gap-1">
        <Button size="sm" variant="secondary" isIconOnly aria-label={`Fewer (${label})`} isDisabled={value <= 1} onPress={() => onChange(value - 1)}>
          <Minus size={14} />
        </Button>
        <input
          type="number"
          aria-label={label}
          min={1}
          max={max}
          className={`${FIELD_INPUT} w-14 text-center`}
          value={value}
          onChange={(e) => onChange(Math.min(max, Math.max(1, Math.round(Number(e.currentTarget.value)) || 1)))}
        />
        <Button size="sm" variant="secondary" isIconOnly aria-label={`More (${label})`} isDisabled={value >= max} onPress={() => onChange(value + 1)}>
          <Plus size={14} />
        </Button>
      </div>
      {hint && <span className={`${MUTED} text-xs`}>{hint}</span>}
    </div>
  );
}

/** Pick a library speaker column by column — Brand, Family, Model,
 * Application — then name it and say how many. The name defaults to
 * the model; several get " 1", " 2", … after it. */
function AddSpeakerModal({
  open,
  library,
  onClose,
  onAdd,
}: {
  open: boolean;
  library: SpeakerLibraryEntry[];
  onClose: () => void;
  onAdd: (entry: SpeakerLibraryEntry, name: string, parallel: number) => Promise<string | null>;
}) {
  const compact = useIsCompact();
  const [query, setQuery] = useState("");
  const [picks, setPicks] = useState<Partial<Record<Level, string>>>({});
  const [name, setName] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [parallel, setParallel] = useState(1);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    setQuery("");
    setPicks({});
    setName("");
    setQuantity(1);
    setParallel(1);
    setError(null);
    onClose();
  }

  const needle = query.trim().toLowerCase();
  // Each column lists what the picks to its left leave. Its pick is the
  // stored one while still listed, else the only option there is — so a
  // search that drops a pick clears it, and a lone option needs no click.
  let remaining = library.filter((e) => [e.brand, e.family, e.model, e.application].join(" ").toLowerCase().includes(needle));
  const columns = LEVELS.map(({ key, label }) => {
    const options = [...new Set(remaining.map((e) => e[key]))].sort((a, b) => a.localeCompare(b));
    const stored = picks[key];
    const pick = stored !== undefined && options.includes(stored) ? stored : options.length === 1 ? options[0] : undefined;
    const column = { key, label, options, pick, enabled: remaining.length > 0 };
    remaining = pick === undefined ? [] : remaining.filter((e) => e[key] === pick);
    return column;
  });
  // Two entries can share all four names; the first is taken.
  const entry = remaining[0] ?? null;
  const next = columns.find((c) => c.pick === undefined)?.key;

  /** Picking in a column keeps the picks left of it and resets those right of it. */
  function choose(level: Level, value: string) {
    const at = columns.findIndex((c) => c.key === level);
    setPicks({ ...Object.fromEntries(columns.slice(0, at).map((c) => [c.key, c.pick])), [level]: value });
    setError(null);
  }

  async function add(andClose: boolean) {
    if (!entry) return;
    setAdding(true);
    setError(null);
    const base = name.trim() || entry.model;
    let added = 0;
    for (; added < quantity; added++) {
      const message = await onAdd(entry, quantity > 1 ? `${base} ${added + 1}` : base, parallel);
      if (message) {
        setError(message);
        break;
      }
    }
    setAdding(false);
    if (added < quantity) return;
    if (andClose) close();
    else toast.success(`Added ${quantity > 1 ? `${quantity} × ` : ""}${base}`);
  }

  return (
    <Modal.Backdrop isOpen={open} onOpenChange={(o) => !o && close()}>
      <Modal.Container placement="center" size={compact ? "full" : "lg"}>
        {/* Wide enough for four columns and the details side by side. */}
        <Modal.Dialog className={compact ? undefined : "max-w-[960px]"}>
          <Modal.Header>
            <Modal.Heading>Add Speaker</Modal.Heading>
            <Modal.CloseTrigger />
          </Modal.Header>
          <Modal.Body>
            <div className="flex flex-col gap-3">
              {library.length === 0 ? (
                <span className={MUTED}>The speaker library is empty. Import speaker presets in an amp's Speakers tab first.</span>
              ) : (
                <>
                  <input
                    type="search"
                    aria-label="Search the library"
                    placeholder="Search the library"
                    className={FIELD_INPUT}
                    value={query}
                    onChange={(e) => setQuery(e.currentTarget.value)}
                  />
                  {/* Irreducible width: scrolls sideways in its own box on a narrow window. */}
                  <div className="min-w-0 overflow-x-auto">
                    <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(4, minmax(120px, 1fr)) minmax(180px, 220px)" }}>
                      {columns.map((column) => (
                        <div key={column.key} className="flex min-w-0 flex-col gap-1">
                          <span
                            className={`border-0 border-b-2 border-solid pb-1 text-center text-xs font-semibold tracking-wide uppercase ${
                              column.key === next ? "border-accent" : `border-transparent ${MUTED}`
                            }`}
                          >
                            {column.label}
                          </span>
                          <div className="flex h-80 flex-col gap-px overflow-y-auto rounded-md border border-solid border-[var(--amp-color-default-border)] p-1">
                            {column.enabled &&
                              column.options.map((option) => (
                                <button
                                  key={option}
                                  type="button"
                                  aria-pressed={column.pick === option}
                                  onClick={() => choose(column.key, option)}
                                  className={`truncate rounded-md px-2 py-1 text-center text-sm hover:bg-[var(--amp-color-gray-light)] ${
                                    column.pick === option ? "bg-accent-soft font-medium" : ""
                                  }`}
                                >
                                  {option || "—"}
                                </button>
                              ))}
                            {column.key === "brand" && column.options.length === 0 && (
                              <span className={`${MUTED} p-2 text-center`}>No speaker matches.</span>
                            )}
                          </div>
                        </div>
                      ))}
                      <div className="flex min-w-0 flex-col gap-1">
                        <span className={`border-0 border-b-2 border-solid border-transparent pb-1 text-center text-xs font-semibold tracking-wide uppercase ${MUTED}`}>
                          Details
                        </span>
                        {entry ? (
                          <div className="flex flex-col gap-3 p-1 text-sm">
                            <span>
                              {entry.ways.length} {entry.ways.length === 1 ? "way" : "ways"}: {entry.ways.map((w) => w.label).join(", ")}
                            </span>
                            {entry.notes && <span className={MUTED}>{entry.notes}</span>}
                            <label className="flex flex-col gap-1">
                              <span className={MUTED}>Name in this project</span>
                              <input
                                className={FIELD_INPUT}
                                placeholder={entry.model}
                                maxLength={40}
                                value={name}
                                onChange={(e) => setName(e.currentTarget.value)}
                              />
                            </label>
                            <Stepper label="Quantity" value={quantity} max={MAX_QUANTITY} onChange={setQuantity} />
                            <Stepper
                              label="Parallel"
                              hint="Cabinets wired in parallel on the same outputs: one speaker, linked once."
                              value={parallel}
                              max={MAX_PARALLEL}
                              onChange={setParallel}
                            />
                          </div>
                        ) : (
                          <span className={`${MUTED} p-1 text-sm`}>Pick a speaker in each column.</span>
                        )}
                      </div>
                    </div>
                  </div>
                </>
              )}
              {error && <span className="text-sm text-danger">{error}</span>}
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onPress={close}>Cancel</Button>
                <Button variant="secondary" isDisabled={!entry || adding} onPress={() => void add(false)}>
                  Add
                </Button>
                <Button variant="primary" isDisabled={!entry || adding} onPress={() => void add(true)}>
                  Add &amp; Close
                </Button>
              </div>
            </div>
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
