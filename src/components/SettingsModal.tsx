import { useEffect, useState, type ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import {
  Badge,
  Button,
  Divider,
  Group,
  Modal,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  useMantineColorScheme,
} from "@mantine/core";
import { setPreference, usePreference } from "../lib/preferences";

interface SettingsModalProps {
  opened: boolean;
  onClose: () => void;
}

/** A settings chapter: an uppercase dimmed heading over its rows, matching
 * the section-header treatment used throughout the amp editor. */
function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Stack gap="xs">
      <Divider
        label={
          <Text size="xs" fw={700} c="dimmed" tt="uppercase">
            {title}
          </Text>
        }
        labelPosition="left"
      />
      {children}
    </Stack>
  );
}

/** One label + control row. Every setting in this modal is this shape, so
 * the wrapping/spacing is decided once here rather than per row. */
function SettingRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Group justify="space-between" wrap="wrap" gap="xs">
      <Text size="sm">{label}</Text>
      {children}
    </Group>
  );
}

type VersionStatus = "dev" | "checking" | "update-available" | "up-to-date" | "check-failed";

const STATUS_COLOR: Record<VersionStatus, string> = {
  dev: "red",
  checking: "gray",
  "update-available": "orange",
  "up-to-date": "green",
  "check-failed": "gray",
};

export function SettingsModal({ opened, onClose }: SettingsModalProps) {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const [version, setVersion] = useState("");
  const [status, setStatus] = useState<VersionStatus>("checking");
  const [pendingUpdate, setPendingUpdate] = useState<Update | null>(null);
  const [installing, setInstalling] = useState(false);
  const autoUpdateChecks = usePreference("autoUpdateChecks");
  const showFingerprintMenu = usePreference("showFingerprintMenu");
  const showRawTelemetry = usePreference("showRawTelemetry");

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
    <Modal opened={opened} onClose={onClose} title="App Settings" centered>
      <Stack gap="lg">
        <SettingsSection title="Appearance">
          <SettingRow label="Color mode">
            <SegmentedControl
              size="xs"
              value={colorScheme}
              onChange={(value) => setColorScheme(value as "light" | "dark" | "auto")}
              data={[
                { label: "Light", value: "light" },
                { label: "Dark", value: "dark" },
                { label: "Auto", value: "auto" },
              ]}
            />
          </SettingRow>
        </SettingsSection>

        {/* Two developer-facing surfaces in the amp editor, off by default so
         * an ordinary operator never meets them. Both read live: toggling one
         * updates an editor that is already open. */}
        <SettingsSection title="Amp Edit">
          <SettingRow label="Show Fingerprint Menu">
            <Switch
              checked={showFingerprintMenu}
              onChange={(e) =>
                setPreference("showFingerprintMenu", e.currentTarget.checked)
              }
            />
          </SettingRow>

          <SettingRow label="Show Raw Telemetry">
            <Switch
              checked={showRawTelemetry}
              onChange={(e) =>
                setPreference("showRawTelemetry", e.currentTarget.checked)
              }
            />
          </SettingRow>
        </SettingsSection>

        <SettingsSection title="Updates">
          <SettingRow label="Check for updates on startup">
            <Switch
              checked={autoUpdateChecks}
              onChange={(e) =>
                setPreference("autoUpdateChecks", e.currentTarget.checked)
              }
            />
          </SettingRow>

          <SettingRow label="Version">
            <Group gap="xs" wrap="wrap">
              <Badge color={STATUS_COLOR[status]} variant="light">
                {version ? `${version} — ${statusLabel}` : statusLabel}
              </Badge>
              {status === "update-available" && (
                <Button size="xs" loading={installing} onClick={handleInstallUpdate}>
                  Update now
                </Button>
              )}
            </Group>
          </SettingRow>
        </SettingsSection>
      </Stack>
    </Modal>
  );
}
