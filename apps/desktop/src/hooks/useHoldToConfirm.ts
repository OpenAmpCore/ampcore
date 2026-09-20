import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

const HOLD_KEYS = new Set([" ", "Enter"]);

/** Press-and-hold confirmation for an action that overwrites something.
 * `progress` runs 0 → 1 over `durationMs` while the control is held and
 * rewinds over `rewindMs` on an early release; reaching 1 fires `onConfirm`
 * once and resets. Pointer and keyboard (Space/Enter) both hold — spread
 * `bind` onto the control. The pointer is captured on press, so drifting off
 * the control mid-hold (or the control resizing under it) doesn't cancel;
 * only releasing does. Becoming `disabled` mid-hold cancels the hold. */
export function useHoldToConfirm({
  durationMs,
  rewindMs = 200,
  disabled = false,
  onConfirm,
}: {
  durationMs: number;
  rewindMs?: number;
  disabled?: boolean;
  onConfirm: () => void;
}) {
  const [progress, setProgress] = useState(0);
  const [holding, setHolding] = useState(false);
  const progressRef = useRef(0);
  const holdingRef = useRef(false);
  const frame = useRef<number | null>(null);
  const confirmRef = useRef(onConfirm);
  confirmRef.current = onConfirm;

  const cancelFrame = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);

  const commit = useCallback((value: number) => {
    progressRef.current = value;
    setProgress(value);
  }, []);

  /** Moves progress linearly from wherever it is toward `target`, at a pace
   * where the full 0..1 range takes `fullRangeMs` — so pressing again
   * mid-rewind resumes from the current fill instead of starting over. */
  const animate = useCallback(
    (target: number, fullRangeMs: number, onDone?: () => void) => {
      cancelFrame();
      const from = progressRef.current;
      const span = Math.abs(target - from) * fullRangeMs;
      if (span <= 0) {
        commit(target);
        onDone?.();
        return;
      }
      const start = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / span);
        commit(from + (target - from) * t);
        if (t < 1) {
          frame.current = requestAnimationFrame(tick);
        } else {
          frame.current = null;
          onDone?.();
        }
      };
      frame.current = requestAnimationFrame(tick);
    },
    [cancelFrame, commit],
  );

  const press = useCallback(() => {
    if (disabled || holdingRef.current) return;
    holdingRef.current = true;
    setHolding(true);
    animate(1, durationMs, () => {
      holdingRef.current = false;
      setHolding(false);
      commit(0);
      confirmRef.current();
    });
  }, [animate, commit, disabled, durationMs]);

  const release = useCallback(() => {
    if (!holdingRef.current) return;
    holdingRef.current = false;
    setHolding(false);
    animate(0, rewindMs);
  }, [animate, rewindMs]);

  useEffect(() => {
    if (!disabled) return;
    holdingRef.current = false;
    setHolding(false);
    cancelFrame();
    commit(0);
  }, [disabled, cancelFrame, commit]);

  useEffect(() => cancelFrame, [cancelFrame]);

  const bind = {
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      press();
    },
    onPointerUp: release,
    onPointerCancel: release,
    onLostPointerCapture: release,
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (!HOLD_KEYS.has(event.key)) return;
      event.preventDefault();
      if (!event.repeat) press();
    },
    onKeyUp: (event: KeyboardEvent<HTMLElement>) => {
      if (HOLD_KEYS.has(event.key)) release();
    },
    onBlur: release,
  };

  return { progress, holding, bind };
}
