import { useEffect, useState, type ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { Button, Chip, Modal, Spinner, Switch } from "@heroui/react";
import { setPreference, usePreference } from "../lib/preferences";
import { setListPreference, useListPreference } from "../lib/listPreferences";
import { MultiSelect } from "./MultiSelect";

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
function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
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
      </div>
      {children}
    </div>
  );
}

/** One label + control row. Every setting in this modal is this shape, so
 * the wrapping/spacing is decided once here rather than per row.
 *
 * Never wraps onto two rows — `flex-nowrap` plus the modal's own width (see
 * `Modal.Container`'s `size="lg"`) keep every label/control pair on one
 * line. If the label text itself is too long for its shrunk share of the
 * row, it wraps internally (`min-w-0`) rather than pushing the control onto
 * its own line below. */
function SettingRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-nowrap items-center justify-between gap-2">
      <span className="min-w-0" style={{ fontSize: "var(--amp-font-size-sm)" }}>
        {label}
      </span>
      {children}
    </div>
  );
}

type VersionStatus = "dev" | "checking" | "update-available" | "up-to-date" | "check-failed";

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
  const autoUpdateChecks = usePreference("autoUpdateChecks");
  const showFingerprintMenu = usePreference("showFingerprintMenu");
  const showRawTelemetry = usePreference("showRawTelemetry");
  const peakHoldSurfaces = useListPreference("peakHoldSurfaces");
  const limiterThresholdSurfaces = useListPreference("limiterThresholdSurfaces");

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
            <div className="flex flex-col gap-4">
              <SettingsSection title="General">
                <SettingRow label="Enable peak hold in meters">
                  <MultiSelect
                    data={PEAK_HOLD_OPTIONS}
                    values={peakHoldSurfaces}
                    onChange={(values) => setListPreference("peakHoldSurfaces", values)}
                  />
                </SettingRow>

                <SettingRow label="Enable limiter threshold lines in meters">
                  <MultiSelect
                    data={LIMITER_THRESHOLD_OPTIONS}
                    values={limiterThresholdSurfaces}
                    onChange={(values) => setListPreference("limiterThresholdSurfaces", values)}
                  />
                </SettingRow>
              </SettingsSection>

              {/* Two developer-facing surfaces in the amp editor, off by default so
               * an ordinary operator never meets them. Both read live: toggling one
               * updates an editor that is already open. */}
              <SettingsSection title="Amp Edit">
                <SettingRow label="Show Fingerprint Menu">
                  <Switch
                    isSelected={showFingerprintMenu}
                    onChange={(isSelected) => setPreference("showFingerprintMenu", isSelected)}
                  >
                    <Switch.Content>
                      <Switch.Control>
                        <Switch.Thumb />
                      </Switch.Control>
                    </Switch.Content>
                  </Switch>
                </SettingRow>

                <SettingRow label="Show Raw Telemetry">
                  <Switch
                    isSelected={showRawTelemetry}
                    onChange={(isSelected) => setPreference("showRawTelemetry", isSelected)}
                  >
                    <Switch.Content>
                      <Switch.Control>
                        <Switch.Thumb />
                      </Switch.Control>
                    </Switch.Content>
                  </Switch>
                </SettingRow>
              </SettingsSection>

              <SettingsSection title="Updates">
                <SettingRow label="Check for updates on startup">
                  <Switch
                    isSelected={autoUpdateChecks}
                    onChange={(isSelected) => setPreference("autoUpdateChecks", isSelected)}
                  >
                    <Switch.Content>
                      <Switch.Control>
                        <Switch.Thumb />
                      </Switch.Control>
                    </Switch.Content>
                  </Switch>
                </SettingRow>

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
            </div>
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
