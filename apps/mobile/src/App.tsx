import { useState } from "react";
import { Card, Chip, Link, List, ListItem, Navbar, Page, Panel, Preloader } from "konsta/react";
import { AmpScreen } from "./AmpScreen";
import { Settings } from "./sections";
import { chipColors, go, goSettings, useDevices, useRoute, type Device } from "./lib";

const Dot = ({ online }: { online: boolean }) => (
  <span className={`size-2.5 shrink-0 rounded-full ${online ? "bg-green-500" : "bg-gray-400"}`} />
);

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
  const { id, tab, eqChannel, settings } = useRoute();
  const [menu, setMenu] = useState(false);
  const amp = id ? devices.find((d) => d.id === id) : undefined;
  const nav = (fn: () => void) => () => {
    fn();
    setMenu(false);
  };

  return (
    <Page>
      <Navbar
        title={settings ? "Settings" : amp ? amp.name || amp.mac : "AmpCore"}
        left={
          // On the EQ route the same slot goes back one level instead — the
          // hash history entry is what Android's back button pops too.
          eqChannel !== null ? (
            <Link onClick={() => history.back()} aria-label="Back">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M12 4l-6 6 6 6" />
              </svg>
            </Link>
          ) : (
            <Link onClick={() => setMenu(true)} aria-label="Menu">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M3 5h14M3 10h14M3 15h14" />
              </svg>
            </Link>
          )
        }
        right={!amp && !settings && (devices.length === 0 ? <Preloader className="size-5" /> : <span className="pr-4 opacity-60">{devices.length} found</span>)}
      />

      <Panel side="left" opened={menu} onBackdropClick={() => setMenu(false)}>
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
                onClick={nav(() => go(d.id, tab))} // amp → amp keeps the current section
                className={d.id === id ? "bg-black/10 dark:bg-white/10" : ""}
              />
            ))}
            <ListItem link title="Settings" onClick={nav(goSettings)} className={settings ? "bg-black/10 dark:bg-white/10" : ""} />
          </List>
        </Page>
      </Panel>

      <main className={`px-4 py-4 ${amp ? "pb-24" : ""}`}>
        {settings ? (
          <Settings />
        ) : amp ? (
          <AmpScreen key={amp.id} device={amp} tab={tab} eqChannel={eqChannel} />
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
      </main>
    </Page>
  );
}
