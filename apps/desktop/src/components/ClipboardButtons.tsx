import { useState, useSyncExternalStore } from "react";
import { Button, Tooltip } from "@heroui/react";
import { ClipboardPaste, Copy } from "lucide-react";

import type { ChannelClip, ClipSection } from "../lib/bindings";
import type { ConfigureActions } from "../lib/configureActions";

/** The app's one channel clipboard, shared by every editor and both edit
 * sources — so a live amp's EQ can be pasted into a project and back. Kept in
 * memory only; what a clip means and where it may go is core's business
 * (`data/channel_clipboard.rs`). */
let entry: { clip: ChannelClip; label: string } | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Mirrors core's `ChannelClip::fits` only to disable a Paste that core would
 * refuse anyway; core stays the authority. */
function fits(clip: ChannelClip, section: ClipSection): boolean {
  return clip.kind === "eq" ? section === "inputEq" || section === "outputEq" : clip.kind === section;
}

/** Copy/Paste pair for one channel section. `label` names what Copy takes
 * (e.g. "Out A output EQ") and is shown on Paste elsewhere. Renders nothing
 * when the source can't copy; Paste stays disabled while the clipboard holds
 * something else or the source is read-only (e.g. an edit-locked amp). */
export function ClipboardButtons({
  actions,
  channelIndex,
  section,
  label,
}: {
  actions: ConfigureActions;
  channelIndex: number;
  section: ClipSection;
  label: string;
}) {
  const current = useSyncExternalStore(subscribe, () => entry);
  const [busy, setBusy] = useState(false);
  if (!actions.copyChannelSection) return null;

  const canPaste = Boolean(actions.pasteChannelSection && current && fits(current.clip, section));

  async function handleCopy() {
    const clip = await actions.copyChannelSection?.(channelIndex, section);
    if (!clip) return;
    entry = { clip, label };
    listeners.forEach((listener) => listener());
  }

  async function handlePaste() {
    if (!current || !actions.pasteChannelSection) return;
    setBusy(true);
    await actions.pasteChannelSection(channelIndex, section, current.clip);
    setBusy(false);
  }

  return (
    <div className="flex gap-2">
      <Button size="sm" variant="secondary" onPress={() => void handleCopy()}>
        <Copy size={14} /> Copy
      </Button>
      <Tooltip delay={300} isDisabled={!current}>
        <Tooltip.Trigger>
          <Button size="sm" variant="secondary" isDisabled={!canPaste || busy} onPress={() => void handlePaste()}>
            <ClipboardPaste size={14} /> Paste
          </Button>
        </Tooltip.Trigger>
        <Tooltip.Content showArrow>
          {current && fits(current.clip, section) ? `Paste ${current.label}` : `Clipboard holds ${current?.label}`}
        </Tooltip.Content>
      </Tooltip>
    </div>
  );
}
