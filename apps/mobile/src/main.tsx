import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App as Konsta } from "konsta/react";
import "./styles.css";
import { App } from "./App";

// iOS look on iPhone/iPad, Material everywhere else (Android is the only build today).
const theme = /iPhone|iPad|iPod/.test(navigator.userAgent) ? "ios" : "material";

/** Android's system bars, which env(safe-area-inset-*) never reports there — it
 * only carries display-cutout geometry, so it reads 0px on this phone while the
 * status bar is really 40dp tall. MainActivity measures the window and hands the
 * values over; this writes them onto <html>, and styles.css feeds them into the
 * --k-safe-area-* variables Konsta's pt-safe/px-safe utilities read. They cannot
 * be written directly: Konsta redeclares those on its own .safe-areas root,
 * which shadows anything set on <html>. No-op on iOS and in a desktop browser,
 * where the bridge is absent and env() works. */
declare global {
  interface Window {
    AmpCoreInsets?: { get(): string };
    __ampcoreApplyInsets?: () => void;
  }
}

const EDGES = ["top", "right", "bottom", "left"] as const;
function applyInsets() {
  const raw = window.AmpCoreInsets?.get();
  if (!raw) return;
  const parts = raw.split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return;
  EDGES.forEach((edge, i) => document.documentElement.style.setProperty(`--ampcore-inset-${edge}`, `${parts[i]}px`));
}
// Native calls this on resume and on rotation; the listeners cover a reload that
// lands after the last push, and the initial read on startup.
window.__ampcoreApplyInsets = applyInsets;
addEventListener("resize", applyInsets);
applyInsets();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Konsta theme={theme}>
      <App />
    </Konsta>
  </StrictMode>,
);
