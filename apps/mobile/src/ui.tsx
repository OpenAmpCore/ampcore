import { useEffect, useState, type ReactNode } from "react";
import { Button, Chip, List, ListItem, Range, Toggle } from "konsta/react";
import { chipColors, FILTER_LABELS, stateStatus } from "./lib";

/** A decoded amp/channel state as a chip — always spelled out, never colour alone. */
export const StateChip = ({ state }: { state: string | null | undefined }) =>
  state ? (
    <Chip className="shrink-0" colors={chipColors(stateStatus(state))}>
      {state}
    </Chip>
  ) : null;

// Level meter. Scale and colours are desktop's (METER_FLOOR_DB and
// DEFAULT_LEVEL_GRADIENT in AmpConfigureView.tsx / VuMeter.tsx) so both apps
// read alike.
const METER_FLOOR_DB = -60;
const METER_GRADIENT = "linear-gradient(to right, #0f6e5c 0%, #2f9e6a 35%, #d4c94a 65%, #e0793a 82%, #d64545 100%)";
const HOLD_MS = 2000;
const DECAY_DB_PER_S = 20;
const litFraction = (db: number | null) => (db === null ? 0 : Math.max(0, Math.min(1, (db - METER_FLOOR_DB) / -METER_FLOOR_DB)));

/** Peak that holds 2s then falls at 20 dB/s. Driven by the ~200ms telemetry
 * tick, so it marks the loudest recent poll, not a transient between polls. */
function usePeakHold(db: number | null): number | null {
  const [peak, setPeak] = useState<{ db: number; at: number } | null>(null);
  useEffect(() => {
    if (db === null) return;
    setPeak((p) => {
      if (p === null || db >= p.db) return { db, at: Date.now() };
      const decayed = p.db - Math.max(0, Date.now() - p.at - HOLD_MS) * (DECAY_DB_PER_S / 1000);
      return decayed <= db ? { db, at: Date.now() } : p;
    });
  }, [db]);
  return peak && peak.db > METER_FLOOR_DB ? peak.db : null;
}

function Meter({ db, muted }: { db: number | null; muted?: boolean }) {
  const peak = usePeakHold(db);
  return (
    <div className={`relative h-3 flex-1 overflow-hidden rounded-full bg-black/15 dark:bg-white/15 ${muted ? "opacity-40" : ""}`}>
      {/* The gradient spans the whole track and is clipped by the lit width,
          so a colour stays at a fixed scale position. */}
      <div className="absolute inset-y-0 left-0 overflow-hidden" style={{ width: `${litFraction(db) * 100}%` }}>
        <div className="h-full" style={{ width: `${100 / Math.max(litFraction(db), 0.001)}%`, background: METER_GRADIENT }} />
      </div>
      {peak !== null && <div className="absolute inset-y-0 w-0.5 bg-white/90" style={{ left: `${litFraction(peak) * 100}%` }} />}
    </div>
  );
}

/** Meter + numeric readout: an unlit meter alone looks the same as no reading. */
export const MeterRow = ({ db, unit, muted }: { db: number | null; unit: string; muted?: boolean }) => (
  <div className="flex items-center gap-3">
    <Meter db={db} muted={muted} />
    <span className="w-20 text-right text-sm tabular-nums opacity-70">{db === null ? "—" : `${db.toFixed(1)} ${unit}`}</span>
  </div>
);

const Minus = () => (
  <svg width="18" height="18" viewBox="0 0 20 20" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M4 10h12" />
  </svg>
);
const Plus = () => (
  <svg width="18" height="18" viewBox="0 0 20 20" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M4 10h12M10 4v12" />
  </svg>
);

/** Slider with − / + nudges. The slider writes on release (one packet per
 * gesture); a nudge writes at once. `log` maps the track to log10 — linear
 * 20Hz-20kHz puts everything under 2kHz in the first 10% — and nudges by a
 * sixth of an octave. Double-tapping the value snaps to `reset` (0 dB).
 * ponytail: holds the chosen value 800ms so it doesn't snap back before the
 * next poll confirms; a rejected write then shows the amp's value. */
export function Fader(p: {
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  log?: boolean;
  reset?: number;
  disabled: boolean;
  onCommit: (v: number) => void;
}) {
  const [held, setHeld] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const shown = held ?? p.value;
  const step = p.step ?? (p.log ? 1 : 0.5);
  const clamp = (v: number) => Math.min(p.max, Math.max(p.min, v));
  const round = (v: number) => (p.log ? Math.round(v) : Math.round(v / step) * step);
  const commit = (v: number) => {
    const next = clamp(round(v));
    setHeld(next);
    p.onCommit(next);
    setTimeout(() => setHeld(null), 800);
  };
  const release = () => {
    if (!dragging || held === null) return;
    setDragging(false);
    commit(held);
  };
  const nudge = (dir: 1 | -1) => commit(p.log ? shown * 2 ** (dir / 6) : shown + dir * step);
  const to = (v: number) => (p.log ? Math.log10(Math.max(v, 1e-6)) : v);
  const from = (v: number) => (p.log ? 10 ** v : v);
  const canReset = p.reset !== undefined && p.reset >= p.min && p.reset <= p.max;
  const decimals = p.log ? 0 : step < 0.1 ? 2 : 1;
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span>{p.label}</span>
        <button
          type="button"
          disabled={p.disabled || !canReset}
          onDoubleClick={() => canReset && commit(p.reset!)}
          className="min-h-11 px-2 text-right tabular-nums"
          aria-label={canReset ? `${p.label}: double-tap to reset` : p.label}
        >
          {`${shown.toFixed(decimals)} ${p.unit}`.trim()}
        </button>
      </div>
      <div className="flex items-center gap-1">
        <Button clear rounded inline className="!size-11 !p-0" disabled={p.disabled || shown <= p.min} onClick={() => nudge(-1)} aria-label={`${p.label} down`}>
          <Minus />
        </Button>
        {/* Range has no release callback; pointer/touch end bubble up from its <input>. */}
        <Range
          className="flex-1"
          aria-label={p.label}
          min={to(p.min)}
          max={to(p.max)}
          step={p.log ? 0.002 : step}
          value={to(shown)}
          disabled={p.disabled}
          onInput={(e) => {
            setDragging(true);
            setHeld(round(from(Number(e.currentTarget.value))));
          }}
          onPointerUp={release}
          onTouchEnd={release}
        />
        <Button clear rounded inline className="!size-11 !p-0" disabled={p.disabled || shown >= p.max} onClick={() => nudge(1)} aria-label={`${p.label} up`}>
          <Plus />
        </Button>
      </div>
    </div>
  );
}

/** A settings-style row: title (+ optional subtitle/extra) and a toggle. */
export function ToggleRow(p: { name: string; subtitle?: string; extra?: ReactNode; checked: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <ListItem
      label
      title={p.name}
      subtitle={p.subtitle}
      after={
        <span className="flex items-center gap-2">
          {p.extra}
          <Toggle checked={p.checked} disabled={p.disabled} onChange={(e) => p.onChange(e.target.checked)} />
        </span>
      }
    />
  );
}

/** A standalone inset list — the grouping every settings-ish block uses. */
export const Group = ({ title, children }: { title?: string; children: ReactNode }) => (
  <section>
    {title && <h2 className="mb-2 px-1 text-sm font-semibold uppercase tracking-wide opacity-60">{title}</h2>}
    <List strong inset className="!mx-0 !my-0">
      {children}
    </List>
  </section>
);

const FIELD =
  "w-full min-w-0 rounded-lg border border-black/20 bg-transparent px-3 py-2.5 disabled:opacity-50 dark:border-white/20";

/** Text field. Commits on Enter (the keyboard's Done) or blur; keyed by the
 * amp's value so a poll refreshes it. */
export function NameField(p: { label: string; value: string; max: number; disabled: boolean; onCommit: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm opacity-60">{p.label}</span>
      <input
        key={p.value}
        enterKeyHint="done"
        defaultValue={p.value}
        maxLength={p.max}
        disabled={p.disabled}
        className={FIELD}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        onBlur={(e) => e.target.value.trim() !== p.value && p.onCommit(e.target.value)}
      />
    </label>
  );
}

/** Numeric field; commits on Enter/Done or blur, clamped to the amp's range. */
export function NumField(p: { label: string; unit: string; value: number; min: number; max: number; disabled: boolean; onCommit: (v: number) => void }) {
  return (
    <label className="flex min-h-11 items-center justify-between gap-3">
      <span>{p.label}</span>
      <span className="flex items-center gap-2">
        <input
          key={p.value}
          type="number"
          inputMode="decimal"
          enterKeyHint="done"
          className={`${FIELD} !w-28 text-right`}
          defaultValue={p.value}
          min={p.min}
          max={p.max}
          step={0.1}
          disabled={p.disabled}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          onBlur={(e) => {
            const v = e.target.valueAsNumber;
            if (!Number.isFinite(v)) return;
            const c = Math.min(p.max, Math.max(p.min, v));
            if (c !== p.value) p.onCommit(c);
            else e.target.value = String(p.value);
          }}
        />
        <span className="w-8 text-sm opacity-60">{p.unit}</span>
      </span>
    </label>
  );
}

/** Native <select> — 11 filter types is too many for a segmented control, and
 * the platform picker is the right control on a phone anyway. */
export const TypePicker = <T extends keyof typeof FILTER_LABELS>(p: { types: readonly T[]; value: T; disabled: boolean; onChange: (v: T) => void }) => (
  <label className="flex min-h-11 items-center justify-between gap-3">
    <span>Type</span>
    <select className={`${FIELD} !w-60`} value={p.value} disabled={p.disabled} onChange={(e) => p.onChange(e.target.value as T)}>
      {p.types.map((t) => (
        <option key={t} value={t}>
          {FILTER_LABELS[t]}
        </option>
      ))}
    </select>
  </label>
);

export const Chevron = () => (
  <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0 opacity-40">
    <path d="M8 4l6 6-6 6" />
  </svg>
);

/** Centered note for empty/loading states. */
export const Note = ({ children }: { children: ReactNode }) => <p className="mt-10 px-6 text-center opacity-60">{children}</p>;
