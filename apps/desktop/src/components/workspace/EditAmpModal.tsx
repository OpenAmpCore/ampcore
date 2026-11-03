import { useEffect, useState } from "react";
import { Button, Input, Label, Modal, Spinner, TextField } from "@heroui/react";
import { SimpleSelect } from "../SimpleSelect";
import { commands, type AmpAssignment, type AmpModelCatalogEntry, type Project } from "../../lib/bindings";
import { firmwareOptionsFor } from "../../lib/firmwareOptions";

/** The Workspace's Edit Amp: a project amp's name and planned firmware. */
export function EditAmpModal({
  projectId,
  assignment,
  model,
  onClose,
  onProjectUpdate,
}: {
  projectId: string;
  /** The amp being edited; `null` closes the dialog. */
  assignment: AmpAssignment | null;
  model: AmpModelCatalogEntry | undefined;
  onClose: () => void;
  onProjectUpdate: (project: Project) => void;
}) {
  const [name, setName] = useState("");
  const [firmware, setFirmware] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Each opening starts from the amp as it is.
  useEffect(() => {
    if (!assignment) return;
    setError(null);
    setName(assignment.deviceName ?? "");
    setFirmware(assignment.firmwareVersion ?? null);
  }, [assignment]);

  async function save() {
    if (!assignment) return;
    setError(null);
    setSaving(true);
    // Through the sync push for a linked, online amp: the name is part of its fingerprint.
    const result = await commands.projectsEditAmp(projectId, assignment.id, name.trim() || null, firmware);
    setSaving(false);
    if (result.status === "ok") {
      onProjectUpdate(result.data);
      onClose();
    } else {
      setError(result.error.message);
    }
  }

  const firmwareOptions = firmwareOptionsFor(model?.protocol);

  return (
    <Modal.Backdrop isOpen={assignment !== null} onOpenChange={(open) => !open && onClose()}>
      <Modal.Container placement="center" size="sm">
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Heading>Edit Amp</Modal.Heading>
            <Modal.CloseTrigger />
          </Modal.Header>
          <Modal.Body>
            <div className="flex flex-col gap-3">
              <TextField autoFocus>
                <Label>Device Name</Label>
                <Input placeholder="Optional" maxLength={32} value={name} onChange={(e) => setName(e.target.value)} />
              </TextField>
              {firmwareOptions.length > 0 && (
                <SimpleSelect
                  label="Firmware Version"
                  description={
                    assignment?.mac
                      ? "Taken from the linked amp."
                      : "Which parameter ranges/units to plan around — not detected, since there's no live device yet."
                  }
                  data={firmwareOptions.map((v) => ({ value: v, label: v }))}
                  value={firmware}
                  onChange={setFirmware}
                  disabled={!!assignment?.mac}
                />
              )}
              {error && (
                <span style={{ color: "var(--amp-color-red-6)", fontSize: "var(--amp-font-size-sm)" }}>{error}</span>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onPress={onClose} isDisabled={saving}>
                  Cancel
                </Button>
                <Button variant="primary" onPress={save} isDisabled={saving}>
                  {saving ? <Spinner size="sm" /> : "Save"}
                </Button>
              </div>
            </div>
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
