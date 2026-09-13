import { useMemo, useState } from "react";
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Center,
  Divider,
  Group,
  Loader,
  Modal,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Tooltip,
} from "@mantine/core";
import { Link, Pencil, Server, X } from "lucide-react";
import { AmpCatalogueModal } from "./AmpCatalogueModal";
import { AmpLinkModal } from "./AmpLinkModal";
import { commands, type AmpAssignment, type AmpModelCatalogEntry, type Project } from "../lib/bindings";
import { firmwareOptionsFor } from "../lib/firmwareOptions";
import { useIsCompact } from "../lib/breakpoints";
import { AMP_LINK_STATUS_META, ampLinkStatus } from "../lib/ampLinkStatus";
import { useLiveDevices } from "../hooks/useLiveDevices";
import { useLiveDriver } from "../hooks/useLiveDriver";

/** Neutral amp-card controls (edit, link): gray with a white icon in dark mode,
 * light gray with a black icon in light mode. Delete keeps Mantine's red. */
const CARD_CONTROL_CLASS =
  "bg-[var(--mantine-color-gray-3)] text-black hover:bg-[var(--mantine-color-gray-4)] " +
  "dark:bg-[var(--mantine-color-gray-7)] dark:text-white dark:hover:bg-[var(--mantine-color-gray-6)]";

/** Card controls fade in on hover so the grid stays calm at rest. Hover is
 * not a thing on touch, though, and these are the *only* way to edit, delete
 * or link an amp — so they also reveal on keyboard focus, and stay visible
 * outright on any pointer that can't hover. `(hover: none)` is a pointer
 * *capability* query, not a width breakpoint, so it doesn't belong in
 * `lib/breakpoints.ts`. */
const CARD_CONTROL_REVEAL =
  "opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 " +
  "focus-visible:opacity-100 [@media(hover:none)]:opacity-100";

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
  const [editLabel, setEditLabel] = useState("");
  const [editFirmwareVersion, setEditFirmwareVersion] = useState<string | null>(null);
  const [savingLabel, setSavingLabel] = useState(false);
  const [labelError, setLabelError] = useState<string | null>(null);
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
      <Center h="100%">
        <Loader size="sm" />
      </Center>
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
    return assignment.label ?? modelNameFor(assignment) ?? "Unnamed";
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

  async function handleSaveLabel() {
    if (!editTarget) return;
    setLabelError(null);
    setSavingLabel(true);
    const result = await commands.projectsUpdate({
      ...project,
      ampAssignments: project.ampAssignments.map((a) =>
        a.id === editTarget.id
          ? { ...a, label: editLabel.trim() || null, firmwareVersion: editFirmwareVersion }
          : a,
      ),
    });
    setSavingLabel(false);
    if (result.status === "ok") {
      onProjectUpdate(result.data);
      setEditTarget(null);
    } else {
      setLabelError(result.error.message);
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
      <Stack
        w={compact ? "100%" : 340}
        h={compact ? undefined : "100%"}
        p="md"
        gap="md"
        className="min-w-0 shrink-0"
      >
        <Group justify="space-between" wrap="wrap" gap="xs">
          <Text fw={500} size="sm" c="dimmed">
            Amplifiers
          </Text>
          <Group gap="xs">
            <Button
              size="xs"
              variant="default"
              disabled={!selectedAssignment}
              onClick={() => selectedAssignment && onOpenDevice(selectedAssignment)}
            >
              Configure
            </Button>
            <Button size="xs" onClick={() => setCatalogueOpen(true)}>
              Add Amp
            </Button>
          </Group>
        </Group>

        {assignments.length === 0 ? (
          <Center className="flex-1">
            <Text c="dimmed" size="sm" ta="center">
              No amps assigned yet — add one to get started.
            </Text>
          </Center>
        ) : (
          <SimpleGrid cols={compact ? { base: 3, xs: 5, sm: 6 } : 3} spacing="md" className="flex-1 content-start">
            {assignments.map((assignment) => {
              const displayName = nameFor(assignment);
              const modelName = assignment.label ? modelNameFor(assignment) : null;
              const isSelected = assignment.id === selectedId;
              const model = assignment.ampModelId ? modelsById.get(assignment.ampModelId) : undefined;
              const isCvr = model?.brand === "CVR";
              const linkStatus = AMP_LINK_STATUS_META[ampLinkStatus(assignment, devices)];

              return (
                <div key={assignment.id} className="group flex flex-col items-center gap-1.5">
                  <Box className="relative">
                    <Box
                      w={90}
                      h={90}
                      onClick={() => setSelectedId(assignment.id)}
                      className={`flex cursor-pointer items-center justify-center rounded-[var(--mantine-radius-sm)] border-solid transition-colors duration-150 group-hover:border-[var(--mantine-color-amber-filled)] group-hover:bg-[var(--mantine-color-amber-light)] ${
                        isSelected
                          ? "border-2 border-[var(--mantine-color-amber-filled)]"
                          : "border border-[var(--mantine-color-default-border)]"
                      }`}
                    >
                      {isCvr ? (
                        <img
                          src="/cvr_dsp_amp.png"
                          alt="CVR amp"
                          className="max-h-full max-w-full object-contain"
                        />
                      ) : (
                        <ThemeIcon variant="light" color="gray" size={48}>
                          <Server size={28} />
                        </ThemeIcon>
                      )}
                    </Box>
                    {assignment.firmwareVersion && (
                      <Badge
                        size="xs"
                        radius="sm"
                        variant="filled"
                        color="dark"
                        className="absolute bottom-1 left-1/2 -translate-x-1/2"
                      >
                        v{assignment.firmwareVersion}
                      </Badge>
                    )}
                    <ActionIcon
                      className={`absolute -top-1.5 -left-1.5 ${CARD_CONTROL_REVEAL} ${CARD_CONTROL_CLASS}`}
                      size="sm"
                      radius="sm"
                      color="gray"
                      variant="filled"
                      onClick={(e) => {
                        e.stopPropagation();
                        setLabelError(null);
                        setEditLabel(assignment.label ?? "");
                        setEditFirmwareVersion(assignment.firmwareVersion ?? null);
                        setEditTarget(assignment);
                      }}
                      aria-label="Edit amp"
                    >
                      <Pencil size={12} />
                    </ActionIcon>
                    <ActionIcon
                      className={`absolute -top-1.5 -right-1.5 ${CARD_CONTROL_REVEAL}`}
                      size="sm"
                      radius="sm"
                      color="red"
                      variant="filled"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteTarget(assignment);
                      }}
                      aria-label="Remove amp"
                    >
                      <X size={12} />
                    </ActionIcon>
                    <ActionIcon
                      className={`absolute -bottom-1.5 -left-1.5 ${CARD_CONTROL_REVEAL} ${CARD_CONTROL_CLASS}`}
                      size="sm"
                      radius="sm"
                      color="gray"
                      variant="filled"
                      onClick={(e) => {
                        e.stopPropagation();
                        setLinkTargetId(assignment.id);
                      }}
                      aria-label="Link amp"
                    >
                      <Link size={12} />
                    </ActionIcon>
                    <Tooltip label={linkStatus.label} withArrow openDelay={300}>
                      <span
                        role="img"
                        aria-label={linkStatus.label}
                        className="absolute -right-1 -bottom-1 size-3 rounded-full border-2 border-solid border-[var(--mantine-color-body)]"
                        style={{ backgroundColor: `var(--mantine-color-${linkStatus.color}-filled)` }}
                      />
                    </Tooltip>
                  </Box>
                  <div className="flex flex-col items-center gap-px">
                    <Text size="xs" ta="center" lineClamp={2} className="max-w-[90px]">
                      {displayName}
                    </Text>
                    {modelName && (
                      <Text size="xs" c="dimmed" ta="center" lineClamp={1} fz={10} className="max-w-[90px]">
                        {modelName}
                      </Text>
                    )}
                  </div>
                </div>
              );
            })}
          </SimpleGrid>
        )}
      </Stack>

      <Divider orientation={compact ? "horizontal" : "vertical"} />

      {/* Speakers pane — mock only, no real data/functionality yet */}
      <Stack className="min-w-0 flex-1" h={compact ? undefined : "100%"} mih={compact ? 140 : undefined} p="md" gap="md">
        <Text fw={500} size="sm" c="dimmed">
          Speakers
        </Text>
        <Center className="flex-1">
          <Text c="dimmed" ta="center">
            Speaker assignment — coming soon
          </Text>
        </Center>
      </Stack>

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

      <Modal opened={editTarget !== null} onClose={() => setEditTarget(null)} title="Edit Amp" centered size="sm">
        <Stack gap="md">
          <TextInput
            label="Label"
            placeholder="Optional"
            value={editLabel}
            onChange={(e) => setEditLabel(e.currentTarget.value)}
            data-autofocus
          />
          {editFirmwareOptions.length > 0 && (
            <Select
              label="Firmware Version"
              description="Which parameter ranges/units to plan around — not detected, since there's no live device yet."
              data={editFirmwareOptions}
              value={editFirmwareVersion}
              onChange={setEditFirmwareVersion}
              allowDeselect={false}
            />
          )}
          {labelError && (
            <Text c="red" size="sm">
              {labelError}
            </Text>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setEditTarget(null)} disabled={savingLabel}>
              Cancel
            </Button>
            <Button loading={savingLabel} onClick={handleSaveLabel}>
              Save
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Remove Amp"
        centered
        size="sm"
      >
        <Stack gap="md">
          <Text size="sm">
            Remove {deleteTarget ? nameFor(deleteTarget) : ""} from this project? This can't be undone.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button color="red" loading={deleting} onClick={handleConfirmDelete}>
              Remove
            </Button>
          </Group>
        </Stack>
      </Modal>
    </div>
  );
}
