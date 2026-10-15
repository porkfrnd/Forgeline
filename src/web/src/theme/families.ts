/** Theme families and modes.
 *
 *  One source of truth for every colour in the interface. The values live in
 *  TypeScript rather than in a stylesheet for two reasons: `scripts/check-contrast.mjs`
 *  reads this file to verify every text pair and every lane colour against
 *  WCAG AA, and `ThemeProvider` applies them as custom properties, so a
 *  family and its light and dark modes cannot drift apart.
 *
 *  The starting values came from the update that commissioned them and are
 *  suggestions: the contrast script has the final word, and the numbers here
 *  are whatever it accepted. */

export type Mode = "dark" | "light";
export type Surface = "glass" | "solid";
export type Effects = "full" | "reduced" | "off";

/** A colour as it appears in CSS. Alpha is kept separate so the contrast
 *  script can composite a translucent panel over the ambient gradient. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export type Paint = string | Rgba;

export interface ThemeTokens {
  /** Page background. */
  base: string;
  /** Primary panel fill. Translucent in Glass surface, opaque in Solid. */
  panel: Paint;
  /** A step above the panel: rows, menus, popovers. */
  raised: Paint;
  /** Above that: dialogs and the command palette. */
  overlay: Paint;
  /** 1 px dividers and borders. */
  hairline: string;
  /** Body text. */
  text: string;
  /** Secondary text. Must meet 4.5:1 against the panel. */
  muted: string;
  /** Fills, graphics, focus rings, glow. 3:1 against the surface. */
  accent: string;
  /** Accent used as text on a light surface, so it also meets 4.5:1. */
  accentText: string;
  /** The cold end of the heat ramp: idle, old, quiet. */
  cold: string;
  /** The hot end of the heat ramp: recent, active, HEAD. */
  hot: string;
  /** The very tip of the ramp, used only for HEAD. */
  whiteHot: string;
  /** Eight lane colours for the commit graph, easy to tell apart. */
  lanes: string[];
  /** Ambient gradient behind the panels, Glass surface only. */
  ambient: [string, string];
  /** Semantic status colours. These never change meaning between themes. */
  status: {
    clean: string;
    changed: string;
    conflict: string;
    ahead: string;
    behind: string;
  };
}

export interface Family {
  id: string;
  label: string;
  /** Modes this family actually ships. A family that lacks a mode disables it
   *  in the control and says why, rather than offering a broken one. */
  modes: Mode[];
  /** Hidden families are not listed in the picker. */
  hidden?: boolean;
  note?: string;
  dark?: ThemeTokens;
  light?: ThemeTokens;
}

const STATUS = {
  clean: "#3FB950",
  changed: "#D29922",
  conflict: "#F85149",
  ahead: "#3FB950",
  behind: "#D29922",
};

export const FAMILIES: Family[] = [
  {
    id: "lagoon",
    label: "Lagoon",
    modes: ["dark", "light"],
    note: "The default. Teal and cyan.",
    dark: {
      base: "#0A141C",
      panel: { r: 16, g: 28, b: 40, a: 0.72 },
      raised: { r: 22, g: 38, b: 52, a: 0.86 },
      overlay: { r: 12, g: 22, b: 32, a: 0.94 },
      hairline: "rgba(255,255,255,0.09)",
      text: "#E6F1F5",
      muted: "#8FA7B3",
      accent: "#1CE6D0",
      accentText: "#1CE6D0",
      cold: "#8FA7B3",
      hot: "#1CE6D0",
      whiteHot: "#B8FFF8",
      lanes: [
        "#1CE6D0",
        "#2FA4FF",
        "#C65BE3",
        "#8C6CF0",
        "#4ADE80",
        "#F2B544",
        "#FF7AB6",
        "#A3E635",
      ],
      ambient: ["#123B47", "#1B1F4B"],
      status: STATUS,
    },
    light: {
      base: "#EAF4F6",
      panel: { r: 255, g: 255, b: 255, a: 0.78 },
      raised: { r: 255, g: 255, b: 255, a: 0.92 },
      overlay: { r: 255, g: 255, b: 255, a: 0.96 },
      hairline: "rgba(14,36,48,0.12)",
      text: "#0E2430",
      muted: "#4F6B78",
      accent: "#0B8F83",
      accentText: "#07756B",
      cold: "#93A8B4",
      hot: "#0B8F83",
      whiteHot: "#04423B",
      lanes: [
        "#0B8F83",
        "#1668C4",
        "#8B32B8",
        "#5B47C8",
        "#1F8A3A",
        "#9A6B00",
        "#C2437F",
        "#5E8A0F",
      ],
      ambient: ["#CFE9EC", "#DCD9F2"],
      status: {
        clean: "#1A7F37",
        changed: "#9A6700",
        conflict: "#CF222E",
        ahead: "#1A7F37",
        behind: "#9A6700",
      },
    },
  },
  {
    id: "cathode",
    label: "Cathode",
    modes: ["dark", "light"],
    note: "Amber CRT warmth.",
    dark: {
      base: "#0F0905",
      panel: { r: 32, g: 20, b: 11, a: 0.74 },
      raised: { r: 44, g: 28, b: 16, a: 0.88 },
      overlay: { r: 22, g: 14, b: 8, a: 0.95 },
      hairline: "rgba(255,170,90,0.14)",
      text: "#FFEBD6",
      muted: "#C9AE92",
      accent: "#FF8A1F",
      accentText: "#FF8A1F",
      cold: "#8C9BA8",
      hot: "#FF8A1F",
      whiteHot: "#FFE1B0",
      lanes: [
        "#FF8A1F",
        "#FFB454",
        "#FF5A36",
        "#E8C547",
        "#C97B4A",
        "#FFD9A0",
        "#5BC0BE",
        "#E86AA6",
      ],
      ambient: ["#3A1A08", "#2A0F0A"],
      status: {
        clean: "#4ADE80",
        changed: "#F2B544",
        conflict: "#FF6B5A",
        ahead: "#4ADE80",
        behind: "#F2B544",
      },
    },
    light: {
      base: "#FFF4E8",
      panel: { r: 255, g: 255, b: 255, a: 0.8 },
      raised: { r: 255, g: 255, b: 255, a: 0.93 },
      overlay: { r: 255, g: 255, b: 255, a: 0.97 },
      hairline: "rgba(190,100,30,0.22)",
      text: "#2B1608",
      muted: "#7A5A3F",
      accent: "#D45A00",
      accentText: "#B34700",
      cold: "#B08A66",
      hot: "#D45A00",
      whiteHot: "#6E2A00",
      lanes: [
        "#B34700",
        "#4A6B0F",
        "#8C1F4E",
        "#1F5FA8",
        "#7A5E00",
        "#0E6B68",
        "#A02A5E",
        "#3F5C1A",
      ],
      ambient: ["#FFE3C4", "#FFF4E8"],
      status: {
        clean: "#1A7F37",
        changed: "#9A6700",
        conflict: "#CF222E",
        ahead: "#1A7F37",
        behind: "#9A6700",
      },
    },
  },
  {
    id: "paper",
    label: "Paper",
    modes: ["dark", "light"],
    note: "Neutral. Quiet blue accent.",
    dark: {
      base: "#0D1117",
      panel: { r: 22, g: 27, b: 34, a: 0.8 },
      raised: { r: 33, g: 38, b: 45, a: 0.9 },
      overlay: { r: 13, g: 17, b: 23, a: 0.95 },
      hairline: "rgba(255,255,255,0.1)",
      text: "#E6EDF3",
      muted: "#9DA7B1",
      accent: "#4493F8",
      accentText: "#4493F8",
      cold: "#9DA7B1",
      hot: "#4493F8",
      whiteHot: "#C2DEFF",
      lanes: [
        "#4493F8",
        "#39C5CF",
        "#BC8CFF",
        "#7EE787",
        "#FF7B72",
        "#E3B341",
        "#E36BA0",
        "#A5D6FF",
      ],
      ambient: ["#161B27", "#10151F"],
      status: {
        clean: "#3FB950",
        changed: "#D29922",
        conflict: "#F85149",
        ahead: "#3FB950",
        behind: "#D29922",
      },
    },
    light: {
      base: "#FFFFFF",
      panel: { r: 255, g: 255, b: 255, a: 0.82 },
      raised: { r: 255, g: 255, b: 255, a: 0.94 },
      overlay: { r: 255, g: 255, b: 255, a: 0.97 },
      hairline: "rgba(31,35,40,0.12)",
      text: "#1F2328",
      muted: "#59636E",
      accent: "#0969DA",
      accentText: "#0757BA",
      cold: "#8A949E",
      hot: "#0969DA",
      whiteHot: "#043A6B",
      lanes: [
        "#0757BA",
        "#0A7C82",
        "#7A3FB8",
        "#1A7F37",
        "#B3200F",
        "#8A5A00",
        "#7A3FA8",
        "#9D174D",
      ],
      ambient: ["#E8EEF4", "#F2F4F8"],
      status: {
        clean: "#1A7F37",
        changed: "#9A6700",
        conflict: "#CF222E",
        ahead: "#1A7F37",
        behind: "#9A6700",
      },
    },
  },
  {
    id: "mono",
    label: "Mono",
    modes: ["dark", "light"],
    note: "Black and white, hairlines only.",
    dark: {
      base: "#000000",
      panel: { r: 10, g: 10, b: 10, a: 0.82 },
      raised: { r: 23, g: 23, b: 23, a: 0.9 },
      overlay: { r: 5, g: 5, b: 5, a: 0.96 },
      hairline: "rgba(255,255,255,0.14)",
      text: "#EDEDED",
      muted: "#A1A1A1",
      accent: "#EDEDED",
      accentText: "#EDEDED",
      cold: "#A1A1A1",
      hot: "#EDEDED",
      whiteHot: "#FFFFFF",
      lanes: [
        "#EDEDED",
        "#BDBDBD",
        "#FFFFFF",
        "#9E9E9E",
        "#D4D4D4",
        "#8A8A8A",
        "#CFCFCF",
        "#A8A8A8",
      ],
      ambient: ["#141414", "#000000"],
      status: {
        clean: "#7EE787",
        changed: "#E3B341",
        conflict: "#FF7B72",
        ahead: "#7EE787",
        behind: "#E3B341",
      },
    },
    light: {
      base: "#FFFFFF",
      panel: { r: 255, g: 255, b: 255, a: 0.84 },
      raised: { r: 250, g: 250, b: 250, a: 0.94 },
      overlay: { r: 255, g: 255, b: 255, a: 0.98 },
      hairline: "rgba(0,0,0,0.14)",
      text: "#0A0A0A",
      muted: "#5C5C5C",
      accent: "#0A0A0A",
      accentText: "#0A0A0A",
      cold: "#8C8C8C",
      hot: "#0A0A0A",
      whiteHot: "#000000",
      lanes: [
        "#1A1A1A",
        "#4A4A4A",
        "#767676",
        "#2E2E2E",
        "#5E5E5E",
        "#8C8C8C",
        "#3D3D3D",
        "#6E6E6E",
      ],
      ambient: ["#F2F2F2", "#FFFFFF"],
      status: {
        clean: "#1A7F37",
        changed: "#9A6700",
        conflict: "#CF222E",
        ahead: "#1A7F37",
        behind: "#9A6700",
      },
    },
  },
  {
    id: "dracula",
    label: "Dracula",
    modes: ["dark"],
    dark: {
      base: "#21222C",
      panel: { r: 40, g: 42, b: 54, a: 0.82 },
      raised: { r: 68, g: 71, b: 90, a: 0.9 },
      overlay: { r: 33, g: 34, b: 44, a: 0.96 },
      hairline: "rgba(248,248,242,0.12)",
      text: "#F8F8F2",
      muted: "#B0AFC0",
      accent: "#BD93F9",
      accentText: "#D7BAFF",
      cold: "#B0AFC0",
      hot: "#BD93F9",
      whiteHot: "#EBDCFF",
      lanes: [
        "#BD93F9",
        "#8BE9FD",
        "#FF79C6",
        "#50FA7B",
        "#FFB86C",
        "#F1FA8C",
        "#6272A4",
        "#FF6E6E",
      ],
      ambient: ["#2A2136", "#191A21"],
      status: {
        clean: "#50FA7B",
        changed: "#F1FA8C",
        conflict: "#FF5555",
        ahead: "#50FA7B",
        behind: "#F1FA8C",
      },
    },
  },
  {
    id: "nord",
    label: "Nord",
    modes: ["dark"],
    dark: {
      base: "#2E3440",
      panel: { r: 46, g: 52, b: 64, a: 0.84 },
      raised: { r: 59, g: 66, b: 82, a: 0.92 },
      overlay: { r: 36, g: 41, b: 51, a: 0.96 },
      hairline: "rgba(216,222,233,0.14)",
      text: "#ECEFF4",
      muted: "#C0C8D6",
      accent: "#88C0D0",
      accentText: "#9FD3E0",
      cold: "#8A99AD",
      hot: "#88C0D0",
      whiteHot: "#D8EFFF",
      lanes: [
        "#88C0D0",
        "#C9737C",
        "#B48EAD",
        "#A3BE8C",
        "#EBCB8B",
        "#D08770",
        "#8FBCBB",
        "#5E81AC",
      ],
      ambient: ["#33405A", "#2A303C"],
      status: {
        clean: "#A3BE8C",
        changed: "#EBCB8B",
        conflict: "#E0808A",
        ahead: "#A3BE8C",
        behind: "#EBCB8B",
      },
    },
  },
  {
    id: "phosphor",
    label: "Phosphor",
    modes: ["dark"],
    hidden: true,
    note: "Green on black.",
    dark: {
      base: "#030A03",
      panel: { r: 6, g: 22, b: 6, a: 0.86 },
      raised: { r: 12, g: 34, b: 12, a: 0.94 },
      overlay: { r: 4, g: 14, b: 4, a: 0.97 },
      hairline: "rgba(80,255,120,0.18)",
      text: "#C8FFC8",
      muted: "#7FC47F",
      accent: "#4FE84F",
      accentText: "#6BFF6B",
      cold: "#7FC47F",
      hot: "#4FE84F",
      whiteHot: "#D8FFD8",
      lanes: [
        "#4FE84F",
        "#8CFF8C",
        "#2FBF2F",
        "#B8FFB8",
        "#6BE86B",
        "#A8F0A8",
        "#3FD08F",
        "#D0FF9A",
      ],
      ambient: ["#06210A", "#020802"],
      status: {
        clean: "#6BFF6B",
        changed: "#D8FF6B",
        conflict: "#FF8A6B",
        ahead: "#6BFF6B",
        behind: "#D8FF6B",
      },
    },
  },
];

export const DEFAULT_FAMILY = "lagoon";
export const DEFAULT_MODE: Mode = "dark";

export function getFamily(id: string): Family {
  return FAMILIES.find((f) => f.id === id) ?? FAMILIES[0];
}

/** The token set for a family in a given mode, or null when that family does
 *  not ship the mode. Callers use this to disable the mode in the control
 *  rather than silently falling back. */
export function tokensFor(id: string, mode: Mode): ThemeTokens | null {
  const family = getFamily(id);
  const tokens = mode === "dark" ? family.dark : family.light;
  return tokens ?? null;
}

/** Families the picker should list. */
export function visibleFamilies(): Family[] {
  return FAMILIES.filter((f) => !f.hidden);
}

/** `mode` resolved against `prefers-color-scheme` when Auto is chosen. */
export function resolveMode(mode: Mode | "auto", prefersDark: boolean): Mode {
  return mode === "auto" ? (prefersDark ? "dark" : "light") : mode;
}
