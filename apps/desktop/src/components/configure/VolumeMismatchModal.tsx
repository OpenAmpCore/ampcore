import { useState } from "react";
import { AlertDialog, Button, toast } from "@heroui/react";
import type { ActionResult } from "../../lib/actionResult";
import type { AmpChannel } from "../../lib/bindings";
import { VOLUME_EQUAL_DB } from "../../lib/channelLinks";
import { outputLetter } from "../../lib/channelTelemetry";

const dB = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;

/** Output volumes move together only from one level: `check` asks, when the
 * outputs' volumes differ, whether to set them all to the lowest — never louder than now — or
 * to edit outputs singly. Equal volumes need no question. `onTogether` gets
 * the answer; `write` is the unlinked setter, so the link doesn't carry the
 * differences along. */
export function useVolumeMismatch({
  channels,
  write,
  onTogether,
}: {
  channels: AmpChannel[];
  write?: (volumes: { channelIndex: number; volumeDb: number }[]) => Promise<ActionResult>;
  onTogether: (together: boolean) => void;
}) {
  const [asking, setAsking] = useState<{ lowest: number } | null>(null);
  const [busy, setBusy] = useState(false);

  function check() {
    const vols = channels.map((c) => c.outputVolumeDb ?? 0);
    const lowest = Math.min(...vols);
    if (vols.every((v) => v - lowest < VOLUME_EQUAL_DB)) onTogether(true);
    else setAsking({ lowest });
  }

  async function setLowest() {
    if (!asking || !write) return;
    setBusy(true);
    const result = await write(
      channels.map((c) => ({ channelIndex: c.channelIndex, volumeDb: asking.lowest })),
    );
    setBusy(false);
    if (!result.ok) toast.danger("Output volumes not all set", { description: result.message });
    onTogether(result.ok);
    setAsking(null);
  }

  const dialog = (
    <AlertDialog.Backdrop isOpen={asking !== null}>
      <AlertDialog.Container placement="center" size="sm">
        <AlertDialog.Dialog>
          <AlertDialog.Header>
            <AlertDialog.Icon status="warning" />
            <AlertDialog.Heading>Output volumes differ</AlertDialog.Heading>
          </AlertDialog.Header>
          <AlertDialog.Body>
            <div className="flex flex-col gap-3 text-[length:var(--amp-font-size-sm)]">
              <div className="flex flex-wrap gap-x-4 gap-y-1 tabular-nums">
                {channels.map((c) => (
                  <span key={c.channelIndex}>
                    <b>{outputLetter(c.channelIndex)}</b> {dB(c.outputVolumeDb ?? 0)}
                  </span>
                ))}
              </div>
              <span className="text-[var(--amp-color-dimmed)]">
                To move them together, set all to the lowest ({asking && dB(asking.lowest)}), or keep editing outputs singly.
              </span>
            </div>
          </AlertDialog.Body>
          <AlertDialog.Footer>
            <Button
              variant="ghost"
              isDisabled={busy}
              onPress={() => {
                onTogether(false);
                setAsking(null);
              }}
            >
              Edit outputs singly
            </Button>
            <Button variant="primary" isDisabled={busy || !write} onPress={() => void setLowest()}>
              Set all to lowest
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  );

  return { dialog, check };
}
