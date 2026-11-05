import { useRef, useState, type ReactNode } from "react";
import { Popover, Button, popoverVariants } from "@heroui/react";
import { FIELD_INPUT } from "../fieldClasses";
import { STAT_TILE_FOCUS } from "../StatTiles";
import type { AmpAssignment, ChannelSpeakerState, AmpCapability_Serialize as AmpCapability, ChannelEq, DiscoveredDevice, Telemetry } from "../../lib/bindings";
import type { LinkConfig, LinkScope } from "../../lib/channelLinks";
import type { ConfigureActions } from "../../lib/configureActions";
import type { AmpGainReading } from "../../lib/ampGain";

export type SkeletonVariant = "list" | "grid";

/* HeroUI's overlay parts (`Popover.Content`, `Popover.Dialog`) read their class
 * names off a React context that ONLY the `<Popover>` root provides. Every
 * overlay in this file deliberately skips that root and drives the overlay
 * itself with `triggerRef` + `isOpen`, because the roots wrap their child in a
 * `PressResponder`/`role="button"` element — nesting each tile's own
 * `<button>` inside a second one and double-firing its click.
 *
 * Without the root, those `slots?.x()` lookups come back `undefined` and the
 * overlay renders with *no class at all*: transparent background, no radius,
 * no shadow, no padding. Passing the slot names explicitly is what restores
 * HeroUI's own styling on the standalone pattern. */
export const POPOVER_SLOTS = popoverVariants();

/** One labelled row of the source editor. */
export function EditorRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span style={{ fontSize: "var(--amp-font-size-xs)", color: "var(--amp-color-dimmed)" }}>{label}</span>
      <div className="w-[104px] shrink-0">{children}</div>
    </div>
  );
}

/** The "Tile+Popover" pattern (see CLAUDE.md) used throughout this file:
 * a tile opens a small popover editor. HeroUI's `Popover` has no
 * `Popover.Target`-style auto-wrap of a ref'd trigger the way Mantine's did,
 * so this standalone-controlled form (a `triggerRef` div wrapping the tile,
 * `isOpen`/`onOpenChange` driven by the caller) is repeated at every call
 * site — centralized here once rather than by hand ~20 times over. */
export function TilePopover({
  opened,
  onOpenChange,
  trigger,
  placement = "bottom",
  width = 220,
  dotted,
  children,
}: {
  opened: boolean;
  onOpenChange: (opened: boolean) => void;
  trigger: ReactNode;
  placement?: "bottom" | "top" | "right" | "left";
  width?: number;
  /** A dotted orange border: the value lives outside what the row's context
   * owns (output volume, which no speaker preset holds). */
  dotted?: boolean;
  children: ReactNode;
}) {
  const triggerRef = useRef<HTMLDivElement>(null);
  return (
    <>
      {/* `flex` is load-bearing, not cosmetic. This wrapper exists only to
          give the popover something to anchor to, but a *block* wrapper puts
          the tile's `<button>` in an inline formatting context, where the
          line box's strut adds a few px of descender space under it. The
          wrapper then measures taller than the tile, and since the strip row
          is `items-center`, centring that taller box leaves the tile itself
          sitting visibly higher than its unwrapped neighbours. `flex` makes
          the tile a flex item instead, so no strut, and the wrapper is
          exactly the tile's height. */}
      <div ref={triggerRef} className="flex">{trigger}</div>
      <Popover.Content
        className={POPOVER_SLOTS.base()}
        triggerRef={triggerRef}
        isOpen={opened}
        onOpenChange={onOpenChange}
        placement={placement}
        style={dotted ? { border: "1px dotted var(--amp-color-orange-6)" } : undefined}
      >
        <Popover.Dialog className={POPOVER_SLOTS.dialog()} style={{ width }}>
          {children}
        </Popover.Dialog>
      </Popover.Content>
    </>
  );
}

/** The standard content shell for a tab whose body is a stack of rows:
 * vertically centered while it fits, plainly scrollable once it doesn't.
 * `Center` alone can't do both — a `Center` taller than its content clips
 * the overflow at *both* ends, so on a short or narrow window the first
 * rows became unreachable. The nested `min-h-full` column is what keeps
 * centering and scrolling from fighting each other. Padding steps down on
 * small windows, where 32px of gutter is a meaningful share of the width. */
export function CenteredScrollPane({ children }: { children: ReactNode }) {
  return (
    <div className="h-full min-h-0 overflow-auto">
      <div className="flex min-h-full min-w-0 flex-col justify-center gap-4 p-4">
        {children}
      </div>
    </div>
  );
}

export function TabSkeleton({
  label,
  variant,
}: {
  label: string;
  variant: SkeletonVariant;
}) {
  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <span style={{ fontWeight: 600 }}>{label}</span>

      <div className="flex flex-1 flex-col gap-4 opacity-50 pointer-events-none">
        {variant === "list" && (
          <div className="flex flex-1 flex-col gap-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="animate-pulse rounded-md"
                style={{ height: 34, background: "var(--amp-color-default)" }}
              />
            ))}
          </div>
        )}

        {variant === "grid" && (
          <div
            className="grid flex-1 content-start gap-4"
            style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}
          >
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="animate-pulse rounded-md"
                style={{ height: 80, background: "var(--amp-color-default)" }}
              />
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-center">
        <span style={{ fontSize: "var(--amp-font-size-xs)", color: "var(--amp-color-dimmed)" }}>
          Coming soon
        </span>
      </div>
    </div>
  );
}

export interface ConfigurableTabProps {
  assignment: AmpAssignment;
  /** This amp's channel links, for `MainTab`'s linked-controls highlight. */
  linkConfig?: LinkConfig;
  capability: AmpCapability;
  /** Latest heartbeat reading for a `"live"` source — `undefined` for a
   * Project source and before the first heartbeat arrives. Read through the
   * `channelTelemetry` helper rather than indexed directly, so a short
   * array (a firmware whose packet carries fewer channels than the model's
   * topology) degrades to `null`/unlit instead of `0`. */
  telemetry?: Telemetry;
  /** Each output's amplifier gain and the sensitivity it implies, indexed by
   * channel — `undefined` without a live amp (see `ampGainReading`). Shown on
   * the Overview tab only. */
  ampGains?: AmpGainReading[];
  /** Every mutation a tab can make, targeting either a Project or a live
   * device — see `configureActions.ts`. Fields with no write support for
   * the current source (Project-only concepts, or live writes not built
   * yet) are simply absent; a handler guards with `if (!actions.setX)
   * return;` rather than assuming every field is always writable. */
  actions: ConfigureActions;
  /** The live amp this editor can reach right now, if any — Direct Edit's own
   * device or the online amp a project amp is following, and `undefined` once
   * that amp is offline or deliberately disengaged (see `liveAmpDeviceId`).
   * Distinct from `telemetry`'s "is there a live source at all": a tab reads
   * this to decide whether a *device-only* feature can be queried. Today just
   * FIR, whose coefficients exist nowhere but on the amp. */
  deviceId?: string;
  /** Speaker-library status per output channel of a project amp (empty for
   * Direct Edit); shown as a chip on each output row. */
  speakerStates?: Map<number, ChannelSpeakerState>;
  onOpenSpeakers?: () => void;
  /** Output volumes move together (the Overview's switch, the `volumeOut`
   * link); turning it on goes through `useVolumeMismatch`'s question. */
  volumeTogether?: boolean;
  onVolumeTogetherChange?: (on: boolean) => void;
  /** The view is locked; for what a tab renders outside its panel's own
   * disabled fieldset (a dialog). */
  locked?: boolean;
  /** The live amp this view reads, for the Overview's info bar — Direct
   * Edit's device or the one a project amp is following. */
  device?: DiscoveredDevice;
  /** Catalog brand and model of the assigned amp model. */
  modelLabel?: string;
  /** Label of the amp's last recalled preset, from the FC=27 snapshot. */
  presetName?: string | null;
}

/** Marks a tile for `MainTab`'s linked-controls highlight. */
export function LinkTarget({ scope, channel, children }: { scope: LinkScope; channel: number; children: ReactNode }) {
  return (
    <div className="flex" data-link-scope={scope} data-link-channel={channel}>
      {children}
    </div>
  );
}

/** How many filters in a chain are engaged — the parametric bands plus the
 * two crossover slots. Only ever compared against zero (the EQ tile shows a
 * binary "is this chain doing anything"), but kept as a count because that
 * is the cheap thing to compute and callers may want more later. */
export function activeFilterCount(eq: ChannelEq | undefined): number {
  if (!eq) return 0;
  let count = eq.bands.filter((band) => band.active).length;
  if (eq.hp.active) count += 1;
  if (eq.lp.active) count += 1;
  return count;
}

/** Click-to-rename label shared by `InputChannelRow`/`OutputChannelRow` —
 * shows the user-assigned `name` when set, otherwise the default numbered/
 * lettered label. Opens a small `Popover` with a `TextInput` capped at
 * `maxLength` (`AmpParamRanges.channelNameMaxLength`); saving an empty value
 * clears back to the default (`name: null`). */
export function RenameableLabel({
  defaultLabel,
  name,
  maxLength,
  onRename,
  trailing,
}: {
  defaultLabel: string;
  name: string | null | undefined;
  maxLength: number;
  onRename: (name: string | null) => void;
  /** Status pills shown beside the name — the channel state, an input clip
   * flag. They live in this header rather than in the row's tile `Group`
   * because that row has a fixed width budget (`OUTPUT_ROW_MAX_WIDTH`) that
   * an extra item wraps, and because a pill that comes and goes with
   * telemetry would move the wrap point at runtime. The reference app floats
   * its pills over the card's top-left corner for the same reason. */
  trailing?: ReactNode;
}) {
  const [opened, setOpened] = useState(false);
  const [draft, setDraft] = useState(name ?? "");

  function commit() {
    const trimmed = draft.trim();
    onRename(trimmed.length > 0 ? trimmed : null);
    setOpened(false);
  }

  return (
    <div className="flex min-w-0 flex-nowrap items-center gap-1.5 mb-1.5">
      <TilePopover
        opened={opened}
        onOpenChange={(o) => {
          setOpened(o);
          if (o) setDraft(name ?? "");
        }}
        placement="bottom"
        trigger={
          /* A bordered tile rather than bare text: every other editable
           * value in the app is a Tile+Popover, and a plain label gave no
           * hint at all that the channel could be renamed — a hint that
           * can't be a hover effect, since this ships to touch. Sized to
           * its content, not to `STAT_TILE_W`, because the row beneath it
           * has a fixed width budget an oversized header would wrap. */
          <button
            type="button"
            onClick={() => setOpened((o) => !o)}
            aria-label={`Rename channel (${name && name.length > 0 ? name : defaultLabel})`}
            className={`inline-flex min-w-0 shrink cursor-pointer appearance-none items-center border-0 bg-transparent px-1.5 py-0.5 font-inherit transition-colors duration-200 ${STAT_TILE_FOCUS}`}
            style={{
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--amp-color-default-border)",
            }}
          >
            <span
              className="truncate"
              style={{
                fontSize: "var(--amp-font-size-xs)",
                fontWeight: 700,
                color: "var(--amp-color-dimmed)",
                textTransform: "uppercase",
              }}
            >
              {name && name.length > 0 ? name : defaultLabel}
            </span>
          </button>
        }
      >
        <div className="flex flex-col gap-2">
          <span
            style={{
              fontSize: "var(--amp-font-size-xs)",
              fontWeight: 700,
              color: "var(--amp-color-dimmed)",
              textTransform: "uppercase",
              textAlign: "center",
            }}
          >
            Rename
          </span>
          <input
            type="text"
            value={draft}
            maxLength={maxLength}
            placeholder={defaultLabel}
            className={FIELD_INPUT}
            onChange={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && commit()}
          />
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="secondary"
              onPress={() => {
                onRename(null);
                setDraft("");
                setOpened(false);
              }}
            >
              Reset
            </Button>
            <Button size="sm" variant="primary" onPress={commit}>
              Save
            </Button>
          </div>
        </div>
      </TilePopover>
      {trailing}
    </div>
  );
}
