import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Alert, Group, Loader, Stack, Switch, Text } from "@mantine/core";

// ponytail: hand-written subset of ampcore_core's ChannelConfigSnapshot
// (camelCase). Move to tauri-specta bindings if mobile's command count grows.
interface Snapshot {
  standby: boolean | null;
  standbyLocked: boolean | null;
  channels: { channelIndex: number; outputMuted: boolean; outputName: string | null }[];
}

function Row(p: { label: string; checked: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <Group justify="space-between" mih={48}>
      <Text>{p.label}</Text>
      <Switch
        aria-label={p.label}
        checked={p.checked}
        disabled={p.disabled}
        onChange={(e) => p.onChange(e.currentTarget.checked)}
      />
    </Group>
  );
}

/** Mounted only while its accordion item is open: the effect subscribes the
 * heavy polls for this one amp and unsubscribes on unmount. State shown is the
 * polled one, so a switch reflects a write one poll cycle (~200ms) later. */
export function DeviceControls({ id, online }: { id: string; online: boolean }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = crypto.randomUUID();
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      const off = await listen<{ deviceId: string; config: Snapshot }>("live_channel_config:updated", (e) => {
        if (e.payload.deviceId === id) setSnap(e.payload.config);
      });
      if (cancelled) return off();
      unlisten = off;
      await invoke("poll_subscribe", { token, deviceIds: [id] });
    })();
    return () => {
      cancelled = true;
      unlisten?.();
      void invoke("poll_subscribe", { token, deviceIds: [] });
    };
  }, [id]);

  const write = (cmd: string, args: Record<string, unknown>) =>
    invoke(cmd, { deviceId: id, ...args }).then(
      () => setError(null),
      (e) => setError(String(e)),
    );

  if (!snap) {
    return (
      <Group justify="center" py="md">
        <Loader size="sm" />
      </Group>
    );
  }

  return (
    <Stack gap={0}>
      {error && (
        <Alert color="red" mb="sm" withCloseButton onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      <Row
        label="Standby"
        checked={snap.standby === true}
        disabled={!online || snap.standby === null || snap.standbyLocked === true}
        onChange={(standby) => write("set_standby", { standby })}
      />
      {snap.channels.map((c) => (
        <Row
          key={c.channelIndex}
          // Outputs are lettered A, B, C… (repo convention; inputs are numbered).
          label={`Mute ${String.fromCharCode(65 + c.channelIndex)}${c.outputName ? ` · ${c.outputName}` : ""}`}
          checked={c.outputMuted}
          disabled={!online}
          onChange={(muted) => write("set_output_mute", { channelIndex: c.channelIndex, muted })}
        />
      ))}
    </Stack>
  );
}
