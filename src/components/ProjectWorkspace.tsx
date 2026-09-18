import { useEffect, useState } from "react";
import { Button } from "@heroui/react";
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
          <div
            className="flex w-14 shrink-0 flex-col gap-1 overflow-y-auto border-r border-[var(--amp-color-default-border)] p-1"
          >
            {openAssignments.map((assignment) => {
              const tabValue = deviceTabValue(assignment.id);
              const isActive = activeTab === tabValue;
              return (
                <div key={assignment.id} className="relative">
                  <button
                    type="button"
                    onClick={() => onActiveTabChange(tabValue)}
                    className={`w-full appearance-none bg-transparent p-1 font-inherit rounded-md border ${
                      isActive
                        ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                        : "border-transparent"
                    }`}
                  >
                    <div className="flex flex-col items-center gap-0.5">
                      <div
                        className="flex items-center justify-center rounded-full"
                        style={{
                          width: 28,
                          height: 28,
                          background: "var(--amp-color-gray-light)",
                          color: "var(--amp-color-gray-6)",
                        }}
                      >
                        <Server size={16} />
                      </div>
                      <span
                        className="line-clamp-2 max-w-[48px] text-center"
                        style={{ fontSize: 9 }}
                      >
                        {assignment.deviceName ?? "Amp"}
                      </span>
                    </div>
                  </button>
                  <Button
                    isIconOnly
                    size="sm"
                    variant="danger"
                    className="absolute -top-1 -right-1"
                    style={{ width: 18, height: 18, minWidth: 18 }}
                    onPress={() => closeDevice(assignment.id)}
                    aria-label="Close device"
                  >
                    <X size={10} />
                  </Button>
                </div>
              );
            })}
          </div>
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
