import { useEffect, useState } from "react";
import { Button, ButtonGroup, Card, Chip, Drawer, Spinner } from "@heroui/react";
import { Menu } from "lucide-react";
import { AmpConfigureView } from "./AmpConfigureView";
import { SimpleSelect } from "./SimpleSelect";
import { DeviceTelemetryPanel } from "./DeviceTelemetryPanel";
import { Hint } from "./Hint";
import { ScanStatus } from "./ScanStatus";
import { useLiveDevices } from "../hooks/useLiveDevices";
import { useLiveDriver } from "../hooks/useLiveDriver";
import { useLivePolling } from "../hooks/useLivePolling";
import { useScanTimeout } from "../hooks/useScanTimeout";
import { useLiveChannelConfig, useLiveTelemetry } from "../hooks/useLiveMap";
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
  // One timer for every "nothing found" spot below — rail, main pane and the
  // compact select — so they can never disagree about whether we gave up.
  const scan = useScanTimeout(ready && devices.length === 0);
  const telemetryById = useLiveTelemetry();
  const channelConfigById = useLiveChannelConfig();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState("configure");
  const showRawTelemetry = usePreference("showRawTelemetry");
  /** Owned here rather than inside `AmpConfigureView` so the editor's tab
   * survives anything that re-renders this view. */
  const [configureTab, setConfigureTab] = useState<string | null>("overview");
  const [drawerOpen, setDrawerOpen] = useState(false);

  const selectedDevice = devices.find((d) => d.id === selectedId) ?? null;
  const firstDeviceId = devices[0]?.id ?? null;

  // Opens the first amp found, and falls back to it if the selected one leaves
  // the list. A manual pick is never overridden while that amp is still listed.
  useEffect(() => {
    if (!selectedDevice && firstDeviceId) setSelectedId(firstDeviceId);
  }, [selectedDevice, firstDeviceId]);

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
      <div className="flex h-full items-center justify-center">
        <Spinner size="sm" />
      </div>
    );
  }

  const modelSelect = (
    <SimpleSelect
      placeholder="Assign amp model…"
      className="min-w-0"
      style={{ flex: compact ? "1 1 160px" : "0 0 240px" }}
      data={ampModels.filter((m) => !m.archived).map((m) => ({ value: m.id, label: `${m.brand} ${m.model}` }))}
      value={ampModel?.id ?? null}
      onChange={setManualModel}
      clearable
    />
  );

  const viewSwitch = (
    <ButtonGroup size="sm">
      <Button variant={view === "configure" ? "primary" : "ghost"} onPress={() => setView("configure")}>
        Configure
      </Button>
      <Button variant={view === "telemetry" ? "primary" : "ghost"} onPress={() => setView("telemetry")}>
        Raw Telemetry
      </Button>
    </ButtonGroup>
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
    <div className="flex h-full items-center justify-center p-4">
      <ScanStatus
        timedOut={scan.timedOut}
        scanning={<span style={{ color: "var(--amp-color-dimmed)" }}>Scanning for amplifiers on the network…</span>}
        onScanAgain={scan.scanAgain}
      />
    </div>
  );

  // The same list in the wide rail and the compact drawer.
  const deviceList = (
    <>
      <span style={{ fontWeight: 500, fontSize: "var(--amp-font-size-sm)", color: "var(--amp-color-dimmed)" }}>
        Discovered Amps
      </span>

      {devices.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          {/* Text only: Scan again lives in the main pane right beside it. */}
          <span style={{ color: "var(--amp-color-dimmed)", fontSize: "var(--amp-font-size-sm)", textAlign: "center" }}>
            {scan.timedOut ? "No amps found" : "Scanning for amplifiers on the network…"}
          </span>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col gap-2">
            {devices.map((d) => {
              const isSelected = d.id === selectedId;
              return (
                <Card
                  key={d.id}
                  onClick={() => {
                    setSelectedId(d.id);
                    setDrawerOpen(false);
                  }}
                  className={`cursor-pointer p-[var(--amp-spacing-sm)]${isSelected ? " border-2 border-[var(--accent)]" : ""}`}
                >
                  <div className="flex flex-nowrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate" style={{ fontWeight: 500, fontSize: "var(--amp-font-size-sm)" }}>
                        {d.name || d.mac}
                      </div>
                      <div style={{ fontSize: "var(--amp-font-size-xs)", color: "var(--amp-color-dimmed)" }}>
                        {d.ip}
                      </div>
                    </div>
                    <Chip size="sm" color={d.online ? "success" : "default"}>
                      {d.online ? "Online" : "Offline"}
                    </Chip>
                  </div>
                </Card>
              );
            })}
          </div>
        </div>
      )}
    </>
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
          small window — in favour of the same list in a drawer, opened from
          the toolbar below. Same data, same selection state. */}
      {!compact && (
        <>
          <div className="flex h-full w-[260px] shrink-0 flex-col gap-3 p-4">{deviceList}</div>
          <hr className="m-0 h-full border-l border-t-0 border-[var(--amp-color-default-border)]" />
        </>
      )}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Rendered whenever it has something in it: the device picker in
            compact, the view/model controls once an amp is selected. */}
        {(compact || selectedDevice) && (
          <>
            <div
              className={`flex flex-wrap items-center gap-2 py-2 ${compact ? "px-3" : "px-4"} ${
                compact ? "" : "justify-between"
              }`}
            >
              {compact && (
                <div className="flex min-w-0 items-center gap-2" style={{ flex: "1 1 160px" }}>
                  <Hint text="Amps" className="shrink-0">
                    <Button isIconOnly size="sm" variant="ghost" aria-label="Show amps" onPress={() => setDrawerOpen(true)}>
                      <Menu size={18} />
                    </Button>
                  </Hint>
                  {selectedDevice ? (
                    <>
                      <span
                        className="block shrink-0 rounded-full"
                        style={{
                          width: 8,
                          height: 8,
                          background: selectedDevice.online ? "var(--amp-color-green-5)" : "var(--amp-color-gray-5)",
                        }}
                      />
                      <span className="min-w-0 truncate" style={{ fontWeight: 500, fontSize: "var(--amp-font-size-sm)" }}>
                        {selectedDevice.name || selectedDevice.mac}
                      </span>
                    </>
                  ) : (
                    <span style={{ color: "var(--amp-color-dimmed)", fontSize: "var(--amp-font-size-sm)" }}>
                      {scan.timedOut ? "No amps found" : "Scanning…"}
                    </span>
                  )}
                </div>
              )}
              {selectedDevice && showRawTelemetry && viewSwitch}
              {selectedDevice && modelSelect}
            </div>
            <hr className="m-0 border-t border-[var(--amp-color-default-border)]" />
          </>
        )}
        <div className="min-h-0 min-w-0 flex-1 overflow-auto">{deviceContent}</div>
      </div>

      {compact && (
        <Drawer.Backdrop isOpen={drawerOpen} onOpenChange={setDrawerOpen}>
          <Drawer.Content placement="left">
            <Drawer.Dialog aria-label="Discovered amps">
              <Drawer.Body className="flex h-full flex-col gap-3">{deviceList}</Drawer.Body>
            </Drawer.Dialog>
          </Drawer.Content>
        </Drawer.Backdrop>
      )}
    </div>
  );
}
