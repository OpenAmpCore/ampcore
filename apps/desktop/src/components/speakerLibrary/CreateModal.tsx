import { useState } from "react";
import { Button, Modal, Spinner } from "@heroui/react";
import { commands, type SpeakerDetails } from "../../lib/bindings";
import { useIsCompact } from "../../lib/breakpoints";
import { SimpleSelect } from "../SimpleSelect";
import { MUTED } from "../speakers/SpeakerBench";
import { FIELD_INPUT } from "../fieldClasses";
import { DETAIL_FIELDS, WayLabelFields } from "./SpeakerEditor";
import { MAX_WAYS } from "./shared";
import { EMPTY_SPEAKER_DETAILS } from "../../lib/speakers";

/** A new speaker from scratch: name and way count. Every way starts neutral
 * (flat EQ, limiters off) and is edited in the tab. */
export function CreateModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const compact = useIsCompact();
  const [draft, setDraft] = useState(EMPTY_SPEAKER_DETAILS);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<SpeakerDetails>) => setDraft((d) => ({ ...d, ...patch }));

  function close() {
    setDraft(EMPTY_SPEAKER_DETAILS);
    setError(null);
    onClose();
  }

  async function create() {
    setSaving(true);
    const r = await commands.speakersCreate(draft);
    setSaving(false);
    if (r.status !== "ok") {
      setError(r.error.message);
      return;
    }
    onCreated(r.data.id);
    close();
  }

  return (
    <Modal.Backdrop isOpen={open} onOpenChange={(o) => !o && close()}>
      <Modal.Container placement="center" size={compact ? "full" : "md"}>
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Heading>New speaker</Modal.Heading>
            <Modal.CloseTrigger />
          </Modal.Header>
          <Modal.Body>
            <div className="flex flex-col gap-3">
              <span className={MUTED}>Every way starts flat — EQ bypassed, limiters off, no delay. Edit the values afterwards.</span>
              <div className="grid grid-cols-2 gap-3">
                {DETAIL_FIELDS.map(([key, label, required]) => (
                  <label key={key} className="flex flex-col gap-1">
                    <span className={MUTED}>
                      {label}
                      {required && " *"}
                    </span>
                    <input className={FIELD_INPUT} value={draft[key]} onChange={(e) => set({ [key]: e.currentTarget.value })} />
                  </label>
                ))}
              </div>
              <SimpleSelect
                label="Ways"
                data={Array.from({ length: MAX_WAYS }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))}
                value={String(draft.wayLabels.length)}
                onChange={(v) => {
                  const n = Number(v ?? 1);
                  set({ wayLabels: Array.from({ length: n }, (_, i) => draft.wayLabels[i] ?? "") });
                }}
              />
              {draft.wayLabels.length > 1 && (
                <WayLabelFields labels={draft.wayLabels} onChange={(wayLabels) => set({ wayLabels })} />
              )}
              {error && <span className="text-sm text-danger">{error}</span>}
              <div className="flex justify-end gap-2">
                <Button variant="secondary" isDisabled={saving} onPress={close}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  isDisabled={saving || !draft.brand.trim() || !draft.model.trim()}
                  onPress={() => void create()}
                >
                  {saving ? <Spinner size="sm" /> : "Create speaker"}
                </Button>
              </div>
            </div>
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
