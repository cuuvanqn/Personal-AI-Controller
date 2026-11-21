import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import "@astryxdesign/theme-neutral/theme.css";
import "./app.css";
import { Theme } from "@astryxdesign/core/theme";
import { otterTheme } from "./theme";
import { AuthProvider } from "./auth";
import App from "./App";

function Root() {
  const [mode, setMode] = useState<"dark" | "light">("dark");

  return (
    <Theme theme={otterTheme} mode={mode}>
      <AuthProvider>
        <App mode={mode} onToggleMode={() => setMode((m) => (m === "dark" ? "light" : "dark"))} />
      </AuthProvider>
    </Theme>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>
);
