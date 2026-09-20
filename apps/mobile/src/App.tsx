import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Badge, Card, Container, Group, Loader, Stack, Text, Title } from "@mantine/core";

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

  return (
    <Container size="sm" py="md" style={{ paddingTop: "max(env(safe-area-inset-top), 1rem)" }}>
      <Title order={2} mb="md">
        AmpCore
      </Title>
      {devices.length === 0 ? (
        <Group justify="center" gap="sm" mt="xl">
          <Loader size="sm" />
          <Text c="dimmed">Searching for amps on your Wi-Fi…</Text>
        </Group>
      ) : (
        <Stack>
          {devices.map((d) => (
            <Card key={d.id} withBorder radius="md">
              <Group justify="space-between" mb={4}>
                <Text fw={600}>{d.name || d.mac}</Text>
                <Badge color={d.online ? "green" : "gray"}>{d.online ? "online" : "offline"}</Badge>
              </Group>
              <Text size="sm" c="dimmed">
                {d.brand} · {d.ip} · fw {d.firmwareVersion}
              </Text>
              <Text size="sm" c="dimmed">
                {d.analogInputChannels + d.digitalInputChannels} in · {d.outputChannels} out
              </Text>
            </Card>
          ))}
        </Stack>
      )}
    </Container>
  );
}
