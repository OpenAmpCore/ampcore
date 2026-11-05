import { useEffect, useRef, useState } from "react";
import { Button, Modal, Spinner } from "@heroui/react";
import { Check, X } from "lucide-react";
import { commands, type AmpAssignment, type AmpEditLock, type Project } from "../../lib/bindings";

type RowState = { kind: "busy" } | { kind: "done"; text: string } | { kind: "error"; text: string };

/** ArmoníaPlus's data-mismatch window: when a project opens and amps differ
 * from it, one question per amp — Send the project to it (the usual answer,
 * speakers restored) or Read it into the project. Opens once per opening of the project, for the amps that
 * differ then; later differences show on the amp cards as before. Compare
 * opens the amp, whose editor shows the comparison. */
export function AmpDesyncModal({
  project,
  locks,
  nameOf,
  onProjectUpdate,
  onCompare,
}: {
  project: Project;
  locks: Map<string, AmpEditLock>;
  nameOf: (assignment: AmpAssignment) => string;
  onProjectUpdate: (project: Project) => void;
  onCompare: (assignment: AmpAssignment) => void;
}) {
  const [open, setOpen] = useState(false);
  const [ids, setIds] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const asked = useRef(false);

  const mismatched = project.ampAssignments.filter((a) => locks.get(a.id)?.state === "mismatch");
  useEffect(() => {
    if (asked.current || mismatched.length === 0) return;
    asked.current = true;
    setIds(mismatched.map((a) => a.id));
    setOpen(true);
  }, [mismatched.length]);

  const amps = ids.map((id) => project.ampAssignments.find((a) => a.id === id)).filter((a): a is AmpAssignment => !!a);
  const differing = (a: AmpAssignment) => locks.get(a.id)?.rows.filter((r) => r.differs).length ?? 0;
  const setRow = (id: string, state: RowState) => setRows((r) => ({ ...r, [id]: state }));

  /** The project onto the amp, then every output whose speaker reads Edited
   * re-applied from the library (`speakers_apply`) — a project that once took in a recall holds wrong
   * values, and pushing those back alone restores nothing. In that order
   * because `speakers_apply` only writes an amp that matches. A newer library
   * revision (Library updated) is left for the user to take. */
  async function send(a: AmpAssignment) {
    setRow(a.id, { kind: "busy" });
    const r = await commands.projectsPushAmpToLive(project.id, a.id);
    if (r.status === "error") return setRow(a.id, { kind: "error", text: r.error.message });
    if (r.data.project) onProjectUpdate(r.data.project);
    if (!r.data.pushed) {
      return setRow(a.id, { kind: "error", text: r.data.error ?? "The amp didn't end up as sent: compare it" });
    }
    const states = await commands.speakersChannelStates(project.id, a.id);
    const edited = states.status === "ok" ? states.data.filter((s) => s.status.kind === "edited") : [];
    if (edited.length === 0) return setRow(a.id, { kind: "done", text: "Sent" });
    const items = edited.map((s) => ({
      channelIndex: s.channelIndex,
      libraryId: s.speaker.libraryId,
      wayIndex: s.speaker.wayIndex,
      projectSpeakerId: s.speaker.projectSpeakerId ?? null,
    }));
    const applied = await commands.speakersApply(project.id, a.id, items, false);
    if (applied.status === "error") {
      return setRow(a.id, {
        kind: "error",
        text: `Sent; ${edited.length} ${edited.length === 1 ? "speaker needs" : "speakers need"} Re-apply (${applied.error.message})`,
      });
    }
    onProjectUpdate(applied.data);
    setRow(a.id, { kind: "done", text: `Sent, ${edited.length} ${edited.length === 1 ? "speaker" : "speakers"} restored` });
  }

  async function read(a: AmpAssignment) {
    setRow(a.id, { kind: "busy" });
    const r = await commands.projectsMergeAmpFromLive(project.id, a.id);
    if (r.status === "error") return setRow(a.id, { kind: "error", text: r.error.message });
    if (r.data.project) onProjectUpdate(r.data.project);
    setRow(a.id, r.data.merged ? { kind: "done", text: "Read" } : { kind: "error", text: "Couldn't read every setting: compare it" });
  }

  async function sendAll() {
    for (const a of amps) if (rows[a.id]?.kind !== "done") await send(a);
  }

  const busy = Object.values(rows).some((r) => r.kind === "busy");

  return (
    <Modal.Backdrop isOpen={open} onOpenChange={(o) => !o && !busy && setOpen(false)}>
      <Modal.Container placement="center" size="md">
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Heading>Amps differ from the project</Modal.Heading>
          </Modal.Header>
          <Modal.Body>
            <div className="flex flex-col gap-3 text-[length:var(--amp-font-size-sm)]">
              <span className="text-[var(--amp-color-dimmed)]">
                These amps changed while the project was closed (a preset recall, other software). Send puts the
                project back on them, speakers included. Read takes the amp's values into the project.
              </span>
              {amps.map((a) => {
                const row = rows[a.id];
                return (
                  <div
                    key={a.id}
                    className="flex flex-col gap-2 rounded-md border border-[var(--amp-color-default-border)] px-3 py-2"
                  >
                    {/* Name and state on their own line, actions under them:
                        side by side, the buttons squeezed the name to "P…". */}
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate font-medium">{nameOf(a)}</span>
                      <span className="text-[length:var(--amp-font-size-xs)] text-[var(--amp-color-dimmed)]">
                        {row?.kind === "done" || row?.kind === "error" ? (
                          <span className="inline-flex items-center gap-1" style={{ color: row.kind === "done" ? "var(--amp-color-green-6)" : "var(--amp-color-red-6)" }}>
                            {row.kind === "done" ? <Check size={12} /> : <X size={12} />}
                            {row.text}
                          </span>
                        ) : (
                          `Differs in ${differing(a)} ${differing(a) === 1 ? "setting" : "settings"}`
                        )}
                      </span>
                    </div>
                    {row?.kind === "busy" ? (
                      <Spinner size="sm" className="self-end" />
                    ) : row?.kind !== "done" ? (
                      <div className="flex flex-wrap justify-end gap-1.5">
                        <Button size="sm" variant="ghost" isDisabled={busy} onPress={() => { setOpen(false); onCompare(a); }}>
                          Compare…
                        </Button>
                        <Button size="sm" variant="secondary" isDisabled={busy} onPress={() => void read(a)}>
                          Read from amp
                        </Button>
                        <Button size="sm" variant="primary" isDisabled={busy} onPress={() => void send(a)}>
                          Send to amp
                        </Button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="ghost" isDisabled={busy} onPress={() => setOpen(false)}>
              {amps.every((a) => rows[a.id]?.kind === "done") ? "Close" : "Later"}
            </Button>
            {amps.some((a) => rows[a.id]?.kind !== "done") && (
              <Button variant="primary" isDisabled={busy} onPress={() => void sendAll()}>
                Send all
              </Button>
            )}
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
