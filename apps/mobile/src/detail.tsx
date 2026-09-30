import { useState } from "react";
import { Link, ListItem, Navbar, NavbarBackLink, Page, Segmented, SegmentedButton, Sheet } from "konsta/react";
import {
  channelCount,
  channelLabel,
  CROSSOVER_FILTER_TYPES,
  EQ_FILTER_TYPES,
  FILTER_LABELS,
  isNormal,
  openDetail,
  upFromDetail,
  useEqFilterCaps,
  useResponseCurve,
  type Channel,
  type ChannelEq,
  type Dir,
  type EqStageRef,
} from "./lib";
import { Banners, MuteButton, SheetHeader, ToggleRowBare, type AmpCtx } from "./amp";
import { Fader, Group, MeterRow, NameField, NumField, StateChip, ToggleRow, TypePicker } from "./ui";

/** The processing a channel has, in signal order. Mute and volume are on the
 * Channels strip already; the detail is for shaping. */
const STAGES: Record<Dir, { id: string; label: string }[]> = {
  out: [
    { id: "eq", label: "EQ" },
    { id: "limiter", label: "Limiter" },
    { id: "delay", label: "Delay" },
    { id: "out", label: "Output" },
  ],
  in: [
    { id: "eq", label: "EQ" },
    { id: "delay", label: "Delay" },
    { id: "in", label: "Input" },
  ],
};

interface StageProps {
  ctx: AmpCtx;
  dir: Dir;
  ch: number;
  channel: Channel;
  disabled: boolean;
}

/** One channel. Stage and channel switches replace the history entry, so back
 * always returns to where the detail was opened from. */
export function ChannelDetail({ ctx, dir, ch: rawCh, stage }: { ctx: AmpCtx; dir: Dir; ch: number; stage: string | null }) {
  const count = channelCount(dir, ctx.config, ctx.device);
  // A channel the amp doesn't have (stale link) clamps to the last real one.
  const ch = Math.max(0, Math.min(rawCh, count - 1));
  const channel = ctx.config.channels.find((c) => c.channelIndex === ch);
  const stages = STAGES[dir];
  const stageId = stages.some((s) => s.id === stage) ? stage! : stages[0].id;
  const go = (c: number, s = stageId) => openDetail(ctx.device.id, dir, c, s, true);
  const t = ctx.telemetry;
  const out = dir === "out";
  const state = out ? t?.outputChannelStates[ch] : null;
  const name = channel ? (out ? channel.outputName : channel.inputName) : null;
  const disabled = ctx.disabled || ctx.config.standby === true;

  const props = channel && { ctx, dir, ch, channel, disabled };
  return (
    <Page>
      <Navbar
        left={<NavbarBackLink onClick={() => upFromDetail(ctx.device.id)} showText={false} />}
        title={`${out ? "Output" : "Input"} ${channelLabel(dir, ch)}`}
        subtitle={name || ctx.device.name}
        right={
          <span className="flex">
            <Link iconOnly onClick={() => ch > 0 && go(ch - 1)} className={ch > 0 ? "" : "opacity-30"} aria-label="Previous channel">
              <Arrow d="M12 4l-6 6 6 6" />
            </Link>
            <Link iconOnly onClick={() => ch < count - 1 && go(ch + 1)} className={ch < count - 1 ? "" : "opacity-30"} aria-label="Next channel">
              <Arrow d="M8 4l6 6-6 6" />
            </Link>
          </span>
        }
        subnavbar={
          <Segmented strong>
            {stages.map((s) => (
              <SegmentedButton key={s.id} active={s.id === stageId} onClick={() => go(ch, s.id)}>
                {s.label}
              </SegmentedButton>
            ))}
          </Segmented>
        }
      />
      <main className="mx-auto w-full max-w-3xl px-safe-4 pt-4 pb-safe-8">
        <Banners ctx={ctx} />
        {!props ? (
          <p className="opacity-60">Waiting for channel data…</p>
        ) : (
          <>
            {/* The level stays in view while shaping, so a change can be judged by eye too. */}
            <div className="mb-4 flex items-center gap-3">
              {!isNormal(state) && <StateChip state={state} />}
              {!out && t?.inputClipping[ch] && <StateChip state="clip" />}
              <div className="min-w-0 flex-1">
                <MeterRow
                  db={(out ? t?.outputLevelDb[ch] : t?.inputDbfs[ch]) ?? null}
                  unit={out ? "dB" : "dBV"}
                  muted={out ? props.channel.outputMuted : props.channel.inputMuted}
                />
              </div>
            </div>
            {/* Standby greys the stage rather than hiding it — the settings stay readable. */}
            <div className={ctx.config.standby === true ? "opacity-50" : ""}>
              {stageId === "eq" && <EqStage {...props} />}
              {stageId === "limiter" && <LimiterStage {...props} />}
              {stageId === "delay" && <DelayStage {...props} />}
              {stageId === "out" && <OutStage {...props} />}
              {stageId === "in" && <InStage {...props} />}
            </div>
          </>
        )}
      </main>
    </Page>
  );
}

const Arrow = ({ d }: { d: string }) => (
  <svg width="22" height="22" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d={d} />
  </svg>
);

// --- EQ ---------------------------------------------------------------------

type Open = number | "hp" | "lp";
const refFor = (o: Open): EqStageRef => (typeof o === "number" ? { kind: "band", bandIndex: o } : { kind: o });

/** The channel's chain as a curve, then the HP, 8 bands and LP as rows —
 * the same 10 segments the amp stores. Tapping a row or a band's dot opens
 * its sheet; every edit is a partial patch, so untouched fields stay. */
function EqStage({ ctx, dir, ch, channel: c, disabled }: StageProps) {
  const caps = useEqFilterCaps();
  const [open, setOpen] = useState<Open | null>(null);
  const eq = dir === "out" ? c.outputEq : c.inputEq;
  const direction = dir === "out" ? "output" : "input";
  const { ranges, write } = ctx;

  const slotSub = (s: ChannelEq["hp"]) => (s.active ? `${Math.round(s.freqHz)} Hz · ${FILTER_LABELS[s.filterType]}` : "Off");
  return (
    <div className="flex flex-col gap-4">
      <EqGraph eq={eq} selected={open} gainRange={ranges.eqBandGainDb} onPick={setOpen} />
      <Group>
        <ListItem link title="High-pass" after={slotSub(eq.hp)} onClick={() => setOpen("hp")} />
        {eq.bands.map((b, i) => {
          const cap = caps?.[b.filterType];
          return (
            <ListItem
              key={i}
              link
              media={<BandDot index={i} active={b.active} />}
              title={FILTER_LABELS[b.filterType]}
              after={
                b.active
                  ? [`${Math.round(b.freqHz)} Hz`, cap?.supportsGain !== false && `${b.gainDb.toFixed(1)} dB`, cap?.supportsQ !== false && `Q ${b.q.toFixed(2)}`]
                      .filter(Boolean)
                      .join(" · ")
                  : "Off"
              }
              onClick={() => setOpen(i)}
            />
          );
        })}
        <ListItem link title="Low-pass" after={slotSub(eq.lp)} onClick={() => setOpen("lp")} />
      </Group>

      <Sheet opened={open !== null} onBackdropClick={() => setOpen(null)} className="w-full">
        <div className="flex flex-col gap-3 p-4 pb-safe-4">
          {typeof open === "number" && (
            <>
              <SheetHeader title={`Band ${open + 1}`} onClose={() => setOpen(null)} />
              <ToggleRowBare
                name="Active"
                checked={eq.bands[open].active}
                disabled={disabled}
                onChange={(active) => write("set_eq_band", { channelIndex: ch, direction, bandIndex: open, patch: { active } })}
              />
              <TypePicker
                types={EQ_FILTER_TYPES}
                value={eq.bands[open].filterType}
                disabled={disabled}
                onChange={(filterType) => write("set_eq_band", { channelIndex: ch, direction, bandIndex: open, patch: { filterType } })}
              />
              <Fader
                label="Frequency"
                unit="Hz"
                log
                value={eq.bands[open].freqHz}
                min={ranges.crossoverFreqHz.min}
                max={ranges.crossoverFreqHz.max}
                disabled={disabled}
                onCommit={(freqHz) => write("set_eq_band", { channelIndex: ch, direction, bandIndex: open, patch: { freqHz } })}
              />
              {/* Gain/Q support is per filter type, resolved by core — an all-pass has neither. */}
              <Fader
                label="Gain"
                unit="dB"
                value={eq.bands[open].gainDb}
                min={ranges.eqBandGainDb.min}
                max={ranges.eqBandGainDb.max}
                reset={0}
                disabled={disabled || caps?.[eq.bands[open].filterType]?.supportsGain === false}
                onCommit={(gainDb) => write("set_eq_band", { channelIndex: ch, direction, bandIndex: open, patch: { gainDb } })}
              />
              <Fader
                label="Q"
                unit=""
                step={0.05}
                value={eq.bands[open].q}
                min={ranges.eqBandQ.min}
                max={ranges.eqBandQ.max}
                disabled={disabled || caps?.[eq.bands[open].filterType]?.supportsQ === false}
                onCommit={(q) => write("set_eq_band", { channelIndex: ch, direction, bandIndex: open, patch: { q } })}
              />
            </>
          )}
          {(open === "hp" || open === "lp") && (
            <>
              <SheetHeader title={open === "hp" ? "High-pass" : "Low-pass"} onClose={() => setOpen(null)} />
              <ToggleRowBare
                name="Active"
                checked={eq[open].active}
                disabled={disabled}
                onChange={(active) => write("set_crossover_slot", { channelIndex: ch, direction, slot: open, patch: { active } })}
              />
              <TypePicker
                types={CROSSOVER_FILTER_TYPES}
                value={eq[open].filterType}
                disabled={disabled}
                onChange={(filterType) => write("set_crossover_slot", { channelIndex: ch, direction, slot: open, patch: { filterType } })}
              />
              <Fader
                label="Frequency"
                unit="Hz"
                log
                value={eq[open].freqHz}
                min={ranges.crossoverFreqHz.min}
                max={ranges.crossoverFreqHz.max}
                disabled={disabled}
                onCommit={(freqHz) => write("set_crossover_slot", { channelIndex: ch, direction, slot: open, patch: { freqHz } })}
              />
            </>
          )}
        </div>
      </Sheet>
    </div>
  );
}

const BandDot = ({ index, active }: { index: number; active: boolean }) => (
  <span
    className={`flex size-7 items-center justify-center rounded-full text-xs font-semibold ${
      active ? "bg-brand-primary text-white" : "bg-black/10 opacity-60 dark:bg-white/10"
    }`}
  >
    {index + 1}
  </span>
);

// Graph geometry: viewBox units; the SVG scales to the container width.
const W = 360;
const H = 170;
const LOG_LO = Math.log10(20);
const LOG_HI = Math.log10(20000);
const xFor = (hz: number) => ((Math.log10(Math.max(hz, 20)) - LOG_LO) / (LOG_HI - LOG_LO)) * W;

/** Composite response (accent) with the open stage's own curve on top, and a
 * numbered dot per active band — tapping a dot opens that band. Curves come
 * from core (`useResponseCurve`), so they match desktop's graph. */
function EqGraph({ eq, selected, gainRange, onPick }: { eq: ChannelEq; selected: Open | null; gainRange: { min: number; max: number }; onPick: (o: Open) => void }) {
  const curve = useResponseCurve(eq);
  const iso = useResponseCurve(selected === null ? null : eq, selected === null ? null : refFor(selected));
  const span = Math.max(Math.abs(gainRange.min), Math.abs(gainRange.max), 12) + 3;
  const yFor = (db: number) => H / 2 - (Math.max(-span, Math.min(span, db)) / span) * (H / 2);
  const path = (pts: { freqHz: number; db: number }[]) => pts.map((p, i) => `${i ? "L" : "M"}${xFor(p.freqHz).toFixed(1)} ${yFor(p.db).toFixed(1)}`).join("");
  const gridDb = [-12, -6, 6, 12].filter((d) => d < span);
  return (
    <div className="overflow-hidden rounded-lg bg-black/5 dark:bg-white/5">
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full touch-manipulation" role="img" aria-label="EQ response">
        {[100, 1000, 10000].map((f) => (
          <g key={f}>
            <line x1={xFor(f)} x2={xFor(f)} y1={0} y2={H} className="stroke-current opacity-15" />
            <text x={xFor(f) + 3} y={H - 4} className="fill-current text-[9px] opacity-50">
              {f >= 1000 ? `${f / 1000}k` : f}
            </text>
          </g>
        ))}
        {gridDb.map((d) => (
          <g key={d}>
            <line x1={0} x2={W} y1={yFor(d)} y2={yFor(d)} className="stroke-current opacity-10" />
            <text x={3} y={yFor(d) - 2} className="fill-current text-[9px] opacity-40">
              {d > 0 ? `+${d}` : d}
            </text>
          </g>
        ))}
        <line x1={0} x2={W} y1={H / 2} y2={H / 2} className="stroke-current opacity-30" />
        {curve && <path d={`${path(curve)}L${W} ${H / 2}L0 ${H / 2}Z`} className="fill-brand-primary opacity-15" />}
        {iso && <path d={path(iso)} fill="none" strokeWidth={1.5} strokeDasharray="4 3" className="stroke-current opacity-70" />}
        {curve && <path d={path(curve)} fill="none" strokeWidth={2} className="stroke-brand-primary" />}
        {eq.bands.map((b, i) =>
          b.active ? (
            <g key={i} onClick={() => onPick(i)} className="cursor-pointer">
              {/* Generous invisible hit area around a small visible dot. */}
              <circle cx={xFor(b.freqHz)} cy={yFor(b.gainDb)} r={16} fill="transparent" />
              <circle cx={xFor(b.freqHz)} cy={yFor(b.gainDb)} r={8} className={selected === i ? "fill-white stroke-brand-primary" : "fill-brand-primary"} strokeWidth={2} />
              <text x={xFor(b.freqHz)} y={yFor(b.gainDb) + 3} textAnchor="middle" className={`text-[9px] font-semibold ${selected === i ? "fill-brand-primary" : "fill-white"}`}>
                {i + 1}
              </text>
            </g>
          ) : null,
        )}
      </svg>
    </div>
  );
}

// --- Other stages -----------------------------------------------------------

/** RMS and Peak, each independently engaged. Every field is a patch — the
 * backend merges the rest from the last poll (each stage is one whole-record packet). */
function LimiterStage({ ctx, ch, channel: c, disabled }: StageProps) {
  const { ranges, write, telemetry } = ctx;
  const patch = (p: Record<string, unknown>) => write("set_limiter", { channelIndex: ch, patch: p });
  const { rms, peak } = c.limiter;
  const reduction = telemetry?.limiters[ch];
  return (
    <div className="flex flex-col gap-6 tablet:grid tablet:grid-cols-2 tablet:items-start">
      {/* 0 means the limiter is not pulling anything back. */}
      {reduction ? <p className="text-sm opacity-70 tablet:col-span-2">Gain reduction {reduction.toFixed(1)} dB</p> : null}
      <Group title="RMS">
        <ToggleRow name="Enabled" checked={rms.enabled} disabled={disabled} onChange={(v) => patch({ rmsEnabled: v })} />
        <li className="flex flex-col gap-2 px-4 py-3">
          <Fader
            label="Threshold"
            unit="Vrms"
            value={rms.thresholdVrms}
            min={ranges.rmsLimiterThresholdVrms.min}
            max={ranges.rmsLimiterThresholdVrms.max}
            disabled={disabled}
            onCommit={(v) => patch({ rmsThresholdVrms: v })}
          />
          <NumField label="Attack" unit="ms" value={rms.attackMs} min={ranges.rmsLimiterAttackMs.min} max={ranges.rmsLimiterAttackMs.max} disabled={disabled} onCommit={(v) => patch({ rmsAttackMs: v })} />
          <NumField
            label="Release"
            unit="× att"
            value={rms.releaseMultiplier}
            min={ranges.rmsLimiterReleaseMultiplier.min}
            max={ranges.rmsLimiterReleaseMultiplier.max}
            disabled={disabled}
            onCommit={(v) => patch({ rmsReleaseMultiplier: v })}
          />
        </li>
      </Group>
      <Group title="Peak">
        <ToggleRow name="Enabled" checked={peak.enabled} disabled={disabled} onChange={(v) => patch({ peakEnabled: v })} />
        <li className="flex flex-col gap-2 px-4 py-3">
          <Fader
            label="Threshold"
            unit="Vp"
            value={peak.thresholdVp}
            min={ranges.peakLimiterThresholdVp.min}
            max={ranges.peakLimiterThresholdVp.max}
            disabled={disabled}
            onCommit={(v) => patch({ peakThresholdVp: v })}
          />
          <NumField label="Hold" unit="ms" value={peak.holdMs} min={ranges.peakLimiterHoldMs.min} max={ranges.peakLimiterHoldMs.max} disabled={disabled} onCommit={(v) => patch({ peakHoldMs: v })} />
          <NumField
            label="Release"
            unit="ms"
            value={peak.releaseMs}
            min={ranges.peakLimiterReleaseMs.min}
            max={ranges.peakLimiterReleaseMs.max}
            disabled={disabled}
            onCommit={(v) => patch({ peakReleaseMs: v })}
          />
        </li>
      </Group>
    </div>
  );
}

/** Delay, plus polarity on outputs — both are time/phase alignment. */
function DelayStage({ ctx, dir, ch, channel: c, disabled }: StageProps) {
  const out = dir === "out";
  const r = out ? ctx.ranges.delayOutMs : ctx.ranges.delayInMs;
  return (
    <Group>
      <li className="px-4 py-2">
        <NumField
          label="Delay"
          unit="ms"
          value={out ? c.delayOutMs : c.delayInMs}
          min={r.min}
          max={r.max}
          disabled={disabled}
          onCommit={(ms) => ctx.write(out ? "set_output_delay" : "set_input_delay", { channelIndex: ch, ms })}
        />
      </li>
      {out && (
        <ToggleRow
          name="Invert polarity"
          checked={c.outputPhaseInverted}
          disabled={disabled}
          onChange={(inverted) => ctx.write("set_output_polarity", { channelIndex: ch, inverted })}
        />
      )}
    </Group>
  );
}

/** What leaves the amp: level, trim, mute and the channel's name. */
function OutStage({ ctx, ch, channel: c, disabled }: StageProps) {
  const { ranges, write } = ctx;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <MuteButton muted={c.outputMuted} disabled={disabled} onToggle={() => write("set_output_mute", { channelIndex: ch, muted: !c.outputMuted })} />
        <span className="text-sm opacity-60">{c.outputMuted ? "Output is muted" : "Output is live"}</span>
      </div>
      <Fader
        label="Volume"
        unit="dB"
        value={c.outputVolumeDb}
        min={ranges.outputVolumeDb.min}
        max={ranges.outputVolumeDb.max}
        reset={0}
        disabled={disabled}
        onCommit={(db) => write("set_output_volume", { channelIndex: ch, db })}
      />
      <Fader
        label="Trim"
        unit="dB"
        value={c.outputTrimDb}
        min={ranges.outputTrimDb.min}
        max={ranges.outputTrimDb.max}
        reset={0}
        disabled={disabled}
        onCommit={(db) => write("set_output_trim", { channelIndex: ch, db })}
      />
      <NameField
        label="Channel name"
        value={c.outputName ?? ""}
        max={ranges.channelNameMaxLength}
        disabled={disabled}
        onCommit={(name) => write("set_channel_name", { channelIndex: ch, output: true, name })}
      />
    </div>
  );
}

/** What the amp receives, before any processing. */
function InStage({ ctx, ch, channel: c, disabled }: StageProps) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <MuteButton muted={c.inputMuted} disabled={disabled} onToggle={() => ctx.write("set_input_mute", { channelIndex: ch, muted: !c.inputMuted })} />
        <span className="text-sm opacity-60">{c.inputMuted ? "Input is muted" : "Input is live"}</span>
      </div>
      <NameField
        label="Channel name"
        value={c.inputName ?? ""}
        max={ctx.ranges.channelNameMaxLength}
        disabled={disabled}
        onCommit={(name) => ctx.write("set_channel_name", { channelIndex: ch, output: false, name })}
      />
    </div>
  );
}
