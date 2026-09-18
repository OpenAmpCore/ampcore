import { useEffect, useState, type FormEvent } from "react";
import { Button, Card, Input, Label, Modal, TextArea, TextField } from "@heroui/react";
import { Pencil } from "lucide-react";
import { ProjectEditModal } from "./ProjectEditModal";
import { commands, type Project } from "../lib/bindings";

interface ProjectSelectorProps {
  onSelect: (project: Project) => void;
}

export function ProjectSelector({ onSelect }: ProjectSelectorProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [editingProject, setEditingProject] = useState<Project | null>(null);

  async function loadProjects() {
    setLoading(true);
    const result = await commands.projectsList();
    if (result.status === "ok") {
      setProjects(result.data);
    }
    setLoading(false);
  }

  useEffect(() => {
    loadProjects();
  }, []);

  function resetForm() {
    setName("");
    setDescription("");
    setNameError(null);
    setCreateError(null);
  }

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    if (name.trim().length === 0) {
      setNameError("Name is required");
      return;
    }
    setCreateError(null);
    const result = await commands.projectsCreate(name.trim(), description.trim());
    if (result.status === "ok") {
      setModalOpen(false);
      resetForm();
      onSelect(result.data);
    } else {
      setCreateError(result.error.message);
    }
  }

  return (
    /* Scroll rather than clip once the project list outgrows the window —
     * `Center` alone cuts off both ends of taller-than-viewport content. */
    <div className="h-full overflow-y-auto">
      <div className="flex min-h-full flex-col items-center justify-center p-4">
        <div className="flex w-full flex-col gap-3" style={{ maxWidth: 420 }}>
          <h2 className="m-0 text-center text-2xl font-semibold">Select a Project</h2>

          {!loading && projects.length === 0 && (
            <span style={{ color: "var(--amp-color-dimmed)", textAlign: "center" }}>
              No projects yet — create one to get started.
            </span>
          )}

          <div className="flex flex-col gap-2">
            {projects.map((project) => (
              <Card
                key={project.id}
                onClick={() => onSelect(project)}
                className="group cursor-pointer p-[var(--amp-spacing-sm)]"
              >
                <div className="flex flex-nowrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div style={{ fontWeight: 500 }}>{project.name}</div>
                    {project.description && (
                      <div style={{ fontSize: "var(--amp-font-size-sm)", color: "var(--amp-color-dimmed)" }}>
                        {project.description}
                      </div>
                    )}
                  </div>
                  <Button
                    isIconOnly
                    variant="ghost"
                    // Reveals on hover, on keyboard focus, and always on a
                    // pointer that can't hover — it used to be `invisible`
                    // on anything but hover, which both hid it on touch and
                    // left it sitting there tappable but unseen.
                    className={
                      "opacity-0 transition-opacity group-hover:opacity-100 " +
                      "group-focus-within:opacity-100 focus-visible:opacity-100 " +
                      "[@media(hover:none)]:opacity-100"
                    }
                    onPress={() => setEditingProject(project)}
                    aria-label="Edit project"
                  >
                    <Pencil size={16} />
                  </Button>
                </div>
              </Card>
            ))}
          </div>

          <Button variant="primary" onPress={() => setModalOpen(true)}>
            New Project
          </Button>
        </div>
      </div>

      <Modal.Backdrop
        isOpen={modalOpen}
        onOpenChange={(open) => {
          if (!open) {
            setModalOpen(false);
            setCreateError(null);
          }
        }}
      >
        <Modal.Container placement="center">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>New Project</Modal.Heading>
              <Modal.CloseTrigger />
            </Modal.Header>
            <Modal.Body>
              <form onSubmit={handleCreate}>
                <div className="flex flex-col gap-3">
                  <TextField isRequired isInvalid={nameError !== null} autoFocus>
                    <Label>Name</Label>
                    <Input
                      placeholder="Project name"
                      value={name}
                      onChange={(e) => {
                        setName(e.target.value);
                        setNameError(null);
                      }}
                    />
                    {nameError && (
                      <span style={{ fontSize: "var(--amp-font-size-xs)", color: "var(--amp-color-red-6)" }}>
                        {nameError}
                      </span>
                    )}
                  </TextField>
                  <TextField>
                    <Label>Description</Label>
                    <TextArea
                      placeholder="Optional description"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                    />
                  </TextField>
                  {createError && (
                    <span style={{ color: "var(--amp-color-red-6)", fontSize: "var(--amp-font-size-sm)" }}>
                      {createError}
                    </span>
                  )}
                  <Button type="submit" variant="primary">
                    Create
                  </Button>
                </div>
              </form>
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>

      <ProjectEditModal
        project={editingProject}
        onClose={() => setEditingProject(null)}
        onSaved={(updated) => setProjects((current) => current.map((p) => (p.id === updated.id ? updated : p)))}
        onDeleted={(id) => setProjects((current) => current.filter((p) => p.id !== id))}
      />
    </div>
  );
}
