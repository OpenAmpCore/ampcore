import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Block, Preloader, Tabbar, TabbarLink, Toast } from "konsta/react";
import { go, useAmpLive, type Device, type Tab, type Write, type WriteAck } from "./lib";
import { Eq, Inputs, Outputs, Overview, Presets } from "./sections";

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

/** One amp: polls it while mounted (App keys this by amp id, so switching amps
 * re-subscribes) and shows only what is useful right now:
 *  - offline → banner, controls read-only
 *  - in standby → Overview only (state + Standby switch); other tabs say so
 *  - Presets tab only when core says the firmware supports it
 *  - `eqChannel` set → that channel's EQ instead of the tab's own body */
export function AmpScreen({ device, tab, eqChannel }: { device: Device; tab: Tab; eqChannel: number | null }) {
  const { config, telemetry } = useAmpLive(device.id);
  const [presetsOk, setPresetsOk] = useState(false);

  useEffect(() => {
    invoke<boolean>("amp_presets_supported", { deviceId: device.id }).then(setPresetsOk, () => setPresetsOk(false));
  }, [device.id]);

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

  const tabs: Tab[] = presetsOk ? ["overview", "inputs", "outputs", "presets"] : ["overview", "inputs", "outputs"];
  const active = tabs.includes(tab) ? tab : "overview";
  const props = { id: device.id, write, disabled: !device.online };

  let body;
  if (active === "presets") {
    body = <Presets {...props} />;
  } else if (!config) {
    body = (
      <div className="flex justify-center py-4">
        <Preloader className="size-5" />
      </div>
    );
  } else if (active !== "overview" && config.standby === true) {
    body = <p className="opacity-60">The amp is in standby.</p>;
  } else if (eqChannel !== null) {
    body = <Eq {...props} device={device} config={config} telemetry={telemetry} tab={active} channelIndex={eqChannel} />;
  } else {
    const Section = { overview: Overview, outputs: Outputs, inputs: Inputs }[active];
    body = <Section {...props} device={device} config={config} telemetry={telemetry} />;
  }

  return (
    <>
      {!device.online && <Block strong className="!my-0 mb-4 bg-orange-500/20">Amp is offline — controls are disabled.</Block>}
      {body}
      <Tabbar labels className="fixed bottom-0 left-0">
        {tabs.map((t) => (
          <TabbarLink key={t} active={t === active} label={t} onClick={() => go(device.id, t)} className="capitalize" />
        ))}
      </Tabbar>
      <Toast
        opened={toast !== null}
        position="center"
        colors={{ bgIos: toast?.ok ? "bg-green-700" : "bg-red-700", bgMaterial: toast?.ok ? "bg-green-700" : "bg-red-700" }}
      >
        <div className="shrink text-white">{toast?.text}</div>
      </Toast>
    </>
  );
}
