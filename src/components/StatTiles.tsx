import { forwardRef, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { ActionFeedbackContent, actionFeedbackAccent } from "./ActionFeedback";
import {
  isPromiseLike,
  useActionFeedback,
  type ActionFeedback,
  type ActionFeedbackStatus,
} from "../hooks/useActionFeedback";

/* ---------------------------------------------------------------------------
 * Channel-strip tiles
 *
 * A strip mixes three genuinely different kinds of cell, and they used to
 * share one component (`InputStatTile`), which rendered an identical
 * bordered <button> whether or not it had an `onClick`. That made a live
 * temperature readout look exactly as pressable as Mute, and left the only
 * highlight (`active`) meaning two contradictory things — "currently muted"
 * on one tile, "this one is editable" on the next. The components below keep
 * the same grid rhythm so a strip still lines up, but give each class its own
 * affordance:
 *
 *   StatReadout       passive, recessed, no border, not focusable
 *   StatToggle        on/off state, fills with its accent when engaged
 *   StatEditorTile    opens a popover or a sub-view, corner chevron, and
 *                     accents itself when its value is off-default
 *
 * Tile colours carry one meaning each: red = this channel's audio is being cut
 * (mute) or something is destroyed (overwrite); the accent = engaged/off-default
 * but working as intended (gate, polarity, a non-zero delay, active EQ bands).
 * Red is fixed, since it reads as danger; the accent is whatever the user picked
 * in the appearance menu (see `src/lib/appearance.ts`).
 *
 * Visual validation
 *
 * Every actionable tile takes `visualValidation` (see `VisualValidation`).
 * With it on, firing the tile's request swaps its content for a spinner, then
 * a check with a green border or a cross with a red border for a moment, then
 * the tile returns to normal. The result colour outranks the tile's own accent
 * for that second, so success and failure read identically on every tile.
 * Sequencing lives in `useActionFeedback`; the animation in
 * `ActionFeedbackContent`. Tiles only wire the two together.
 * ------------------------------------------------------------------------ */

const STAT_TILE_W = 72;
const STAT_TILE_H = 52;
const DEFAULT_BORDER = "var(--amp-color-default-border)";
const TILE_RADIUS = "var(--radius-md)";

/** Tiles are the only focusable things in a strip now that readouts are
 * plain divs, so they need a visible focus ring — a plain reset `<button>`
 * ships none. */
export const STAT_TILE_FOCUS =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]";

/** Strips a native `<button>` down to an unstyled surface (no Mantine
 * `UnstyledButton` dependency): no default background/border/padding/font,
 * no default focus ring (tiles supply their own via `STAT_TILE_FOCUS`). */
const RESET_BUTTON = "appearance-none bg-transparent border-0 p-0 m-0 font-inherit text-inherit outline-none";

function wash(color: string, percent: number): string {
  return `color-mix(in srgb, ${color} ${percent}%, transparent)`;
}

/** A tile's click handler. Returning a promise (typically an `ActionResult`
 * from `ConfigureActions`) is what lets `visualValidation: true` follow the
 * request; a handler that returns nothing just runs. */
export type TileClickHandler = () => void | PromiseLike<unknown>;

/** Opt-in request feedback for an actionable tile.
 *
 * - `true` — the tile follows the promise its own `onClick` returns. For a
 *   tile whose click *is* the request: Mute, Pol, Recall.
 * - an `ActionFeedback` from `useActionFeedback()` — the tile displays that
 *   controller instead. For a tile whose click only opens an editor and whose
 *   request is committed from somewhere else (a popover's input or confirm
 *   button): the caller routes the commit through `feedback.track(...)` and
 *   the tile still shows the result.
 * - omitted / `false` — no feedback; the tile behaves as before. */
export type VisualValidation = boolean | ActionFeedback;

function useTileFeedback(visualValidation: VisualValidation | undefined, onClick: TileClickHandler | undefined) {
  // Always created, so hook order never depends on the prop; only used when
  // the tile tracks its own click.
  const own = useActionFeedback();
  const feedback = typeof visualValidation === "object" ? visualValidation : visualValidation ? own : null;
  const status: ActionFeedbackStatus = feedback?.status ?? "idle";
  // `busy`, not `status === "pending"`: a fast request never shows the
  // spinner at all, but it is still in flight and must not be fired twice.
  const busy = feedback?.busy ?? false;

  function handleClick() {
    // A second click mid-request would fire the same write again against a
    // state the UI hasn't caught up with yet.
    if (busy) return;
    const result = onClick?.();
    if (feedback && isPromiseLike(result)) void feedback.track(result);
  }

  return { status, busy, accent: actionFeedbackAccent(status), handleClick };
}

/** A passive telemetry display — level, volts, amps, temperature. Rendered
 * as a recessed <div>, not a button: nothing happens when you click it, so
 * it must not offer a border, a pointer cursor or a tab stop. Values use
 * tabular figures (fixed-width digits within the app's own font, not a
 * switch to a monospace typeface) so a live-updating number doesn't reflow
 * its own tile. */
export function StatReadout({ value, label }: { value: string; label: string }) {
  return (
    <div
      className="shrink-0 text-center"
      style={{
        width: STAT_TILE_W,
        height: STAT_TILE_H,
        borderRadius: TILE_RADIUS,
        background: "var(--amp-color-default)",
      }}
    >
      <div className="flex h-full flex-col items-center justify-center gap-0.5">
        <span style={{ fontSize: "var(--amp-font-size-sm)", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
          {value}
        </span>
        <span style={{ fontSize: "var(--amp-font-size-xs)", color: "var(--amp-color-dimmed)" }}>{label}</span>
      </div>
    </div>
  );
}

/** An on/off control (mute, polarity, gate). Engaged state is a filled
 * accent wash plus a matching border and label — a much louder signal than
 * the old border-colour-only treatment, which mattered because Mute is the
 * most consequential control on the strip and used to be as quiet as a
 * temperature readout. Icons inherit `currentColor`, so call sites pass
 * them uncoloured. */
export const StatToggle = forwardRef<
  HTMLButtonElement,
  {
    label: string;
    icon: ReactNode;
    engaged: boolean;
    accent?: string;
    /** See `VisualValidation`. */
    visualValidation?: VisualValidation;
    onClick?: TileClickHandler;
  }
>(function StatToggle({ label, icon, engaged, accent = "var(--amp-color-red-6)", visualValidation, onClick }, ref) {
  const feedback = useTileFeedback(visualValidation, onClick);
  const tone = feedback.accent ?? (engaged ? accent : undefined);

  return (
    <button
      type="button"
      ref={ref}
      onClick={feedback.handleClick}
      aria-pressed={engaged}
      aria-busy={feedback.busy || undefined}
      className={`${RESET_BUTTON} shrink-0 cursor-pointer text-center transition-colors duration-200 ${STAT_TILE_FOCUS}`}
      style={{
        width: STAT_TILE_W,
        height: STAT_TILE_H,
        borderRadius: TILE_RADIUS,
        border: `1px solid ${tone ?? DEFAULT_BORDER}`,
        background: tone ? wash(tone, 20) : "transparent",
        color: tone ?? "var(--amp-color-dimmed)",
      }}
    >
      <ActionFeedbackContent status={feedback.status}>
        <div className="flex h-full flex-col items-center justify-center gap-0.5">
          {icon}
          <span style={{ fontSize: "var(--amp-font-size-xs)", fontWeight: engaged ? 700 : 400, color: "inherit" }}>
            {label}
          </span>
        </div>
      </ActionFeedbackContent>
    </button>
  );
});

/** A tile that opens something — a popover editor, or a whole sub-view. The
 * corner chevron is what separates it from a `StatReadout` at a glance
 * (down = a popover drops from here, right = this navigates away).
 *
 * `modified` is the scannability fix: a channel sitting at 12 ms with six
 * active EQ bands used to look identical to a flat one, so "which channels
 * are doing something" could only be answered by opening every tile. Now
 * off-default tiles carry the accent and the strip can be read at a
 * glance. */
export const StatEditorTile = forwardRef<
  HTMLButtonElement,
  {
    value?: ReactNode;
    label: string;
    icon?: ReactNode;
    modified?: boolean;
    accent?: string;
    opens?: "popover" | "view";
    /** Tile width in px. Defaults to the strip grid's width; only override for
     * a tile that sits in its own wider column and holds a longer value (e.g.
     * the Routing tab's Source column). The height is never overridden, so
     * tiles still line up row by row. */
    width?: number;
    /** See `VisualValidation`. A popover tile usually passes a controller,
     * since its own click only opens the editor. */
    visualValidation?: VisualValidation;
    onClick?: TileClickHandler;
  }
>(function StatEditorTile(
  {
    value,
    label,
    icon,
    modified,
    accent = "var(--accent)",
    opens = "popover",
    width = STAT_TILE_W,
    visualValidation,
    onClick,
  },
  ref,
) {
  const feedback = useTileFeedback(visualValidation, onClick);
  const tone = feedback.accent ?? (modified ? accent : undefined);
  const color = modified ? accent : "var(--amp-color-text)";

  return (
    <button
      type="button"
      ref={ref}
      onClick={feedback.handleClick}
      aria-busy={feedback.busy || undefined}
      className={`${RESET_BUTTON} relative shrink-0 cursor-pointer text-center transition-colors duration-200 ${STAT_TILE_FOCUS}`}
      style={{
        width,
        height: STAT_TILE_H,
        borderRadius: TILE_RADIUS,
        border: `1px solid ${tone ?? DEFAULT_BORDER}`,
        background: tone ? wash(tone, 10) : "transparent",
      }}
    >
      <ActionFeedbackContent status={feedback.status}>
        <div className="pointer-events-none absolute right-[3px] top-[3px] opacity-40">
          <ChevronRight
            size={10}
            style={{
              transform: opens === "popover" ? "rotate(90deg)" : undefined,
            }}
          />
        </div>
        <div className="flex h-full flex-col items-center justify-center gap-0.5">
          {icon ? (
            <span style={{ color, display: "flex" }}>{icon}</span>
          ) : (
            <span style={{ fontSize: "var(--amp-font-size-sm)", fontWeight: 700, fontVariantNumeric: "tabular-nums", color }}>
              {value}
            </span>
          )}
          <span style={{ fontSize: "var(--amp-font-size-xs)", color: "var(--amp-color-dimmed)" }}>
            {label}
          </span>
        </div>
      </ActionFeedbackContent>
    </button>
  );
});

