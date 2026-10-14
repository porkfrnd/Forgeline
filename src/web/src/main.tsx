import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { ThemeProvider } from "./theme/ThemeProvider";
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
