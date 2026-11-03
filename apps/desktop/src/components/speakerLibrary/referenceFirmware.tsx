import { useEffect, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { commands, type AmpCapability_Serialize as AmpCapability, type Project } from "../../lib/bindings";
import { firmwareOptionsFor } from "../../lib/firmwareOptions";
import { TilePopover } from "../configure/parts";
import { SimpleSelect } from "../SimpleSelect";
import { MUTED } from "../speakers/SpeakerBench";

/** The firmwares a speaker can be edited against: every CVR amp runs one. */
const FIRMWARES = firmwareOptionsFor("cvrUdp");

/** The firmware whose ranges and features the editors offer. A speaker
 * belongs to no amp, so there is no model: rated voltage only matters on
 * apply, where `fit` bounds the values to the real amp. Defaults to the
 * project's first amp's firmware, else the newest. */
export function useReferenceFirmware(project: Project) {
  const fallback = useMemo(() => {
    const own = project.ampAssignments.map((a) => a.firmwareVersion).find((f) => f && FIRMWARES.includes(f));
    return own ?? FIRMWARES[0] ?? null;
  }, [project.ampAssignments]);
  const [choice, setChoice] = useState<string | null>(null);
  const firmware = choice ?? fallback;
  const [capability, setCapability] = useState<AmpCapability | null>(null);

  useEffect(() => {
    let cancelled = false;
    commands.ampCapabilityForFirmware(firmware).then((c) => !cancelled && setCapability(c));
    return () => {
      cancelled = true;
    };
  }, [firmware]);

  return { firmware, capability, choose: setChoice };
}

type ReferenceFirmware = ReturnType<typeof useReferenceFirmware>;

/** "Firmware 1.1.8" in the header; opens the firmware picker. */
export function ReferenceChip({ reference }: { reference: ReferenceFirmware }) {
  const [open, setOpen] = useState(false);
  const noSpeakerManagement = reference.capability && !reference.capability.firmware.speakerManagement;
  return (
    <TilePopover
      opened={open}
      onOpenChange={setOpen}
      width={260}
      trigger={
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex cursor-pointer items-center gap-1 rounded-sm border border-[var(--amp-color-default-border)] bg-transparent px-1.5 py-0.5 text-inherit hover:bg-[var(--amp-color-gray-light)]"
        >
          <span>Firmware {reference.firmware ?? "—"}</span>
          {noSpeakerManagement && <span className="text-warning">!</span>}
          <ChevronDown size={12} />
        </button>
      }
    >
      <div className="flex flex-col gap-2">
        <span className={MUTED}>
          A speaker belongs to no amp: the firmware sets the ranges and features offered here. Applying it fits the values to
          each amp.
        </span>
        <SimpleSelect
          data={FIRMWARES.map((f) => ({ value: f, label: `Firmware ${f}` }))}
          value={reference.firmware}
          onChange={(firmware) => firmware && reference.choose(firmware)}
        />
        {noSpeakerManagement && <span className="text-sm text-warning">This firmware has no speaker management.</span>}
      </div>
    </TilePopover>
  );
}
