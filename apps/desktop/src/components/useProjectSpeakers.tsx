import { useEffect, useState, type ReactNode } from "react";
import { Button, Modal, toast } from "@heroui/react";
import {
  commands,
  type AmpAssignment,
  type ChannelSpeakerState,
  type Project,
  type ProjectSpeaker,
  type SpeakerLibraryEntry,
} from "../lib/bindings";
import { usePreference } from "../lib/preferences";
import { speakerName, useSpeakerLibrary } from "../lib/speakers";
import { useConfirm } from "./ConfirmDialog";
import { MUTED, outputRows } from "./SpeakerBench";
import { FIELD_INPUT } from "./fieldClasses";
import { confirmFit } from "./speakerApply";

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
  /** The speaker being written to its amp; `"*"` while several are. */
  const [busy, setBusy] = useState<string | null>(null);
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

  /** Sets outputs of one amp up from library ways, as ways of their project
   * speakers, in one apply — so one push. Resolves to whether they hold them. */
  async function applyToAmp(
    ways: Way[],
    busyId: string,
    ui: { title: string; intro: ReactNode; confirmLabel: string },
    failure: string,
  ): Promise<boolean> {
    const amp = ways[0].target.amp;
    setBusy(busyId);
    try {
      // Applying to a linked, online amp pushes the whole project amp, so it
      // must be in step with it first — the same rule its own tabs follow.
      const lock = await commands.projectsAmpEditLock(project.id, amp.id);
      if (lock.status !== "ok" || lock.data.locked) {
        toast.danger(`${nameFor(amp)} can't be changed right now`, {
          description:
            lock.status !== "ok" ? lock.error.message
            : lock.data.state === "mismatch" ? "It differs from this project. Compare the two from its card first."
            : "It is still being read. Try again in a moment.",
        });
        return false;
      }
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
      const r = await commands.speakersApply(project.id, amp.id, pairs, true);
      if (r.status !== "ok") {
        // Stays up: it says what the amp does and doesn't hold now.
        toast.danger(failure, { description: r.error.message, timeout: 0 });
        return false;
      }
      onProjectUpdate(r.data);
      return true;
    } finally {
      setBusy(null);
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
      speaker.id,
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
        of.length === 1 ? of[0].id : "*",
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
    busy,
    link,
    /** The project speakers with an output to re-apply. */
    staleSpeakers: speakers.filter((sp) => stale.some((w) => w.speaker === sp)),
    reapply,
    /** Removes an output's link; its values and library reference stay. */
    unlink: async (output: Output) => {
      const r = await commands.projectsUnlinkOutput(project.id, output.amp.id, output.row.leader);
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
          onAdd={async (entry, name) => {
            const r = await commands.projectsAddSpeaker(project.id, entry.id, name);
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

/** Pick a library speaker and name it. The name defaults to "Brand Model". */
function AddSpeakerModal({
  open,
  library,
  onClose,
  onAdd,
}: {
  open: boolean;
  library: SpeakerLibraryEntry[];
  onClose: () => void;
  onAdd: (entry: SpeakerLibraryEntry, name: string) => Promise<string | null>;
}) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<SpeakerLibraryEntry | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  function close() {
    setQuery("");
    setPicked(null);
    setName("");
    setError(null);
    onClose();
  }

  const needle = query.trim().toLowerCase();
  const shown = library
    .filter((e) => [e.brand, e.model, e.family, e.application].join(" ").toLowerCase().includes(needle))
    .sort((a, b) => a.brand.localeCompare(b.brand) || a.model.localeCompare(b.model));

  return (
    <Modal.Backdrop isOpen={open} onOpenChange={(o) => !o && close()}>
      <Modal.Container placement="center" size="md">
        <Modal.Dialog>
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
                  <div className="flex max-h-64 flex-col overflow-auto rounded-lg border border-[var(--amp-color-default-border)]">
                    {shown.length === 0 && <span className={`${MUTED} p-2`}>No speaker matches.</span>}
                    {shown.map((entry) => (
                      <button
                        key={entry.id}
                        type="button"
                        aria-pressed={picked?.id === entry.id}
                        onClick={() => setPicked(entry)}
                        className={`flex items-baseline gap-2 px-2 py-1 text-left text-sm hover:bg-[var(--amp-color-gray-light)] ${
                          picked?.id === entry.id ? "bg-accent-soft" : ""
                        }`}
                      >
                        <span className="truncate font-medium">{speakerName(entry)}</span>
                        <span className={`${MUTED} shrink-0`}>{entry.ways.length} way</span>
                        <span className={`${MUTED} truncate`}>{[entry.family, entry.application].filter(Boolean).join(" · ")}</span>
                      </button>
                    ))}
                  </div>
                  <label className="flex flex-col gap-1">
                    <span className={MUTED}>Name in this project</span>
                    <input
                      className={FIELD_INPUT}
                      placeholder={picked ? speakerName(picked) : "e.g. Main L"}
                      maxLength={40}
                      value={name}
                      onChange={(e) => setName(e.currentTarget.value)}
                    />
                  </label>
                </>
              )}
              {error && <span className="text-sm text-danger">{error}</span>}
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onPress={close}>Cancel</Button>
                <Button
                  variant="primary"
                  isDisabled={!picked}
                  onPress={async () => {
                    if (!picked) return;
                    const message = await onAdd(picked, name);
                    if (message) setError(message);
                    else close();
                  }}
                >
                  Add
                </Button>
              </div>
            </div>
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
