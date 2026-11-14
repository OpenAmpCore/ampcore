import { useEffect, useState, type ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { Button, Chip, Modal, Spinner, Switch, toast } from "@heroui/react";
import { ChevronRight, Copy } from "lucide-react";
import { commands, type NetworkAdapter } from "../lib/bindings";
import { startLiveDriver } from "../hooks/useLiveDriver";
import { setPreference, usePreference } from "../lib/preferences";
import { MultiSelect } from "./MultiSelect";
import { SimpleSelect } from "./SimpleSelect";
import { FIELD_INPUT } from "./fieldClasses";

const PEAK_HOLD_OPTIONS = [
  { value: "input", label: "Input" },
  { value: "output", label: "Output" },
  { value: "limiter", label: "Limiter" },
];

const LIMITER_THRESHOLD_OPTIONS = [
  { value: "output", label: "Output" },
  { value: "limiter", label: "Limiter" },
];

interface SettingsModalProps {
  opened: boolean;
  onClose: () => void;
}

/** A settings chapter: an uppercase dimmed heading over its rows, matching
 * the section-header treatment used throughout the amp editor. */
function SettingsSection({ title, collapsed, children }: { title: string; collapsed?: boolean; children: ReactNode }) {
  const heading = (
    <>
      <span
        style={{
          fontSize: "var(--amp-font-size-xs)",
          fontWeight: 700,
          color: "var(--amp-color-dimmed)",
          textTransform: "uppercase",
        }}
      >
        {title}
      </span>
      <hr className="m-0 flex-1 border-t border-[var(--amp-color-default-border)]" />
    </>
  );
  if (collapsed === undefined) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">{heading}</div>
        {children}
      </div>
    );
  }
  // Starts closed when `collapsed`; the browser keeps it open or shut from there.
  return (
    <details open={!collapsed} className="group">
      {/* A collapsible heading is muted further: it is the way in, not a chapter. */}
      <summary className="flex cursor-pointer list-none items-center gap-2 opacity-60 hover:opacity-100 [&::-webkit-details-marker]:hidden">
        {heading}
        <ChevronRight size={14} className="text-[var(--amp-color-dimmed)] transition-transform group-open:rotate-90" />
      </summary>
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </details>
  );
}

/** One label + control row. Every setting in this modal is this shape, so
 * the wrapping/spacing is decided once here rather than per row.
 *
 * The label is a short name in sentence case ("Peak hold"); anything that
 * explains it goes in `description`, a dimmed line under it. The control
 * never wraps below: a long description wraps inside its column (`min-w-0`). */
function SettingRow({ label, description, children }: { label: string; description?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-10 flex-nowrap items-center justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm">{label}</span>
        {description && <span className="text-xs text-[var(--amp-color-dimmed)]">{description}</span>}
      </div>
      {children}
    </div>
  );
}

/** A setting that is a switch bound to one boolean preference. */
function SwitchRow({ label, description, pref }: { label: string; description?: string; pref: BooleanPreference }) {
  const value = usePreference(pref);
  return (
    <SettingRow label={label} description={description}>
      <Switch aria-label={label} isSelected={value} onChange={(isSelected) => setPreference(pref, isSelected)}>
        <Switch.Content>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
        </Switch.Content>
      </Switch>
    </SettingRow>
  );
}

type BooleanPreference = "outputMeterVolts" | "abbreviateBrands" | "showFingerprintMenu" | "showRawTelemetry" | "showSpeakerComparator" | "autoUpdateChecks";

const ALL_ADAPTERS = "all";

/** Which network adapter the amps are reached through. The driver follows the
 * choice within a discovery cycle (1 s), and only then knows if it could open
 * the port there, hence the wait before asking. A chosen adapter that is gone
 * stays listed, so the setting doesn't silently change while it is unplugged. */
function NetworkAdapterSetting({ opened }: { opened: boolean }) {
  const selected = usePreference("networkAdapter");
  const [adapters, setAdapters] = useState<NetworkAdapter[]>([]);

  useEffect(() => {
    if (!opened) return;
    // A freshly plugged adapter only gets its address some seconds later.
    const refresh = () => void commands.liveControlListAdapters().then(setAdapters);
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [opened]);

  const options = adapters.map((a) => ({ value: a.name, label: `${a.name} (${a.ip})` }));
  if (selected && !adapters.some((a) => a.name === selected)) {
    options.push({ value: selected, label: `${selected} (not connected)` });
  }

  return (
    <SettingRow label="Network adapter" description="Where AmpCore looks for amps.">

      <div className="w-64 min-w-0 shrink">
        <SimpleSelect
          data={[{ value: ALL_ADAPTERS, label: "All adapters" }, ...options]}
          value={selected || ALL_ADAPTERS}
          onChange={(value) => {
            setPreference("networkAdapter", !value || value === ALL_ADAPTERS ? "" : value);
            setTimeout(() => void startLiveDriver(), 1500);
          }}
        />
      </div>
    </SettingRow>
  );
}

/** The built-in web server: its switch, port, and the addresses other devices
 * open. The backend owns the server; this asks it for the wanted state when
 * the modal opens and whenever the switch or port changes, and takes the
 * switch back off if the port can't be used. */
function WebServerSettings({ opened }: { opened: boolean }) {
  const enabled = usePreference("webServerEnabled");
  const port = usePreference("webServerPort");
  const [portDraft, setPortDraft] = useState(String(port));
  const [urls, setUrls] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!opened) return;
    let stale = false;
    void commands.webServerSet(enabled, port).then((r) => {
      if (stale) return;
      setUrls(r.status === "ok" ? r.data : []);
      if (r.status === "ok") return;
      // Stays up after the switch falls back: that re-run succeeds (stopped).
      setError(r.error.message);
      if (enabled) setPreference("webServerEnabled", false);
    });
    return () => {
      stale = true;
    };
  }, [opened, enabled, port]);

  function commitPort() {
    const next = Number(portDraft);
    if (Number.isInteger(next) && next >= 1024 && next <= 65535) setPreference("webServerPort", next);
    else setPortDraft(String(port));
  }

  return (
    <SettingsSection title="Network">
      <NetworkAdapterSetting opened={opened} />
      <SettingRow label="Web server" description="Open AmpCore's page from other devices on this network.">
        <Switch
          isSelected={enabled}
          onChange={(isSelected) => {
            setError(null);
            setPreference("webServerEnabled", isSelected);
          }}
        >
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
          </Switch.Content>
        </Switch>
      </SettingRow>
      <SettingRow label="Port">
        {/* FIELD_INPUT is `w-full`: the width belongs on a wrapper, or the
            input squeezes the label beside it. */}
        <div className="w-24 shrink-0">
          <input
            type="number"
            aria-label="Web server port"
            min={1024}
            max={65535}
            className={`${FIELD_INPUT} [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none`}
            value={portDraft}
            onChange={(e) => setPortDraft(e.currentTarget.value)}
            onBlur={commitPort}
            onKeyDown={(e) => e.key === "Enter" && commitPort()}
          />
        </div>
      </SettingRow>
      {error && <span className="text-sm text-danger">{error}</span>}
      {urls.map((url) => (
        <div key={url} className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-mono text-sm">{url}</span>
          <Button
            size="sm"
            variant="ghost"
            isIconOnly
            aria-label={`Copy ${url}`}
            onPress={() => void navigator.clipboard.writeText(url).then(() => toast.success("Address copied"))}
          >
            <Copy size={14} />
          </Button>
        </div>
      ))}
    </SettingsSection>
  );
}

type VersionStatus ="dev" | "checking" | "update-available" | "up-to-date" | "check-failed";

const STATUS_COLOR: Record<VersionStatus, "danger" | "default" | "warning" | "success"> = {
  dev: "danger",
  checking: "default",
  "update-available": "warning",
  "up-to-date": "success",
  "check-failed": "default",
};

export function SettingsModal({ opened, onClose }: SettingsModalProps) {
  const [version, setVersion] = useState("");
  const [status, setStatus] = useState<VersionStatus>("checking");
  const [pendingUpdate, setPendingUpdate] = useState<Update | null>(null);
  const [installing, setInstalling] = useState(false);
  const peakHoldSurfaces = usePreference("peakHoldSurfaces");
  const limiterThresholdSurfaces = usePreference("limiterThresholdSurfaces");

  useEffect(() => {
    if (!opened) return;

    getVersion().then(setVersion);

    if (import.meta.env.DEV) {
      setStatus("dev");
      return;
    }

    setStatus("checking");
    setPendingUpdate(null);
    check()
      .then((update) => {
        if (update) {
          setPendingUpdate(update);
          setStatus("update-available");
        } else {
          setStatus("up-to-date");
        }
      })
      .catch((e) => {
        console.error("Update check failed", e);
        setStatus("check-failed");
      });
  }, [opened]);

  async function handleInstallUpdate() {
    if (!pendingUpdate) return;
    setInstalling(true);
    try {
      await pendingUpdate.downloadAndInstall();
      await relaunch();
    } catch (e) {
      console.error("Update install failed", e);
      setInstalling(false);
    }
  }

  const statusLabel =
    status === "dev"
      ? "development build"
      : status === "checking"
        ? "checking…"
        : status === "update-available"
          ? `update available: ${pendingUpdate?.version ?? ""}`
          : status === "up-to-date"
            ? "up to date"
            : "check failed";

  return (
    <Modal.Backdrop isOpen={opened} onOpenChange={(open) => !open && onClose()}>
      <Modal.Container placement="center" size="lg">
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Heading>App Settings</Modal.Heading>
            <Modal.CloseTrigger />
          </Modal.Header>
          <Modal.Body>
            <div className="flex flex-col gap-7">
              <SettingsSection title="Speakers">
                <SwitchRow
                  label="Short brand names"
                  description="In the Speakers tab library, e.g. Plansound → PS."
                  pref="abbreviateBrands"
                />
              </SettingsSection>

              <WebServerSettings opened={opened} />

              <SettingsSection title="Meters">
                <SettingRow label="Peak hold" description="Meters that hold their highest reading.">
                  <MultiSelect
                    data={PEAK_HOLD_OPTIONS}
                    values={peakHoldSurfaces}
                    onChange={(values) => setPreference("peakHoldSurfaces", values)}
                  />
                </SettingRow>
                <SettingRow label="Limiter threshold lines" description="Meters that mark where the limiters start.">
                  <MultiSelect
                    data={LIMITER_THRESHOLD_OPTIONS}
                    values={limiterThresholdSurfaces}
                    onChange={(values) => setPreference("limiterThresholdSurfaces", values)}
                  />
                </SettingRow>
                <SwitchRow label="Output meters in volts" description="Instead of dB." pref="outputMeterVolts" />
              </SettingsSection>

              <SettingsSection title="Updates">
                <SwitchRow label="Update dialog at startup" pref="autoUpdateChecks" />

                <SettingRow label="Version">
                  <div className="flex flex-wrap items-center gap-2">
                    <Chip color={STATUS_COLOR[status]}>
                      {version ? `${version} — ${statusLabel}` : statusLabel}
                    </Chip>
                    {status === "update-available" && (
                      <Button size="sm" variant="primary" onPress={handleInstallUpdate} isDisabled={installing}>
                        {installing ? <Spinner size="sm" /> : "Update now"}
                      </Button>
                    )}
                  </div>
                </SettingRow>
              </SettingsSection>

              {/* Developer-facing surfaces, off by default so an ordinary operator
               * never meets them: last, collapsed and muted. All read live:
               * toggling one updates an editor that is already open. */}
              <SettingsSection title="Debug" collapsed>
                <SwitchRow label="Fingerprint menu" pref="showFingerprintMenu" />
                <SwitchRow label="Raw telemetry" pref="showRawTelemetry" />
                <SwitchRow label="Speaker preset comparator" description="Apply shows every value: now, preset, written." pref="showSpeakerComparator" />
              </SettingsSection>
            </div>
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
