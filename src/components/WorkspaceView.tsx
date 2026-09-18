import { useMemo, useState } from "react";
import { Button, Chip, Input, Label, Modal, Spinner, TextField, Tooltip } from "@heroui/react";
import { Link, Pencil, Server, X } from "lucide-react";
import { AmpCatalogueModal } from "./AmpCatalogueModal";
import { AmpLinkModal } from "./AmpLinkModal";
import { SimpleSelect } from "./SimpleSelect";
import { commands, type AmpAssignment, type AmpModelCatalogEntry, type Project } from "../lib/bindings";
import { firmwareOptionsFor } from "../lib/firmwareOptions";
import { useIsCompact } from "../lib/breakpoints";
import { AMP_LINK_STATUS_META, ampLinkStatus } from "../lib/ampLinkStatus";
import { useLiveDevices } from "../hooks/useLiveDevices";
import { useLiveDriver } from "../hooks/useLiveDriver";

/** Neutral amp-card controls (edit, link): gray with a white icon in dark mode,
 * light gray with a black icon in light mode. Delete keeps the destructive red. */
const CARD_CONTROL_CLASS =
  "bg-[var(--amp-color-gray-3)] text-black hover:bg-[var(--amp-color-gray-4)] " +
  "dark:bg-[var(--amp-color-gray-7)] dark:text-white dark:hover:bg-[var(--amp-color-gray-6)]";

/** Card controls fade in on hover so the grid stays calm at rest. Hover is
 * not a thing on touch, though, and these are the *only* way to edit, delete
 * or link an amp — so they also reveal on keyboard focus, and stay visible
 * outright on any pointer that can't hover. `(hover: none)` is a pointer
 * *capability* query, not a width breakpoint, so it doesn't belong in
 * `lib/breakpoints.ts`. */
const CARD_CONTROL_REVEAL =
  "opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 " +
  "focus-visible:opacity-100 [@media(hover:none)]:opacity-100";

/** Side of the square amp tile. The name/model labels below it are clamped to
 * the same width, so they have to track this number. */
const TILE_SIZE = 90;

interface WorkspaceViewProps {
  project: Project;
  onProjectUpdate: (project: Project) => void;
  ampModels: AmpModelCatalogEntry[] | null;
  onOpenDevice: (assignment: AmpAssignment) => void;
}

export function WorkspaceView({ project, onProjectUpdate, ampModels, onOpenDevice }: WorkspaceViewProps) {
  const compact = useIsCompact();
  const [catalogueOpen, setCatalogueOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AmpAssignment | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [editTarget, setEditTarget] = useState<AmpAssignment | null>(null);
  const [editDeviceName, setEditDeviceName] = useState("");
  const [editFirmwareVersion, setEditFirmwareVersion] = useState<string | null>(null);
  const [savingDeviceName, setSavingDeviceName] = useState(false);
  const [deviceNameError, setDeviceNameError] = useState<string | null>(null);
  // By id, so the modal sees the updated assignment (new MAC) after Assign/Unlink.
  const [linkTargetId, setLinkTargetId] = useState<string | null>(null);

  // Status dots need discovery running whenever the project workspace is open.
  useLiveDriver();
  const { devices, ready: devicesReady } = useLiveDevices();

  const modelsById = useMemo(() => {
    const map = new Map<string, AmpModelCatalogEntry>();
    for (const model of ampModels ?? []) {
      map.set(model.id, model);
    }
    return map;
  }, [ampModels]);

  if (ampModels === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size="sm" />
      </div>
    );
  }

  const assignments = project.ampAssignments;
  const selectedAssignment = assignments.find((a) => a.id === selectedId) ?? null;
  const linkTarget = assignments.find((a) => a.id === linkTargetId) ?? null;

  function modelNameFor(assignment: AmpAssignment) {
    const model = assignment.ampModelId ? modelsById.get(assignment.ampModelId) : undefined;
    return model ? `${model.brand} ${model.model}` : null;
  }

  function nameFor(assignment: AmpAssignment) {
    return assignment.deviceName ?? modelNameFor(assignment) ?? "Unnamed";
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    const result = await commands.projectsRemoveAmpAssignment(project.id, deleteTarget.id);
    setDeleting(false);
    if (result.status === "ok") {
      onProjectUpdate(result.data);
      if (selectedId === deleteTarget.id) setSelectedId(null);
      setDeleteTarget(null);
    }
  }

  async function handleSaveDeviceName() {
    if (!editTarget) return;
    setDeviceNameError(null);
    setSavingDeviceName(true);
    const result = await commands.projectsUpdate({
      ...project,
      ampAssignments: project.ampAssignments.map((a) =>
        a.id === editTarget.id
          ? { ...a, deviceName: editDeviceName.trim() || null, firmwareVersion: editFirmwareVersion }
          : a,
      ),
    });
    setSavingDeviceName(false);
    if (result.status === "ok") {
      onProjectUpdate(result.data);
      setEditTarget(null);
    } else {
      setDeviceNameError(result.error.message);
    }
  }

  const editModel = editTarget?.ampModelId ? modelsById.get(editTarget.ampModelId) : undefined;
  const editFirmwareOptions = firmwareOptionsFor(editModel?.protocol);

  return (
    <div
      className={`flex h-full min-h-0 min-w-0 ${
        // Two side-by-side panes below ~900px would leave the Amplifiers
        // grid too narrow for even one tile row, so they stack and the page
        // scrolls instead.
        compact ? "flex-col overflow-y-auto" : "flex-row items-stretch"
      }`}
    >
      {/* Amplifiers pane */}
      <div
        className="flex min-w-0 shrink-0 flex-col gap-3 p-4"
        style={{ width: compact ? "100%" : 340, height: compact ? undefined : "100%" }}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span style={{ fontWeight: 500, fontSize: "var(--amp-font-size-sm)", color: "var(--amp-color-dimmed)" }}>
            Amplifiers
          </span>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              isDisabled={!selectedAssignment}
              onPress={() => selectedAssignment && onOpenDevice(selectedAssignment)}
            >
              Configure
            </Button>
            <Button size="sm" variant="primary" onPress={() => setCatalogueOpen(true)}>
              Add Amp
            </Button>
          </div>
        </div>

        {assignments.length === 0 ? (
          <div className="flex flex-1 items-center justify-center">
            <span style={{ color: "var(--amp-color-dimmed)", fontSize: "var(--amp-font-size-sm)", textAlign: "center" }}>
              No amps assigned yet — add one to get started.
            </span>
          </div>
        ) : (
          <div
            className="grid flex-1 content-start gap-3"
            style={{ gridTemplateColumns: `repeat(${compact ? 5 : 3}, minmax(0, 1fr))` }}
          >
            {assignments.map((assignment) => {
              const displayName = nameFor(assignment);
              const modelName = assignment.deviceName ? modelNameFor(assignment) : null;
              const isSelected = assignment.id === selectedId;
              const model = assignment.ampModelId ? modelsById.get(assignment.ampModelId) : undefined;
              const isCvr = model?.brand === "CVR";
              const linkStatus = AMP_LINK_STATUS_META[ampLinkStatus(assignment, devices)];

              return (
                <div key={assignment.id} className="group flex flex-col items-center gap-1.5">
                  {/* The size lives on the *positioning context*, not just the
                   * tile: the corner controls anchor to `bottom-0`, and
                   * `Tooltip.Trigger` renders a real in-flow `inline-block`
                   * `<div>` (see the dot below), whose line-box strut would
                   * otherwise make this wrapper ~20px taller than the tile and
                   * drop every bottom-anchored control below the border. */}
                  <div className="relative" style={{ width: TILE_SIZE, height: TILE_SIZE }}>
                    <div
                      onClick={() => setSelectedId(assignment.id)}
                      className={`flex h-full w-full cursor-pointer items-center justify-center border-solid transition-colors duration-150 group-hover:border-[var(--accent)] group-hover:bg-[var(--accent-soft)] ${
                        isSelected
                          ? "border-2 border-[var(--accent)]"
                          : "border border-[var(--amp-color-default-border)]"
                      }`}
                      style={{ borderRadius: "var(--radius-xl)" }}
                    >
                      {isCvr ? (
                        <img
                          src="/cvr_dsp_amp.png"
                          alt="CVR amp"
                          className="max-h-full max-w-full object-contain"
                        />
                      ) : (
                        <div
                          className="flex items-center justify-center rounded-full"
                          style={{
                            width: 48,
                            height: 48,
                            background: "var(--amp-color-gray-light)",
                            color: "var(--amp-color-gray-6)",
                          }}
                        >
                          <Server size={28} />
                        </div>
                      )}
                    </div>
                    {assignment.firmwareVersion && (
                      <Chip
                        size="sm"
                        className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2"
                        style={{ background: "var(--amp-color-dark-6)", color: "white" }}
                      >
                        v{assignment.firmwareVersion}
                      </Chip>
                    )}
                    <Button
                      isIconOnly
                      size="sm"
                      className={`absolute top-0 left-0 -translate-x-1/2 -translate-y-1/2 ${CARD_CONTROL_REVEAL} ${CARD_CONTROL_CLASS}`}
                      style={{ width: 22, height: 22, minWidth: 22 }}
                      onPress={() => {
                        setDeviceNameError(null);
                        setEditDeviceName(assignment.deviceName ?? "");
                        setEditFirmwareVersion(assignment.firmwareVersion ?? null);
                        setEditTarget(assignment);
                      }}
                      aria-label="Edit amp"
                    >
                      <Pencil size={12} />
                    </Button>
                    <Button
                      isIconOnly
                      size="sm"
                      variant="danger"
                      className={`absolute top-0 right-0 translate-x-1/2 -translate-y-1/2 ${CARD_CONTROL_REVEAL}`}
                      style={{ width: 22, height: 22, minWidth: 22 }}
                      onPress={() => setDeleteTarget(assignment)}
                      aria-label="Remove amp"
                    >
                      <X size={12} />
                    </Button>
                    <Button
                      isIconOnly
                      size="sm"
                      className={`absolute bottom-0 left-0 -translate-x-1/2 translate-y-1/2 ${CARD_CONTROL_REVEAL} ${CARD_CONTROL_CLASS}`}
                      style={{ width: 22, height: 22, minWidth: 22 }}
                      onPress={() => setLinkTargetId(assignment.id)}
                      aria-label="Link amp"
                    >
                      <Link size={12} />
                    </Button>
                    <Tooltip delay={300}>
                      {/* The dot *is* the trigger. `Tooltip.Trigger` renders its
                       * own `<div role="button">`, so styling that div directly
                       * beats nesting a span inside it: one element, and being
                       * absolute makes it block-level, so it leaves no line box
                       * in the wrapper above. */}
                      <Tooltip.Trigger
                        aria-label={linkStatus.label}
                        className="absolute right-0 bottom-0 size-3 translate-x-1/2 translate-y-1/2 rounded-full border-2 border-solid border-[var(--amp-color-body)]"
                        style={{ backgroundColor: `var(--amp-color-${linkStatus.color}-filled)` }}
                      />
                      <Tooltip.Content showArrow>{linkStatus.label}</Tooltip.Content>
                    </Tooltip>
                  </div>
                  <div className="flex flex-col items-center gap-px">
                    <span
                      className="line-clamp-2 text-center"
                      style={{ maxWidth: TILE_SIZE, fontSize: "var(--amp-font-size-xs)" }}
                    >
                      {displayName}
                    </span>
                    {modelName && (
                      <span
                        className="line-clamp-1 text-center"
                        style={{ maxWidth: TILE_SIZE, fontSize: 10, color: "var(--amp-color-dimmed)" }}
                      >
                        {modelName}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <hr
        className={
          compact
            ? "m-0 w-full border-t border-[var(--amp-color-default-border)]"
            : "m-0 h-full border-l border-t-0 border-[var(--amp-color-default-border)]"
        }
      />

      {/* Speakers pane — mock only, no real data/functionality yet */}
      <div
        className="flex min-w-0 flex-1 flex-col gap-3 p-4"
        style={{ height: compact ? undefined : "100%", minHeight: compact ? 140 : undefined }}
      >
        <span style={{ fontWeight: 500, fontSize: "var(--amp-font-size-sm)", color: "var(--amp-color-dimmed)" }}>
          Speakers
        </span>
        <div className="flex flex-1 items-center justify-center">
          <span style={{ color: "var(--amp-color-dimmed)", textAlign: "center" }}>
            Speaker assignment — coming soon
          </span>
        </div>
      </div>

      <AmpCatalogueModal
        opened={catalogueOpen}
        onClose={() => setCatalogueOpen(false)}
        projectId={project.id}
        ampModels={ampModels}
        onProjectUpdate={onProjectUpdate}
      />

      <AmpLinkModal
        project={project}
        assignment={linkTarget}
        displayName={linkTarget ? nameFor(linkTarget) : ""}
        modelName={linkTarget ? modelNameFor(linkTarget) : null}
        devices={devices}
        devicesReady={devicesReady}
        onProjectUpdate={onProjectUpdate}
        onClose={() => setLinkTargetId(null)}
      />

      <Modal.Backdrop isOpen={editTarget !== null} onOpenChange={(open) => !open && setEditTarget(null)}>
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
                  <Input
                    placeholder="Optional"
                    maxLength={32}
                    value={editDeviceName}
                    onChange={(e) => setEditDeviceName(e.target.value)}
                  />
                </TextField>
                {editFirmwareOptions.length > 0 && (
                  <SimpleSelect
                    label="Firmware Version"
                    description="Which parameter ranges/units to plan around — not detected, since there's no live device yet."
                    data={editFirmwareOptions.map((v) => ({ value: v, label: v }))}
                    value={editFirmwareVersion}
                    onChange={setEditFirmwareVersion}
                  />
                )}
                {deviceNameError && (
                  <span style={{ color: "var(--amp-color-red-6)", fontSize: "var(--amp-font-size-sm)" }}>
                    {deviceNameError}
                  </span>
                )}
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" onPress={() => setEditTarget(null)} isDisabled={savingDeviceName}>
                    Cancel
                  </Button>
                  <Button variant="primary" onPress={handleSaveDeviceName} isDisabled={savingDeviceName}>
                    {savingDeviceName ? <Spinner size="sm" /> : "Save"}
                  </Button>
                </div>
              </div>
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>

      <Modal.Backdrop isOpen={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <Modal.Container placement="center" size="sm">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>Remove Amp</Modal.Heading>
              <Modal.CloseTrigger />
            </Modal.Header>
            <Modal.Body>
              <div className="flex flex-col gap-3">
                <span style={{ fontSize: "var(--amp-font-size-sm)" }}>
                  Remove {deleteTarget ? nameFor(deleteTarget) : ""} from this project? This can't be undone.
                </span>
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" onPress={() => setDeleteTarget(null)} isDisabled={deleting}>
                    Cancel
                  </Button>
                  <Button variant="danger" onPress={handleConfirmDelete} isDisabled={deleting}>
                    {deleting ? <Spinner size="sm" /> : "Remove"}
                  </Button>
                </div>
              </div>
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </div>
  );
}
