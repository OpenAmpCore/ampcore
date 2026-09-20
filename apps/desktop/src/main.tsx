import React from "react";
import ReactDOM from "react-dom/client";
import { Toast } from "@heroui/react";
import "@fontsource-variable/inter";
import "./styles/tailwind.css";
import App from "./App";
import { applyAppearance } from "./lib/appearance";

// The pre-paint script in index.html already applied these; re-applying from
// the store is what keeps the two honest — if they ever disagree, the store
// wins rather than the app running on a stale hand-copied table.
applyAppearance();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {/* `maxVisibleToasts` is explicit because failure toasts now persist
        until dismissed (see `liveConfigureAdapter`'s `reportWrite`) —
        without a cap, a burst against an unreachable amp could bury the
        screen. */}
    <Toast.Provider placement="bottom end" maxVisibleToasts={5} />
    <App />
  </React.StrictMode>,
);
