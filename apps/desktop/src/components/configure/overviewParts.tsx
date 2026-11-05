import type { ReactNode } from "react";
import { SECTION_TITLE } from "../fieldClasses";
import { Hint } from "../Hint";
import { DEFAULT_LEVEL_GRADIENT, VuMeter, type VuMeterMark } from "../VuMeter";
import { INPUT_METER_FLOOR_DB } from "../../lib/channelTelemetry";

/** Every channel column is the strip tile's own width, so the Mute toggle
 * fills its column exactly and the three cards read as one grid. */
const COLUMN_W = 72;

/** Faders and meters share one height and all start right under the header,
 * so their ends line up across cards. */
export const STRIP_H = 200;

/** A value row: the dB/Gain/SEN fields and the V/A/°C readouts. */
export const ROW_H = 30;

/** A column's channel number or letter, with its name under it. */
export const HEADER_H = 36;

const GAP = 8;

/** `action` sits right of the title, in a title row of one fixed height for
 * every section, so the cards still start level. `footer` sits inside the
 * card under the columns, wrapping at the card's width (`w-0 min-w-full`)
 * rather than widening it, in the space the stretched card leaves. */
export function Section({
  title,
  action,
  footer,
  children,
}: {
  title: string;
  action?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-1.5">
      <div className="flex h-6 items-center justify-between gap-3">
        <h3 className={SECTION_TITLE}>{title}</h3>
        {action}
      </div>
      {/* `flex-1`: the card row stretches its sections, so every card ends on
       * the same bottom edge. */}
      <div className="flex min-w-0 flex-1 flex-col rounded-xl border border-[var(--amp-color-default-border)] p-3" style={{ gap: GAP }}>
        <div className="flex min-w-0 overflow-x-auto" style={{ gap: GAP }}>
          {children}
        </div>
        {footer && <div className="mt-auto w-0 min-w-full">{footer}</div>}
      </div>
    </section>
  );
}

export function Column({ width = COLUMN_W, children }: { width?: number; children: ReactNode }) {
  return (
    <div className="flex shrink-0 flex-col" style={{ width, gap: GAP }}>
      {children}
    </div>
  );
}

/** One fixed-height row of a column. `align` places side labels against the
 * channel columns they describe. */
export function Cell({
  height,
  align = "center",
  children,
}: {
  height: number;
  align?: "start" | "center" | "end";
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center" style={{ height, justifyContent: align }}>
      {children}
    </div>
  );
}

export function SideText({ children }: { children: ReactNode }) {
  return (
    <span style={{ fontSize: "var(--amp-font-size-xs)", color: "var(--amp-color-dimmed)", whiteSpace: "nowrap" }}>
      {children}
    </span>
  );
}

export function ChannelHeader({ label, name }: { label: string; name: string }) {
  return (
    <div className="flex min-w-0 flex-col items-center justify-center" style={{ height: HEADER_H }}>
      <span style={{ fontSize: "var(--amp-font-size-sm)", fontWeight: 600, color: "var(--amp-color-dimmed)" }}>
        {label}
      </span>
      <Hint text={name} className="w-full min-w-0">
        <span className="block truncate text-center text-[length:var(--amp-font-size-xs)]">{name}</span>
      </Hint>
    </div>
  );
}

/** A passive value, recessed like `StatReadout` but one row high. */
export function ValueCell({ value, hint }: { value: string; hint?: string }) {
  const cell = (
    <div
      className="flex w-full items-center justify-center"
      style={{
        height: ROW_H,
        borderRadius: "var(--radius-md)",
        background: "var(--amp-color-default)",
        fontSize: "var(--amp-font-size-sm)",
        fontWeight: 700,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {value}
    </div>
  );
  return hint ? (
    <Hint text={hint} className="w-full">
      {cell}
    </Hint>
  ) : (
    cell
  );
}

export function Led({ color, lit, label }: { color: string; lit: boolean; label: string }) {
  return (
    <span
      role="img"
      aria-label={`${label}: ${lit ? "on" : "off"}`}
      className="block shrink-0 rounded-full"
      style={{
        width: 8,
        height: 8,
        background: lit ? color : "var(--amp-color-default)",
        border: `1px solid ${lit ? color : "var(--amp-color-default-border)"}`,
        boxShadow: lit ? `0 0 6px ${color}` : undefined,
      }}
    />
  );
}

/** A meter scale on its own: a `VuMeter` with no track, so its labels sit at
 * exactly the positions a real meter of the same size puts them. `inset`
 * shortens it at both ends, for a fader whose thumb stops short of its box. */
export function Scale({ min, max, marks, inset = 0 }: { min: number; max: number; marks: VuMeterMark[]; inset?: number }) {
  return (
    <Cell height={STRIP_H} align="end">
      <VuMeter
        orientation="vertical"
        min={min}
        max={max}
        value={min}
        marks={marks}
        thickness={0}
        size={STRIP_H - 2 * inset}
      />
    </Cell>
  );
}

export function LevelMeter({
  level,
  peakHold,
  disabled,
  min = INPUT_METER_FLOOR_DB,
  max = 0,
}: {
  level: number | null;
  peakHold: boolean;
  disabled?: boolean;
  min?: number;
  max?: number;
}) {
  return (
    <VuMeter
      orientation="vertical"
      min={min}
      max={max}
      value={level ?? min}
      gradient={DEFAULT_LEVEL_GRADIENT}
      thickness={14}
      size={STRIP_H}
      peakHold={peakHold}
      disabled={disabled}
    />
  );
}
