# Design

> Last updated: 2026-10-15

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

## The organising idea: heat

Recent or active runs hot. Old or idle runs cold. The commit graph is the
Forgeline itself: a line of metal white-hot at HEAD and cooling along the
history behind it.

The heat ramp is five steps interpolated between three tokens per theme:

| Token | Meaning |
| --- | --- |
| `--cold` | idle, old, quiet |
| `--heat-1` … `--heat-5` | the ramp, `--heat-5` is HEAD |
| `--hot` | recent, active |
| `--white-hot` | the very tip, used only for HEAD |

`--cold` is the theme's muted tone and `--hot` its accent, so the ramp is
relative to the theme rather than fixed orange-and-blue. The script fails a
build whose ramp spans less than 0.2 perceptual distance — a ramp that barely
spans anything encodes nothing.

**Colour never carries meaning alone.** Heat always sits beside a number, an
icon, or a word. A status lamp is a dot *and* an icon *and* a word.

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

## Surfaces

| Surface | Behaviour |
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
| `.button` | Standard control. `.primary` glows only while enabled — never when disabled |
| `.keycap` | Keyboard hints, everywhere |
| `.panel` | Surface with hairline, radius, and optional `[data-ticks]` corner registration marks |
| `.row` | List row, `--row-h` tall. Selected rows get a 2px accent inset |
| `.readout` | Large tabular monospace numerals for headline values |
| `.lamp` | Status: a dot, an icon, and a word. Never colour alone |
| `.toast` | Transient messages |
| `.dialog` | Modal surface |
| `.palette` | Command palette, Ctrl or Cmd + K |
| `.heatbar` | 2px bar driven by the heat ramp |
| `.watcher-dot` | Live status. Pulses slowly, and only while watching |

The Workbench shell is the CSS grid on `.shell`: sidebar, toolbar, work, status
bar. Below 960px it collapses to a single column.

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

## Design review checklist

For the screenshot pass. Every item has to hold in every theme.

1. Squint test: the hierarchy reads, and each screen has one clear focal point.
2. Density: no wasted blank blocks, nothing cramped, everything on the 4px grid.
3. Every glow, gradient, and texture encodes information or orientation. If not, delete it.
4. Set Effects to Off. The screen must still be complete and legible.
5. Run `npm run check:contrast` on every text pair.
6. Compare families on the same screen. The layout must be identical, and only tokens may differ.
7. If the screen could be mistaken for a generic dashboard kit, rework its signature element.

Do not copy the layout or branding of any existing product.
