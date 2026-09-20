import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Alert, AppShell, Group, Loader, Tabs, Text } from "@mantine/core";
import { go, useAmpLive, type Device, type Tab, type Write } from "./lib";
import { Inputs, Outputs, Overview, Presets } from "./sections";

/** One amp: polls it while mounted (App keys this by amp id, so switching amps
 * re-subscribes) and shows only what is useful right now:
 *  - offline → banner, controls read-only
 *  - in standby → Overview only (state + Standby switch); other tabs say so
 *  - Presets tab only when core says the firmware supports it */
export function AmpScreen({ device, tab }: { device: Device; tab: Tab }) {
  const { config, telemetry } = useAmpLive(device.id);
  const [error, setError] = useState<string | null>(null);
  const [presetsOk, setPresetsOk] = useState(false);

  useEffect(() => {
    invoke<boolean>("amp_presets_supported", { deviceId: device.id }).then(setPresetsOk, () => setPresetsOk(false));
  }, [device.id]);

  const write: Write = (cmd, args) =>
    invoke(cmd, { deviceId: device.id, ...args }).then(
      () => setError(null),
      (e) => setError(String(e)),
    );

  const tabs: Tab[] = presetsOk ? ["overview", "outputs", "inputs", "presets"] : ["overview", "outputs", "inputs"];
  const active = tabs.includes(tab) ? tab : "overview";
  const props = { id: device.id, write, disabled: !device.online };

  let body;
  if (active === "presets") {
    body = <Presets {...props} />;
  } else if (!config) {
    body = (
      <Group justify="center" py="md">
        <Loader size="sm" />
      </Group>
    );
  } else if (active !== "overview" && config.standby === true) {
    body = <Text c="dimmed">The amp is in standby.</Text>;
  } else {
    const Section = { overview: Overview, outputs: Outputs, inputs: Inputs }[active];
    body = <Section {...props} config={config} telemetry={telemetry} />;
  }

  return (
    <>
      {!device.online && (
        <Alert color="yellow" mb="md">
          Amp is offline — controls are disabled.
        </Alert>
      )}
      {error && (
        <Alert color="red" mb="md" withCloseButton onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {body}
      <AppShell.Footer style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        <Tabs value={active} onChange={(t) => t && go(device.id, t as Tab)}>
          <Tabs.List grow h={56}>
            {tabs.map((t) => (
              <Tabs.Tab key={t} value={t} style={{ textTransform: "capitalize" }}>
                {t}
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs>
      </AppShell.Footer>
    </>
  );
}
