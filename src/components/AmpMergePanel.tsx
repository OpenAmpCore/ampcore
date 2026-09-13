import { useEffect, useState, type ReactNode } from "react";
import { Button, Loader, SegmentedControl, Stack, Text, ThemeIcon } from "@mantine/core";
import { ArrowLeft, ArrowRight, Check, Network, Server, X } from "lucide-react";
import {
  commands,
  type AmpEditLock,
  type AmpMergeResult,
  type AmpPushResult,
  type Project,
} from "../lib/bindings";
import { useHoldToConfirm } from "../hooks/useHoldToConfirm";

const HOLD_MS = 1000;

/** Which way the data travels. `pull` copies the online amp into the project
 * (`projects_merge_amp_from_live`); `push` makes the amp adopt the project
 * (`projects_push_amp_to_live`). */
export type MergeDirection = "pull" | "push";

type Outcome =
  | { kind: "merged"; ampHash: string | null }
  | { kind: "diverged"; count: number }
  | { kind: "error"; message: string }
  /** A push that stopped partway: some writes landed, one failed. */
  | { kind: "partial"; stage: string | null; message: string; stagesCompleted: number; stagesTotal: number };

type StripState = "blocked" | "idle" | "holding" | "pending" | "merged" | "inSync" | "failed";

/** Why the match can't run right now, or `null` when it can (or already did). */
function blockedReason(lock: AmpEditLock | null): string | null {
  if (!lock) return "Comparing the amps…";
  switch (lock.state) {
    case "unlinked":
      return "Link this amp to a network amp first.";
    case "offline":
      return "The linked amp is offline.";
    case "checking":
      return "Waiting for the amp's first settings reading…";
    case "unreadable":
      return lock.unreadable[0] ?? "The amps can't be compared completely yet.";
    default:
      return null;
  }
}

function caption(
  state: StripState,
  outcome: Outcome | null,
  reason: string | null,
  direction: MergeDirection,
): { text: string; color?: string } {
  const pull = direction === "pull";
  switch (state) {
    case "pending":
      return {
        text: pull
          ? "Copying the online settings and re-checking the fingerprint…"
          : "Writing the plan to the amp, one setting at a time…",
      };
    case "merged":
      return {
        text:
          outcome?.kind === "merged" && outcome.ampHash
            ? `Matched — both amps now share ${outcome.ampHash}`
            : "Matched — both amps now share one fingerprint",
        color: "green",
      };
    case "inSync":
      return { text: "The offline amp already matches the online amp.", color: "green" };
    case "failed":
      if (outcome?.kind === "partial") {
        const where = outcome.stage ? ` at ${outcome.stage}` : "";
        return {
          text: `Stopped${where} after ${outcome.stagesCompleted} of ${outcome.stagesTotal} steps — ${outcome.message}. Everything before it was written; hold again to carry on.`,
          color: "red",
        };
      }
      if (outcome?.kind === "diverged") {
        const noun = outcome.count === 1 ? "setting" : "settings";
        return {
          text: pull
            ? `${outcome.count} ${noun} couldn't be matched — nothing was saved.`
            : `Every write landed, but ${outcome.count} ${noun} still differ.`,
          color: "red",
        };
      }
      return { text: outcome?.kind === "error" ? outcome.message : "Matching failed.", color: "red" };
    case "blocked":
      return { text: reason ?? "" };
    default:
      return {
        text: pull
          ? "Replaces every setting in this project amp with the online amp's."
          : "Replaces every differing setting on the online amp with this project's.",
      };
  }
}

/** One side of the strip. `pulseKey` replays a green ring pulse whenever it
 * changes — used on whichever side just received data.
 *
 * `role` is the static half of "which way does this go": one word under each
 * end naming what it is in *this* transfer. The flowing dashes on the track
 * say the same thing, but only while they're moving — this survives a
 * screenshot, a reduced-motion setting, and a glance. */
function AmpEnd({
  icon,
  label,
  color,
  role,
  pulseKey,
}: {
  icon: ReactNode;
  label: string;
  color: string;
  role?: "source" | "destination";
  pulseKey?: string;
}) {
  return (
    <Stack gap={4} align="center" className="shrink-0">
      <span
        key={pulseKey}
        className={`rounded-[var(--mantine-radius-sm)] ${
          pulseKey ? "animate-[merge-pulse_900ms_ease-out_450ms_2] motion-reduce:animate-none" : ""
        }`}
      >
        <ThemeIcon variant="light" color={color} size={40} className="transition-colors duration-300">
          {icon}
        </ThemeIcon>
      </span>
      <Text size="xs" c="dimmed" ta="center">
        {label}
      </Text>
      {/* Amber on the side that loses its settings — the same "this changes
          something" accent the tiles use — and a plain dimmed word on the
          side that doesn't. */}
      {role && (
        <Text
          fz={10}
          fw={700}
          tt="uppercase"
          ta="center"
          c={role === "destination" ? "amber" : "dimmed"}
        >
          {role === "destination" ? "Overwritten" : "Source"}
        </Text>
      )}
    </Stack>
  );
}

function CenterNode({ state, direction }: { state: StripState; direction: MergeDirection }) {
  const base =
    "flex size-7 items-center justify-center rounded-full border-2 border-solid transition-colors duration-300";
  switch (state) {
    case "pending":
      return (
        <div className={`${base} border-[var(--mantine-color-amber-filled)] bg-[var(--mantine-color-body)]`}>
          <Loader size={12} color="amber" />
        </div>
      );
    case "merged":
      return (
        <div
          className={`${base} animate-[link-pop_320ms_ease-out_450ms_both] border-transparent bg-[var(--mantine-color-green-filled)] motion-reduce:animate-none`}
        >
          <Check size={16} strokeWidth={3} color="white" />
        </div>
      );
    case "inSync":
      return (
        <div className={`${base} border-transparent bg-[var(--mantine-color-green-filled)]`}>
          <Check size={16} strokeWidth={3} color="white" />
        </div>
      );
    case "failed":
      return (
        <div
          className={`${base} animate-[merge-shake_360ms_ease-in-out] border-transparent bg-[var(--mantine-color-red-filled)] motion-reduce:animate-none`}
        >
          <X size={16} strokeWidth={3} color="white" />
        </div>
      );
    default: {
      const tone =
        state === "holding"
          ? "border-[var(--mantine-color-amber-filled)] text-[var(--mantine-color-amber-filled)]"
          : "border-[var(--mantine-color-default-border)] text-[var(--mantine-color-dimmed)]";
      const Arrow = direction === "pull" ? ArrowLeft : ArrowRight;
      return (
        <div className={`${base} ${tone} bg-[var(--mantine-color-body)]`}>
          <Arrow size={14} strokeWidth={2.5} />
        </div>
      );
    }
  }
}

/** `[offline] ◂◂◂ ── node ── ◂◂◂ [online]` for a pull, and the same mirrored
 * for a push. Every motion runs the way the data travels: the dashes drift
 * toward the receiving amp, the hold fills from the sending side, a shimmer
 * carries the request, and the result fills green (or flashes red). */
function MergeStrip({
  state,
  progress,
  attempt,
  direction,
}: {
  state: StripState;
  progress: number;
  attempt: number;
  direction: MergeDirection;
}) {
  const green = state === "merged" || state === "inSync";
  const drifting = state === "idle" || state === "holding";
  const pull = direction === "pull";
  // The fill grows from the sending amp, so its transform origin is that side.
  const origin = pull ? "origin-right" : "origin-left";
  const pulse = state === "merged" ? `merged-${attempt}` : undefined;
  // Once the two match there is no source and no destination any more, so the
  // roles drop away rather than claiming something is about to be overwritten.
  const showRoles = !green;

  return (
    <div className="flex w-full max-w-[520px] min-w-0 items-start gap-3">
      <AmpEnd
        icon={<Server size={20} />}
        label="Offline Amp"
        color={green ? "green" : state === "failed" ? "red" : "gray"}
        role={showRoles ? (pull ? "destination" : "source") : undefined}
        pulseKey={pull ? pulse : undefined}
      />

      <div className="relative mt-1 h-8 min-w-0 flex-1">
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-[var(--mantine-color-default-border)]">
          {drifting && (
            <div
              className={`absolute inset-0 opacity-80 motion-reduce:animate-none ${
                pull ? "animate-[merge-flow_900ms_linear_infinite]" : "animate-[push-flow_900ms_linear_infinite]"
              }`}
              style={{
                backgroundImage:
                  "repeating-linear-gradient(90deg, var(--mantine-color-gray-5) 0 6px, transparent 6px 18px)",
              }}
            />
          )}
          {/* The hold fill: follows the hook's progress frame by frame while
              held, and eases back on an early release. */}
          <div
            className={`absolute inset-0 ${origin} bg-[var(--mantine-color-amber-filled)] ${
              state === "holding" ? "" : "transition-transform duration-200"
            }`}
            style={{ transform: `scaleX(${state === "holding" || state === "idle" ? progress : 0})` }}
          />
          {state === "pending" && (
            <div
              className={`absolute inset-y-0 left-0 w-1/4 motion-reduce:animate-none ${
                pull ? "animate-[merge-shimmer_900ms_linear_infinite]" : "animate-[link-shimmer_900ms_linear_infinite]"
              }`}
              style={{
                background: "linear-gradient(90deg, transparent, var(--mantine-color-amber-filled), transparent)",
              }}
            />
          )}
          {state === "merged" && (
            <div
              key={`fill-${attempt}`}
              className={`absolute inset-0 ${origin} animate-[link-fill_500ms_ease-out_both] bg-[var(--mantine-color-green-filled)] motion-reduce:animate-none`}
            />
          )}
          {state === "inSync" && <div className="absolute inset-0 bg-[var(--mantine-color-green-filled)]" />}
          {state === "failed" && <div className="absolute inset-0 bg-[var(--mantine-color-red-filled)]" />}
        </div>

        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
          <CenterNode key={`${state}-${attempt}`} state={state} direction={direction} />
        </div>
      </div>

      <AmpEnd
        icon={<Network size={20} />}
        label="Online Amp"
        color={green ? "green" : !pull && state === "failed" ? "red" : "gray"}
        role={showRoles ? (pull ? "source" : "destination") : undefined}
        pulseKey={pull ? undefined : pulse}
      />
    </div>
  );
}

/** Top of the "Offline Amp vs. Online Amp" modal: matches the offline project
 * amp to its linked online amp, in either direction. Hold-to-confirm, since
 * both directions overwrite every differing setting of whichever side
 * receives — and in the push direction that side is real hardware. */
export function AmpMergePanel({
  lock,
  projectId,
  assignmentId,
  direction,
  onDirectionChange,
  pushBlocked,
  onProjectUpdate,
  onResult,
  onPushStateChange,
}: {
  lock: AmpEditLock | null;
  projectId: string;
  assignmentId: string;
  direction: MergeDirection;
  onDirectionChange: (direction: MergeDirection) => void;
  /** Why pushing isn't available, disabling that direction — currently only
   * while the project amp is following the online one, where it is a mirror
   * rather than a plan and `useLinkedSync` would pull any difference straight
   * back out. `null`/undefined when a push is available. */
  pushBlocked?: string | null;
  onProjectUpdate: (project: Project) => void;
  /** Every settled pull attempt (`null` when a new one starts), so the modal
   * can show the rows that still differ after a failed match. */
  onResult: (result: AmpMergeResult | null) => void;
  /** Whether a push is in flight, and a counter bumped on each settled
   * attempt — the step list uses both to know when to re-plan. */
  onPushStateChange?: (running: boolean, attempt: number) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [attempt, setAttempt] = useState(0);

  // A new online reading, another amp, or a change of direction makes an old
  // outcome stale. A successful pull changes only the offline hash, so it
  // keeps showing.
  const liveHash = lock?.live?.ampHash ?? null;
  useEffect(() => {
    setOutcome(null);
  }, [liveHash, assignmentId, direction]);

  const blockedHere = direction === "push" ? (pushBlocked ?? null) : null;
  const reason = blockedHere ?? blockedReason(lock);
  const runnable = !blockedHere && lock?.state === "mismatch" && !busy && outcome?.kind !== "merged";

  async function run() {
    setBusy(true);
    setOutcome(null);
    const next = attempt + 1;
    setAttempt(next);
    onResult(null);
    onPushStateChange?.(direction === "push", next);

    if (direction === "pull") {
      const response = await commands.projectsMergeAmpFromLive(projectId, assignmentId);
      setBusy(false);
      if (response.status === "error") {
        setOutcome({ kind: "error", message: response.error.message });
        return;
      }
      const result = response.data;
      onResult(result);
      if (result.merged && result.project) {
        onProjectUpdate(result.project);
        setOutcome({ kind: "merged", ampHash: result.ampHash });
      } else {
        setOutcome({ kind: "diverged", count: result.remaining.filter((row) => row.differs).length });
      }
      return;
    }

    const response = await commands.projectsPushAmpToLive(projectId, assignmentId);
    setBusy(false);
    onPushStateChange?.(false, next);
    if (response.status === "error") {
      setOutcome({ kind: "error", message: response.error.message });
      return;
    }
    handlePushResult(response.data);
  }

  function handlePushResult(result: AmpPushResult) {
    // The project is saved whether or not every write landed — the amp's state
    // moved, and the three device-determined fields are read back from it.
    if (result.project) onProjectUpdate(result.project);
    if (result.pushed) {
      setOutcome({ kind: "merged", ampHash: result.ampHash });
      return;
    }
    if (result.error) {
      setOutcome({
        kind: "partial",
        stage: result.failedStageLabel,
        message: result.error,
        stagesCompleted: result.stagesCompleted,
        stagesTotal: result.stagesTotal,
      });
      return;
    }
    // Every write was acknowledged but the amp didn't end up where the plan
    // said — the honest outcome, and the row table below shows what's left.
    onResult({ merged: false, project: null, ampHash: null, remaining: result.remaining });
    setOutcome({ kind: "diverged", count: result.remaining.filter((row) => row.differs).length });
  }

  const hold = useHoldToConfirm({ durationMs: HOLD_MS, disabled: !runnable, onConfirm: () => void run() });

  // Compared by hash rather than by `state === "matches"`: a disengaged amp
  // reports `disengaged` whether or not the two agree, and offering a merge
  // for settings that are already identical would be a lie.
  const hashesAgree =
    lock?.project?.ampHash != null && lock.project.ampHash === lock.live?.ampHash;

  const state: StripState = busy
    ? "pending"
    : outcome?.kind === "merged"
      ? "merged"
      : hashesAgree
        ? "inSync"
        : outcome
          ? "failed"
          : reason
            ? "blocked"
            : hold.holding
              ? "holding"
              : "idle";
  const { text, color } = caption(state, outcome, reason, direction);
  const done = state === "merged" || state === "inSync";
  const Arrow = direction === "pull" ? ArrowLeft : ArrowRight;
  // "Match offline to online" was ambiguous English — it can mean "make
  // offline resemble online" or "pair the two". Name the side that loses its
  // settings instead.
  const idleLabel =
    direction === "pull" ? "Hold to overwrite the offline amp" : "Hold to overwrite the online amp";
  const retryLabel = outcome?.kind === "partial" ? "Hold to carry on" : "Hold to try again";

  return (
    <Stack gap="sm" align="center" className="min-w-0 py-1">
      <SegmentedControl
        size="xs"
        radius="xl"
        value={direction}
        onChange={(value) => onDirectionChange(value as MergeDirection)}
        // Switching direction mid-write would leave the step list describing a
        // run that is no longer the one in flight.
        disabled={busy}
        // Deliberately *not* "Offline ← Online" / "Online ← Offline": two
        // labels built from the same two words in swapped order can only be
        // told apart by decoding an arrow, and `dest ← src` is a convention
        // the panel never states. These share no words, so they read
        // differently at a glance, and from/to carries the direction in
        // plain English. Which side gets overwritten is named by the role
        // badges in the strip below.
        data={[
          { value: "pull", label: "Read from Amp" },
          { value: "push", label: "Write to Amp", disabled: Boolean(pushBlocked) },
        ]}
      />

      <MergeStrip state={state} progress={hold.progress} attempt={attempt} direction={direction} />

      {/* The whole ring is the hold target, not just the button inside it,
          and the button keeps one width while its label changes — a hit area
          that shrank under the pointer mid-hold used to cancel the hold. */}
      <div
        className={`inline-flex max-w-full touch-none rounded-full p-[3px] select-none ${
          runnable ? "cursor-pointer" : ""
        }`}
        style={{
          background: done
            ? "var(--mantine-color-green-filled)"
            : `conic-gradient(var(--mantine-color-amber-filled) ${hold.progress * 360}deg, var(--mantine-color-default-border) 0deg)`,
        }}
        {...(done ? {} : hold.bind)}
      >
        {done ? (
          <Button
            component="div"
            w={272}
            maw="100%"
            radius="xl"
            color="green"
            variant="light"
            leftSection={<Check size={14} />}
          >
            {state === "merged" ? "Matched" : "In sync"}
          </Button>
        ) : (
          <Button
            w={272}
            maw="100%"
            radius="xl"
            color="amber"
            variant={state === "holding" ? "filled" : "light"}
            loading={busy}
            disabled={!runnable}
            leftSection={<Arrow size={14} />}
            // Mantine nudges a pressed button down 1px, which reads as the
            // button slipping inside the ring while held.
            className="active:transform-none"
          >
            {state === "holding" ? "Keep holding…" : state === "failed" ? retryLabel : idleLabel}
          </Button>
        )}
      </div>

      <Text size="sm" ta="center" c={color ?? "dimmed"} className="min-w-0">
        {text}
      </Text>
    </Stack>
  );
}
