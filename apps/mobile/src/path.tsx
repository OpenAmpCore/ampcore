import { go, goPath, goStage, outputLabel, stagesFor, type Channel, type Dir, type Snapshot, type Telemetry } from "./lib";

/** How many channels this direction has. Input and output counts come from the
 * amp itself and are not assumed equal — but every per-channel control is
 * indexed into `config.channels`, so a count can't outrun that array. */
export const channelCount = (dir: Dir, config: Snapshot, analogIn: number, out: number) =>
  Math.min(dir === "in" ? analogIn : out, config.channels.length);

export const channelLabel = (dir: Dir, ch: number) => (dir === "in" ? `${ch + 1}` : outputLabel(ch));

/** One line of current state per stage, for the rail. Field reads and
 * `toFixed` only — anything needing DSP semantics (which filter types have
 * gain/Q, what a bound is) still comes from core via `amp_ranges` /
 * `amp_eq_filter_capabilities`. */
export function stageBadge(stage: string, dir: Dir, c: Channel): string | null {
  const eq = dir === "in" ? c.inputEq : c.outputEq;
  switch (stage) {
    case "in":
      return c.inputMuted ? "muted" : null;
    case "delay":
      return dir === "in"
        ? `${c.delayInMs.toFixed(1)} ms`
        : `${c.delayOutMs.toFixed(1)} ms${c.outputPhaseInverted ? " ø" : ""}`;
    case "eq": {
      const on = eq.bands.filter((b) => b.active).length;
      return `${on}/${eq.bands.length}`;
    }
    case "limiter": {
      const on = [c.limiter.rms.enabled && "RMS", c.limiter.peak.enabled && "Pk"].filter(Boolean);
      return on.length ? on.join("+") : "off";
    }
    case "matrix": {
      const n = c.matrixCrosspoints.filter((x) => x.active).length;
      return `${n} src`;
    }
    case "out":
      return c.outputMuted ? "muted" : `${c.outputVolumeDb.toFixed(1)} dB`;
    default:
      return null;
  }
}

/** Input ⇄ output. The matrix is the seam between them, so it is a stage on
 * the output path (a crosspoint is addressed by output channel + source) and
 * the input path just ends at one. */
function DirSwitch({ dir, onPick }: { dir: Dir; onPick: (d: Dir) => void }) {
  return (
    <div className="flex shrink-0 gap-1">
      {(["in", "out"] as const).map((d) => (
        <button
          key={d}
          type="button"
          onClick={() => onPick(d)}
          className={`rounded-md px-3 py-1 text-xs font-semibold landscape:flex-1 landscape:px-0 ${
            d === dir ? "bg-black/15 dark:bg-white/15" : "opacity-60"
          }`}
        >
          {d === "in" ? "In" : "Out"}
        </button>
      ))}
    </div>
  );
}

/** Channel picker. Portrait has width to spare, so it is one row; landscape
 * has none, so it wraps two to a line inside the rail. Switching channel keeps
 * the open stage, so comparing the same stage across channels is one tap. */
function ChannelPills(p: { id: string; dir: Dir; ch: number; count: number; stage: string | null; telemetry: Telemetry | null }) {
  return (
    <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto landscape:grid landscape:flex-none landscape:grid-cols-2 landscape:overflow-visible landscape:tablet:grid-cols-3">
      {Array.from({ length: p.count }, (_, i) => {
        const st = p.dir === "out" ? p.telemetry?.outputChannelStates[i] : null;
        const bad = st && st !== "normal" && st !== "run";
        return (
          <button
            key={i}
            type="button"
            onClick={() => (p.stage ? goStage(p.id, p.dir, i, p.stage) : goPath(p.id, p.dir, i))}
            className={`flex min-w-8 shrink-0 items-center justify-center gap-1 rounded-md px-2 py-1 text-sm font-semibold ${
              i === p.ch ? "bg-brand-primary text-white" : "bg-black/10 dark:bg-white/10"
            }`}
          >
            {channelLabel(p.dir, i)}
            {bad && <span className="size-1.5 rounded-full bg-red-500" />}
          </button>
        );
      })}
    </div>
  );
}

/** The audio path. Left-to-right in portrait, top-to-bottom in landscape —
 * either way the order is the signal chain. Landscape is the tight one: the
 * whole rail has to live in 375px of height, so rows stay compact. */
function PathList(p: { id: string; dir: Dir; ch: number; stage: string; channel: Channel }) {
  return (
    <div className="flex min-w-0 gap-0 overflow-x-auto landscape:flex-col landscape:overflow-visible">
      {stagesFor(p.dir).map((s, i) => {
        const active = s.id === p.stage;
        return (
          <div key={s.id} className="flex shrink-0 items-center landscape:flex-col landscape:items-stretch">
            {i > 0 && <div className="h-px w-1.5 shrink-0 bg-current opacity-20 landscape:h-1 landscape:w-px landscape:self-center" />}
            <button
              type="button"
              onClick={() => goStage(p.id, p.dir, p.ch, s.id)}
              className={`flex items-baseline gap-1 rounded-md px-2 py-1 landscape:w-full landscape:justify-between ${
                active ? "bg-brand-primary text-white" : "bg-black/10 dark:bg-white/10"
              }`}
            >
              <span className="text-xs font-semibold">{s.short}</span>
              <span className={`truncate text-[10px] tabular-nums ${active ? "opacity-80" : "opacity-60"}`}>
                {stageBadge(s.id, p.dir, p.channel) ?? ""}
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** Navigation for a channel's path: a top bar in portrait, a left rail in
 * landscape. One component — the axis is the only thing that changes, so it is
 * CSS (Tailwind's orientation variants), not a JS branch.
 *
 * Safe areas differ by axis and both matter: in landscape the display cutout is
 * on a side edge, in portrait it is on the top. */
export function PathRail(p: {
  id: string;
  name: string;
  dir: Dir;
  ch: number;
  count: number;
  stage: string;
  channel: Channel;
  telemetry: Telemetry | null;
  onDir: (d: Dir) => void;
}) {
  return (
    <aside
      className="flex shrink-0 flex-col gap-1.5 border-b border-black/10 px-safe-3 pt-safe-2 pb-2 dark:border-white/10 landscape:w-36 landscape:tablet:w-56 landscape:gap-2 landscape:overflow-y-auto landscape:border-b-0 landscape:border-r landscape:pl-safe-2 landscape:pr-2 landscape:pb-safe-2"
    >
      {/* Replaces the navbar on path screens — it cost ~20% of the height in
          landscape. Back leaves the amp entirely, not one step. */}
      <button type="button" onClick={() => go(null)} className="flex items-center gap-1 text-left" aria-label="Back to amps">
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0">
          <path d="M12 4l-6 6 6 6" />
        </svg>
        <span className="truncate text-sm font-semibold">{p.name}</span>
      </button>
      {/* Portrait pairs direction and channels on one line; landscape stacks
          them, since the rail is only 144px wide. */}
      <div className="flex min-w-0 items-center gap-2 landscape:flex-col landscape:items-stretch landscape:gap-2">
        <DirSwitch dir={p.dir} onPick={p.onDir} />
        <ChannelPills id={p.id} dir={p.dir} ch={p.ch} count={p.count} stage={p.stage} telemetry={p.telemetry} />
      </div>
      <PathList id={p.id} dir={p.dir} ch={p.ch} stage={p.stage} channel={p.channel} />
    </aside>
  );
}
