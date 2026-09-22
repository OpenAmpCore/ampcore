import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Card, Chip, Link, List, ListItem, Navbar, Page, Panel, Preloader } from "konsta/react";
import { AmpScreen, isPathScreen } from "./AmpScreen";
import { Settings } from "./sections";
import { chipColors, go, goPresets, goSettings, useDevices, useRoute, type Device } from "./lib";

const Dot = ({ online }: { online: boolean }) => (
  <span className={`size-2.5 shrink-0 rounded-full ${online ? "bg-green-500" : "bg-gray-400"}`} />
);

/** The one top-level content container for navbar-driven screens (amp list,
 * Overview, Presets, Settings). Clamps/centers on wide (tablet) viewports and
 * carries the safe-area padding the path screen's own section already has, so
 * the two stop diverging. */
export function PageMain({ className = "", children }: { className?: string; children: ReactNode }) {
  return <main className={`mx-auto w-full max-w-3xl px-safe-4 pb-safe-4 pt-4 ${className}`}>{children}</main>;
}

function AmpCard({ d }: { d: Device }) {
  return (
    <Card className="!mx-0 cursor-pointer" onClick={() => go(d.id)}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-semibold">{d.name || d.mac}</div>
          <div className="text-sm opacity-60">
            {d.brand} · {d.ip} · fw {d.firmwareVersion}
          </div>
          <div className="text-sm opacity-60">
            {d.analogInputChannels + d.digitalInputChannels} in · {d.outputChannels} out
          </div>
        </div>
        <Chip colors={chipColors(d.online ? "success" : "default")}>{d.online ? "online" : "offline"}</Chip>
      </div>
    </Card>
  );
}

export function App() {
  const devices = useDevices();
  const route = useRoute();
  const { id, settings, presets } = route;
  const [menu, setMenu] = useState(false);
  const [presetsOk, setPresetsOk] = useState(false);
  const amp = id ? devices.find((d) => d.id === id) : undefined;
  const pendingNav = useRef<(() => void) | null>(null);

  // The drawer owns a history entry of its own, so the first back press closes
  // it instead of navigating. Both the navbar chevron and Android's hardware
  // button reach history.back(), so one mechanism covers both. The hash is
  // untouched, so pushing the entry fires no hashchange and the route is
  // unaffected (setting location.hash fires hashchange but never popstate, so
  // the listener below only ever runs on a real back/forward).
  const openMenu = () => {
    history.pushState({ menu: true }, "");
    setMenu(true);
  };
  useEffect(() => {
    const onPop = () => {
      setMenu(false);
      const go = pendingNav.current;
      pendingNav.current = null;
      go?.();
    };
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  /** Closing any other way pops the same entry, so history stays balanced. */
  const closeMenu = () => {
    if (history.state?.menu) history.back();
    else setMenu(false);
  };
  /** Navigating straight from an open drawer has to pop its entry first —
   * otherwise the entry stays buried under the new page and costs a dead back
   * press later. The navigation runs from the popstate handler. */
  const nav = (fn: () => void) => () => {
    if (history.state?.menu) {
      pendingNav.current = fn;
      history.back();
    } else {
      fn();
      setMenu(false);
    }
  };

  // Presets are firmware-gated; core decides (`write_helpers::presets_supported`).
  useEffect(() => {
    if (!id) return setPresetsOk(false);
    invoke<boolean>("amp_presets_supported", { deviceId: id }).then(setPresetsOk, () => setPresetsOk(false));
  }, [id]);

  // The path layout carries its own back button and amp name in the rail — a
  // navbar on top of that cost ~20% of the landscape height for nothing.
  const pathScreen = !!amp && isPathScreen(route);
  // Presets and Settings show a chevron; it leaves the amp entirely rather than
  // stepping back one entry, so "back" means one thing everywhere in the app.
  const deep = settings || presets;

  return (
    <Page>
      {!pathScreen && (
        <Navbar
          title={settings ? "Settings" : presets ? "Presets" : amp ? amp.name || amp.mac : "AmpCore"}
          left={
            deep ? (
              <Link onClick={() => go(null)} aria-label="Back to amps">
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M12 4l-6 6 6 6" />
                </svg>
              </Link>
            ) : (
              <Link onClick={openMenu} aria-label="Menu">
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M3 5h14M3 10h14M3 15h14" />
                </svg>
              </Link>
            )
          }
          right={!amp && !settings && (devices.length === 0 ? <Preloader className="size-5" /> : <span className="pr-4 opacity-60">{devices.length} found</span>)}
        />
      )}

      <Panel side="left" opened={menu} onBackdropClick={closeMenu}>
        <Page>
          <Navbar title="AmpCore" />
          <List nested>
            <ListItem link title="All amps" onClick={nav(() => go(null))} className={!id && !settings ? "bg-black/10 dark:bg-white/10" : ""} />
            {devices.map((d) => (
              <ListItem
                key={d.id}
                link
                media={<Dot online={d.online} />}
                title={d.name || d.mac}
                subtitle={d.ip}
                onClick={nav(() => go(d.id))}
                className={d.id === id ? "bg-black/10 dark:bg-white/10" : ""}
              />
            ))}
            {/* Presets and Settings lost their tabs with the tabbar. */}
            {amp && presetsOk && (
              <ListItem link title="Presets" onClick={nav(() => goPresets(amp.id))} className={presets ? "bg-black/10 dark:bg-white/10" : ""} />
            )}
            <ListItem link title="Settings" onClick={nav(goSettings)} className={settings ? "bg-black/10 dark:bg-white/10" : ""} />
          </List>
        </Page>
      </Panel>

      {/* AmpScreen brings its own container — the path layout has to be
          full-bleed to fill the height, so it can't live inside a padded main. */}
      {amp ? (
        <AmpScreen key={amp.id} device={amp} route={route} />
      ) : (
        <PageMain>
          {settings ? (
            <Settings />
          ) : id ? (
            <p className="mt-8 text-center opacity-60">Looking for this amp…</p>
          ) : devices.length === 0 ? (
            <p className="mt-8 text-center opacity-60">Searching for amps on your Wi-Fi…</p>
          ) : (
            <div className="grid gap-3" aria-live="polite">
              {devices.map((d) => (
                <AmpCard key={d.id} d={d} />
              ))}
            </div>
          )}
        </PageMain>
      )}
    </Page>
  );
}
