import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App as Konsta } from "konsta/react";
import "./styles.css";
import { App } from "./App";

// iOS look on iPhone/iPad, Material everywhere else (Android is the only build today).
const theme = /iPhone|iPad|iPod/.test(navigator.userAgent) ? "ios" : "material";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Konsta theme={theme}>
      <App />
    </Konsta>
  </StrictMode>,
);
