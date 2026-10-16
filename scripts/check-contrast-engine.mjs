// The colour engine behind both colour checks, so there is one implementation
// and one source of truth:
//
//   - scripts/check-contrast.mjs runs it on every family and mode and reports
//     the counts, as it always has.
//   - scripts/check-design.mjs runs the same function and treats any failure as
//     a failed design gate.
//
// On top of the original pairs this now checks the two things Update 4 names:
//   - each filled button's label against its fill, which is the pair that
//     quietly fails when a light-mode accent is bright enough to look right but
//     not dark enough to carry white text on;
//   - the OKLCH lightness steps between base, card, and raised, because depth
//     from tone only reads as depth when the steps are real.
import { FAMILIES, tokensFor } from "../src/web/src/theme/families.ts";

export const AA_TEXT = 4.5;
export const AA_GRAPHIC = 3.0;
/** Two lanes closer than this are hard to tell apart on a commit graph. */
export const LANE_MIN_DELTA = 0.11;
/** The minimum perceptual step between two surface levels. Update 4, rule 3. */
export const SURFACE_MIN_STEP = 0.04;

export function parse(input) {
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
export function over(fg, bg) {
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  };
}

export function luminance({ r, g, b }) {
  const chan = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
}

export function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Perceptual distance, used to tell lanes apart. */
export function delta(a, b) {
  return (Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b)) / 765;
}

/** OKLCH lightness, the perceptually even measure of how light a colour reads.
 *  Lightness steps between surface levels have to be judged on this scale, not
 *  on RGB, because two colours the same RGB distance apart can be nowhere near
 *  the same distance apart to look at. */
export function oklchLightness({ r, g, b }) {
  const chan = (v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const lr = chan(r);
  const lg = chan(g);
  const lb = chan(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
}

/**
 * Run every colour check. Returns an array of failure strings; empty means the
 * colours are allowed.
 */
export function checkColours() {
  const failures = [];

  for (const family of FAMILIES) {
    for (const mode of family.modes) {
      const t = tokensFor(family.id, mode);
      if (!t) {
        failures.push(`${family.id}/${mode}: declares mode but has no tokens`);
        continue;
      }
      const label = `${family.id}/${mode}`;
      const panelSolid = parse(typeof t.panel === "string" ? t.panel : { ...t.panel, a: 1 });
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
        if (ratio < AA_GRAPHIC) {
          failures.push(
            `${label}: accent ${t.accent} as a graphic on ${backName} is ${ratio.toFixed(2)}:1, needs ${AA_GRAPHIC}:1`,
          );
        }
      }

      // Diff colours carry the reading of a diff, so they are held to the text
      // threshold: an added line you cannot read is not an added line.
      for (const [name, colour] of Object.entries(t.diff)) {
        if (name.endsWith("Surface")) continue; // washes are backgrounds, never text
        for (const [backName, backdrop] of backdrops) {
          const ratio = contrast(parse(colour), backdrop);
          if (ratio < AA_TEXT) {
            failures.push(
              `${label}: diff ${name} ${colour} on ${backName} is ${ratio.toFixed(2)}:1, needs ${AA_TEXT}:1`,
            );
          }
        }
      }

      // Semantic status colours carry meaning with an icon and a word beside
      // them, so they are held to the graphic threshold, not the text one.
      for (const [name, colour] of Object.entries(t.status)) {
        for (const [backName, backdrop] of backdrops) {
          const ratio = contrast(parse(colour), backdrop);
          if (ratio < AA_GRAPHIC) {
            failures.push(
              `${label}: status ${name} ${colour} on ${backName} is ${ratio.toFixed(2)}:1, needs ${AA_GRAPHIC}:1`,
            );
          }
        }
      }

      // The filled primary button: its label against its own fill. This is the
      // check that catches Update 4's numbers — white on #D45A00 and white on
      // #0B8F83 are both about 4.0:1, which fails button text even though both
      // colours look fine as an accent on their own.
      const fill = t.accentStrong;
      const buttonLabel = mode === "dark" ? t.base : "#FFFFFF";
      const fillRatio = contrast(parse(fill), parse(buttonLabel));
      if (fillRatio < AA_TEXT) {
        failures.push(
          `${label}: filled button label ${buttonLabel} on fill ${fill} is ${fillRatio.toFixed(2)}:1, needs ${AA_TEXT}:1`,
        );
      }

      // Lane colours: 3:1 against the panel, and distinguishable from neighbours.
      t.lanes.forEach((lane, i) => {
        for (const [backName, backdrop] of backdrops) {
          const ratio = contrast(parse(lane), backdrop);
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

      // Surface steps, measured in OKLCH lightness rather than RGB. A card that
      // is only a hair away from the page is depth that reads as a bug. Both
      // paints are composited over the base here, because that is what the app
      // actually renders; measuring one raw and one composited compares two
      // different things and reports a step that does not exist on screen.
      const baseFlat = parse(t.base);
      const panelOverBase = over(parse(t.panel), baseFlat);
      const raisedOverBase = over(parse(t.raised), baseFlat);
      const levels = [
        ["base", baseFlat],
        ["panel", panelOverBase],
        ["raised", raisedOverBase],
      ];
      for (let i = 1; i < levels.length; i++) {
        const step = Math.abs(
          oklchLightness(levels[i][1]) - oklchLightness(levels[i - 1][1]),
        );
        if (step < SURFACE_MIN_STEP) {
          failures.push(
            `${label}: ${levels[i][0]} is only ${step.toFixed(3)} above ${levels[i - 1][0]} in OKLCH lightness, needs ${SURFACE_MIN_STEP}`,
          );
        }
      }
    }
  }

  return failures;
}

export { FAMILIES };
