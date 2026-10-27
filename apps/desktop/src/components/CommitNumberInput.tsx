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
  /** `"log"` steps by fractions of an octave instead of adding `step` — for
   * frequencies, where 1 Hz is nothing at 10 kHz and a lot at 20 Hz. Values
   * stay whole Hz. */
  scale?: "linear" | "log";
  /** Whole numbers only: a committed value is rounded — before clamping, so
   * the result still respects `min`/`max` — and touch keyboards get a
   * digits-only pad. */
  integer?: boolean;
  disabled?: boolean;
  /** How a number is shown in the field. Pass the same rounding the caller
   * applies to `value`, so a committed number is shown at that precision
   * rather than as typed. Defaults to one decimal more than `step`, enough
   * for a fine step and short of f32 noise (0.00999999977). */
  format?: (value: number) => string;
  /** For a field with no visible `<label>` of its own. */
  "aria-label"?: string;
  /** Called once per committed edit, never per keystroke. */
  onCommit: (value: number) => void;
};

/** How long after the last arrow press the stepped value is committed. Long
 * enough that clicking up five times is one write rather than five. */
export const STEP_COMMIT_DELAY_MS = 400;

/** First repeat of a held arrow, then each repeat a little faster down to
 * the floor. */
const REPEAT_DELAY_MS = 400;
const REPEAT_START_MS = 100;
const REPEAT_MIN_MS = 30;

/** Octaves per step on a `scale="log"` field: 1/12, fine 1/48, coarse 1/3. */
const LOG_STEP_OCTAVES = 1 / 12;

/** `0.01` → 2, so repeated steps don't drift into 0.30000000000000004. */
function decimalsOf(step: number) {
  return (String(step).split(".")[1] ?? "").length;
}

/** How far one step reaches: Shift is fine, Ctrl/Cmd (or PageUp/PageDown)
 * coarse — the audio-software convention. */
type StepSize = "fine" | "normal" | "coarse";

export function stepSizeOf(event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): StepSize {
  if (event.shiftKey) return "fine";
  if (event.ctrlKey || event.metaKey) return "coarse";
  return "normal";
}

/** `base` moved one step up or down. Linear steps are `step` ÷10 / ×10
 * (never below 1 on an integer field); log steps are octave fractions,
 * rounded to whole numbers and always moving at least 1. */
export function stepped(
  base: number,
  direction: 1 | -1,
  size: StepSize,
  step: number,
  scale: "linear" | "log" = "linear",
  integer = false,
): number {
  if (scale === "log") {
    const octaves = LOG_STEP_OCTAVES * (size === "fine" ? 0.25 : size === "coarse" ? 4 : 1);
    const next = Math.round(base * 2 ** (direction * octaves));
    return next === Math.round(base) ? next + direction : next;
  }
  let increment = Number((step * (size === "fine" ? 0.1 : size === "coarse" ? 10 : 1)).toPrecision(12));
  if (integer) increment = Math.max(1, Math.round(increment));
  // Keep the field's own precision too: a coarse step of 1 from 1.23 is 2.23.
  return Number((base + direction * increment).toFixed(Math.max(decimalsOf(increment), decimalsOf(step) + 1)));
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
 * Every field steps — arrow buttons (held to repeat), ↑/↓, PageUp/PageDown
 * and the wheel while focused — with Shift for a fine step and Ctrl/Cmd for
 * a coarse one (`stepped`). They hold to the same one-write discipline: each
 * step only moves the local draft and (re)starts a `STEP_COMMIT_DELAY_MS`
 * timer, so a burst of presses or a held arrow still commits once, with the
 * final value. While that timer
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
  step = 1,
  suffix,
  className,
  scale = "linear",
  integer = false,
  disabled,
  format = integer || scale === "log"
    ? (n: number) => String(Math.round(n))
    : (n: number) => String(Number(n.toFixed(decimalsOf(step) + 1))),
  "aria-label": ariaLabel,
  onCommit,
}: CommitNumberInputProps) {
  const [draft, setDraftState] = useState<string>(format(value));
  // Read by a held arrow's repeats, whose closure would see a stale `draft`.
  const draftRef = useRef(draft);
  const setDraft = (text: string) => {
    draftRef.current = text;
    setDraftState(text);
  };
  const input = useRef<HTMLInputElement>(null);
  const focused = useRef(false);
  const cancelled = useRef(false);
  const stepTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const repeatTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = (timer: typeof stepTimer) => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const clearStepTimer = () => clear(stepTimer);
  const stopRepeat = () => clear(repeatTimer);

  // Re-sync from upstream only while the field is NOT being edited. Without
  // this guard the ~200ms config poll would overwrite whatever the user is
  // halfway through typing — or has just stepped but not yet committed.
  useEffect(() => {
    if (!focused.current && stepTimer.current === null) setDraft(format(value));
  }, [value]);

  useEffect(
    () => () => {
      clearStepTimer();
      stopRepeat();
    },
    [],
  );

  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));

  const commit = () => {
    clearStepTimer();
    // The shown text left as is (or typed back) is not an edit. Comparing the
    // parsed number instead would write on every blur for a value sitting on
    // an un-round bound: the shown, rounded figure clamps back to the exact
    // bound, which never equals it (Peak's floor is Vrms·√2).
    if (draft === format(value)) return;
    const parsed = Number.parseFloat(draft);
    const next = integer ? Math.round(parsed) : parsed;
    if (Number.isFinite(next)) {
      const clamped = clamp(next);
      if (clamped !== value) {
        onCommit(clamped);
        // Show what was sent, not what was typed. The re-sync above only runs
        // when `value` changes, and committing a bound the field already sits
        // at (a too-low entry clamped to the same floor again) leaves it
        // unchanged — so without this the typed text would stay up for good.
        setDraft(format(clamped));
        return;
      }
    }
    setDraft(format(value));
  };

  const nudge = (direction: 1 | -1, size: StepSize) => {
    if (disabled) return;
    const parsed = Number.parseFloat(draftRef.current);
    const base = Number.isFinite(parsed) ? parsed : value;
    const next = clamp(stepped(base, direction, size, step, scale, integer));
    setDraft(format(next));
    clearStepTimer();
    stepTimer.current = setTimeout(() => {
      stepTimer.current = null;
      if (next !== value) onCommit(next);
    }, STEP_COMMIT_DELAY_MS);
  };

  // Pressing an arrow steps once; holding it repeats, faster the longer it
  // is held. Every repeat goes through `nudge`, so a hold still commits once.
  const startRepeat = (direction: 1 | -1, size: StepSize) => {
    stopRepeat();
    nudge(direction, size);
    let interval = REPEAT_START_MS;
    const repeat = () => {
      nudge(direction, size);
      interval = Math.max(REPEAT_MIN_MS, interval * 0.9);
      repeatTimer.current = setTimeout(repeat, interval);
    };
    repeatTimer.current = setTimeout(repeat, REPEAT_DELAY_MS);
  };

  // The wheel steps only while the field has focus, so scrolling the page
  // past a field never changes it. A native listener, since React's wheel
  // handler is passive and can't stop the page scrolling instead.
  const wheelStep = useRef(nudge);
  wheelStep.current = nudge;
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (document.activeElement !== element || event.deltaY === 0) return;
      event.preventDefault();
      wheelStep.current(event.deltaY < 0 ? 1 : -1, stepSizeOf(event));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  const stepperWidth = 18;

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
        inputMode={integer ? "numeric" : "decimal"}
        aria-label={ariaLabel}
        value={draft}
        disabled={disabled}
        step={step}
        className={`${FIELD_INPUT} ${className ?? ""}`}
        ref={input}
        style={{ paddingRight: `${(suffix?.length ?? 0) * 7 + 12 + stepperWidth}px` }}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={(event) => {
          focused.current = false;
          // A field disabled while focused (say, a poll turned its limiter
          // stage off mid-edit) gets blurred by the browser's focus fix-up —
          // WKWebView and Chromium both do it. Committing then would send a
          // half-typed draft, so treat it like Escape.
          if (cancelled.current || event.currentTarget.disabled) {
            cancelled.current = false;
            clearStepTimer();
            setDraft(format(value));
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
          } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            // The field is `type="text"`, so arrows would otherwise just move
            // the caret. Same coalescing as the buttons.
            event.preventDefault();
            nudge(event.key === "ArrowUp" ? 1 : -1, stepSizeOf(event));
          } else if (event.key === "PageUp" || event.key === "PageDown") {
            event.preventDefault();
            nudge(event.key === "PageUp" ? 1 : -1, "coarse");
          }
        }}
      />
      {suffix && <span style={suffixStyle}>{suffix}</span>}
      <div className="absolute top-px right-px bottom-px flex flex-col" style={{ width: stepperWidth }}>
        {([1, -1] as const).map((direction) => (
          <button
            key={direction}
            type="button"
            tabIndex={-1}
            disabled={disabled}
            aria-label={direction === 1 ? "Increase" : "Decrease"}
            // Keeps focus (and therefore the draft) in the input: letting
            // the button take focus would blur-commit the typed value and
            // then commit the step, i.e. two writes for one gesture.
            onMouseDown={(event) => event.preventDefault()}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              startRepeat(direction, stepSizeOf(event));
            }}
            onPointerUp={stopRepeat}
            onPointerCancel={stopRepeat}
            onLostPointerCapture={stopRepeat}
            className="flex min-h-0 flex-1 items-center justify-center rounded-xs text-[var(--amp-color-dimmed)] hover:bg-[var(--amp-color-default)] hover:text-[var(--amp-color-text)] disabled:opacity-40"
          >
            {direction === 1 ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
        ))}
      </div>
    </div>
  );
}
