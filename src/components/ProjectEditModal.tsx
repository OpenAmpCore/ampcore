import { useEffect, useState } from "react";
import { Button, Input, Label, Modal, Spinner, TextField } from "@heroui/react";
import { commands, type Project } from "../lib/bindings";

interface ProjectEditModalProps {
  project: Project | null;
  onClose: () => void;
  onSaved: (project: Project) => void;
  onDeleted: (id: string) => void;
}

export function ProjectEditModal({ project, onClose, onSaved, onDeleted }: ProjectEditModalProps) {
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (project) {
      setName(project.name);
      setConfirmingDelete(false);
      setError(null);
    }
  }, [project]);

  async function handleSave() {
    if (!project) return;
    setError(null);
    setSubmitting(true);
    const result = await commands.projectsUpdate({ ...project, name: name.trim() });
    setSubmitting(false);
    if (result.status === "ok") {
      onSaved(result.data);
      onClose();
    } else {
      setError(result.error.message);
    }
  }

  async function handleDelete() {
    if (!project) return;
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setError(null);
    setSubmitting(true);
    const result = await commands.projectsDelete(project.id);
    setSubmitting(false);
    if (result.status === "ok") {
      onDeleted(project.id);
      onClose();
    } else {
      setError(result.error.message);
    }
  }

  return (
    <Modal.Backdrop isOpen={!!project} onOpenChange={(open) => !open && onClose()}>
      <Modal.Container placement="center">
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Heading>Edit Project</Modal.Heading>
            <Modal.CloseTrigger />
          </Modal.Header>
          <Modal.Body>
            <div className="flex flex-col gap-3">
              <TextField isRequired autoFocus>
                <Label>Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </TextField>
              {error && (
                <span style={{ color: "var(--amp-color-red-6)", fontSize: "var(--amp-font-size-sm)" }}>
                  {error}
                </span>
              )}
              <div className="flex items-center justify-between">
                <Button
                  variant={confirmingDelete ? "danger" : "danger-soft"}
                  onPress={handleDelete}
                  isDisabled={submitting}
                >
                  {confirmingDelete ? "Confirm Delete" : "Delete"}
                </Button>
                <Button variant="primary" isDisabled={!name.trim() || submitting} onPress={handleSave}>
                  {submitting ? <Spinner size="sm" /> : "Save"}
                </Button>
              </div>
            </div>
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
