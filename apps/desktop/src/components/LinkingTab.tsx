import { useState } from "react";
import { Button, Modal } from "@heroui/react";
import { X } from "lucide-react";
import { outputLetter } from "../lib/channelTelemetry";
import { NO_LINKS, type LinkConfig, type LinkScope } from "../lib/channelLinks";
import { setPreference, usePreference } from "../lib/preferences";
import { useConfirm } from "./ConfirmDialog";
import { SECTION_TITLE } from "./fieldClasses";

const INPUT_SCOPES: { scope: LinkScope; label: string }[] = [
  { scope: "muteIn", label: "Mute" },
  { scope: "inputEq", label: "EQ" },
];
const OUTPUT_SCOPES: { scope: LinkScope; label: string }[] = [
  { scope: "muteOut", label: "Mute" },
  { scope: "noiseGateOut", label: "Noise Gate" },
  { scope: "volumeOut", label: "Volume" },
  { scope: "polarityOut", label: "Polarity" },
  { scope: "trimOut", label: "Trim" },
  { scope: "delayOut", label: "Delay" },
  { scope: "outputEq", label: "EQ" },
];

const inputLabel = (channel: number) => String(channel + 1);

/** Groups of one scope: which channels move together, and a way to change it. */
function ScopeModal({
  title,
  groups,
  channelCount,
  labelOf,
  onChange,
  onClose,
}: {
  title: string;
  groups: number[][];
  channelCount: number;
  labelOf: (channel: number) => string;
  onChange: (groups: number[][]) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<number[]>([]);
  const taken = new Set(groups.flat());

  return (
    <Modal.Backdrop isOpen onOpenChange={(open) => !open && onClose()}>
      <Modal.Container placement="center" size="sm">
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Heading>{title}</Modal.Heading>
            <Modal.CloseTrigger />
          </Modal.Header>
          <Modal.Body>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <span className={SECTION_TITLE}>Current groups</span>
                {groups.length === 0 ? (
                  <span className="text-[length:var(--amp-font-size-sm)] text-[var(--amp-color-dimmed)]">
                    Nothing linked.
                  </span>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {groups.map((group) => (
                      <Button
                        key={group.join()}
                        size="sm"
                        variant="secondary"
                        aria-label={`Remove group ${group.map(labelOf).join(" + ")}`}
                        onPress={() => onChange(groups.filter((g) => g !== group))}
                      >
                        {group.map(labelOf).join(" + ")}
                        <X size={14} />
                      </Button>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-2">
                <span className={SECTION_TITLE}>New group</span>
                <div className="grid grid-cols-4 gap-2">
                  {Array.from({ length: channelCount }, (_, channel) => (
                    <Button
                      key={channel}
                      size="sm"
                      variant={selected.includes(channel) ? "primary" : "secondary"}
                      isDisabled={taken.has(channel)}
                      aria-pressed={selected.includes(channel)}
                      onPress={() =>
                        setSelected((current) =>
                          current.includes(channel)
                            ? current.filter((c) => c !== channel)
                            : [...current, channel].sort((a, b) => a - b),
                        )
                      }
                    >
                      {labelOf(channel)}
                    </Button>
                  ))}
                </div>
                <Button
                  size="sm"
                  className="self-end"
                  isDisabled={selected.length < 2}
                  onPress={() => {
                    onChange([...groups, selected]);
                    setSelected([]);
                  }}
                >
                  Add group
                </Button>
              </div>
            </div>
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

/** Which actions on this amp's channels move together — stored on this machine
 * by amp, in effect at once wherever a linked control is used. */
export function LinkingTab({ linkKey, channelCount }: { linkKey: string; channelCount: number }) {
  const all = usePreference("channelLinks");
  const config: LinkConfig = all[linkKey] ?? NO_LINKS;
  const [open, setOpen] = useState<{ scope: LinkScope; title: string; labelOf: (c: number) => string } | null>(null);
  const { confirm, dialog } = useConfirm();

  // A smaller model on the same project amp leaves no channel it can't reach.
  const groupsOf = (scope: LinkScope) =>
    (config[scope] ?? []).filter((group) => group.every((channel) => channel < channelCount));
  const save = (next: LinkConfig) => setPreference("channelLinks", { ...all, [linkKey]: next });

  const section = (
    title: string,
    scopes: { scope: LinkScope; label: string }[],
    labelOf: (channel: number) => string,
  ) => (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className={SECTION_TITLE}>{title}</span>
        <Button
          size="sm"
          variant="ghost"
          isDisabled={!scopes.some(({ scope }) => groupsOf(scope).length > 0)}
          onPress={async () => {
            const ok = await confirm({
              title: `Reset ${title.toLowerCase()} links?`,
              description: `Every ${title.toLowerCase()} channel on this amp goes back to moving on its own. No settings change.`,
              confirmLabel: "Reset",
            });
            if (ok) {
              save(Object.fromEntries(Object.entries(config).filter(([s]) => !scopes.some(({ scope }) => scope === s))));
            }
          }}
        >
          Reset
        </Button>
      </div>
      {scopes.map(({ scope, label }) => {
        const groups = groupsOf(scope);
        return (
          <button
            key={scope}
            type="button"
            className="flex cursor-pointer items-center justify-between gap-3 rounded-md border border-[var(--amp-color-default-border)] bg-transparent px-3 py-2 text-left"
            onClick={() => setOpen({ scope, title: `${title} ${label}`, labelOf })}
          >
            <span className="min-w-0 text-[length:var(--amp-font-size-sm)] font-medium">{label}</span>
            <span className="shrink-0 text-[length:var(--amp-font-size-xs)] text-[var(--amp-color-dimmed)]">
              {groups.length === 0 ? "Off" : groups.map((g) => g.map(labelOf).join(" + ")).join(" | ")}
            </span>
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="h-full min-h-0 overflow-auto">
      {dialog}
      <div className="mx-auto flex w-full min-w-0 max-w-xl flex-col gap-5 p-4">
        {section("Input", INPUT_SCOPES, inputLabel)}
        {section("Output", OUTPUT_SCOPES, outputLetter)}
      </div>
      {open && (
        <ScopeModal
          title={open.title}
          groups={groupsOf(open.scope)}
          channelCount={channelCount}
          labelOf={open.labelOf}
          onChange={(groups) => save({ ...config, [open.scope]: groups })}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
