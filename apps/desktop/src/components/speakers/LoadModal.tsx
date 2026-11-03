import { useState } from "react";
import { Button, Modal } from "@heroui/react";
import type { ChannelSpeakerState, SpeakerLibraryEntry, SpeakerProcessing } from "../../lib/bindings";
import { useIsCompact } from "../../lib/breakpoints";
import { speakerName } from "../../lib/speakers";
import { Hint } from "../Hint";
import { SimpleSelect } from "../SimpleSelect";
import { MUTED, type OutputRow } from "./SpeakerBench";
import type { Assignment } from "./SpeakersTab";

/** A way's limiter thresholds, delay, polarity and FIR filter on one line. */
function waySummary(p: SpeakerProcessing): string {
  const { rms, peak } = p.limiter;
  return [
    rms.enabled ? `${(rms.thresholdVrms ?? 0).toFixed(1)} Vrms` : "RMS off",
    peak.enabled ? `${(peak.thresholdVp ?? 0).toFixed(1)} Vp` : "peak off",
    `${(p.delayOutMs ?? 0).toFixed(2)} ms`,
    ...(p.phaseInverted ? ["inverted"] : []),
    // Anything but a unit impulse is a real filter.
    ...(p.fir?.coefficients.some((c, i) => (c ?? 0) !== (i === 0 ? 1 : 0)) ? [`FIR ${p.fir.name.trim() || "unnamed"}`] : []),
  ].join(" · ");
}

/** The precise, keyboard-reachable alternative to dragging, under the
 * speaker's details: a one-way speaker is toggled per output, a multi-way one
 * gets a way picked per output. Each output records the way it was given. */
export function LoadModal({
  entry,
  rows,
  states,
  onClose,
  onAssign,
}: {
  entry: SpeakerLibraryEntry | null;
  rows: OutputRow[];
  states: Map<number, ChannelSpeakerState>;
  onClose: () => void;
  onAssign: (entry: SpeakerLibraryEntry, items: Assignment[]) => void;
}) {
  const compact = useIsCompact();
  const [picks, setPicks] = useState<Record<number, string>>({});
  const options = [
    { value: "", label: "No change" },
    ...(entry?.ways.map((w, i) => ({ value: String(i), label: `Way ${i + 1}: ${w.label}` })) ?? []),
  ];
  const items = rows.flatMap((row) => (picks[row.leader] ? [{ row, wayIndex: Number(picks[row.leader]) }] : []));
  function close() {
    setPicks({});
    onClose();
  }
  return (
    <Modal.Backdrop isOpen={entry !== null} onOpenChange={(open) => !open && close()}>
      <Modal.Container placement="center" size={compact ? "full" : "lg"}>
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Heading>{entry ? `Load ${speakerName(entry)}` : "Load"}</Modal.Heading>
            <Modal.CloseTrigger />
          </Modal.Header>
          <Modal.Body>
            <div className="flex flex-col gap-4">
              {entry && (
                <div className="flex min-w-0 flex-col gap-1 rounded-xl border border-[var(--amp-color-default-border)] p-3">
                  {(entry.family || entry.application) && (
                    <span className={MUTED}>{[entry.family, entry.application].filter(Boolean).join(" · ")}</span>
                  )}
                  {entry.ways.map((w, i) => (
                    <div key={i} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                      <span className="text-sm font-medium">{w.label}</span>
                      <span className={MUTED}>{waySummary(w.processing)}</span>
                    </div>
                  ))}
                  {entry.notes && <span className={`${MUTED} italic`}>{entry.notes}</span>}
                </div>
              )}
              {entry?.ways.length === 1 ? (
                // One way: an output either gets the speaker or it doesn't.
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className={`${MUTED} font-semibold uppercase`}>Load onto</span>
                    <div className="flex gap-1">
                      <Button size="sm" variant="ghost" onPress={() => setPicks(Object.fromEntries(rows.map((r) => [r.leader, "0"])))}>All</Button>
                      <Button size="sm" variant="ghost" onPress={() => setPicks({})}>None</Button>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {rows.map((row) => {
                      const on = !!picks[row.leader];
                      const current = states.get(row.leader)?.speaker.label;
                      return (
                        <div key={row.leader} className="flex w-[104px] flex-col gap-1">
                          <Button
                            variant={on ? "primary" : "secondary"}
                            aria-pressed={on}
                            onPress={() => setPicks((p) => ({ ...p, [row.leader]: on ? "" : "0" }))}
                          >
                            {row.label}
                          </Button>
                          <Hint text={current} className="min-w-0">
                            <span className={`${MUTED} block truncate text-center`}>{current ?? "free"}</span>
                          </Hint>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="grid min-w-0 grid-cols-[56px_minmax(0,1fr)_200px] items-center gap-x-3 gap-y-2">
                  <span className={`${MUTED} font-semibold uppercase`}>Out</span>
                  <span className={`${MUTED} font-semibold uppercase`}>Current</span>
                  <span className={`${MUTED} font-semibold uppercase`}>Way to load</span>
                  {rows.map((row) => {
                    const current = states.get(row.leader)?.speaker.label;
                    return (
                      <div key={row.leader} className="contents">
                        <span className="text-sm font-bold">{row.label}</span>
                        <Hint text={current} className="min-w-0">
                          <span className={`block truncate text-sm ${current ? "" : "text-[var(--amp-color-dimmed)]"}`}>{current ?? "free"}</span>
                        </Hint>
                        <SimpleSelect
                          className="whitespace-nowrap"
                          data={options}
                          value={picks[row.leader] ?? ""}
                          onChange={(v) => setPicks((p) => ({ ...p, [row.leader]: v ?? "" }))}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onPress={close}>Cancel</Button>
                <Button
                  variant="primary"
                  isDisabled={items.length === 0}
                  onPress={() => {
                    if (entry) onAssign(entry, items);
                    close();
                  }}
                >
                  {items.length ? `Load onto ${items.map((i) => i.row.label).join(", ")}` : "Load"}
                </Button>
              </div>
            </div>
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
