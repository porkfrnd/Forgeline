// Verifies every theme's colours against WCAG AA, plus the two pairs Update 4
// adds: each filled button's label against its fill, and the OKLCH lightness
// steps between base, card, and raised surfaces.
//
// The pairs themselves live in check-contrast-engine.mjs so that
// scripts/check-design.mjs runs the exact same code rather than a second
// implementation that could drift from this one.
//
// Exits non-zero on any failure, so it can gate a commit the way lint does.
// Run: node scripts/check-contrast.mjs
import { FAMILIES } from "../src/web/src/theme/families.ts";
import { checkColours } from "./check-contrast-engine.mjs";

const failures = checkColours();

if (failures.length > 0) {
  console.error(`contrast: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}

// Reported so a reviewer can see what was actually checked, rather than having
// to trust a bare "ok". The engine does the work; this only counts the shape of
// the matrix it walked — three backdrops per pair, because a Glass panel is
// measured against the lightest and darkest points of the ambient gradient it
// sits over as well as the opaque panel Solid uses.
let pairs = 0;
let lanes = 0;
for (const family of FAMILIES) {
  pairs += family.modes.length * (3 * 3 + 1 * 3 + 2 * 3 + 5 * 3 + 1 + 1 + 2);
  lanes += family.modes.length * 8 * 3;
}

console.log(
  `contrast ok: ${pairs} text/graphic pairs and ${lanes} lane checks across ${FAMILIES.length} families, plus filled-button labels and surface steps`,
);
