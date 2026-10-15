// Verifies every theme's colours against WCAG AA.
//
// Checks, per family and mode:
//   1. text, muted, and accentText against the panel, composited over the
//      ambient gradient at both extremes (the worst case behind a Glass panel)
//      and against the opaque panel used by Solid surface.
//   2. accent as a graphic against the surface (3:1).
//   3. every lane colour against the panel (3:1), and that neighbours in the
//      lane list are distinguishable.
//
// Exits non-zero on any failure, so it can gate a commit the way lint does.
// Run: node scripts/check-contrast.mjs
import { FAMILIES, tokensFor } from "../src/web/src/theme/families.ts";

const AA_TEXT = 4.5;
const AA_GRAPHIC = 3.0;
/** Two lanes closer than this are hard to tell apart on a commit graph. */
const LANE_MIN_DELTA = 0.11;

function parse(input) {
  if (typeof input === "string") {
    const hex = input.trim();
    const m = hex.match(/^#([0-9a-f]{6})$/i);
    if (m) {
      const n = parseInt(m[1], 16);
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
    }
    const rgba = hex.match(
      /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.%]+))?\s*\)$/i,
    );
    if (rgba) {
      let a = 1;
      if (rgba[4] !== undefined) {
        a = rgba[4].endsWith("%") ? parseFloat(rgba[4]) / 100 : parseFloat(rgba[4]);
      }
      return { r: +rgba[1], g: +rgba[2], b: +rgba[3], a };
    }
    throw new Error(`unparseable colour: ${hex}`);
  }
  return input;
}

/** Composite `fg` (with alpha) over an opaque `bg`. */
function over(fg, bg) {
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  };
}

function luminance({ r, g, b }) {
  const chan = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
}

function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Perceptual distance, used to tell lanes apart. */
function delta(a, b) {
  return (
    (Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b)) / 765
  );
}

const failures = [];
const checked = { pairs: 0, lanes: 0 };

for (const family of FAMILIES) {
  for (const mode of family.modes) {
    const t = tokensFor(family.id, mode);
    if (!t) {
      failures.push(`${family.id}/${mode}: declares mode but has no tokens`);
      continue;
    }
    const label = `${family.id}/${mode}`;
    const panelSolid = parse(
      typeof t.panel === "string" ? t.panel : { ...t.panel, a: 1 },
    );
    const ambientA = parse(t.ambient[0]);
    const ambientB = parse(t.ambient[1]);

    // A Glass panel sits over the ambient gradient, so measure against the
    // lightest and darkest points it can have behind it.
    const backdrops = [
      ["solid panel", panelSolid],
      ["glass over ambient A", over(parse(t.panel), ambientA)],
      ["glass over ambient B", over(parse(t.panel), ambientB)],
    ];

    const textPairs = [
      ["text", t.text, AA_TEXT],
      ["muted", t.muted, AA_TEXT],
      ["accentText", t.accentText, AA_TEXT],
    ];

    for (const [name, colour, min] of textPairs) {
      for (const [backName, backdrop] of backdrops) {
        const ratio = contrast(parse(colour), backdrop);
        checked.pairs += 1;
        if (ratio < min) {
          failures.push(
            `${label}: ${name} ${colour} on ${backName} is ${ratio.toFixed(2)}:1, needs ${min}:1`,
          );
        }
      }
    }

    // The accent is a graphic: 3:1, and only against the surface it is drawn on.
    for (const [backName, backdrop] of backdrops) {
      const ratio = contrast(parse(t.accent), backdrop);
      checked.pairs += 1;
      if (ratio < AA_GRAPHIC) {
        failures.push(
          `${label}: accent ${t.accent} as a graphic on ${backName} is ${ratio.toFixed(2)}:1, needs ${AA_GRAPHIC}:1`,
        );
      }
    }

    // Semantic status colours carry meaning with an icon and a word beside
    // them, so they are held to the graphic threshold, not the text one.
    for (const [name, colour] of Object.entries(t.status)) {
      for (const [backName, backdrop] of backdrops) {
        const ratio = contrast(parse(colour), backdrop);
        checked.pairs += 1;
        if (ratio < AA_GRAPHIC) {
          failures.push(
            `${label}: status ${name} ${colour} on ${backName} is ${ratio.toFixed(2)}:1, needs ${AA_GRAPHIC}:1`,
          );
        }
      }
    }

    // Lane colours: 3:1 against the panel, and distinguishable from neighbours.
    t.lanes.forEach((lane, i) => {
      for (const [backName, backdrop] of backdrops) {
        const ratio = contrast(parse(lane), backdrop);
        checked.lanes += 1;
        if (ratio < AA_GRAPHIC) {
          failures.push(
            `${label}: lane ${i} ${lane} on ${backName} is ${ratio.toFixed(2)}:1, needs ${AA_GRAPHIC}:1`,
          );
        }
      }
      const next = t.lanes[(i + 1) % t.lanes.length];
      const d = delta(parse(lane), parse(next));
      if (d < LANE_MIN_DELTA) {
        failures.push(
          `${label}: lane ${i} ${lane} and lane ${(i + 1) % t.lanes.length} ${next} are only ${d.toFixed(3)} apart`,
        );
      }
    });

    // The heat ramp must actually span cold to hot, or it encodes nothing.
    const rampDelta = delta(parse(t.cold), parse(t.whiteHot));
    if (rampDelta < 0.2) {
      failures.push(
        `${label}: heat ramp spans only ${rampDelta.toFixed(3)} between cold ${t.cold} and white-hot ${t.whiteHot}`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error(`contrast: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}

console.log(
  `contrast ok: ${checked.pairs} text/graphic pairs and ${checked.lanes} lane checks across ${FAMILIES.length} families`,
);
