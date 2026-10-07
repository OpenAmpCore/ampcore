import type { ReactNode } from "react";
import { toast } from "@heroui/react";
import { commands, type FitRow, type SpeakerItem, type SpeakerLibraryEntry } from "../lib/bindings";
import type { useConfirm } from "./ConfirmDialog";
import { MUTED } from "./SpeakerBench";

/** One output of one project amp to set up from a library way. */
export interface FitItem {
  channelIndex: number;
  /** The output as the user reads it ("A", "A+B"). */
  outputLabel: string;
  entry: SpeakerLibraryEntry;
  wayIndex: number;
  /** Set to link the output to a project speaker; see `SpeakerItem`. */
  projectSpeakerId?: string | null;
}

/** The first half of every speaker apply: fit the items to one project amp
 * and let the user decide on what it can't take as stored. Returns what to
 * hand to `speakersApply`, or `null` when it can't be applied or was declined.
 * `preconfirmed` (the outputs were just picked in a dialog) skips the question
 * unless the amp has to adjust something. */
export async function confirmFit({
  projectId,
  assignmentId,
  items,
  confirm,
  showComparator,
  ui,
}: {
  projectId: string;
  assignmentId: string;
  items: FitItem[];
  confirm: ReturnType<typeof useConfirm>["confirm"];
  /** The debug preference: show every compared value, not just the issues. */
  showComparator: boolean;
  ui: { title: string; intro: ReactNode; confirmLabel: string; preconfirmed?: boolean };
}): Promise<SpeakerItem[] | null> {
  const pairs = items.map(({ channelIndex, entry, wayIndex, projectSpeakerId }) => ({
    channelIndex,
    libraryId: entry.id,
    wayIndex,
    projectSpeakerId: projectSpeakerId ?? null,
  }));
  const fit = await commands.speakersFit(projectId, assignmentId, pairs);
  if (fit.status !== "ok") {
    toast.danger(`Speaker can't be applied to ${items.map((i) => i.outputLabel).join(", ")}`, { description: fit.error.message });
    return null;
  }
  const issues = fit.data.flatMap((f) => {
    const label = items.find((i) => i.channelIndex === f.channelIndex)?.outputLabel;
    return f.issues.map((issue) => `${label}: ${issue}`);
  });
  const issueList = issues.length > 0 && (
    <ul className="max-h-48 list-disc overflow-auto pl-5">
      {issues.map((issue) => (
        <li key={issue}>{issue}</li>
      ))}
    </ul>
  );
  if (ui.preconfirmed && issues.length === 0 && !showComparator) return pairs;
  const ok = await confirm({
    title: ui.title,
    description: showComparator ? (
      <div className="flex max-h-[60vh] flex-col gap-3 overflow-auto">
        {issueList}
        {fit.data.map((f) => {
          const item = items.find((i) => i.channelIndex === f.channelIndex);
          const way = item?.entry.ways[item.wayIndex];
          return (
            <FitDiff
              key={f.channelIndex}
              title={`Out ${item?.outputLabel}${way && item && item.entry.ways.length > 1 ? ` · ${way.label}` : ""}`}
              rows={f.rows}
            />
          );
        })}
      </div>
    ) : (
      <div className="flex flex-col gap-2">
        {ui.intro}
        {issueList && <span>This amp can't take everything exactly as stored. Applying writes these adjusted values:</span>}
        {issueList}
      </div>
    ),
    confirmLabel: issues.length ? "Apply anyway" : ui.confirmLabel,
  });
  return ok ? pairs : null;
}

const DIFF_CELL = "px-2 py-0.5 font-mono text-xs whitespace-nowrap";

/** Debug comparator: every compared value of one output, GitHub-diff style.
 * Red − what the output loses, green + what it gets, orange where `fit`
 * changed the preset's value to suit this amp. */
function FitDiff({ title, rows }: { title: string; rows: FitRow[] }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-sm font-semibold">{title}</span>
      <div className="overflow-x-auto rounded-md border border-[var(--amp-color-default-border)]">
        <table className="w-full border-collapse">
          <thead>
            <tr className={`${MUTED} text-left`}>
              <th className={DIFF_CELL}>Field</th>
              <th className={DIFF_CELL}>Amp now</th>
              <th className={DIFF_CELL}>Preset</th>
              <th className={DIFF_CELL}>Will write</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const changes = r.current !== r.written;
              const adjusted = r.preset !== r.written;
              return (
                <tr key={r.label} style={{ opacity: changes || adjusted ? 1 : 0.5 }}>
                  <td className={DIFF_CELL}>{r.label}</td>
                  <td className={DIFF_CELL} style={changes ? { background: "var(--amp-color-red-light)" } : undefined}>
                    {changes && "− "}{r.current}
                  </td>
                  <td className={DIFF_CELL}>{r.preset}</td>
                  <td
                    className={DIFF_CELL}
                    style={
                      adjusted
                        ? { background: "var(--amp-color-orange-light)" }
                        : changes
                          ? { background: "var(--amp-color-green-light)" }
                          : undefined
                    }
                  >
                    {changes && "+ "}{r.written}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
