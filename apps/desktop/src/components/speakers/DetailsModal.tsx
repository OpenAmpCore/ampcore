import { useRef, useState } from "react";
import { Button, Modal, Spinner } from "@heroui/react";
import type { SpeakerDetails, SpeakerLibraryEntry } from "../../lib/bindings";
import { useIsCompact } from "../../lib/breakpoints";
import { SimpleSelect } from "../SimpleSelect";
import { MUTED, type OutputRow } from "./SpeakerBench";
import { FIELD_INPUT } from "../fieldClasses";
import { EMPTY_SPEAKER_DETAILS } from "../../lib/speakers";

export type DetailsTarget = { kind: "edit"; entry: SpeakerLibraryEntry } | { kind: "save"; rowIndex: number; ways: number };

/** Edit an entry's metadata, or save outputs as a new entry. Editing never
 * touches processing — "Update library from these outputs" does that. */
export function DetailsModal({
  target,
  rows,
  onClose,
  onSave,
}: {
  target: DetailsTarget | null;
  rows: OutputRow[];
  onClose: () => void;
  onSave: (target: DetailsTarget, details: SpeakerDetails) => Promise<string | null>;
}) {
  const compact = useIsCompact();
  const [draft, setDraft] = useState<SpeakerDetails>(EMPTY_SPEAKER_DETAILS);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const seeded = useRef<DetailsTarget | null>(null);
  if (target !== seeded.current) {
    seeded.current = target;
    if (target) {
      setError(null);
      setDraft(
        target.kind === "edit"
          ? { ...target.entry, wayLabels: target.entry.ways.map((w) => w.label) }
          : { ...EMPTY_SPEAKER_DETAILS, wayLabels: Array.from({ length: target.ways }, () => "") },
      );
    }
  }
  const maxWays = target?.kind === "save" ? rows.length - target.rowIndex : 0;
  const set = (patch: Partial<SpeakerDetails>) => setDraft((d) => ({ ...d, ...patch }));

  async function save() {
    if (!target || saving) return;
    setSaving(true);
    const message = await onSave(target, draft);
    setSaving(false);
    if (message) setError(message);
    else onClose();
  }

  const field = (key: "brand" | "family" | "model" | "application", label: string, required = false) => (
    <label className="flex flex-col gap-1">
      <span className={MUTED}>{label}{required && " *"}</span>
      <input className={FIELD_INPUT} value={draft[key]} onChange={(e) => set({ [key]: e.currentTarget.value })} />
    </label>
  );

  return (
    <Modal.Backdrop isOpen={target !== null} onOpenChange={(open) => !open && onClose()}>
      <Modal.Container placement="center" size={compact ? "full" : "lg"}>
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Heading>
              {target?.kind === "edit" ? "Speaker details" : `Save output ${target ? rows[target.rowIndex]?.label : ""} as speaker`}
            </Modal.Heading>
            <Modal.CloseTrigger />
          </Modal.Header>
          <Modal.Body>
            <div className="flex flex-col gap-3">
              {target?.kind === "save" && (
                <span className={MUTED}>
                  Captures this project's output EQ, limiters, delay and polarity. A multi-way speaker takes one way
                  per output, starting here.
                </span>
              )}
              <div className="grid grid-cols-2 gap-3">
                {field("brand", "Brand", true)}
                {field("model", "Model", true)}
                {field("family", "Family")}
                {field("application", "Application")}
              </div>
              <label className="flex flex-col gap-1">
                <span className={MUTED}>Notes</span>
                <textarea className={FIELD_INPUT} rows={2} value={draft.notes} onChange={(e) => set({ notes: e.currentTarget.value })} />
              </label>
              {target?.kind === "save" && maxWays > 1 && (
                <SimpleSelect
                  label="Ways"
                  data={Array.from({ length: maxWays }, (_, i) => ({
                    value: String(i + 1),
                    label: `${i + 1} — outputs ${rows[target.rowIndex].label}–${rows[target.rowIndex + i].label}`,
                  }))}
                  value={String(draft.wayLabels.length)}
                  onChange={(v) => {
                    const n = Number(v ?? 1);
                    set({ wayLabels: Array.from({ length: n }, (_, i) => draft.wayLabels[i] ?? "") });
                  }}
                />
              )}
              {draft.wayLabels.length > 1 && (
                <div className="grid grid-cols-2 gap-3">
                  {draft.wayLabels.map((label, i) => (
                    <label key={i} className="flex flex-col gap-1">
                      <span className={MUTED}>Way {i + 1}{target?.kind === "save" ? ` (output ${rows[target.rowIndex + i]?.label})` : ""}</span>
                      <input
                        className={FIELD_INPUT}
                        placeholder={i === 0 ? "e.g. Low" : "e.g. High"}
                        value={label}
                        onChange={(e) => {
                          const next = [...draft.wayLabels];
                          next[i] = e.currentTarget.value;
                          set({ wayLabels: next });
                        }}
                      />
                    </label>
                  ))}
                </div>
              )}
              {error && <span className="text-sm text-danger">{error}</span>}
              <div className="flex justify-end gap-2">
                <Button variant="secondary" isDisabled={saving} onPress={onClose}>Cancel</Button>
                <Button
                  variant="primary"
                  isDisabled={saving || !draft.brand.trim() || !draft.model.trim()}
                  onPress={() => void save()}
                >
                  {saving ? <Spinner size="sm" /> : target?.kind === "edit" ? "Save details" : "Save to library"}
                </Button>
              </div>
            </div>
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
