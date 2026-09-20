import { AppShell, Badge, Burger, Card, Group, Loader, NavLink, Text, Title, UnstyledButton } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { AmpScreen } from "./AmpScreen";
import { go, useDevices, useRoute, type Device } from "./lib";

const Dot = ({ online }: { online: boolean }) => (
  <span
    style={{ width: 10, height: 10, borderRadius: "50%", background: online ? "var(--mantine-color-green-6)" : "var(--mantine-color-gray-5)" }}
  />
);

function AmpCard({ d }: { d: Device }) {
  return (
    <UnstyledButton w="100%" onClick={() => go(d.id)}>
      <Card withBorder radius="md" mih={64}>
        <Group justify="space-between" wrap="nowrap">
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
      </Card>
    </UnstyledButton>
  );
}

export function App() {
  const devices = useDevices();
  const { id, tab } = useRoute();
  const [menu, { toggle, close }] = useDisclosure(false);
  const amp = id ? devices.find((d) => d.id === id) : undefined;

  return (
    // viewport-fit=cover (index.html) draws under the system bars, so the bars
    // and the content end pad with the safe-area insets.
    <AppShell
      header={{ height: "calc(56px + env(safe-area-inset-top))" }}
      footer={amp ? { height: "calc(56px + env(safe-area-inset-bottom))" } : undefined}
      navbar={{ width: 280, breakpoint: 0, collapsed: { mobile: !menu, desktop: !menu } }}
      padding="md"
    >
      <AppShell.Header style={{ paddingTop: "env(safe-area-inset-top)" }}>
        <Group h={56} px="md" justify="space-between" wrap="nowrap">
          <Group wrap="nowrap">
            <Burger opened={menu} onClick={toggle} aria-label="Menu" />
            <Title order={3}>{amp ? amp.name || amp.mac : "AmpCore"}</Title>
          </Group>
          {!amp && (devices.length === 0 ? <Loader size="sm" /> : <Text c="dimmed">{devices.length} found</Text>)}
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="md" style={{ paddingTop: "calc(var(--mantine-spacing-md) + env(safe-area-inset-top))" }}>
        <NavLink
          label="All amps"
          active={!id}
          onClick={() => {
            go(null);
            close();
          }}
        />
        {devices.map((d) => (
          <NavLink
            key={d.id}
            label={d.name || d.mac}
            description={d.ip}
            leftSection={<Dot online={d.online} />}
            active={d.id === id}
            onClick={() => {
              go(d.id, tab); // amp → amp keeps the current section
              close();
            }}
          />
        ))}
      </AppShell.Navbar>

      <AppShell.Main style={amp ? undefined : { paddingBottom: "calc(var(--mantine-spacing-md) + env(safe-area-inset-bottom))" }}>
        {amp ? (
          <AmpScreen key={amp.id} device={amp} tab={tab} />
        ) : id ? (
          <Text c="dimmed" ta="center" mt="xl">
            Looking for this amp…
          </Text>
        ) : devices.length === 0 ? (
          <Text c="dimmed" ta="center" mt="xl">
            Searching for amps on your Wi-Fi…
          </Text>
        ) : (
          <div style={{ display: "grid", gap: "var(--mantine-spacing-sm)" }} aria-live="polite">
            {devices.map((d) => (
              <AmpCard key={d.id} d={d} />
            ))}
          </div>
        )}
      </AppShell.Main>
    </AppShell>
  );
}
