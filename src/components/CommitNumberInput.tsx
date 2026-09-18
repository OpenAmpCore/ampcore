import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { FIELD_INPUT } from "./fieldClasses";

type CommitNumberInputProps = {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  /** Appended after the number, inside the field (e.g. " Hz", " dB"). */
  suffix?: string;
  className?: string;
  /** Opt-in up/down arrows. Off by default so existing callers keep the
   * plain field — see the stepper note in the component doc. */
  showStepper?: boolean;
  /** Called once per committed edit, never per keystroke. */
  onCommit: (value: number) => void;
};

/** How long after the last arrow press the stepped value is committed. Long
 * enough that clicking up five times is one write rather than five. */
const STEP_COMMIT_DELAY_MS = 400;

/** `0.01` → 2, so repeated steps don't drift into 0.30000000000000004. */
function decimalsOf(step: number) {
  return (String(step).split(".")[1] ?? "").length;
}

/**
 * A number field that reports its value on **commit** (blur or Enter) rather
 * than on every keystroke.
 *
 * A bare `onChange` fires once per character: typing `1000` into a frequency
 * field produces four separate writes (1, 10, 100, 1000), and a held stepper
 * produces one per repeat. On the live path each of those is a UDP packet
 * that the backend's write queue can only retire one ACK round trip at a
 * time, and each one extends the window in which background polling is
 * suspended (see `WriteRegistry::has_pending`).
 *
 * This mirrors the discipline `EqEditor`'s graph drag already uses — preview
 * locally, commit once — and the vendor app's own approach of disabling the
 * page during a transaction so it cannot emit a burst at all.
 *
 * Escape reverts to the last upstream value without committing.
 *
 * `showStepper` adds arrows for values that are tedious to type (a 0.01 ms
 * source delay). They hold to the same one-write discipline: each press only
 * moves the local draft and (re)starts a `STEP_COMMIT_DELAY_MS` timer, so a
 * burst of presses still commits once, with the final value. While that timer
 * is pending the upstream re-sync is suspended for the same reason it is
 * during typing — a poll landing mid-step would otherwise yank the draft back.
 *
 * A plain `<input>` rather than HeroUI's `NumberField`: that component's
 * built-in commit-on-blur/Enter (`useNumberFieldState`'s `commit()`) doesn't
 * expose a way to reset its internal display text on Escape without
 * committing, which this relies on — so the hand-rolled draft/commit/cancel
 * state below (identical to the pre-HeroUI version) stays, just re-skinned.
 */
export function CommitNumberInput({
  value,
  min,
  max,
  step,
  suffix,
  className,
  showStepper,
  onCommit,
}: CommitNumberInputProps) {
  const [draft, setDraft] = useState<string>(String(value));
  const focused = useRef(false);
  const cancelled = useRef(false);
  const stepTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearStepTimer = () => {
    if (stepTimer.current !== null) {
      clearTimeout(stepTimer.current);
      stepTimer.current = null;
    }
  };

  // Re-sync from upstream only while the field is NOT being edited. Without
  // this guard the ~200ms config poll would overwrite whatever the user is
  // halfway through typing — or has just stepped but not yet committed.
  useEffect(() => {
    if (!focused.current && stepTimer.current === null) setDraft(String(value));
  }, [value]);

  useEffect(() => clearStepTimer, []);

  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));

  const commit = () => {
    clearStepTimer();
    const next = Number.parseFloat(draft);
    if (Number.isFinite(next)) {
      const clamped = clamp(next);
      if (clamped !== value) {
        onCommit(clamped);
        return;
      }
    }
    setDraft(String(value));
  };

  const nudge = (direction: 1 | -1) => {
    const increment = step ?? 1;
    const parsed = Number.parseFloat(draft);
    const base = Number.isFinite(parsed) ? parsed : value;
    const next = clamp(Number((base + direction * increment).toFixed(decimalsOf(increment))));
    setDraft(String(next));
    clearStepTimer();
    stepTimer.current = setTimeout(() => {
      stepTimer.current = null;
      if (next !== value) onCommit(next);
    }, STEP_COMMIT_DELAY_MS);
  };

  const stepperWidth = showStepper ? 15 : 0;

  const suffixStyle: CSSProperties = {
    position: "absolute",
    right: 8 + stepperWidth,
    top: "50%",
    transform: "translateY(-50%)",
    color: "var(--amp-color-dimmed)",
    fontSize: "var(--amp-font-size-sm)",
    pointerEvents: "none",
  };

  return (
    <div className="relative">
      <input
        type="text"
        inputMode="decimal"
        value={draft}
        step={step}
        className={`${FIELD_INPUT} ${className ?? ""}`}
        style={{ paddingRight: suffix || showStepper ? `${(suffix?.length ?? 0) * 7 + 12 + stepperWidth}px` : undefined }}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          if (cancelled.current) {
            cancelled.current = false;
            setDraft(String(value));
            return;
          }
          commit();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            cancelled.current = true;
            event.currentTarget.blur();
          } else if (showStepper && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
            // The field is `type="text"`, so arrows would otherwise just move
            // the caret. Same coalescing as the buttons.
            event.preventDefault();
            nudge(event.key === "ArrowUp" ? 1 : -1);
          }
        }}
      />
      {suffix && <span style={suffixStyle}>{suffix}</span>}
      {showStepper && (
        <div className="absolute top-px right-px bottom-px flex w-[15px] flex-col justify-center">
          {([1, -1] as const).map((direction) => (
            <button
              key={direction}
              type="button"
              tabIndex={-1}
              aria-label={direction === 1 ? "Increase" : "Decrease"}
              // Keeps focus (and therefore the draft) in the input: letting
              // the button take focus would blur-commit the typed value and
              // then commit the step, i.e. two writes for one gesture.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => nudge(direction)}
              className="flex flex-1 items-center justify-center text-[var(--amp-color-dimmed)] hover:text-[var(--amp-color-text)]"
            >
              {direction === 1 ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
