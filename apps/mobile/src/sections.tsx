import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Alert, Badge, Group, Loader, Modal, NavLink, Progress, Stack, Text, Button } from "@mantine/core";
import { outputLabel, Row, type Presets as PresetsData, type Snapshot, type Telemetry, type Write } from "./lib";

interface Props {
  id: string;
  config: Snapshot;
  telemetry: Telemetry | null;
  write: Write;
  disabled: boolean;
}

// Decoded AmpChannelState (core) → badge colour. Anything not listed is gray.
const STATE_COLOR: Record<string, string> = {
  normal: "green",
  run: "green",
  clip: "orange",
  limit: "orange",
  temp: "orange",
  fault: "red",
  overload: "red",
  dcp: "red",
  powerError: "red",
  open: "red",
};
const StateBadge = ({ state }: { state: string | null | undefined }) =>
  state ? (
    <Badge variant="light" color={STATE_COLOR[state] ?? "gray"}>
      {state}
    </Badge>
  ) : null;

const NORMAL = new Set(["normal", "run"]);

export function Overview({ config, telemetry, write, disabled }: Props) {
  const t = telemetry;
  const temps = t?.temperatures ?? [];
  return (
    <Stack gap="md">
      <Row
        name="Standby"
        extra={<StateBadge state={t?.machineStateDecoded} />}
        checked={config.standby === true}
        disabled={disabled || config.standby === null || config.standbyLocked === true}
        onChange={(standby) => write("set_standby", { standby })}
      />
      {config.standbyLocked && (
        <Text size="xs" c="dimmed" mt={-12}>
          Standby is locked on the amp.
        </Text>
      )}
      {!t ? (
        <Group justify="center">
          <Loader size="sm" />
          <Text c="dimmed">Waiting for meters…</Text>
        </Group>
      ) : (
        <>
          {temps.length > 0 && (
            <Text size="sm">
              Temperature {temps.slice(0, 4).map((v) => Math.round(v)).join(" · ")} °C
              {temps[4] !== undefined && ` · PSU ${Math.round(temps[4])} °C`}
            </Text>
          )}
          {t.inputClipping.some((c) => c === true) && <Badge color="orange">Input clipping</Badge>}
          <Stack gap="xs">
            {t.outputLevelDb.map((db, i) => (
              <Group key={i} wrap="nowrap" gap="sm">
                <Text w={20} fw={600}>
                  {outputLabel(i)}
                </Text>
                {/* 0 dB = the amp's rated output; the bar shows -60…0 dB. */}
                <Progress flex={1} value={db === null ? 0 : Math.max(0, Math.min(100, ((db + 60) / 60) * 100))} />
                <Text w={64} ta="right" size="sm" c="dimmed">
                  {db === null ? "—" : `${db.toFixed(0)} dB`}
                </Text>
                {t.outputChannelStates[i] && !NORMAL.has(t.outputChannelStates[i]!) && <StateBadge state={t.outputChannelStates[i]} />}
              </Group>
            ))}
          </Stack>
        </>
      )}
    </Stack>
  );
}

export function Outputs({ config, telemetry, write, disabled }: Props) {
  return (
    <Stack gap={0}>
      {config.channels.map((c) => {
        const st = telemetry?.outputChannelStates[c.channelIndex];
        return (
          <Row
            key={c.channelIndex}
            name={`${outputLabel(c.channelIndex)}${c.outputName ? ` · ${c.outputName}` : ""}`}
            extra={st && !NORMAL.has(st) ? <StateBadge state={st} /> : null}
            checked={c.outputMuted}
            disabled={disabled}
            onChange={(muted) => write("set_output_mute", { channelIndex: c.channelIndex, muted })}
          />
        );
      })}
    </Stack>
  );
}

export function Inputs({ config, telemetry, write, disabled }: Props) {
  return (
    <Stack gap={0}>
      {config.channels.map((c) => (
        <Row
          key={c.channelIndex}
          name={`${c.channelIndex + 1}${c.inputName ? ` · ${c.inputName}` : ""}`}
          extra={telemetry?.inputClipping[c.channelIndex] ? <Badge color="orange">clip</Badge> : null}
          checked={c.inputMuted}
          disabled={disabled}
          onChange={(muted) => write("set_input_mute", { channelIndex: c.channelIndex, muted })}
        />
      ))}
    </Stack>
  );
}

export function Presets({ id, write, disabled }: Pick<Props, "id" | "write" | "disabled">) {
  const [presets, setPresets] = useState<PresetsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ index: number; name: string } | null>(null);

  const load = () => invoke<PresetsData>("fetch_presets", { deviceId: id }).then(setPresets, (e) => setError(String(e)));
  useEffect(() => {
    void load();
  }, [id]);

  if (error) return <Alert color="red">{error}</Alert>;
  if (!presets)
    return (
      <Group justify="center" py="md">
        <Loader size="sm" />
      </Group>
    );

  return (
    <>
      <Stack gap="xs">
        {presets.slots.map((s) => (
          <NavLink
            key={s.index}
            mih={56}
            label={s.name || "(empty)"}
            description={`Slot ${s.index}`}
            active={s.name !== "" && s.name === presets.activePresetName}
            disabled={disabled}
            onClick={() => setPending(s)}
          />
        ))}
      </Stack>
      {/* Recall replaces the whole amp's live settings, so it is always confirmed. */}
      <Modal opened={pending !== null} onClose={() => setPending(null)} title="Recall preset?" centered>
        <Text mb="md">
          “{pending?.name || "(empty)"}” replaces the amp’s current settings.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setPending(null)}>
            Cancel
          </Button>
          <Button
            color="red"
            onClick={() => {
              const slot = pending!;
              setPending(null);
              void write("recall_preset", { slotIndex: slot.index }).then(load);
            }}
          >
            Recall
          </Button>
        </Group>
      </Modal>
    </>
  );
}
