import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Block,
  Button,
  Card,
  Dialog,
  DialogButton,
  ListItem,
  Navbar,
  NavbarBackLink,
  Page,
  Preloader,
  Sheet,
  Tabbar,
  TabbarLink,
  Toast,
  Toggle,
} from "konsta/react";
import {
  channelCount,
  channelLabel,
  goTab,
  isNormal,
  openDetail,
  outputLabel,
  upFromAmp,
  useLive,
  usePresetsSupported,
  useRanges,
  type Channel,
  type Device,
  type Dir,
  type Presets as PresetsData,
  type Ranges,
  type Route,
  type Snapshot,
  type Tab,
  type Telemetry,
  type Write,
} from "./lib";
import { Chevron, Fader, Group, MeterRow, NameField, Note, StateChip, ToggleRow } from "./ui";
import { ChannelDetail } from "./detail";

/** What every screen of one amp gets. */
export interface AmpCtx {
  device: Device;
  config: Snapshot;
  telemetry: Telemetry | null;
  ranges: Ranges;
  write: Write;
  /** Offline: nothing can be written. */
  disabled: boolean;
}

/** One amp: polls it while mounted (App keys this by amp id). The tabs share a
 * navbar and a bottom tab bar; a channel detail is its own page above them. */
export function AmpScreen({ device, route }: { device: Device; route: Route }) {
  const { config, telemetry } = useLive([device.id])[device.id] ?? { config: null, telemetry: null };
  const ranges = useRanges();
  const presetsOk = usePresetsSupported(device.id);

  // Silent on success — the next poll is the confirmation. Core retries a
  // write for ~1.2s before it gives up, so a failure here is a real one.
  const [error, setError] = useState<string | null>(null);
  const write: Write = (cmd, args) =>
    invoke(cmd, { deviceId: device.id, ...args }).then(
      () => {},
      (e) => {
        setError(String(e));
        setTimeout(() => setError(null), 4000);
      },
    );
  const toast = (
    <Toast opened={error !== null} position="center" colors={{ bgIos: "bg-red-700", bgMaterial: "bg-red-700" }}>
      <div className="shrink text-white">{error}</div>
    </Toast>
  );

  const ctx = config && ranges ? { device, config, telemetry, ranges, write, disabled: !device.online } : null;

  if (route.detail && ctx) {
    return (
      <>
        <ChannelDetail ctx={ctx} {...route.detail} />
        {toast}
      </>
    );
  }

  const tab: Tab = route.tab === "presets" && !presetsOk ? "channels" : route.tab;
  const tabs: { id: Tab; label: string; icon: ReactNode }[] = [
    { id: "channels", label: "Channels", icon: <Icon d="M5 3v14M10 3v14M15 3v14M3 7h4M8 12h4M13 6h4" /> },
    { id: "routing", label: "Routing", icon: <Icon d="M3 3h6v6H3zM11 3h6v6h-6zM3 11h6v6H3zM11 11h6v6h-6z" /> },
    ...(presetsOk ? [{ id: "presets" as const, label: "Presets", icon: <Icon d="M5 3h10v14l-5-4-5 4z" /> }] : []),
    { id: "device", label: "Device", icon: <Icon d="M10 3v7M6 5.5a6 6 0 1 0 8 0" /> },
  ];

  let body: ReactNode;
  if (!ctx) body = <Spinner />;
  else if (tab === "routing") body = <Routing ctx={ctx} />;
  else if (tab === "presets") body = <PresetsTab ctx={ctx} />;
  else if (tab === "device") body = <DeviceTab ctx={ctx} />;
  else body = <Channels ctx={ctx} />;

  return (
    <Page>
      <Navbar
        left={<NavbarBackLink onClick={upFromAmp} showText={false} />}
        title={device.name || device.mac}
        subtitle={device.online ? device.ip : "offline"}
      />
      <main className="mx-auto w-full max-w-3xl px-safe-4 pt-4 pb-32">
        {ctx && <Banners ctx={ctx} />}
        {body}
      </main>
      <Tabbar labels icons className="fixed bottom-0 left-0">
        {tabs.map((t) => (
          <TabbarLink key={t.id} active={tab === t.id} onClick={() => goTab(device.id, t.id)} icon={t.icon} label={t.label} />
        ))}
      </Tabbar>
      {toast}
    </Page>
  );
}

const Icon = ({ d }: { d: string }) => (
  <svg width="24" height="24" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

export const Spinner = () => (
  <div className="flex justify-center py-8">
    <Preloader />
  </div>
);

/** Offline and standby, above every screen of the amp. Standby carries its own
 * way out: powering on is safe, so it needs no confirm. */
export function Banners({ ctx }: { ctx: AmpCtx }) {
  if (ctx.disabled) return <Block strong inset className="!mx-0 !mt-0 !mb-4 bg-orange-500/20">Amp is offline — controls are disabled.</Block>;
  if (ctx.config.standby !== true) return null;
  return (
    <Block strong inset className="!mx-0 !mt-0 !mb-4 flex items-center justify-between gap-3 bg-orange-500/20">
      <span>Amp is in standby — outputs are silent.</span>
      {!ctx.config.standbyLocked && (
        <Button inline small tonal onClick={() => ctx.write("set_standby", { standby: false })}>
          Power on
        </Button>
      )}
    </Block>
  );
}

// --- Channels ---------------------------------------------------------------

/** The amp's home: every output, then every input, each with its meter and
 * the controls used live. Everything else is one tap into the detail. */
function Channels({ ctx }: { ctx: AmpCtx }) {
  const outs = channelCount("out", ctx.config, ctx.device);
  const ins = channelCount("in", ctx.config, ctx.device);
  if (outs + ins === 0) return <Note>Waiting for channel data…</Note>;
  return (
    <div className="flex flex-col gap-6">
      <StripSection title="Outputs" dir="out" count={outs} ctx={ctx} />
      <StripSection title="Inputs" dir="in" count={ins} ctx={ctx} />
    </div>
  );
}

function StripSection({ title, dir, count, ctx }: { title: string; dir: Dir; count: number; ctx: AmpCtx }) {
  if (count === 0) return null;
  return (
    <section>
      <h2 className="mb-2 px-1 text-sm font-semibold uppercase tracking-wide opacity-60">{title}</h2>
      <div className="grid gap-3 tablet:grid-cols-2">
        {ctx.config.channels.slice(0, count).map((c) => (
          <Strip key={c.channelIndex} dir={dir} channel={c} ctx={ctx} />
        ))}
      </div>
    </section>
  );
}

function Strip({ dir, channel: c, ctx }: { dir: Dir; channel: Channel; ctx: AmpCtx }) {
  const ch = c.channelIndex;
  const t = ctx.telemetry;
  const out = dir === "out";
  const muted = out ? c.outputMuted : c.inputMuted;
  const name = out ? c.outputName : c.inputName;
  const state = out ? t?.outputChannelStates[ch] : null;
  const disabled = ctx.disabled || ctx.config.standby === true;
  return (
    <Card className="!m-0" contentWrapPadding="p-3">
      <button
        type="button"
        className="-m-1 mb-1 flex min-h-11 w-[calc(100%+0.5rem)] items-center gap-3 rounded-md p-1 text-left active:bg-black/5 dark:active:bg-white/10"
        onClick={() => openDetail(ctx.device.id, dir, ch)}
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-black/10 font-semibold dark:bg-white/10">{channelLabel(dir, ch)}</span>
        <span className="min-w-0 flex-1 truncate font-semibold">{name || (out ? "Output" : "Input")}</span>
        {!isNormal(state) && <StateChip state={state} />}
        {!out && t?.inputClipping[ch] && <StateChip state="clip" />}
        <Chevron />
      </button>
      <div className="flex items-center gap-3">
        <MuteButton muted={muted} disabled={disabled} onToggle={() => ctx.write(out ? "set_output_mute" : "set_input_mute", { channelIndex: ch, muted: !muted })} />
        <div className="min-w-0 flex-1">
          {/* dBV on inputs (core converts against 1.0 Vrms, despite the field
              name); dB relative to rated output on outputs. */}
          <MeterRow db={(out ? t?.outputLevelDb[ch] : t?.inputDbfs[ch]) ?? null} unit={out ? "dB" : "dBV"} muted={muted} />
        </div>
      </div>
      {out && (
        <div className="mt-2">
          <Fader
            label="Volume"
            unit="dB"
            value={c.outputVolumeDb}
            min={ctx.ranges.outputVolumeDb.min}
            max={ctx.ranges.outputVolumeDb.max}
            reset={0}
            disabled={disabled}
            onCommit={(db) => ctx.write("set_output_volume", { channelIndex: ch, db })}
          />
        </div>
      )}
    </Card>
  );
}

export function MuteButton({ muted, disabled, onToggle }: { muted: boolean; disabled: boolean; onToggle: () => void }) {
  const red = { fillBgIos: "bg-red-600", fillBgMaterial: "bg-red-600", fillTextIos: "text-white", fillTextMaterial: "text-white" };
  return (
    <Button inline tonal={!muted} colors={muted ? red : undefined} className="!h-11 !w-20 shrink-0" disabled={disabled} onClick={onToggle} aria-pressed={muted}>
      {muted ? "Muted" : "Mute"}
    </Button>
  );
}

// --- Routing ----------------------------------------------------------------

/** Outputs × inputs. A crosspoint is addressed by output channel + source
 * index, so each row is one output's `matrixCrosspoints`. */
function Routing({ ctx }: { ctx: AmpCtx }) {
  const [open, setOpen] = useState<{ ch: number; src: number } | null>(null);
  const outs = ctx.config.channels.slice(0, channelCount("out", ctx.config, ctx.device));
  const sources = outs[0]?.matrixCrosspoints.map((x) => x.sourceIndex) ?? [];
  if (sources.length === 0) return <Note>This amp reports no matrix sources.</Note>;
  const cell = open && outs.find((c) => c.channelIndex === open.ch)?.matrixCrosspoints.find((x) => x.sourceIndex === open.src);
  const disabled = ctx.disabled || ctx.config.standby === true;
  const set = (ch: number, sourceIndex: number, gainDb: number | null, active: boolean | null) =>
    ctx.write("set_matrix_crosspoint", { channelIndex: ch, sourceIndex, gainDb, active });

  return (
    <>
      <p className="mb-3 px-1 text-sm opacity-60">Which inputs feed each output. Tap a cell to edit.</p>
      {/* Irreducible width: scrolls sideways in its own box, never the page. */}
      <div className="overflow-x-auto">
        <table className="border-separate border-spacing-1">
          <thead>
            <tr>
              <th />
              {sources.map((s) => (
                <th key={s} className="px-1 text-sm font-semibold opacity-60">
                  In {s + 1}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {outs.map((c) => (
              <tr key={c.channelIndex}>
                <th className="pr-2 text-left font-semibold">{outputLabel(c.channelIndex)}</th>
                {c.matrixCrosspoints.map((x) => (
                  <td key={x.sourceIndex}>
                    <button
                      type="button"
                      onClick={() => setOpen({ ch: c.channelIndex, src: x.sourceIndex })}
                      className={`h-12 min-w-16 rounded-md px-2 text-sm tabular-nums ${
                        x.active ? "bg-brand-primary text-white" : "bg-black/10 opacity-60 dark:bg-white/10"
                      }`}
                    >
                      {x.active ? `${x.gainDb.toFixed(1)} dB` : "off"}
                    </button>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Sheet opened={cell != null} onBackdropClick={() => setOpen(null)} className="w-full">
        {open && cell && (
          <div className="flex flex-col gap-3 p-4 pb-safe-4">
            <SheetHeader title={`In ${open.src + 1} → Output ${outputLabel(open.ch)}`} onClose={() => setOpen(null)} />
            <ToggleRowBare name="Routed" checked={cell.active} disabled={disabled} onChange={(active) => set(open.ch, open.src, null, active)} />
            <Fader
              label="Gain"
              unit="dB"
              value={cell.gainDb}
              min={ctx.ranges.matrixGainDb.min}
              max={ctx.ranges.matrixGainDb.max}
              reset={0}
              disabled={disabled || !cell.active}
              onCommit={(gainDb) => set(open.ch, open.src, gainDb, null)}
            />
          </div>
        )}
      </Sheet>
    </>
  );
}

export const SheetHeader = ({ title, onClose }: { title: string; onClose: () => void }) => (
  <div className="flex items-center justify-between">
    <h2 className="text-lg font-semibold">{title}</h2>
    <Button clear inline onClick={onClose}>
      Done
    </Button>
  </div>
);

/** A toggle row outside a List (sheets). */
export const ToggleRowBare = (p: { name: string; checked: boolean; disabled: boolean; onChange: (v: boolean) => void }) => (
  <label className="flex min-h-11 items-center justify-between gap-3">
    <span>{p.name}</span>
    <Toggle checked={p.checked} disabled={p.disabled} onChange={(e) => p.onChange(e.target.checked)} />
  </label>
);

// --- Device -----------------------------------------------------------------

/** Power, lock, health numbers and identity: amp-level, not per channel. */
function DeviceTab({ ctx }: { ctx: AmpCtx }) {
  const { config, telemetry: t, device, write, disabled } = ctx;
  const [confirmOff, setConfirmOff] = useState(false);
  const on = config.standby === false;
  const temps = t?.temperatures ?? [];
  const outs = channelCount("out", config, device);
  return (
    <div className="flex flex-col gap-6">
      <Group>
        {/* Power, not "standby": on means sound. Off silences every output, so
            it is confirmed; on is harmless and immediate. */}
        <ToggleRow
          name="Power"
          subtitle={config.standbyLocked ? "Locked on the amp" : on ? "On" : "Standby"}
          extra={<StateChip state={t?.machineStateDecoded ?? device.machineStateDecoded} />}
          checked={on}
          disabled={disabled || config.standby === null || config.standbyLocked === true}
          onChange={(v) => (v ? write("set_standby", { standby: false }) : setConfirmOff(true))}
        />
        <ToggleRow
          name="Lock front knob"
          checked={config.rotaryLocked === true}
          disabled={disabled || config.rotaryLocked === null}
          onChange={(locked) => write("set_rotary_lock", { locked })}
        />
      </Group>

      {!t ? (
        <Spinner />
      ) : (
        <>
          <Group title="Health">
            {temps.slice(0, 4).map((v, i) => (
              <Stat key={i} title={`Temperature ${outputLabel(i)}`} value={`${Math.round(v)} °C`} />
            ))}
            {temps[4] !== undefined && <Stat title="Power supply" value={`${Math.round(temps[4])} °C`} />}
            {t.fanVoltage !== null && <Stat title="Fan" value={`${t.fanVoltage.toFixed(1)} V`} />}
          </Group>
          <Group title="Outputs">
            {Array.from({ length: outs }, (_, i) => (
              <ListItem
                key={i}
                link
                title={`Output ${outputLabel(i)}`}
                after={
                  <span className="tabular-nums">
                    {[
                      t.outputVoltages[i] !== undefined && `${t.outputVoltages[i].toFixed(1)} V`,
                      t.outputCurrents[i] !== undefined && `${t.outputCurrents[i].toFixed(2)} A`,
                      t.outputImpedance[i] !== undefined && `${t.outputImpedance[i].toFixed(1)} Ω`,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "—"}
                  </span>
                }
                // Limiter gain reduction; 0 means it isn't pulling anything back.
                subtitle={t.limiters[i] ? `Limiting ${t.limiters[i].toFixed(1)} dB` : undefined}
                onClick={() => openDetail(device.id, "out", i)}
              />
            ))}
          </Group>
        </>
      )}

      {/* Commissioning, kept last so it isn't in the way while working.
          32 = core's DEVICE_NAME_FIELD_LEN; the backend rejects longer names. */}
      <Group title="Amp">
        <li className="px-4 py-3">
          <NameField label="Name" value={device.name} max={32} disabled={disabled} onCommit={(name) => write("set_device_name", { name })} />
        </li>
        <Stat title="IP address" value={device.ip} />
        <Stat title="MAC" value={device.mac} />
        <Stat title="Firmware" value={device.firmwareVersion} />
      </Group>

      <Dialog
        opened={confirmOff}
        onBackdropClick={() => setConfirmOff(false)}
        title="Put amp in standby?"
        content="Every output goes silent until it is powered on again."
        buttons={
          <>
            <DialogButton onClick={() => setConfirmOff(false)}>Cancel</DialogButton>
            <DialogButton
              strong
              onClick={() => {
                setConfirmOff(false);
                void write("set_standby", { standby: true });
              }}
            >
              Standby
            </DialogButton>
          </>
        }
      />
    </div>
  );
}

const Stat = ({ title, value }: { title: string; value: string }) => <ListItem title={title} after={<span className="tabular-nums">{value}</span>} />;

// --- Presets ----------------------------------------------------------------

function PresetsTab({ ctx }: { ctx: AmpCtx }) {
  const { device, write, disabled } = ctx;
  const [presets, setPresets] = useState<PresetsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ index: number; name: string } | null>(null);
  // Kept after close so the dialog text doesn't blank during its exit animation.
  const [shown, setShown] = useState<{ index: number; name: string } | null>(null);
  const slot = pending ?? shown;

  const load = () => invoke<PresetsData>("fetch_presets", { deviceId: device.id }).then(setPresets, (e) => setError(String(e)));
  useEffect(() => {
    void load();
  }, [device.id]);

  if (error) return <Block strong inset className="!mx-0 bg-red-500/20">{error}</Block>;
  if (!presets) return <Spinner />;

  return (
    <>
      <Group>
        {presets.slots.map((s) => {
          const active = s.name !== "" && s.name === presets.activePresetName;
          return (
            <ListItem
              key={s.index}
              link={!disabled}
              title={s.name || "(empty)"}
              subtitle={`Slot ${s.index}`}
              after={active ? <span className="font-semibold text-brand-primary">Active</span> : undefined}
              onClick={
                disabled
                  ? undefined
                  : () => {
                      setPending(s);
                      setShown(s);
                    }
              }
            />
          );
        })}
      </Group>
      {/* Recall replaces the whole amp's live settings, so it is always confirmed. */}
      <Dialog
        opened={pending !== null}
        onBackdropClick={() => setPending(null)}
        title="Recall preset?"
        content={`“${slot?.name || "(empty)"}” replaces the amp’s current settings.`}
        buttons={
          <>
            <DialogButton onClick={() => setPending(null)}>Cancel</DialogButton>
            <DialogButton
              strong
              onClick={() => {
                setPending(null);
                if (slot) void write("recall_preset", { slotIndex: slot.index }).then(load);
              }}
            >
              Recall
            </DialogButton>
          </>
        }
      />
    </>
  );
}
