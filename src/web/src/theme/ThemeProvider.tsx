import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type ThemeName = "paper" | "midnight";

const ThemeCtx = createContext<{ theme: ThemeName; setTheme: (t: ThemeName) => void }>({
  theme: "paper",
  setTheme: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemeName>(() => {
    const saved = localStorage.getItem("forgeline-theme");
    return saved === "midnight" ? "midnight" : "paper";
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("forgeline-theme", theme);
  }, [theme]);
  return <ThemeCtx.Provider value={{ theme, setTheme }}>{children}</ThemeCtx.Provider>;
}

export function useTheme() {
  return useContext(ThemeCtx);
}
