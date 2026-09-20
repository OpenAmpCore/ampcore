import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Accordion, AppShell, Badge, Group, Loader, Text, Title } from "@mantine/core";
import { DeviceControls } from "./DeviceControls";

// ponytail: hand-written subset of ampcore_core::live::state::DiscoveredDevice
// (camelCase). Move to tauri-specta bindings if mobile's command count grows.
interface Device {
  id: string;
  name: string;
  brand: string;
  ip: string;
  mac: string;
  firmwareVersion: string;
  analogInputChannels: number;
  digitalInputChannels: number;
  outputChannels: number;
  online: boolean;
}

export function App() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      const off = await listen<Device[]>("live_device:updated", (e) => setDevices(e.payload));
      if (cancelled) return off();
      unlisten = off;
      setDevices(await invoke<Device[]>("discovery_list"));
      await invoke("discovery_start"); // idempotent; discovery runs for the app's lifetime
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // The backend hands over HashMap order, which reshuffles between events.
  const sorted = [...devices].sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));

  return (
    // viewport-fit=cover (index.html) draws under the system bars, so the bar
    // and the content end pad with the safe-area insets.
    <AppShell header={{ height: "calc(56px + env(safe-area-inset-top))" }} padding="md">
      <AppShell.Header style={{ paddingTop: "env(safe-area-inset-top)" }}>
        <Group h={56} px="md" justify="space-between">
          <Title order={3}>AmpCore</Title>
          {sorted.length === 0 ? <Loader size="sm" /> : <Text c="dimmed">{sorted.length} found</Text>}
        </Group>
      </AppShell.Header>
      <AppShell.Main style={{ paddingBottom: "calc(var(--mantine-spacing-md) + env(safe-area-inset-bottom))" }}>
        {sorted.length === 0 ? (
          <Text c="dimmed" ta="center" mt="xl">
            Searching for amps on your Wi-Fi…
          </Text>
        ) : (
          <Accordion variant="separated" radius="md" value={open} onChange={setOpen}>
            {sorted.map((d) => (
              <Accordion.Item key={d.id} value={d.id}>
                <Accordion.Control mih={64}>
                  <Group justify="space-between" wrap="nowrap" pr="xs">
                    <div>
                      <Text fw={600}>{d.name || d.mac}</Text>
                      <Text size="sm" c="dimmed">
                        {d.brand} · {d.ip} · fw {d.firmwareVersion}
                      </Text>
                      <Text size="sm" c="dimmed">
                        {d.analogInputChannels + d.digitalInputChannels} in · {d.outputChannels} out
                      </Text>
                    </div>
                    <Badge color={d.online ? "green" : "gray"}>{d.online ? "online" : "offline"}</Badge>
                  </Group>
                </Accordion.Control>
                <Accordion.Panel>{open === d.id && <DeviceControls id={d.id} online={d.online} />}</Accordion.Panel>
              </Accordion.Item>
            ))}
          </Accordion>
        )}
      </AppShell.Main>
    </AppShell>
  );
}
