import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  DEFAULT_FAMILY,
  DEFAULT_MODE,
  FAMILIES,
  getFamily,
  resolveMode,
  tokensFor,
  type Effects,
  type Mode,
  type Paint,
  type Rgba,
  type Surface,
} from "./families";

export type { Effects, Mode, Surface };
export type ModeChoice = Mode | "auto";
export type Density = "compact" | "cozy";

export interface Appearance {
  family: string;
  mode: ModeChoice;
  surface: Surface;
  effects: Effects;
  density: Density;
}

const STORAGE_KEY = "forgeline-appearance";

const DEFAULTS: Appearance = {
  family: DEFAULT_FAMILY,
  mode: DEFAULT_MODE,
  surface: "glass",
  effects: "full",
  density: "cozy",
};

function loadAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const saved = JSON.parse(raw) as Partial<Appearance>;
    const family = FAMILIES.some((f) => f.id === saved.family)
      ? (saved.family as string)
      : DEFAULTS.family;
    const mode =
      saved.mode === "dark" || saved.mode === "light" || saved.mode === "auto"
        ? saved.mode
        : DEFAULTS.mode;
    return {
      family,
      mode,
      surface: saved.surface === "solid" ? "solid" : "glass",
      effects:
        saved.effects === "reduced" || saved.effects === "off" ? saved.effects : "full",
      density: saved.density === "compact" ? "compact" : "cozy",
    };
  } catch {
    // A corrupt or unreadable store must never stop the app from starting.
    return DEFAULTS;
  }
}

function parseHex(input: string): Rgba {
  const m = input.trim().match(/^#([0-9a-f]{6})$/i);
  if (!m) return { r: 0, g: 0, b: 0, a: 1 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
}

function toRgba(paint: Paint): Rgba {
  if (typeof paint !== "string") return paint;
  return paint.trim().startsWith("#") ? parseHex(paint) : parseRgba(paint);
}

function parseRgba(input: string): Rgba {
  const m = input
    .trim()
    .match(
      /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.%]+))?\s*\)$/i,
    );
  if (!m) return { r: 0, g: 0, b: 0, a: 1 };
  const a =
    m[4] === undefined
      ? 1
      : m[4].endsWith("%")
        ? parseFloat(m[4]) / 100
        : parseFloat(m[4]);
  return { r: +m[1], g: +m[2], b: +m[3], a };
}

function css(paint: Rgba): string {
  if (paint.a >= 1) {
    const hex = [paint.r, paint.g, paint.b]
      .map((v) => Math.round(v).toString(16).padStart(2, "0"))
      .join("");
    return `#${hex}`;
  }
  return `rgba(${Math.round(paint.r)}, ${Math.round(paint.g)}, ${Math.round(paint.b)}, ${paint.a})`;
}

/** Flatten a translucent colour onto an opaque one, so a Solid-surface panel
 *  is a real opaque colour rather than a see-through approximation. */
function flatten(paint: Rgba, backdrop: Rgba): Rgba {
  return {
    r: paint.r * paint.a + backdrop.r * (1 - paint.a),
    g: paint.g * paint.a + backdrop.g * (1 - paint.a),
    b: paint.b * paint.a + backdrop.b * (1 - paint.a),
    a: 1,
  };
}

function mix(a: Rgba, b: Rgba, t: number): Rgba {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
    a: 1,
  };
}

export interface AppliedTokens {
  [name: string]: string;
}

/** Turn a family, mode, and surface into the flat token record the
 *  stylesheet reads. Returns null when the family has no tokens for the mode,
 *  which the caller treats as "fall back to a mode it does have". */
export function buildTokens(
  familyId: string,
  mode: Mode,
  surface: Surface,
): AppliedTokens | null {
  const tokens = tokensFor(familyId, mode);
  if (!tokens) return null;
  const baseColor = parseHex(tokens.base);
  const panel = toRgba(tokens.panel);
  const raised = toRgba(tokens.raised);
  const overlay = toRgba(tokens.overlay);
  // Solid composites each surface over the page so it is genuinely opaque;
  // Glass keeps the translucency and lets the gradient show through.
  const panelPaint = surface === "solid" ? flatten(panel, baseColor) : panel;
  const raisedPaint = surface === "solid" ? flatten(raised, baseColor) : raised;
  const overlayPaint = surface === "solid" ? flatten(overlay, baseColor) : overlay;

  const cold = parseHex(tokens.cold);
  const hot = parseHex(tokens.hot);
  const whiteHot = parseHex(tokens.whiteHot);
  // Five steps from cold to white-hot, so a graph can encode age as a real
  // ramp instead of two colours with a jump between them.
  const ramp = [
    cold,
    mix(cold, hot, 0.4),
    hot,
    mix(hot, whiteHot, 0.55),
    whiteHot,
  ];

  const out: AppliedTokens = {
    "--base": css(baseColor),    "--panel": css(panelPaint),
    "--raised": css(raisedPaint),
    "--overlay": css(overlayPaint),
    "--hairline": tokens.hairline,
    "--text": tokens.text,
    "--muted": tokens.muted,
    "--accent": tokens.accent,
    "--accent-text": tokens.accentText,
    "--cold": tokens.cold,
    "--hot": tokens.hot,
    "--ambient-from": tokens.ambient[0],
    "--ambient-to": tokens.ambient[1],
    "--surface-blur": surface === "solid" ? "none" : "14px",
  };
  ramp.forEach((step, i) => {
    out[`--heat-${i + 1}`] = css(step);
  });
  tokens.lanes.forEach((lane, i) => {
    out[`--lane-${i + 1}`] = lane;
  });
  for (const [key, value] of Object.entries(tokens.status)) {
    out[`--status-${key}`] = value;
  }
  return out;
}

interface ThemeValue {
  appearance: Appearance;
  /** The mode actually in force, after Auto is resolved. */
  mode: Mode;
  familyLabel: string;
  /** True when the family cannot do the requested mode. */
  modeUnavailable: boolean;
  set: (patch: Partial<Appearance>) => void;
}

const ThemeCtx = createContext<ThemeValue>({
  appearance: DEFAULTS,
  mode: DEFAULT_MODE,
  familyLabel: "",
  modeUnavailable: false,
  set: () => {},
});

function prefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches === true
  );
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [appearance, setAppearance] = useState<Appearance>(() => {
    const loaded = loadAppearance();
    // Effects default from the system setting, but a saved choice wins.
    const hasSaved =
      typeof localStorage !== "undefined" && localStorage.getItem(STORAGE_KEY) !== null;
    return hasSaved || !prefersReducedMotion() ? loaded : { ...loaded, effects: "reduced" };
  });
  const [systemDark, setSystemDark] = useState<boolean>(prefersDark);

  // Follow the system while the mode is Auto.
  useEffect(() => {
    if (appearance.mode !== "auto") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [appearance.mode]);

  const family = getFamily(appearance.family);
  const resolvedMode = resolveMode(appearance.mode, systemDark);
  const modeUnavailable = !family.modes.includes(resolvedMode);
  // A family that lacks the resolved mode falls back to one it has, rather
  // than rendering with missing tokens.
  const effectiveMode: Mode = family.modes.includes(resolvedMode)
    ? resolvedMode
    : family.modes[0];

  useEffect(() => {
    const tokens = buildTokens(appearance.family, effectiveMode, appearance.surface);
    const root = document.documentElement;
    if (tokens) {
      for (const [name, value] of Object.entries(tokens)) {
        root.style.setProperty(name, value);
      }
    }
    root.dataset.family = appearance.family;
    root.dataset.mode = effectiveMode;
    root.dataset.surface = appearance.surface;
    root.dataset.effects = appearance.effects;
    root.dataset.density = appearance.density;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(appearance));
    } catch {
      // A full or blocked store is not worth failing a render over.
    }
  }, [appearance, effectiveMode]);

  const value = useMemo<ThemeValue>(
    () => ({
      appearance,
      mode: effectiveMode,
      familyLabel: family.label,
      modeUnavailable,
      set: (patch) => setAppearance((cur) => ({ ...cur, ...patch })),
    }),
    [appearance, effectiveMode, family.label, modeUnavailable],
  );

  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
}

export function useTheme() {
  return useContext(ThemeCtx);
}
