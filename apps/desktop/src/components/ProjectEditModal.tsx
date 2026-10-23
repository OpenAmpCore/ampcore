import { useEffect, useState } from "react";
import { Button, Input, Label, Modal, Spinner, TextField, toast } from "@heroui/react";
import { Copy, FileDown } from "lucide-react";
import { commands, type Project } from "../lib/bindings";

interface ProjectEditModalProps {
  project: Project | null;
  onClose: () => void;
  onSaved: (project: Project) => void;
  onDeleted: (id: string) => void;
  onDuplicated: (copy: Project) => void;
}

/** `name` with the characters file systems reject replaced. */
function fileNameFor(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, "-").trim() || "project";
}

export function ProjectEditModal({ project, onClose, onSaved, onDeleted, onDuplicated }: ProjectEditModalProps) {
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

  async function handleDuplicate() {
    if (!project) return;
    setError(null);
    setSubmitting(true);
    const result = await commands.projectsDuplicate(project.id);
    setSubmitting(false);
    if (result.status === "ok") {
      onDuplicated(result.data);
      onClose();
    } else {
      setError(result.error.message);
    }
  }

  /** The project, plus the library speakers and custom amp models it uses,
   * as one file — see `data/exchange.rs`. */
  async function handleExport() {
    if (!project) return;
    setError(null);
    const text = await commands.projectsExport(project.id);
    if (text.status !== "ok") {
      setError(text.error.message);
      return;
    }
    const saved = await commands.saveTextFile(`${fileNameFor(project.name)}.ampcore.json`, text.data, "AmpCore project", ["json"]);
    if (saved.status !== "ok") setError(saved.error.message);
    else if (saved.data) toast.success(`Exported “${project.name}”`);
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
              <div className="flex gap-2">
                <Button variant="secondary" isDisabled={submitting} onPress={handleDuplicate}>
                  <Copy size={14} /> Duplicate
                </Button>
                <Button variant="secondary" isDisabled={submitting} onPress={handleExport}>
                  <FileDown size={14} /> Export…
                </Button>
              </div>
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
