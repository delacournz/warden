---
name: warden
description: The familiar agent dev-tool landing in one wide heavy display voice; flat paper, one ink, one orange accent.
colors:
  ground: "#f5f4ef"
  surface: "#fdfcf9"
  fill: "#e9e7df"
  ink: "#0d0d0c"
  ink-2: "#64625b"
  hairline: "#d8d5cb"
  accent: "#ff4f1a"
  accent-text: "#b8360a"
  lease: "#1f7a40"
  lease-ink: "#ffffff"
  ground-dark: "#0f0f0e"
  surface-dark: "#171715"
  fill-dark: "#25241f"
  ink-dark: "#f3f1ea"
  ink-2-dark: "#9c998f"
  hairline-dark: "#302f2a"
  accent-dark: "#ff6a3d"
  accent-text-dark: "#ff8a63"
  lease-dark: "#30d158"
typography:
  display:
    fontFamily: "Mona Sans Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "hero clamp(2.6rem, 6.4vw, 5.4rem); section clamp(2.2rem, 4.6vw, 3.6rem); feature 1.9rem / 2.3rem at sm"
    fontWeight: 800
    lineHeight: "0.95 to 1.02"
    letterSpacing: "-0.035em"
    fontVariation: "'wdth' 125, 'wght' 800"
  card-title:
    fontFamily: "Mona Sans Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 720
    lineHeight: 1.25
    letterSpacing: "-0.02em"
    fontVariation: "'wdth' 120, 'wght' 720"
  tagline:
    fontFamily: "Mona Sans Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.7rem / 2.1rem at sm"
    fontWeight: 560
    lineHeight: 1.15
    letterSpacing: "-0.02em"
    fontVariation: "'wdth' 110, 'wght' 560"
  body:
    fontFamily: "Mona Sans Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 400
    lineHeight: 1.625
  readout:
    fontFamily: "Martian Mono Variable, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "11px"
    fontWeight: 400
    letterSpacing: "normal"
    fontFeature: "tabular-nums"
  command:
    fontFamily: "Martian Mono Variable, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.625
    fontFeature: "tabular-nums"
rounded:
  group: "6px"
  chip: "4px"
  pill: "9999px"
spacing:
  page-gutter: "16px"
  page-gutter-sm: "24px"
  section-gap: "112px"
  section-gap-sm: "144px"
  block-gap: "40px"
  row-y: "24px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ground}"
    typography: "{typography.tagline}"
    rounded: "{rounded.pill}"
    padding: "10px 20px"
  button-primary-hover:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.ink}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "10px 20px"
  sheet:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.group}"
  command-bar:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.command}"
    rounded: "{rounded.group}"
    padding: "6px 6px 6px 16px"
  manager-tab:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.pill}"
    padding: "4px 12px"
  manager-tab-selected:
    backgroundColor: "{colors.fill}"
    textColor: "{colors.ink}"
  inline-code:
    backgroundColor: "{colors.fill}"
    textColor: "{colors.ink}"
    rounded: "{rounded.chip}"
    padding: "2px 4px"
---

# Design System: warden

## Overview

**Creative North Star: "One Voice, Familiar Frame"**

The landing follows the familiar agent dev-tool frame: a centered hero with a pill, headline, one-sentence lede, install command and two buttons; the recorded run; a centered "Works with" row of agent marks; the loop as three alternating feature blocks (copy beside a working sample); the lease rules as cards; the first prompt; use-case cards; FAQ; a closing install sheet. What makes it warden's is one display voice: Mona Sans at wdth 125 / wght 800 with tight tracking on every heading, on flat paper with one ink and one orange. Martian Mono at 11-12.5px carries whatever a machine prints.

The docs (Fumadocs) wear the same tokens so the chrome is one world. Docs pages are quiet prose on the same paper.

**Key Characteristics:**
- One display voice (wide, heavy) for every heading; no condensed or light display cuts.
- Familiar, centered section rhythm: heading + one plain sentence, then content.
- Flat everywhere: hairlines and tonal sheets, no shadows.
- One accent, used large (the headline's last words, the parallel bar, the lamp) and nowhere small.
- Mono is for commands, ids and readouts only, never for sentences.
- Light and dark are the same system on warm paper / warm ink.

## Colors

Warm paper and warm ink with a single saturated foundry orange. Dark mode keeps the same roles on near-black with a lifted accent. Values are the Tailwind `@theme` tokens in `src/styles/app.css`; dark values override under `.dark` (class toggle, not OS).

### Primary
- **Foundry Orange** (accent `#ff4f1a`, dark `#ff6a3d`): the hero's "coding agents.", the accelerated-run bar and time, the caret, text selection tint, the lamp in the warden mark, the closing period of the wordmark, and the primary button hover. About 3.2:1 on paper, so it is for large marks only.
- **Orange Text** (accent-text `#b8360a`, dark `#ff8a63`): the only orange allowed at small sizes (+hook tags, FAQ hover). Passes body contrast.

### Neutral
- **Paper** (ground `#f5f4ef`, dark `#0f0f0e`): page and docs background.
- **Sheet** (surface `#fdfcf9`, dark `#171715`): code plates, command bars, run chart, popovers, docs cards; one step off the ground.
- **Fill** (`#e9e7df`, dark `#25241f`): inline-code chips, selected tab, active sidebar row, bar tracks, hover.
- **Ink** (`#0d0d0c`, dark `#f3f1ea`): all primary text, primary button, focus ring.
- **Ink 2** (`#64625b`, dark `#9c998f`): ledes, captions, readouts, placeholder-weight text.
- **Hairline** (`#d8d5cb`, dark `#302f2a`): every rule, sheet border and table row divider.
- **Lease Green** (`#1f7a40`, dark `#30d158`): docs success state only (Fumadocs `--color-fd-success`); absent from the landing.

### Named Rules
**The One Orange Rule.** Orange appears on large marks or not at all; small text that needs orange uses accent-text. Per screen it is one display word plus its echoes, never a second hue.
**The Paper Rule.** Surfaces differ by one tonal step (ground, surface, fill) separated by hairlines. No gradients, no tinted backdrops.

## Typography

**Display / Body Font:** Mona Sans Variable (`@fontsource-variable/mona-sans/wdth.css`, wdth + wght axes) with ui-sans-serif, system-ui.
**Label / Mono Font:** Martian Mono Variable with ui-monospace, SF Mono, Menlo.

**Character:** One sans face pushed through its whole width and weight range, so contrast is carried by axis settings rather than by a second family. Mono is the machine's voice: it prints what the terminal prints.

### Hierarchy
- **Display** (wdth 125, wght 800, -0.035em): hero H1 `clamp(2.6rem,6.4vw,5.4rem)` at 0.95; section H2 `clamp(2.2rem,4.6vw,3.6rem)` at 0.98; feature H3 1.9rem / 2.3rem; closing H2 `clamp(2.2rem,5vw,4rem)`; run-chart times 2.1rem; the 404. Every heading on the landing uses it.
- **Card title** (wdth 120, wght 720, 1.25rem, -0.02em): lease and use-case card headings.
- **Buttons / FAQ** (wdth 110-112, wght 520-600): CTA labels and FAQ questions (1.125rem).
- **Body** (400, 1rem-1.25rem, 1.625, capped 42-68ch): ledes and feature points in Ink 2.
- **Readout** (Martian Mono, 11px, tabular-nums): feature labels, command chips, captions, figcaption tabs, footer, "+hook" tags.
- **Command** (Martian Mono, 12.5px, 1.625): command bars, terminal and code samples.

Headings in docs prose use wdth 112, -0.025em, balanced wrapping.

### Named Rules
**The One Voice Rule.** Headings are wide and heavy, always. Emphasis inside a heading is the accent on its last words, never a lighter or narrower cut, italic or a new family.
**The Machine Voice Rule.** Mono only for things a machine prints or a human types: commands, ids, readouts, file names. Sentences stay sans.
**The Tabular Rule.** Numbers in readouts and results are tabular-nums.

## Layout

One container: `max-w-6xl`, 16px gutter (24px from `sm`), centered. Sections stack with 112px (144px from `sm`) above each and 48px between a centered heading block (max-w-3xl) and its content. The hero is centered (pill, H1 max-w-5xl, lede max-w-2xl, install max-w-xl, buttons). "Works with" is a 4-column grid on mobile, 8 in one row from `sm`. Feature blocks are two columns from `lg` (64px gap), copy and sample swapping sides on the middle block, stacked below. Card grids are 1 / 3 columns (lease) and 1 / 2 (use cases). The page closes on a Sheet with the closing H2, install and two buttons. Responsive behaviour is reflow, not reduction: every section keeps all content on mobile, with no horizontal page scroll (code samples scroll inside their sheet).

## Elevation & Depth

Flat, with no shadows anywhere (code blocks set `box-shadow: none`). Depth is one tonal step: Sheet on Paper, Fill for state, each outlined by a 1px hairline. Focus is a 2px Ink outline with 2px offset, not a glow.

### Named Rules
**The No-Shadow Rule.** Separation is hairline plus one tonal step. A new surface that wants a shadow wants a rule instead.

## Shapes

Quiet geometry: a 6px "group" radius for every sheet (code plates, command bars, run chart, video frame, docs tables and code blocks), 4px for inline code chips and the focus ring, full pill for buttons, tabs and the copy control. Bars in the run chart are square. The warden mark is a 13x20 outlined device (4.5 radius, 2px stroke in currentColor) with a filled lamp circle at its top right corner; it is the only illustration and reads at favicon size.

## Components

### Buttons
- **Primary:** Ink pill, Paper text, 20px x 10px, wdth 110 wght 600. Hover swaps to Foundry Orange with Ink text.
- **Secondary:** transparent pill with a hairline border, Ink text, wght 520; hover darkens the border to Ink.
- **Copy control:** circular 32px (or a 28px pill with "copy" in a block tab), Ink 2 to Ink, Fill on hover; swaps to a check for 1.6s.

### Command bar and install tabs
A Sheet with hairline border and 6px radius holds `$ command` in 12.5px mono (the `$` is unselectable Ink 2) and a copy control. Above it, one tab per package manager (npm, bun, pnpm, yarn) as pills: selected is Fill + Ink, others Ink 2. Follows the ARIA tabs pattern with arrow keys; the choice is remembered per browser. The landing install line chains `&& warden install`.

### Code plate and copy block
A Sheet figure with a mono 11px tab (file or tool name) divided by a hairline, then 12.5px mono code. The agent prompt uses the same figure with sans text and a copy button in the tab.

### Feature block
Mono orange-text label, Display H3, verb-first points as hairline rows, a mono underlined docs link; beside it a terminal or code sheet (three Fill dots, mono tab) or the run chart.

### Card
A Sheet with hairline border: a mono command chip on Fill, a card-title heading, one Ink 2 sentence.

### Run chart
Two flat bars on one time axis, width proportional to seconds: serial in Ink, parallel in Orange, each labelled in a Display number with a mono caption naming the measurement and date.

### Demo video
A recorded `warden batch` run in a 6px-rounded Sheet frame: muted loop autoplay, poster and controls under reduced motion, a mono caption carrying the exact figures.

### Lists
Agents are a centered row of 36px marks over mono names, +hook in accent-text under the two hooked agents (marks invert in dark); the FAQ is hairline `details` rows with a drawn plus that scales to a minus (200ms).

### Docs chrome
Fumadocs tokens are re-pointed at these colors. Sidebar active row is Fill with wght 550; prose links are Ink with an Ink 2 underline (3px offset); tables are one 6px Sheet group with hairline rows; the toggle is `.dark` on `<html>`.

### Social cards
1200x630, dark tokens only: one 12px-radius Sheet on Paper, the warden mark and name top-left, the landing card sets "Mobile testing for / coding agents." at 800 weight, 96px, the second line in the accent, URL in mono under a hairline. Docs cards set the page title at 600 weight.

## Do's and Don'ts

### Do:
- **Do** set every heading in the one display voice (wdth 125, wght 800) and build hierarchy by size.
- **Do** keep orange to large marks; use accent-text `#b8360a` for any small orange.
- **Do** separate with 1px hairlines and one tonal step; keep every sheet at 6px radius.
- **Do** set commands, ids and readouts in mono at 11px / 12.5px with tabular-nums.
- **Do** give every motion a reduced-motion state; the page has no authored entrance motion.
- **Do** keep claims in captions exact and dated (37 specs, 5 simulators, 3m25s vs 13m55s, Oct 2026).

### Don't:
- **Don't** add shadows, gradients, glow or backdrop blur.
- **Don't** add a dark terminal hero, condensed or light display cuts, giant-word beat sections, type-specimen sliders, or a second accent hue.
- **Don't** set sentences in mono or emphasize with italics or color.
- **Don't** use Lease Green outside docs success states.
- **Don't** let orange carry small text or meaning on its own.
