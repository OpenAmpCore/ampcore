import { useEffect, useRef, useState, type CSSProperties } from "react";
import { FIELD_INPUT } from "./fieldClasses";

type CommitNumberInputProps = {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  /** Appended after the number, inside the field (e.g. " Hz", " dB"). */
  suffix?: string;
  className?: string;
  /** Called once per committed edit, never per keystroke. */
  onCommit: (value: number) => void;
};

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
 * A plain `<input>` rather than HeroUI's `NumberField`: that component's
 * built-in commit-on-blur/Enter (`useNumberFieldState`'s `commit()`) doesn't
 * expose a way to reset its internal display text on Escape without
 * committing, which this relies on — so the hand-rolled draft/commit/cancel
 * state below (identical to the pre-HeroUI version) stays, just re-skinned.
 */
export function CommitNumberInput({ value, min, max, step, suffix, className, onCommit }: CommitNumberInputProps) {
  const [draft, setDraft] = useState<string>(String(value));
  const focused = useRef(false);
  const cancelled = useRef(false);

  // Re-sync from upstream only while the field is NOT being edited. Without
  // this guard the ~200ms config poll would overwrite whatever the user is
  // halfway through typing.
  useEffect(() => {
    if (!focused.current) setDraft(String(value));
  }, [value]);

  const commit = () => {
    const next = Number.parseFloat(draft);
    if (Number.isFinite(next)) {
      const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, next));
      if (clamped !== value) {
        onCommit(clamped);
        return;
      }
    }
    setDraft(String(value));
  };

  const suffixStyle: CSSProperties = {
    position: "absolute",
    right: 8,
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
        style={{ paddingRight: suffix ? `${suffix.length * 7 + 12}px` : undefined }}
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
          }
        }}
      />
      {suffix && <span style={suffixStyle}>{suffix}</span>}
    </div>
  );
}
