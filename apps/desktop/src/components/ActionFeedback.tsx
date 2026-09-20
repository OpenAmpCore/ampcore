import type { CSSProperties, ReactNode } from "react";
import type { ActionFeedbackStatus } from "../hooks/useActionFeedback";
import "./ActionFeedback.css";

const ACCENT: Record<ActionFeedbackStatus, string | undefined> = {
  idle: undefined,
  pending: undefined,
  success: "var(--amp-color-green-6)",
  error: "var(--amp-color-red-6)",
};

/** The border/wash colour a control should take for `status`, or `undefined`
 * when the control should keep its own styling. Shared so a success looks
 * the same green and a failure the same red on every kind of control. */
export function actionFeedbackAccent(status: ActionFeedbackStatus): string | undefined {
  return ACCENT[status];
}

const ANNOUNCEMENT: Record<ActionFeedbackStatus, string> = {
  idle: "",
  pending: "Working…",
  success: "Done",
  error: "Failed",
};

/** Swaps a control's content for request feedback: a spinner while the
 * request is pending, then a drawn check (success) or cross (error) for the
 * hold, then the original content again. Driven entirely by `status` —
 * timing and sequencing live in `useActionFeedback`.
 *
 * Fills its parent (`width`/`height: 100%`), so the control must give itself
 * a fixed size; the swap then never shifts layout. The content and the
 * indicator are stacked layers that cross-fade, and all three marks share one
 * SVG, so pending → result is a morph in place rather than a jump.
 *
 * The content layer is `position: absolute; inset: 0`, so anything absolutely
 * positioned inside `children` (e.g. a corner chevron) keeps its position. */
export function ActionFeedbackContent({
  status,
  size = 20,
  children,
}: {
  status: ActionFeedbackStatus;
  /** Indicator diameter in px. */
  size?: number;
  children: ReactNode;
}) {
  return (
    <div
      className="action-feedback"
      data-status={status}
      style={{ "--action-feedback-size": `${size}px` } as CSSProperties}
    >
      <div className="action-feedback__content" aria-hidden={status !== "idle" || undefined}>
        {children}
      </div>
      <div className="action-feedback__indicator" aria-hidden="true">
        <svg className="action-feedback__glyph" viewBox="0 0 24 24" focusable="false">
          <circle className="action-feedback__spinner" cx="12" cy="12" r="8.5" pathLength={1} />
          <path className="action-feedback__check" d="M6.75 12.5 10.25 16 17.25 8.5" pathLength={1} />
          <path className="action-feedback__cross action-feedback__cross--a" d="M8 8 16 16" pathLength={1} />
          <path className="action-feedback__cross action-feedback__cross--b" d="M16 8 8 16" pathLength={1} />
        </svg>
      </div>
      <span className="action-feedback__announcer" role="status" aria-live="polite">
        {ANNOUNCEMENT[status]}
      </span>
    </div>
  );
}
