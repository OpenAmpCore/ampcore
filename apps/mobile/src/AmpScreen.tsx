import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Block, Preloader, Toast } from "konsta/react";
import {
  goPath,
  stagesFor,
  useAmpLive,
  useRanges,
  type Device,
  type Dir,
  type Route,
  type Write,
  type WriteAck,
} from "./lib";
import { channelCount, channelLabel, PathRail } from "./path";
import { Overview, Presets, STAGES } from "./sections";
import { PageMain } from "./App";

/** What to say about a write the amp acknowledged — `null` stays silent.
 * "Acknowledged" is delivery only; the amp never echoes back the value it took.
 * A command whose packets were *all* coalesced put nothing on the wire (a newer
 * write to the same parameter superseded them before they were sent), so the
 * write that replaced it is the one that reports. */
function ackText(ack: WriteAck): string | null {
  if (ack.packets > 0 && ack.coalesced === ack.packets) return null;
  const sent = ack.packets - ack.coalesced;
  return [
    `Acknowledged — ${sent} packet${sent === 1 ? "" : "s"} in ${ack.elapsedMs} ms`,
    ack.attempts > 1 ? `${ack.attempts} attempts` : null,
    ack.coalesced > 0 ? `${ack.coalesced} coalesced` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** True when this route shows a channel's signal path — the one layout that
 * drops the navbar and runs rail + content instead. App keys its own chrome off
 * the same condition. */
export const isPathScreen = (r: Route) => !r.presets && !r.settings && r.ch !== null;

/** One amp: polls it while mounted (App keys this by amp id, so switching amps
 * re-subscribes). No channel in the route → the landing screen (meters, standby,
 * device); a channel → the two-pane path layout, with the rail as the nav. */
export function AmpScreen({ device, route }: { device: Device; route: Route }) {
  const { config, telemetry } = useAmpLive(device.id);
  const ranges = useRanges();

  // Every write reports: green on the amp's ack, red on failure (core retries a
  // write 6 times over ~1.2s before giving up). The polled state stays the truth.
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null);
  const flash = (text: string, ok: boolean) => {
    setToast({ text, ok });
    setTimeout(() => setToast(null), ok ? 1200 : 4000);
  };
  const write: Write = (cmd, args) =>
    invoke<WriteAck>(cmd, { deviceId: device.id, ...args }).then(
      (ack) => {
        const text = ackText(ack);
        if (text) flash(text, true);
      },
      (e) => flash(String(e), false),
    );

  const disabled = !device.online;
  const offline = !device.online ? <Block strong className="!my-0 mb-3 bg-orange-500/20">Amp is offline — controls are disabled.</Block> : null;
  const toastEl = (
    <Toast
      opened={toast !== null}
      position="center"
      colors={{ bgIos: toast?.ok ? "bg-green-700" : "bg-red-700", bgMaterial: toast?.ok ? "bg-green-700" : "bg-red-700" }}
    >
      <div className="shrink text-white">{toast?.text}</div>
    </Toast>
  );
  const loading = (
    <div className="flex justify-center py-4">
      <Preloader className="size-5" />
    </div>
  );

  // --- Path screens: rail + content, no navbar. ---------------------------
  if (isPathScreen(route) && config && ranges) {
    const count = channelCount(route.dir, config, device.analogInputChannels, device.outputChannels);
    // A channel the amp doesn't have (stale deep link) clamps to the last real one.
    const ch = Math.min(route.ch!, Math.max(count - 1, 0));
    const channel = config.channels.find((c) => c.channelIndex === ch);
    const stages = stagesFor(route.dir);
    // No stage in the route → the first one. The rail is the navigation, so
    // there is no separate "path overview" screen to land on.
    const stageId = route.stage ?? stages[0].id;
    const Stage = STAGES[stageId];
    const goDir = (d: Dir) => goPath(device.id, d, Math.min(ch, channelCount(d, config, device.analogInputChannels, device.outputChannels) - 1));

    if (count === 0 || !channel) {
      return (
        <div className="p-4">
          <p className="opacity-60">Waiting for channel data…</p>
          {toastEl}
        </div>
      );
    }

    return (
      // h-full resolves against Konsta's k-page (absolute, h-full), so the two
      // panes scroll independently and the page itself never does. The axis
      // flips with orientation: landscape is short and wide (834x375 dp on the
      // test phone) so the nav goes left; portrait is tall and narrow (375x834)
      // so it goes on top.
      <div className="flex h-full flex-col landscape:flex-row">
        <PathRail
          id={device.id}
          name={device.name || device.mac}
          dir={route.dir}
          ch={ch}
          count={count}
          stage={stageId}
          channel={channel}
          telemetry={telemetry}
          onDir={goDir}
        />
        {/* min-w-0 keeps a wide stage body from forcing a horizontal page scroll.
            The width clamp lives on the inner div, not this flex/scroll item —
            mx-auto/max-w on a flex-1 overflow-y-auto item is unreliable. */}
        <section className="min-w-0 flex-1 overflow-y-auto px-safe-4 pb-safe-4 pt-3 landscape:pl-4 landscape:pr-safe-4 landscape:pt-safe-3">
          <div className="mx-auto w-full max-w-3xl">
            {offline}
            {config.standby === true && <Block strong className="!my-0 mb-3 bg-orange-500/20">The amp is in standby.</Block>}
            <h2 className="mb-3 font-semibold">
              {route.dir === "in" ? "Input" : "Output"} {channelLabel(route.dir, ch)} · {stages.find((s) => s.id === stageId)?.label}
            </h2>
            {/* Standby greys the stage rather than blanking it — the chain stays
                readable while the amp is down. */}
            <div className={config.standby === true ? "pointer-events-none opacity-40" : ""}>
              <Stage
                id={device.id}
                dir={route.dir}
                ch={ch}
                channel={channel}
                telemetry={telemetry}
                ranges={ranges}
                write={write}
                disabled={disabled || config.standby === true}
              />
            </div>
          </div>
        </section>
        {toastEl}
      </div>
    );
  }

  // --- Everything else keeps App's navbar and its own padding. ------------
  let body;
  if (route.presets) {
    body = <Presets id={device.id} write={write} disabled={disabled} />;
  } else if (!config || !ranges) {
    body = loading;
  } else {
    body = (
      <>
        {/* Two ways in; the per-output rows below link straight to their own path. */}
        <div className="mb-4 flex gap-2">
          {(["in", "out"] as const).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => goPath(device.id, d, 0)}
              className="flex-1 rounded-lg bg-black/10 py-2 text-sm font-semibold dark:bg-white/10"
            >
              {d === "in" ? "Input path" : "Output path"}
            </button>
          ))}
        </div>
        <Overview id={device.id} device={device} config={config} telemetry={telemetry} write={write} disabled={disabled} />
      </>
    );
  }

  return (
    <PageMain>
      {offline}
      {body}
      {toastEl}
    </PageMain>
  );
}
