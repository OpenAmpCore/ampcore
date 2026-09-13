import { useEffect, useState } from "react";
import { ActionIcon, Box, Stack, Text, ThemeIcon, UnstyledButton } from "@mantine/core";
import { Server, X } from "lucide-react";
import { AmpConfigureView } from "./AmpConfigureView";
import { OperatorView } from "./OperatorView";
import { WorkspaceView } from "./WorkspaceView";
import { useAmpEditLock } from "../hooks/useAmpEditLock";
import { useLinkedSync } from "../hooks/useLinkedSync";
import { useLiveBridge } from "../hooks/useLiveBridge";
import { useLiveChannelConfig } from "../hooks/useLiveChannelConfig";
import { useLiveDevices } from "../hooks/useLiveDevices";
import { useLiveDriver } from "../hooks/useLiveDriver";
import { useLivePolling } from "../hooks/useLivePolling";
import { useLiveTelemetry } from "../hooks/useLiveTelemetry";
import { linkedDeviceFor } from "../lib/ampLinkStatus";
import { commands, type AmpAssignment, type AmpModelCatalogEntry, type Project } from "../lib/bindings";

interface ProjectWorkspaceProps {
  project: Project;
  onProjectUpdate: (project: Project) => void;
  /** Workspace/Operator View selection — owned by `App` since the tab
   * selector itself now renders in the title bar, not here. */
  activeTab: string | null;
  onActiveTabChange: (tab: string | null) => void;
}

const deviceTabValue = (assignmentId: string) => `device:${assignmentId}`;

export function ProjectWorkspace({ project, onProjectUpdate, activeTab, onActiveTabChange }: ProjectWorkspaceProps) {
  const [openDeviceIds, setOpenDeviceIds] = useState<string[]>([]);
  const [ampModels, setAmpModels] = useState<AmpModelCatalogEntry[] | null>(null);
  /** Configure-tab per open amp. Held here because `AmpConfigureView` is
   * unmounted whenever you switch to another amp or back to the Workspace —
   * keeping the tab in the editor itself would lose it every time. */
  const [configureTabById, setConfigureTabById] = useState<Record<string, string | null>>({});

  useEffect(() => {
    commands.ampModelsList().then((result) => {
      if (result.status === "ok") {
        setAmpModels(result.data);
      }
    });
  }, []);

  function openDevice(assignment: AmpAssignment) {
    setOpenDeviceIds((prev) => (prev.includes(assignment.id) ? prev : [...prev, assignment.id]));
    onActiveTabChange(deviceTabValue(assignment.id));
  }

  function closeDevice(assignmentId: string) {
    setOpenDeviceIds((prev) => prev.filter((id) => id !== assignmentId));
    setConfigureTabById((prev) => {
      if (!(assignmentId in prev)) return prev;
      const next = { ...prev };
      delete next[assignmentId];
      return next;
    });
    if (activeTab === deviceTabValue(assignmentId)) {
      onActiveTabChange("workspace");
    }
  }

  const openAssignments = openDeviceIds
    .map((id) => project.ampAssignments.find((a) => a.id === id))
    .filter((a): a is AmpAssignment => a !== undefined);

  const activeDevice = openAssignments.find((a) => deviceTabValue(a.id) === activeTab) ?? null;

  // A linked, online amp is polled while its editor is open — the edit lock
  // needs its FC=27 settings to fingerprint it.
  useLiveDriver();
  const { devices } = useLiveDevices();
  const linkedDevice = activeDevice ? linkedDeviceFor(activeDevice, devices) : undefined;
  const linkedOnline = linkedDevice?.online ?? false;
  useLivePolling(linkedDevice && linkedOnline ? [linkedDevice.id] : []);
  // Primes FC=50 bridge state for this amp (see `useLiveBridge`): the edit
  // lock can't fingerprint the online amp until every pair is reported, so
  // without this the editor opens locked until the bridge tick catches up.
  useLiveBridge(linkedDevice && linkedOnline ? linkedDevice.id : undefined);
  const editLock = useAmpEditLock(project.id, activeDevice?.id, linkedDevice?.id, linkedOnline);

  // Once the two fingerprints match, the amp takes over as the source of
  // truth: the editor writes to it directly and this project follows it.
  const channelConfigById = useLiveChannelConfig();
  const telemetryById = useLiveTelemetry();
  const { following } = useLinkedSync({
    projectId: project.id,
    assignmentId: activeDevice?.id,
    lock: editLock,
    deviceName: linkedDevice?.name,
    onProjectUpdate,
  });
  const liveThrough =
    following && linkedDevice && linkedOnline
      ? {
          device: linkedDevice,
          channelConfig: channelConfigById[linkedDevice.id],
          telemetry: telemetryById[linkedDevice.id],
        }
      : undefined;

  return (
    <div className="flex h-full flex-col">

      <div className="flex min-h-0 flex-1">
        {/* Vertical device rail — Armonia-style, persists across Workspace/Operator View */}
        {openAssignments.length > 0 && (
          <Stack
            gap={4}
            p={4}
            w={56}
            className="shrink-0 overflow-y-auto border-r border-[var(--mantine-color-default-border)]"
          >
            {openAssignments.map((assignment) => {
              const tabValue = deviceTabValue(assignment.id);
              const isActive = activeTab === tabValue;
              return (
                <Box key={assignment.id} className="relative">
                  <UnstyledButton
                    onClick={() => onActiveTabChange(tabValue)}
                    p={4}
                    className={`w-full rounded-[var(--mantine-radius-sm)] border ${
                      isActive
                        ? "border-[var(--mantine-color-amber-filled)] bg-[var(--mantine-color-amber-light)]"
                        : "border-transparent"
                    }`}
                  >
                    <Stack align="center" gap={2}>
                      <ThemeIcon variant="light" color="gray" size={28}>
                        <Server size={16} />
                      </ThemeIcon>
                      <Text fz={9} ta="center" lineClamp={2} className="max-w-[48px]">
                        {assignment.label ?? "Amp"}
                      </Text>
                    </Stack>
                  </UnstyledButton>
                  <ActionIcon
                    size="xs"
                    variant="filled"
                    color="red"
                    radius="sm"
                    className="absolute -top-1 -right-1"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeDevice(assignment.id);
                    }}
                    aria-label="Close device"
                  >
                    <X size={10} />
                  </ActionIcon>
                </Box>
              );
            })}
          </Stack>
        )}

        <div className="min-h-0 min-w-0 flex-1 overflow-auto">
          {activeTab === "workspace" && (
            <WorkspaceView
              project={project}
              onProjectUpdate={onProjectUpdate}
              ampModels={ampModels}
              onOpenDevice={openDevice}
            />
          )}
          {activeTab === "operator" && <OperatorView />}
          {activeDevice && (
            <AmpConfigureView
              activeTab={configureTabById[activeDevice.id] ?? "input"}
              onActiveTabChange={(tab) =>
                setConfigureTabById((prev) => ({ ...prev, [activeDevice.id]: tab }))
              }
              source={{
                kind: "project",
                project,
                assignment: activeDevice,
                ampModel: activeDevice.ampModelId ? ampModels?.find((m) => m.id === activeDevice.ampModelId) : undefined,
                onProjectUpdate,
                editLock,
                linkedDevice,
                liveThrough,
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
