import { useEffect, useState } from "react";
import { Button, Chip, Spinner } from "@heroui/react";
import { Check, Server } from "lucide-react";
import { commands, type AmpModelCatalogEntry, type DiscoveredDevice, type Project } from "../lib/bindings";
import { normalizeMac } from "../lib/ampLinkStatus";
import { MUTED } from "./SpeakerBench";

/** Catalog model per discovered device id, resolved exactly like Live Control's
 * model select (`deviceModelLinkAutoMatch`: a manual pick wins, otherwise the
 * firmware-string match). Only resolves while `enabled`, and only for device
 * ids it hasn't resolved yet. */
export function useDetectedModels(devices: DiscoveredDevice[], enabled: boolean) {
  const [models, setModels] = useState<Record<string, AmpModelCatalogEntry | null>>({});
  const pendingKey = devices
    .filter((d) => !(d.id in models))
    .map((d) => d.id)
    .join(",");

  useEffect(() => {
    if (!enabled || !pendingKey) return;
    for (const device of devices.filter((d) => !(d.id in models))) {
      commands
        .deviceModelLinkAutoMatch(device.mac, device.firmwareVersion, device.digitalInputChannels, device.outputChannels)
        .then((result) => {
          setModels((prev) => ({ ...prev, [device.id]: result.status === "ok" ? result.data : null }));
        });
    }
    // `pendingKey` stands in for `devices`, whose identity changes on every discovery tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, pendingKey]);

  return models;
}

/** The online amps on the network this project doesn't hold yet. */
export function unlinkedDevices(project: Project, devices: DiscoveredDevice[]): DiscoveredDevice[] {
  const linked = new Set(project.ampAssignments.flatMap((a) => (a.mac ? [normalizeMac(a.mac)] : [])));
  return devices.filter((d) => d.online && !linked.has(normalizeMac(d.mac)));
}

type Step = { state: "adding" | "reading" | "done" | "differs" | "failed"; message?: string };

/** How long an added amp gets to report its settings before it is left to the
 * comparison: 20 tries, half a second apart. */
const ADOPT_TRIES = 20;

/** Add Amp's Live side: the discovered amps not in this project yet. Adding
 * one creates the project amp as what the device reports itself to be, linked
 * (`projects_add_live_amp`), then takes over its settings as soon as it has
 * been read (`projects_merge_amp_from_live`) — the catalogue, link dialog and
 * comparison in one step. */
export function AmpLivePicker({
  project,
  devices,
  onProjectUpdate,
  onDone,
}: {
  project: Project;
  devices: DiscoveredDevice[];
  onProjectUpdate: (project: Project) => void;
  onDone: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [steps, setSteps] = useState<Record<string, Step>>({});
  /** The amps being added: an added amp leaves `unlinkedDevices`, but its row
   * has to stay to show how it went. */
  const [batch, setBatch] = useState<DiscoveredDevice[] | null>(null);

  const candidates = unlinkedDevices(project, devices);
  const models = useDetectedModels(candidates, true);
  const rows = batch ?? candidates;
  const running = Object.values(steps).some((s) => s.state === "adding" || s.state === "reading");

  /** Why a device can't be added; `null` when it can. */
  function blocker(device: DiscoveredDevice): string | null {
    const model = models[device.id];
    if (model === undefined) return "Detecting model…";
    if (model === null) return "Unknown model — assign it in Live Control";
    if (!device.firmwareFamily) return `Firmware "${device.firmwareVersion}" isn't recognised`;
    return null;
  }
  const addable = candidates.filter((d) => blocker(d) === null);
  const chosen = addable.filter((d) => selected.has(d.id));

  async function add() {
    setBatch(chosen);
    const step = (id: string, next: Step) => setSteps((prev) => ({ ...prev, [id]: next }));
    let clean = true;
    for (const device of chosen) {
      step(device.id, { state: "adding" });
      const added = await commands.projectsAddLiveAmp(project.id, device.id);
      if (added.status !== "ok") {
        step(device.id, { state: "failed", message: added.error.message });
        clean = false;
        continue;
      }
      // From here the Workspace polls it, which is what makes it readable.
      onProjectUpdate(added.data);
      const assignment = added.data.ampAssignments[added.data.ampAssignments.length - 1];
      step(device.id, { state: "reading" });
      let adopted = false;
      for (let attempt = 0; attempt < ADOPT_TRIES && !adopted; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const merged = await commands.projectsMergeAmpFromLive(project.id, assignment.id);
        if (merged.status === "ok" && merged.data.merged && merged.data.project) {
          onProjectUpdate(merged.data.project);
          adopted = true;
        }
      }
      step(device.id, { state: adopted ? "done" : "differs" });
      clean &&= adopted;
    }
    if (clean) onDone();
  }

  if (rows.length === 0) {
    return (
      <div className="flex min-h-[420px] flex-col items-center justify-center gap-2">
        <Spinner size="sm" />
        <span className={MUTED}>No unlinked amps found on the network yet. Still looking…</span>
      </div>
    );
  }

  return (
    <div className="flex min-h-[420px] min-w-0 flex-col gap-3">
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
        {rows.map((device) => {
          const model = models[device.id];
          const reason = blocker(device);
          const step = steps[device.id];
          const on = selected.has(device.id);
          return (
            <button
              key={device.id}
              type="button"
              disabled={batch !== null || reason !== null}
              aria-pressed={on}
              onClick={() =>
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (!next.delete(device.id)) next.add(device.id);
                  return next;
                })
              }
              className={`flex min-w-0 items-center gap-3 rounded-md border border-solid px-3 py-2 text-left text-foreground ${
                on ? "border-accent bg-accent-soft" : "border-[var(--amp-color-default-border)]"
              } ${batch === null && reason === null ? "cursor-pointer" : ""} ${reason !== null ? "opacity-50" : ""}`}
            >
              <span
                className={`flex size-4 shrink-0 items-center justify-center rounded-sm border border-solid ${
                  on ? "border-accent bg-accent text-accent-foreground" : "border-[var(--amp-color-dimmed)]"
                }`}
              >
                {on && <Check size={12} />}
              </span>
              {device.brand === "CVR" ? (
                <img src="/cvr_dsp_amp.png" alt="" className="h-9 w-9 shrink-0 object-contain" />
              ) : (
                <Server size={22} className="shrink-0 text-[var(--amp-color-dimmed)]" />
              )}
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-semibold">{device.name.trim() || "Unnamed amp"}</span>
                {step?.state === "failed" ? (
                  <span className="truncate text-xs text-danger">{step.message}</span>
                ) : step?.state === "differs" ? (
                  <span className={`${MUTED} truncate`}>Linked, but its settings couldn't be read in time. Compare it from its card.</span>
                ) : (
                  <span className={`${MUTED} truncate`}>
                    {reason ?? `${model?.brand} ${model?.model} · firmware ${device.firmwareFamily}`} · {device.ip}
                  </span>
                )}
              </div>
              {step && (
                <span className="flex shrink-0 items-center gap-2">
                  {(step.state === "adding" || step.state === "reading") && <Spinner size="sm" />}
                  <Chip size="sm" color={step.state === "done" ? "success" : step.state === "failed" ? "danger" : step.state === "differs" ? "warning" : "default"}>
                    {step.state === "adding" ? "Adding…"
                      : step.state === "reading" ? "Reading settings…"
                      : step.state === "done" ? "Added"
                      : step.state === "differs" ? "Added"
                      : "Not added"}
                  </Chip>
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="flex shrink-0 items-center justify-between gap-2">
        <Button
          size="sm"
          variant="ghost"
          isDisabled={batch !== null || addable.length === 0}
          onPress={() => setSelected(new Set(chosen.length === addable.length ? [] : addable.map((d) => d.id)))}
        >
          {chosen.length === addable.length && addable.length > 0 ? "Select none" : "Select all"}
        </Button>
        {batch !== null && !running ? (
          <Button variant="primary" onPress={onDone}>Close</Button>
        ) : (
          <Button variant="primary" isDisabled={running || chosen.length === 0} onPress={() => void add()}>
            {running ? <Spinner size="sm" /> : chosen.length ? `Add ${chosen.length} ${chosen.length === 1 ? "amp" : "amps"}` : "Add amps"}
          </Button>
        )}
      </div>
    </div>
  );
}
