import { useRef, useState } from "react";
import { Button, Modal, Spinner, toast } from "@heroui/react";
import { FileUp } from "lucide-react";
import { commands, type ProfileImportResult } from "../../lib/bindings";
import { useIsCompact } from "../../lib/breakpoints";
import { speakerName } from "../../lib/speakers";
import { Hint } from "../Hint";
import { MUTED } from "./SpeakerBench";

/** Pick any number of speaker files — the old app's preset files, or a
 * library exported from AmpCore — preview every speaker in them (with the
 * reason one can't be read), then import all readable ones at once. */
export function ImportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
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
            <Modal.Heading>Import speakers</Modal.Heading>
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
                <span className={MUTED}>
                  Speaker preset files or an exported AmpCore library (.json). Details can be edited after importing.
                </span>
              </div>
              {preview && (
                <div className="flex max-h-[50vh] flex-col gap-0.5 overflow-auto">
                  {preview.map((p, i) => (
                    <div key={`${i}:${p.fileName}`} className="flex min-w-0 items-center gap-2 text-sm" style={{ opacity: p.entry ? 1 : 0.6 }}>
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
