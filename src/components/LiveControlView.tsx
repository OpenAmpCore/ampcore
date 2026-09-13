import { useEffect, useState } from "react";
import { Badge, Card, Center, Divider, Group, Loader, ScrollArea, SegmentedControl, Select, Stack, Text } from "@mantine/core";
import { AmpConfigureView } from "./AmpConfigureView";
import { DeviceTelemetryPanel } from "./DeviceTelemetryPanel";
import { useLiveChannelConfig } from "../hooks/useLiveChannelConfig";
import { useLiveDevices } from "../hooks/useLiveDevices";
import { useLiveDriver } from "../hooks/useLiveDriver";
import { useLivePolling } from "../hooks/useLivePolling";
import { useLiveTelemetry } from "../hooks/useLiveTelemetry";
import { commands, type AmpModelCatalogEntry, type DiscoveredDevice } from "../lib/bindings";
import { useIsCompact } from "../lib/breakpoints";
import { usePreference } from "../lib/preferences";

/** Resolves which catalog `AmpModelCatalogEntry` a live device should be
 * configured as — Direct Edit's counterpart to a Project's
 * `AmpAssignment.ampModelId`, but keyed by MAC in a small standalone store
 * (`device_model_links.json`, see `commands/device_links.rs`) rather than
 * tied to any Project. Auto-matches from the device's firmware string on
 * first sight of a device id; a manual pick always wins afterward and is
 * never silently re-matched (see `device_model_link_auto_match`'s own
 * doc comment). */
function useDeviceModelLink(device: DiscoveredDevice | null) {
  const [ampModels, setAmpModels] = useState<AmpModelCatalogEntry[]>([]);
  const [ampModel, setAmpModel] = useState<AmpModelCatalogEntry | null>(null);

  useEffect(() => {
    commands.ampModelsList().then((result) => {
      if (result.status === "ok") setAmpModels(result.data);
    });
  }, []);

  useEffect(() => {
    if (!device) {
      setAmpModel(null);
      return;
    }
    let cancelled = false;
    commands
      .deviceModelLinkAutoMatch(device.mac, device.firmwareVersion, device.digitalInputChannels, device.outputChannels)
      .then((result) => {
        if (cancelled) return;
        setAmpModel(result.status === "ok" ? result.data : null);
      });
    return () => {
      cancelled = true;
    };
    // Re-resolve only when the selected device identity changes, not on
    // every telemetry-driven re-render of the same device.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device?.id]);

  function setManualModel(id: string | null) {
    if (!device) return;
    const picked = id ? (ampModels.find((m) => m.id === id) ?? null) : null;
    commands.deviceModelLinkSet(device.mac, id).then((result) => {
      if (result.status === "ok") setAmpModel(picked);
    });
  }

  return { ampModels, ampModel, setManualModel };
}

export function LiveControlView() {
  const compact = useIsCompact();
  const { devices, ready } = useLiveDevices();
  const telemetryById = useLiveTelemetry();
  const channelConfigById = useLiveChannelConfig();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState("configure");
  const showRawTelemetry = usePreference("showRawTelemetry");
  /** Owned here rather than inside `AmpConfigureView` so the editor's tab
   * survives anything that re-renders this view. */
  const [configureTab, setConfigureTab] = useState<string | null>("input");

  const selectedDevice = devices.find((d) => d.id === selectedId) ?? null;
  // Derived, not stored: turning the setting off while the telemetry panel
  // is open falls back to Configure instead of stranding the user on a view
  // whose switch has just disappeared.
  const effectiveView = showRawTelemetry ? view : "configure";

  // Live Control is one consumer of the shared live connector, not its owner:
  // it starts the driver like any other live-aware view would, and subscribes
  // only the amp being looked at to the heavy polls. Unmounting drops its
  // subscription, so leaving Live Control falls back to discovery-only.
  useLiveDriver();
  useLivePolling(selectedId ? [selectedId] : []);
  const { ampModels, ampModel, setManualModel } = useDeviceModelLink(selectedDevice);

  if (!ready) {
    return (
      <Center h="100%">
        <Loader size="sm" />
      </Center>
    );
  }

  const modelSelect = (
    <Select
      size="xs"
      placeholder="Assign amp model…"
      className="min-w-0"
      style={{ flex: compact ? "1 1 160px" : "0 0 240px" }}
      data={ampModels.filter((m) => !m.archived).map((m) => ({ value: m.id, label: `${m.brand} ${m.model}` }))}
      value={ampModel?.id ?? null}
      onChange={setManualModel}
      clearable
      searchable
    />
  );

  const viewSwitch = (
    <SegmentedControl
      size="xs"
      value={view}
      onChange={setView}
      data={[
        { label: "Configure", value: "configure" },
        { label: "Raw Telemetry", value: "telemetry" },
      ]}
    />
  );

  const deviceContent = selectedDevice ? (
    effectiveView === "telemetry" ? (
      <DeviceTelemetryPanel
        device={selectedDevice}
        telemetry={telemetryById[selectedDevice.id]}
        channelConfig={channelConfigById[selectedDevice.id]}
      />
    ) : (
      <AmpConfigureView
        activeTab={configureTab}
        onActiveTabChange={setConfigureTab}
        source={{
          kind: "live",
          device: selectedDevice,
          channelConfig: channelConfigById[selectedDevice.id],
          telemetry: telemetryById[selectedDevice.id],
          ampModel: ampModel ?? undefined,
        }}
      />
    )
  ) : (
    <Center h="100%" p="md">
      <Text c="dimmed" ta="center">
        {devices.length === 0 ? "Scanning for amplifiers on the network…" : "Select an amp from the list"}
      </Text>
    </Center>
  );

  // One tree for both layouts, branching only on props/classNames. Returning
  // two *different* element trees would make React tear the whole subtree
  // down every time the window crosses the compact boundary — remounting
  // `AmpConfigureView` and resetting its tab, channel selection and
  // capability fetch. Conditional siblings (`{cond && <X/>}`) render `false`
  // but still hold their slot in the children array, so `deviceContent`
  // keeps a stable position in both modes and survives the switch.
  return (
    <div className={`flex h-full min-h-0 min-w-0 ${compact ? "flex-col" : "flex-row"}`}>
      {/* Compact drops the 260px discovery rail — it costs a third of a
          small window — in favour of the Select in the toolbar below. Same
          data, same selection state, only the affordance changes. */}
      {!compact && (
        <>
          <Stack w={260} h="100%" p="md" gap="md" className="shrink-0">
            <Text fw={500} size="sm" c="dimmed">
              Discovered Amps
            </Text>

            {devices.length === 0 ? (
              <Center className="flex-1">
                <Text c="dimmed" size="sm" ta="center">
                  Scanning for amplifiers on the network…
                </Text>
              </Center>
            ) : (
              <ScrollArea className="min-h-0 flex-1">
                <Stack gap="xs">
                  {devices.map((d) => {
                    const isSelected = d.id === selectedId;
                    return (
                      <Card
                        key={d.id}
                        withBorder
                        padding="sm"
                        onClick={() => setSelectedId(d.id)}
                        className={`cursor-pointer${isSelected ? " border-2 border-[var(--mantine-color-amber-filled)]" : ""}`}
                      >
                        <Group justify="space-between" wrap="nowrap" gap="xs">
                          <div className="min-w-0">
                            <Text fw={500} size="sm" truncate>
                              {d.name || d.mac}
                            </Text>
                            <Text size="xs" c="dimmed">
                              {d.ip}
                            </Text>
                          </div>
                          <Badge color={d.online ? "green" : "gray"} variant="light" size="xs">
                            {d.online ? "Online" : "Offline"}
                          </Badge>
                        </Group>
                      </Card>
                    );
                  })}
                </Stack>
              </ScrollArea>
            )}
          </Stack>
          <Divider orientation="vertical" />
        </>
      )}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Rendered whenever it has something in it: the device picker in
            compact, the view/model controls once an amp is selected. */}
        {(compact || selectedDevice) && (
          <>
            <Group
              px={compact ? "sm" : "md"}
              py="xs"
              gap="xs"
              wrap="wrap"
              align="center"
              justify={compact ? undefined : "space-between"}
            >
              {compact && (
                <Select
                  size="xs"
                  className="min-w-0"
                  style={{ flex: "1 1 160px" }}
                  placeholder={devices.length === 0 ? "Scanning…" : "Discovered amps…"}
                  data={devices.map((d) => ({
                    value: d.id,
                    label: `${d.name || d.mac}${d.online ? "" : " (offline)"}`,
                  }))}
                  value={selectedId}
                  onChange={setSelectedId}
                  searchable
                />
              )}
              {selectedDevice && showRawTelemetry && viewSwitch}
              {selectedDevice && modelSelect}
            </Group>
            <Divider />
          </>
        )}
        <div className="min-h-0 min-w-0 flex-1 overflow-auto">{deviceContent}</div>
      </div>
    </div>
  );
}
