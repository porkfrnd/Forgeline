import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { ThemeProvider } from "./theme/ThemeProvider";
// Fonts before tokens, because tokens.css reads them by family name and the
// @font-face rules have to exist by the time anything renders.
import "./fonts.css";
import "./theme/tokens.css";

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(
    <React.StrictMode>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </React.StrictMode>,
  );
}
