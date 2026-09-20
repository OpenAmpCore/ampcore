import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isActionResult } from "../lib/actionResult";

/** Where a tracked request is in its visible lifecycle:
 * `idle` → (`pending`, only if the request is slow) → `success` | `error` →
 * (after the hold) `idle`. */
export type ActionFeedbackStatus = "idle" | "pending" | "success" | "error";

export type ActionFeedbackOutcome = "success" | "error";

export const ACTION_FEEDBACK_TIMING = {
  /** The spinner only appears if the request is still running after this
   * long. A request that finishes sooner goes straight to its result — no
   * spinner flash and, more importantly, no artificial wait: a fast command
   * should feel fast, not be held back to play an animation. */
  spinnerDelayMs: 150,
  /** Once the spinner *has* appeared, it stays at least this long, so a
   * request finishing just after `spinnerDelayMs` doesn't make it blink on
   * and straight back off. Only ever costs a slow request a fraction more. */
  minSpinnerMs: 250,
  /** How long the success / error state is held before returning to idle.
   * Long enough for the result animation to finish (at the current
   * `--action-feedback-duration-scale` the check / cross and their pop /
   * shake all settle by ~190ms) — shorten the animation before shortening
   * this below that, or the result fades out mid-draw. */
  holdMs: 200,
} as const;

/** A controller for one control's request feedback. Pass it to any component
 * that renders `ActionFeedbackContent` (e.g. a tile's `visualValidation`), and
 * route the request through `track` from wherever it is actually fired. */
export interface ActionFeedback {
  readonly status: ActionFeedbackStatus;
  /** True from the moment a request is tracked until it settles — including
   * the first `spinnerDelayMs`, while `status` is still `idle`. Use this, not
   * `status`, to stop a control firing the same request twice. */
  readonly busy: boolean;
  /** Follows an already-started request through to its result and back to
   * idle.
   *
   * A request **fails** when it rejects, or resolves with an `ActionResult`
   * whose `ok` is `false`; anything else it resolves with counts as success.
   * Never rejects itself, so fire-and-forget (`void feedback.track(...)`) is
   * safe. Resolves with the outcome as soon as the result is shown.
   *
   * Tracking again while a request is still running or its result is being
   * held supersedes it: the newest request owns the display, and a stale one
   * finishing late never overwrites it. */
  track(request: PromiseLike<unknown>): Promise<ActionFeedbackOutcome>;
}

export function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

async function settle(request: PromiseLike<unknown>): Promise<ActionFeedbackOutcome> {
  try {
    const value = await request;
    return isActionResult(value) && !value.ok ? "error" : "success";
  } catch {
    return "error";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Timer = ReturnType<typeof setTimeout>;

/** The engine behind every control's pending → success/error animation.
 * Owns timing and sequencing only; how a status *looks* is
 * `ActionFeedbackContent`'s job. */
export function useActionFeedback(): ActionFeedback {
  const [status, setStatus] = useState<ActionFeedbackStatus>("idle");
  const [busy, setBusy] = useState(false);
  // Every `track` call takes the next id; only the newest may touch state.
  const latestRun = useRef(0);
  const spinnerTimer = useRef<Timer | null>(null);
  const holdTimer = useRef<Timer | null>(null);
  const mounted = useRef(false);

  const clearTimers = useCallback(() => {
    for (const timer of [spinnerTimer, holdTimer]) {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    }
  }, []);

  useEffect(() => {
    // Set here rather than at initialization so StrictMode's
    // mount → unmount → mount cycle ends up mounted.
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimers();
    };
  }, [clearTimers]);

  const track = useCallback(
    async (request: PromiseLike<unknown>): Promise<ActionFeedbackOutcome> => {
      const run = ++latestRun.current;
      const isCurrent = () => mounted.current && run === latestRun.current;

      clearTimers();
      setBusy(true);

      // Reveal the spinner only if the request outlives the delay.
      let spinnerShownAt: number | null = null;
      spinnerTimer.current = setTimeout(() => {
        spinnerTimer.current = null;
        if (!isCurrent()) return;
        spinnerShownAt = performance.now();
        setStatus("pending");
      }, ACTION_FEEDBACK_TIMING.spinnerDelayMs);

      const outcome = await settle(request);

      if (run === latestRun.current && spinnerTimer.current !== null) {
        clearTimeout(spinnerTimer.current);
        spinnerTimer.current = null;
      }
      if (spinnerShownAt !== null) {
        const remaining = ACTION_FEEDBACK_TIMING.minSpinnerMs - (performance.now() - spinnerShownAt);
        if (remaining > 0) await delay(remaining);
      }

      if (isCurrent()) {
        setBusy(false);
        setStatus(outcome);
        holdTimer.current = setTimeout(() => {
          holdTimer.current = null;
          if (isCurrent()) setStatus("idle");
        }, ACTION_FEEDBACK_TIMING.holdMs);
      }
      return outcome;
    },
    [clearTimers],
  );

  return useMemo(() => ({ status, busy, track }), [status, busy, track]);
}
