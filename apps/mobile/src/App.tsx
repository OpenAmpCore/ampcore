import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Block, Button, Card, Link, Navbar, NavbarBackLink, Page, Preloader, Segmented, SegmentedButton } from "konsta/react";
import { AmpScreen } from "./amp";
import {
  applyScheme,
  back,
  openAmp,
  openSettings,
  savedScheme,
  stateStatus,
  upFromAmp,
  useDevices,
  useLive,
  useRoute,
  type Device,
  type Live,
  type Scheme,
  type Status,
} from "./lib";
import { Chevron, Note, StateChip } from "./ui";

export function App() {
  const devices = useDevices();
  const route = useRoute();
  if (route.settings) return <SettingsPage />;
  if (route.id) {
    const amp = devices.find((d) => d.id === route.id);
    if (amp) return <AmpScreen key={amp.id} device={amp} route={route} />;
    return (
      <Page>
        <Navbar left={<NavbarBackLink onClick={upFromAmp} showText={false} />} title="Amp" />
        <Note>Looking for this amp…</Note>
      </Page>
    );
  }
  return <AmpList devices={devices} />;
}

// --- Amp list ---------------------------------------------------------------

const RANK: Record<Status, number> = { danger: 3, warning: 2, default: 1, success: 0 };

/** One word for an amp's health: offline, standby, or its worst reported state. */
function health(d: Device, live: Live | undefined): { label: string; status: Status } {
  if (!d.online) return { label: "offline", status: "default" };
  if (live?.config?.standby === true) return { label: "standby", status: "warning" };
  const states = [d.machineStateDecoded, live?.telemetry?.machineStateDecoded, ...(live?.telemetry?.outputChannelStates ?? [])].filter(
    (s): s is string => !!s,
  );
  const worst = states.reduce<string | null>((w, s) => (w === null || RANK[stateStatus(s)] > RANK[stateStatus(w)] ? s : w), null);
  return worst ? { label: worst, status: stateStatus(worst) } : { label: "online", status: "success" };
}

function AmpList({ devices }: { devices: Device[] }) {
  const live = useLive(devices.filter((d) => d.online).map((d) => d.id));
  // Give discovery a moment before saying nothing answered.
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setWaited(true), 6000);
    return () => clearTimeout(t);
  }, []);
  const retry = async () => {
    setWaited(false);
    await invoke("discovery_stop").catch(() => {});
    await invoke("discovery_start").catch(() => {});
    setTimeout(() => setWaited(true), 6000);
  };

  return (
    <Page>
      <Navbar
        title="AmpCore"
        subtitle={devices.length ? `${devices.length} amp${devices.length === 1 ? "" : "s"}` : undefined}
        right={
          <Link iconOnly onClick={openSettings} aria-label="Settings">
            <svg width="22" height="22" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <circle cx="10" cy="10" r="2.5" />
              <path d="M10 2v2.5M10 15.5V18M2 10h2.5M15.5 10H18M4.3 4.3l1.8 1.8M13.9 13.9l1.8 1.8M4.3 15.7l1.8-1.8M13.9 6.1l1.8-1.8" />
            </svg>
          </Link>
        }
      />
      <main className="mx-auto w-full max-w-3xl px-safe-4 pt-4 pb-safe-8">
        {devices.length === 0 ? (
          waited ? (
            <Block strong inset className="!mx-0 flex flex-col items-center gap-3 text-center">
              <p className="font-semibold">No amps found</p>
              <p className="opacity-70">Make sure this phone is on the same network as the amps.</p>
              <Button tonal inline onClick={retry}>
                Search again
              </Button>
            </Block>
          ) : (
            <div className="mt-10 flex flex-col items-center gap-3 opacity-70">
              <Preloader />
              <span>Searching for amps…</span>
            </div>
          )
        ) : (
          <div className="grid gap-3 tablet:grid-cols-2" aria-live="polite">
            {devices.map((d) => (
              <AmpCard key={d.id} d={d} live={live[d.id]} />
            ))}
          </div>
        )}
      </main>
    </Page>
  );
}

/** Name, health and one mini meter per output — enough to spot the amp that
 * needs attention without opening each one. */
function AmpCard({ d, live }: { d: Device; live: Live | undefined }) {
  const h = health(d, live);
  const levels = live?.telemetry?.outputLevelDb ?? [];
  return (
    <Card className="!m-0 cursor-pointer" contentWrapPadding="p-4" onClick={() => openAmp(d.id)}>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-lg font-semibold">{d.name || d.mac}</div>
          <div className="truncate text-sm opacity-60">
            {d.ip} · {d.analogInputChannels} in · {d.outputChannels} out
          </div>
        </div>
        <StateChip state={h.label} />
        <Chevron />
      </div>
      {d.online && levels.length > 0 && (
        <div className="mt-3 flex h-6 items-end gap-1" aria-hidden>
          {levels.map((db, i) => (
            <div key={i} className="relative h-full flex-1 overflow-hidden rounded-sm bg-black/10 dark:bg-white/10">
              <div
                className="absolute inset-x-0 bottom-0 bg-green-600"
                style={{ height: `${db === null ? 0 : Math.max(0, Math.min(1, (db + 60) / 60)) * 100}%` }}
              />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// --- Settings ---------------------------------------------------------------

function SettingsPage() {
  const [scheme, setScheme] = useState<Scheme>(savedScheme);
  return (
    <Page>
      <Navbar left={<NavbarBackLink onClick={() => back("#/")} showText={false} />} title="Settings" />
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-safe-4 pt-4 pb-safe-8">
        <h2 className="px-1 text-sm font-semibold uppercase tracking-wide opacity-60">Colour scheme</h2>
        <Segmented strong>
          {(["dark", "light", "auto"] as const).map((s) => (
            <SegmentedButton
              key={s}
              active={scheme === s}
              className="capitalize"
              onClick={() => {
                applyScheme(s);
                setScheme(s);
              }}
            >
              {s}
            </SegmentedButton>
          ))}
        </Segmented>
      </main>
    </Page>
  );
}
