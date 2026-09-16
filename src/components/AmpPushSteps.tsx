import { Fragment, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Alert, Spinner } from "@heroui/react";
import { listen } from "@tauri-apps/api/event";
import { Check, Minus, X } from "lucide-react";
import { commands, type AmpEditLock, type AmpPushPlan, type PushStage } from "../lib/bindings";

/** Payload of the Rust `amp_push:progress` event (`AmpPushProgress` in
 * `commands/amp_push.rs`). Declared here rather than imported because specta
 * only exports types a command's signature reaches, and this one is only ever
 * emitted. */
type PushProgress = {
  assignmentId: string;
  stageIndex: number;
  stageId: string;
  state: "running" | "done" | "failed";
  packetsDone: number;
  packetsTotal: number;
};

type StageState = "pending" | "running" | "done" | "failed" | "skipped";

function StageIcon({ state }: { state: StageState }) {
  switch (state) {
    case "running":
      return <Spinner size="sm" style={{ color: "var(--accent)" }} />;
    case "done":
      return <Check size={14} strokeWidth={3} className="text-[var(--amp-color-green-filled)]" />;
    case "failed":
      return <X size={14} strokeWidth={3} className="text-[var(--amp-color-red-filled)]" />;
    case "skipped":
      return <Minus size={14} className="text-[var(--amp-color-dimmed)]" />;
    default:
      return (
        <span className="block size-[6px] rounded-full bg-[var(--amp-color-default-border)]" aria-hidden="true" />
      );
  }
}

/** Right-hand column: how far this stage got, in packets. */
function StageCount({ state, done, total }: { state: StageState; done: number; total: number }) {
  const text =
    state === "running" || (state === "failed" && done > 0) ? `${done}/${total}` : `${total} ${total === 1 ? "write" : "writes"}`;
  const color =
    state === "failed"
      ? "var(--amp-color-red-6)"
      : state === "done"
        ? "var(--amp-color-green-6)"
        : "var(--amp-color-dimmed)";
  return (
    <span
      className="shrink-0 tabular-nums font-mono"
      style={{ fontSize: "var(--amp-font-size-xs)", color }}
    >
      {text}
    </span>
  );
}

/** The animated step list for a push: every stage the plan will write, in send
 * order, advancing as `amp_push:progress` arrives.
 *
 * The plan is fetched up front so the list is readable *before* the user
 * commits to the push — it doubles as the preview of what a push would change,
 * including the device-determined fields that travel the other way instead
 * (`AmpPushPlan.adopted`). */
export function AmpPushSteps({
  lock,
  projectId,
  assignmentId,
  running,
  /** Bumped by the parent after every settled attempt, to re-plan against the
   * amp's new state. */
  reloadKey,
}: {
  lock: AmpEditLock | null;
  projectId: string;
  assignmentId: string;
  running: boolean;
  reloadKey: number;
}) {
  const [plan, setPlan] = useState<AmpPushPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, { state: StageState; done: number }>>({});
  const [failedIndex, setFailedIndex] = useState<number | null>(null);

  // A plan is only meaningful against a readable online amp; the panel above
  // already explains the other states.
  const plannable = lock?.state === "mismatch" || lock?.state === "matches";
  const liveHash = lock?.live?.ampHash ?? null;

  const load = useCallback(async () => {
    const response = await commands.projectsPlanAmpPush(projectId, assignmentId);
    if (response.status === "error") {
      setPlan(null);
      setPlanError(response.error.message);
      return;
    }
    setPlan(response.data);
    setPlanError(null);
    // A fresh plan is fresh work: keeping the last run's ticks and crosses
    // against it would mark stages that no longer mean the same thing. After
    // a push that stopped partway this is what makes the list read as "what's
    // still left" — the panel above is what reports the failure.
    setProgress({});
    setFailedIndex(null);
  }, [projectId, assignmentId]);

  // Never re-plan mid-push: the writes suppress the FC=27 poll, so a plan
  // built now would diff against a stale snapshot and could drop stages the
  // list is already showing as running.
  useEffect(() => {
    if (!plannable || running) return;
    let cancelled = false;
    void (async () => {
      if (cancelled) return;
      await load();
    })();
    return () => {
      cancelled = true;
    };
  }, [plannable, running, liveHash, reloadKey, load]);

  // Cleared on a new attempt, not on every render, so a finished run keeps
  // its checkmarks until the next one starts.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (running && !wasRunning.current) {
      setProgress({});
      setFailedIndex(null);
    }
    wasRunning.current = running;
  }, [running]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      const stop = await listen<PushProgress>("amp_push:progress", (event) => {
        const update = event.payload;
        if (update.assignmentId !== assignmentId) return;
        setProgress((current) => ({
          ...current,
          [update.stageId]: { state: update.state, done: update.packetsDone },
        }));
        if (update.state === "failed") setFailedIndex(update.stageIndex);
      });
      if (cancelled) stop();
      else unlisten = stop;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [assignmentId]);

  if (planError) {
    return (
      <Alert status="danger">
        <Alert.Content>
          <Alert.Title>Can't plan the push</Alert.Title>
          <Alert.Description>{planError}</Alert.Description>
        </Alert.Content>
      </Alert>
    );
  }
  if (!plan) return null;

  if (plan.stages.length === 0) {
    return (
      <span
        style={{ fontSize: "var(--amp-font-size-sm)", color: "var(--amp-color-dimmed)", textAlign: "center" }}
      >
        Nothing to write — every setting the amp can take already matches this project amp.
      </span>
    );
  }

  // Stages arrive in send order and are already grouped by amp/channel, so
  // consecutive runs of one group become one section.
  const groups: { name: string; stages: { stage: PushStage; index: number }[] }[] = [];
  plan.stages.forEach((stage, index) => {
    const last = groups[groups.length - 1];
    if (last && last.name === stage.group) last.stages.push({ stage, index });
    else groups.push({ name: stage.group, stages: [{ stage, index }] });
  });

  const stateFor = (stage: PushStage, index: number): StageState => {
    const reported = progress[stage.id];
    if (reported) return reported.state;
    // Everything after a failure never ran — shown as skipped rather than
    // left looking pending forever.
    if (failedIndex !== null && index > failedIndex) return "skipped";
    return "pending";
  };

  const sectionLabelStyle: CSSProperties = {
    fontSize: "var(--amp-font-size-xs)",
    fontWeight: 600,
    color: "var(--amp-color-dimmed)",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  };

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span style={sectionLabelStyle}>Write plan</span>
        <span style={{ fontSize: "var(--amp-font-size-xs)", color: "var(--amp-color-dimmed)" }}>
          {plan.stages.length} {plan.stages.length === 1 ? "step" : "steps"} · {plan.packetCount}{" "}
          {plan.packetCount === 1 ? "write" : "writes"}
        </span>
      </div>

      {/* Its own scroll container: a full 4-channel push is ~26 rows, which
          must not stretch the modal on a short window. */}
      <div className="max-h-[320px] min-w-0 overflow-y-auto">
        <div className="flex min-w-0 flex-col gap-0.5">
          {groups.map((group) => (
            <Fragment key={`${group.name}-${group.stages[0].index}`}>
              <span style={{ ...sectionLabelStyle, paddingInline: 8, paddingTop: 8 }}>{group.name}</span>
              {group.stages.map(({ stage, index }) => {
                const state = stateFor(stage, index);
                const done = progress[stage.id]?.done ?? 0;
                const tint =
                  state === "failed"
                    ? "bg-[var(--amp-color-red-light)]"
                    : state === "running"
                      ? "bg-[var(--accent-soft)]"
                      : "";
                return (
                  <div
                    key={stage.id}
                    className={`flex min-w-0 flex-nowrap items-center gap-2 rounded-[var(--amp-radius-sm)] px-2 py-1 transition-colors duration-300 ${tint}`}
                  >
                    <span className="flex size-4 shrink-0 items-center justify-center">
                      <StageIcon state={state} />
                    </span>
                    <span
                      className="min-w-0 grow truncate"
                      style={{
                        fontSize: "var(--amp-font-size-sm)",
                        color: state === "skipped" ? "var(--amp-color-dimmed)" : undefined,
                      }}
                    >
                      {stage.label}
                    </span>
                    <StageCount state={state} done={done} total={stage.packets} />
                  </div>
                );
              })}
            </Fragment>
          ))}
        </div>
      </div>

      {plan.adopted.length > 0 && (
        <Alert status="accent">
          <Alert.Content>
            <Alert.Title>Taken from the amp instead</Alert.Title>
            <Alert.Description>
              <div className="flex flex-col gap-1">
                <span style={{ fontSize: "var(--amp-font-size-xs)" }}>
                  The amp can't be told to change these — they describe the hardware itself. Pushing updates the
                  project amp to match what the amp reports.
                </span>
                {plan.adopted.map((row) => (
                  <span key={`${row.group}:${row.label}`} style={{ fontSize: "var(--amp-font-size-xs)" }}>
                    <span style={{ fontWeight: 500 }}>
                      {row.group} · {row.label}
                    </span>
                    {" — "}
                    {row.project ?? "—"} → {row.live ?? "—"}
                  </span>
                ))}
              </div>
            </Alert.Description>
          </Alert.Content>
        </Alert>
      )}
    </div>
  );
}
