# Design

> Last updated: 2026-10-16 (Update 4)

The tokens, components, effects levels, and the review checklist. `families.ts`
is the source of truth for every colour; this file explains the rules that go
around them and documents how they are wired.

## Where the design lives

| File | Owns |
| --- | --- |
| `src/web/src/theme/families.ts` | Every colour: families, modes, lanes, heat, status |
| `src/web/src/theme/ThemeProvider.tsx` | Turns a family + mode + surface into custom properties |
| `src/web/src/theme/tokens.css` | Structure only: layout, surfaces, effects, density, motion |
| `scripts/check-contrast.mjs` | The gate that decides whether the colours are allowed |

Colour is deliberately absent from `tokens.css`. The provider applies it as
custom properties, so a family and its modes cannot drift, and the contrast
script reads the same file the app does.

## Colour means something (Update 4)

The organising idea is no longer heat. Colour now means one thing, the same thing
in every family, and nothing is tinted for mood:

| Colour | Means |
| --- | --- |
| the hero accent | your uncommitted work, and anything needing attention |
| green | clean or synced |
| cool steel | the remote, or other people's work |
| red | deleted lines, and destructive actions only |
| diff green / diff red | added and removed lines — their own tints, never the accent |

Nothing above is carried by colour alone. Every status also has a glyph, a text
label, and `+` / `−` in diffs. The heat ramp survives only where the graph needs
one, and a status never borrows from it.

## Four font roles, one type floor

| Role | Token | Size / line height | Use |
| --- | --- | --- | --- |
| Body, controls, hints | `--font-ui` | 14 / 1.45 (13 in Compact) | All interface text, including hints |
| Panel heading | `--font-ui` 600 | 15 / 1.3 | One per panel |
| Display | `--font-display` | 20–48 | Repo name, card titles, hero numbers only |
| Micro label | `--font-code`, uppercase, 0.08em | 11 / 1.3 | At most one per panel, never a sentence |
| Code-like data | `--font-code` | 13 / 1.5 | Paths, hashes, branches, commands, diffs |
| The app speaking | `--font-message` | 15 / 1.5 | Translated cards and result messages only |

`--font-display` is **Barlow Condensed**, OFL-1.1, weights 400/500/600, Latin
subset only, bundled and self-hosted — no font is ever fetched at runtime. Its
Latin 600 woff2 is 22 KB, inside the 40 KB budget, and the OFL licence texts
ship beside the built assets because OFL-1.1 requires them to travel with the
font. It has no tabular figures, so hero numbers use it (one number at a time)
and any table of numbers stays in `--font-ui` with tabular figures.

**The floor is 11px, and body or control text never goes below 13px.** Those
numbers are enforced by `npm run check:design`, which walks every visible text
node. There is no exception except a micro label, and a micro label holding a
sentence is a copy bug.

Three sizes the update asked for have been moved to satisfy its own floor, and
the reasons are recorded rather than quietly changed: the status bar's 12px
became 13px, the sidebar's 12px branch line became 13px, and `.file-status`
became 13px. In each case the same document specified a size and a floor, and
the floor won.

## Shapes and spacing

One shape language: **pills** for anything you press or that reports state, 12
for inputs, 20 for cards. One surface level — a card never sits inside a card —
and depth comes from tone rather than from a border. Shadows are for menus,
drawers, and dialogs only.

- 4px grid: 4, 8, 12, 16, 24, 32.
- Row height 36 (Cozy) or 28 (Compact). Minimum hit target 32px.
- Corner registration marks are **gone**, along with whatever drew them. Update 2
  added them as a technical-drawing detail; Update 4 removes them.

## Accent tokens

| Token | Use |
| --- | --- |
| `--accent` | Graphics, focus ring, selection bar, and the button fill in a dark mode |
| `--accent-text` | Text on the panel |
| `--accent-strong` | The fill behind a filled button's label |
| `--accent-label` | The label on that fill: the page's near-black in a dark mode, white in a light one |

This corrects Update 3's two-token scheme, which failed its own numbers: white
on `#D45A00` and white on `#0B8F83` are both about 4.0:1. Both pairs are checked
by `scripts/check-contrast.mjs` for every family and mode, which is what stops a
light-mode primary button from quietly failing button text.

## Surfaces, and why the surface steps are checked

The OKLCH lightness difference between the base and a card must be at least
0.04, and a menu or drawer at least 0.04 lighter again. That is checked in OKLCH
rather than RGB, because the same RGB distance is nowhere near the same distance
to look at.

This check found that **every light mode measured 0.000**: a pure-white base with
white panels on it has nothing above it to step to. Each light base is now a
visible off-white in the family's own hue, which is what makes a white panel and
a lighter row both work. It also found the dark modes' third level was too close
to their second. Both are now real ladders, verified per family and mode.

The check measures the **size** of each step, not its direction, and it says
`above` because a word has to cover both. In a light theme the third level is the
row hover, which is darker than the card, and that is the correct direction there
— a light theme has nowhere to go past white.

The update's own light bases are the reason this section exists at all. It
specifies `#F6F8FA` for Paper and `#EAF4F6` for Lagoon Light with white panels,
and a white card over either is 0.032 in OKLCH lightness while the same document
requires 0.04. Nothing a white paint can do closes that gap, because white is the
ceiling. Each light base is therefore darkened by about two percent of lightness
and nothing else — the hue is kept, and `#F6F8FA` becomes `#ECEEF0`. A white card
then steps 0.05, above the floor rather than just under it. Panels stay white at
alpha 0.97, so Glass still reads as glass.

## Families and modes

Two separate controls. The **family** is the palette and style; the **mode**
is Dark, Light, or Auto. A family that does not ship a mode disables it in the
control and says why, rather than offering a broken one.

| Family | Modes | Notes |
| --- | --- | --- |
| Lagoon | Dark, Light | The default. Teal and cyan, glass panels, ambient gradient. |
| Cathode | Dark, Light | Amber CRT warmth: warm black, orange phosphor, orange-to-red-brown ambient. |
| Paper | Dark, Light | Neutral, GitHub-like, quiet blue accent. |
| Mono | Dark, Light | Black and white, hairlines only. |
| Dracula | Dark | |
| Nord | Dark | |
| Phosphor | Dark | Hidden. Not listed in the picker. |

Phosphor is not listed in the picker. It is reachable only if you know its
name, which is the point of a hidden theme.

Every family defines eight **lane** colours for the commit graph. They must be
distinguishable from their neighbours — the script checks adjacent pairs, plus
the wrap-around from the last lane back to the first, which is the mistake that
is easy to make and hard to see.

## Surface levels: glass and solid

| Level | Behaviour |
| --- | --- |
| Glass | Translucent panels, backdrop blur, ambient gradient behind them |
| Solid | Panels composite over the base colour and are genuinely opaque, flat, no blur |

Effects Off forces Solid. Contrast is measured against the **worst case**
behind a panel: the lightest and darkest points of the ambient gradient it sits
over, plus the opaque panel Solid uses. A translucent panel that passes over a
dark corner but fails over a light one fails the build.

## Components

Every component is defined in `tokens.css` and used by the shell.

| Component | Notes |
| --- | --- |
| `.button` | Standard control, a pill, at least 32px tall. `.primary` glows only while enabled — never when disabled. A disabled button is an outlined ghost with a reason beside it, not a dimmed active one, because a dim active button reads as broken |
| `.keycap` | Keyboard hints, everywhere |
| `.panel` | Borderless surface at the one card radius, 20px. One surface level — a card never sits inside a card |
| `.row` | List row, 36px Cozy / 28px Compact, and never under the 32px hit target. Selected rows get a 2px accent inset |
| `.readout` | Large numerals for headline values |
| `.hero` | The display-face hero numbers from real data (Update 4, rule 4) |
| `.lamp` | Status: a dot, an icon, and a word. Never colour alone |
| `.toast` | Transient messages |
| `.dialog` | Modal surface |
| `.palette` | Command palette, Ctrl or Cmd + K |
| `.heatbar` | 2px bar driven by the heat ramp |
| `.watcher-dot` | Live status. Pulses slowly, and only while watching |

The Workbench shell is the CSS grid on `.shell`: sidebar, toolbar, work, status
bar. From 960 to 1279px the sidebar collapses to icons; below 960px it becomes a
single column with tabs. Nothing may cover the status bar, which is why its
height is a token (`--statusbar-h`) that overlays read rather than a number
written twice.

Buttons are pills, at least 32px tall. A disabled control is an outlined ghost
with a clear reason beside it — never a dim active button.

## Effects levels

The **Effects** control has three levels. It defaults from the system
reduced-motion setting.

| Level | Behaviour |
| --- | --- |
| **Full** | Motion, glow, blur, grain, and the ambient gradient are all on |
| **Reduced** | Motion collapses to ~1ms. Structure stays: glow, blur, grain remain |
| **Off** | All motion, glow, blur, and grain removed. Solid surface forced. Every screen is still complete and legible |

An effect that does nothing is deleted. The test for every effect: does it
encode information or help orientation?

**Signature material, one per family, and no more.** Each family gets exactly one
material touch, within the performance budgets:

| Family | Signature |
| --- | --- |
| Lagoon | Frosted panels with a faint top-edge highlight |
| Cathode | Warm grain at 3% opacity, and one soft ember glow on the active row |
| Mono | Hairline grid on empty states |
| Nord | A subtle frost gradient on the header |
| Paper | Fibre texture at 2% in light mode only |

**Motion with a reason.** Selecting a file slides its accent bar in over 160 ms.
The commit button warms up when the summary becomes valid. Panels fade in over
120 ms on first load. Effects Off removes all of it and keeps the layout
identical — not merely similar, identical.

## Motion

Purposeful, short, never blocking. Only `transform`, `opacity`, and `color` are
animated, for 120–320ms, on an ease-out curve. Heat changes animate `color`
over ~400ms. The live watcher dot may pulse slowly, and only while watching.
Nothing bounces, nothing scrolls, nothing enters on scroll.

## Accessibility

- WCAG AA contrast for every text pair, every graphic, and every lane — enforced by `npm run check:contrast`, which gates `verify`.
- A visible 2px focus ring in the accent colour, offset from the element.
- Full keyboard operation. The palette is reachable on Ctrl/Cmd + K.
- Labels for screen readers; the counters carry their meaning in text, not only in a colour.
- `prefers-reduced-motion` is respected without the user having to ask.

## Performance budgets

- Interactions respond in under 100ms; animations hold 60fps.
- No more than four backdrop-blurred layers on screen at once.
- Initial JavaScript under 300KB gzipped, with heavy views split into their own chunks.
- The ambient gradient is static and never animated.
- Lists and the graph virtualize beyond 500 items.
- **The display face stays under 40 KB per weight as woff2, Latin subset only, and
  no font is ever fetched at runtime.** Barlow Condensed Latin 600 measures
  22,308 bytes on this build, which is why it was the face chosen from the three
  candidates. The OFL-1.1 licence texts ship beside the built assets, because
  OFL requires them to travel with the font: `dist/web/font-licences/`, four
  files, verified to be present in the build.

## The gate: `npm run verify:design`

Two commands, both required before a slice merges:

```
npm run verify          # contrast, typecheck, lint, lint:copy, unit, e2e
npm run verify:design   # the six Update 4 section-6 checks
```

`check:contrast` runs the colour engine directly; `check:design` runs the same
engine and then the five browser checks against a real server and a real
repository, so a failure is a screenshot away rather than a claim.

| # | Check | What fails it |
| --- | --- | --- |
| 1 | Type floor | Any computed font-size under 11px, or under 13px for body and control text. A micro label holding a sentence also fails |
| 2 | Contrast | Any token pair under 4.5:1 text or 3:1 graphic against the worst case of the ambient layer, a filled button's label against its fill, or an OKLCH surface step under 0.04 |
| 3 | Overflow and clipping | Horizontal page scroll at 1440, 1024, or 800px, or any element wider than its own box unless it ellipsizes or scrolls on purpose |
| 4 | Overlap | The undo drawer or any menu intersecting the status bar |
| 5 | Hit targets | Any control under 32px tall or 24px wide |
| 6 | Keyboard access | Anything revealed on hover that is not revealed on keyboard focus |

## Design review checklist

For the screenshot pass. Every item has to hold in every theme. This is Update 4
section 8, and the capture list is section 7.

1. Squint test: the hierarchy reads, and each screen has one clear focal point.
2. Density: no wasted blank blocks, nothing cramped, everything on the 4px grid.
3. Every glow, gradient, and texture encodes information or orientation. If not, delete it.
4. Set Effects to Off. The screen must still be complete and legible.
5. Run `npm run check:contrast` on every text pair.
6. Compare families on the same screen. The layout must be identical, and only tokens may differ.
7. If the screen could be mistaken for a generic dashboard kit, rework its signature element.

Do not copy the layout or branding of any existing product.
