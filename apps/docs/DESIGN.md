---
name: warden
description: One simulator per agent. The docs site drawn as warden's own device shelf.
colors:
  ground: "#f2f2f7"
  surface: "#ffffff"
  fill: "#e5e5ea"
  ink: "#1c1c1e"
  ink-2: "#6b6b72"
  hairline: "#d8d8de"
  lease: "#1f7a40"
  lease-ink: "#ffffff"
  lamp: "#34c759"
  device-body: "#1c1c1e"
  device-bezel: "#48484a"
  device-screen-off: "#0b0b0c"
typography:
  display:
    fontFamily: "Onest Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(2.6rem, 6vw, 4rem)"
    fontWeight: 600
    lineHeight: 1.02
    letterSpacing: "-0.035em"
    fontFeature: "'ss01', 'cv11'"
  headline:
    fontFamily: "Onest Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "2.25rem"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-0.025em"
  lede:
    fontFamily: "Onest Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 400
    lineHeight: 1.625
  title:
    fontFamily: "Onest Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 500
    lineHeight: 1.5
  body:
    fontFamily: "Onest Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.43
  numeral:
    fontFamily: "Red Hat Mono Variable, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "1.5rem"
    fontWeight: 500
    letterSpacing: "-0.025em"
    fontFeature: "'tnum'"
  command:
    fontFamily: "Red Hat Mono Variable, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "0.875rem"
    fontWeight: 500
  id:
    fontFamily: "Red Hat Mono Variable, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    fontFeature: "'tnum'"
rounded:
  chip: "6px"
  control: "8px"
  well: "12px"
  group: "14px"
  stage: "22px"
  pill: "9999px"
spacing:
  gutter: "16px"
  gutter-sm: "24px"
  row-y: "12px"
  row-x: "16px"
  grid-gap: "24px"
  block-gap: "32px"
  section-top: "112px"
  section-top-sm: "144px"
  page-max: "1152px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.surface}"
    rounded: "{rounded.pill}"
    padding: "10px 20px"
    typography: "{typography.title}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "10px 20px"
  button-secondary-hover:
    backgroundColor: "{colors.fill}"
  button-claim:
    backgroundColor: "{colors.lease}"
    textColor: "{colors.lease-ink}"
    rounded: "{rounded.pill}"
    padding: "8px 16px"
    typography: "{typography.command}"
  button-release:
    backgroundColor: "{colors.fill}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "8px 16px"
    typography: "{typography.command}"
  button-release-hover:
    backgroundColor: "{colors.hairline}"
  grouped-list:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.group}"
  grouped-row:
    textColor: "{colors.ink}"
    padding: "12px 16px"
  stage:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.stage}"
    padding: "20px"
  spec-well:
    backgroundColor: "{colors.ground}"
    rounded: "{rounded.well}"
    padding: "8px 12px"
    typography: "{typography.id}"
  copy-command:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    rounded: "{rounded.well}"
    padding: "6px 6px 6px 16px"
    typography: "{typography.command}"
  tag:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.chip}"
    padding: "2px 8px"
    typography: "{typography.id}"
---

# Design System: warden

## Overview

**Creative North Star: "The Device Hub"**

warden's site is its own device shelf. It is drawn in the system-UI grammar its readers stare at all day in Xcode and Settings: a grouped gray ground, white (or near-black) inset groups, hairline separators that start after the leading glyph, and ids set in mono. Every simulator on the page is a unit with a name, a udid, a phase and an owner, and the page's argument is made by showing those units being claimed, booted and released, not by describing them.

The world is ink and system gray. One saturated colour exists, lease green, and it is spent only on the lease itself: the lamp on a leased device, the leased phase glyph, the `warden claim` control, and the lamp in the warden mark. Density is calm: generous section spacing (112–144px above each section), content in rounded groups, no decoration between groups. Depth is tonal, never shadowed. The docs chrome (Fumadocs) is re-pointed at the same tokens so the reference pages sit in the same world.

The build explicitly refuses the dark terminal hero over a six-card feature grid.

**Key Characteristics:**
- Grouped gray ground with inset surface groups, light and dark.
- Hairline separators, never borders around groups.
- Drawn phone outlines as the product image; no screenshots, no photography.
- Onest for voice, Red Hat Mono for everything a machine prints (ids, commands, timers, owners).
- One colour, lease green. Shape carries state; colour only confirms it.
- Tonal layering instead of shadows.
- One authored motion moment: the shelf's claim and boot.

## Colors

A system-gray neutral ladder with a single green accent that means "leased".

### Primary
- **Lease Green** (`lease`): the fill of the `warden claim ios` control. Deep enough to carry white mono text at AA in light mode; in dark mode it becomes system green (#30d158) with black text (`lease-ink` #000000). Also Fumadocs' `success` colour.
- **Lamp Green** (`lamp`): the bright status-lamp green. Lights the lamp in a leased device's status bar, the leased phase glyph, the dot in the warden mark and favicon, and tints text selection (32% mix). In dark mode it matches Lease Green (#30d158).

### Neutral
- **Grouped Gray** (`ground`): the page ground; also the inner fill of wells inside a group (copy command, tag, device spec list, chart track). Dark: #000000.
- **Group White** (`surface`): every inset group, stage, code block and table. Dark: #1c1c1e.
- **System Fill** (`fill`): hover fill for secondary controls, the active sidebar row, inline code chip, the release control. Dark: #2c2c2e.
- **Ink** (`ink`): primary text, primary button fill, solid bars in the boot chart, focus ring. Dark: #f5f5f7.
- **Secondary Ink** (`ink-2`): ledes, row details, ids, placeholder owners, the first (gray) line of the hero headline, the `$ ` prompt. Dark: #98989f.
- **Hairline** (`hairline`): row separators, section rules, empty-slot dashed outline, scrollbar thumb. Dark: #38383a.

### Device Material
- **Device Body / Bezel / Screen Off** (`device-body`, `device-bezel`, `device-screen-off`): the drawn phone is dark hardware in both themes. A powered screen shows the ground colour (#f2f2f7 light, #2c2c2e dark) with a quiet home grid (#dcdce1 / #3a3a3c). These are fixed material values inside the device drawing only, never page colours.

### Named Rules
**The One Lamp Rule.** Green appears only where something is leased. Nothing decorative, no links, no headings, no charts are green. If a new element wants colour and it is not a lease, it is ink. (The direction contract says green means "held by you". The build lights it for every lease, including other agents' devices on the shelf, so the rule as recorded is "leased". Ownership is shown by the mono owner string, not by colour.)

**The Shape-First Rule.** Every phase has its own glyph shape (dashed ring = not created, hollow ring = shutdown, spinning arc = booting, gray dot = booted and free, lamp = leased). Colour is added only to the leased glyph, so state survives without colour vision.

**The Re-pointed Chrome Rule.** Fumadocs' `--color-fd-*` tokens are mapped onto the hub palette. Docs pages never introduce their own neutrals.

## Typography

**Display Font:** Onest Variable (with ui-sans-serif, system-ui)
**Mono Font:** Red Hat Mono Variable (with ui-monospace, SF Mono, Menlo)

**Character:** Onest is a warm, slightly geometric system-UI sans that reads like a native settings screen; Red Hat Mono is the machine's voice. The split is strict: people's sentences are Onest, anything the CLI would print is mono. Stylistic sets `ss01` and `cv11` are on globally; code, kbd, samp and pre are tabular.

### Hierarchy
- **Display** (600, 2.6rem → 3.75rem → 4rem, line-height 1.02, -0.035em): the landing headline only. Two lines, two tones: the first in Secondary Ink, the second in Ink.
- **Headline** (600, 1.875rem → 2.25rem, -0.025em, balanced wrap): section titles, stated as a claim ("Sixteen seconds, not four minutes.").
- **Lede** (400, 1.125rem, relaxed): section ledes in Secondary Ink, capped at max-w-2xl.
- **Title** (500, 1rem): grouped-row titles, chart row names, install step titles, button labels.
- **Body** (400, 0.875rem): row details and captions in Secondary Ink.
- **Numeral** (mono 500, 1.5rem, tabular, tight): measured values (chart values, the boot timer, the 404).
- **Command** (mono 500, 0.875rem): shell commands and the shelf controls.
- **Id** (mono 400, 0.75rem, tabular): device names, udids, owners, tags, tick labels (11px), the Markdown path in the docs toolbar.

### Named Rules
**The Machine Voice Rule.** If the CLI would print it (a udid, an owner string, a flag, a duration), it is set in Red Hat Mono with tabular figures. Prose never goes mono for style.

**The Measured Number Rule.** Numbers are shown as measured ("146–239 s", "15.6 s", "~6.5 s"), with a thin space before the unit and no rounding up.

## Layout

A single centred column, max width 1152px, with a 16px side gutter (24px from `sm`). Sections stack with 112px (144px from `sm`) above each; inside a section the title block (max-w-2xl) and its content are 32px apart. Paired content uses a two-column grid from `lg` with 24px gaps, and every grid child carries `min-w-0` so mono lines never force overflow.

The hero is a two-tone headline over a row that splits lede (left) and two pill CTAs (right) from `lg`; below it, the full-width device shelf. On phones the shelf becomes a horizontal snap rack (each unit 78% wide, 11% scroll padding) with `contain: paint` so the rack never widens the layout viewport; when a device starts booting the rack scrolls it to centre. From `sm` the shelf is a fixed four-column grid.

The boot chart uses a three-column row (label up to 15rem, bar track, 8.5rem value) from `sm`, stacking on phones, with tick labels hidden below `sm`. The footer is a single hairline-topped row of links with the credit pushed to the end.

## Elevation & Depth

Flat. There are no drop shadows anywhere; code blocks explicitly remove Fumadocs' shadow. Depth is tonal: ground → surface group → ground-coloured well inside the group. A well inside a group is always the ground colour, which gives two levels of nesting without lines or shadow. Separation inside a group is a 1px hairline.

### Named Rules
**The Tonal Nest Rule.** Groups sit on the ground; wells sit in groups and take the ground colour back. Never nest a surface in a surface, never add a shadow to lift something.

## Shapes

Continuous, system-like rounding in a small set: 6px for chips (tags, inline code, chart bars), 8px for icon buttons, 12px for wells (copy command, device spec list), 14px for every grouped list, code block, table and install step (`--radius-group`), 22px for the two stages that hold a live figure (device shelf, boot chart), and full pills for every text button. Groups clip their contents (`overflow: hidden`) so hairline rows meet the curve cleanly.

The drawn phone is 120×250 with a 24px body radius, 17px screen radius and a pill island. An uncreated slot is the same silhouette as a dashed hairline outline. The warden mark reduces this to a rounded device outline plus one lit lamp circle.

## Components

### Buttons
Quiet, rounded, system pills.
- **Shape:** full pill.
- **Primary:** Ink fill, Surface text, 10px 20px, medium 14px. Hover drops opacity to 0.85.
- **Secondary:** Surface fill, Ink text on the ground. Hover moves to System Fill.
- **Claim (shelf only):** Lease Green fill, mono label `warden claim ios`. Hover brightness 1.1, active 0.95. The only green control on the site.
- **Release (shelf only):** System Fill, mono label `release --mine`. Hover to Hairline.
- **Icon (copy):** 32px square, 8px radius, Secondary Ink; hover System Fill and Ink.
- **Focus:** global 2px Ink outline, 2px offset, 4px radius.

### Grouped List
The hub's one container, used for lease rules, refusals and agent hooks.
- **Corner Style:** 14px, clipped.
- **Background:** Surface.
- **Row:** 16px start inset, optional 18px Lucide glyph in Ink, title (medium) over detail (small, Secondary Ink), optional trailing tag. 12px vertical padding.
- **Separator:** a hairline under each row except the last, starting after the leading glyph (inset, like system lists).
- **Border / Shadow:** none.

### Tag
Mono id in Secondary Ink on a Grouped Gray chip (6px radius, 2px 8px). Used as a row's trailing command name.

### Copy Command
A Grouped Gray well (12px radius) holding `$ command` in mono with a non-selectable gray prompt, and a copy icon button that swaps to a check for 1.6s. Wraps anywhere on phones, scrolls on one line from `sm`. The command is the label, so it is never truncated.

### Code and Tables (docs)
Code blocks are Surface groups with a 1px hairline and no shadow. Tables become grouped lists: one 14px Surface group, hairline rows, a small medium Secondary Ink header. Inline code sits in a System Fill chip (6px, 0.88em). Prose links are Ink with a 1px Secondary Ink underline offset 3px, darkening on hover.

### Navigation
Fumadocs' home and docs layouts, re-tokened. The nav title is the warden mark plus lowercase `warden` in semibold. The active sidebar entry is an Ink label (weight 550) on a System Fill row. The docs toolbar under each description holds copy-as-Markdown, view options, and the page's Markdown path in mono ids at the right, above a hairline.

### Device Shelf (signature)
A 22px Surface stage holding four units and a control bar. Each unit is a drawn `DeviceFrame` over a Grouped Gray spec well of three hairline-divided rows: name and udid (mono), phase glyph and label, owner (mono; "no lease" in Secondary Ink when free). A leased device lights its status-bar lamp. The booting device shows a white boot bar filling across its dark screen and a live mono timer over the screen; mine keep the final time after boot. The control bar (hairline-topped) holds Claim and Release and a polite live-region notice in mono ids that narrates what warden did ("reused … already booted", "cloning … from the golden image", "--max 4"). A small caption states that the session is illustrative and boots replay at 4×.

Behaviour: on load, a claim at 900ms reuses the free booted device and a second at 2100ms clones the empty slot. Claim reuses first, then clones, then waits at `--max`; Release only releases this page's leases and leaves devices booted. Other owners' devices are never changed.

### Boot Chart
A 22px Surface stage of four measured rows on one 0–240 s axis. Tracks are Grouped Gray, 28px tall, 6px radius; measured time is a solid Ink bar, run-to-run spread is Secondary Ink at 40%. Values are right-aligned mono numerals. A hairline-topped caption carries the legend and the measurement source. No colour.

### Not Found
The missing page is an uncreated device slot: the dashed empty `DeviceFrame` with `404` and "not created" in mono inside it, a headline, a lede, and the primary/secondary pill pair.

### Motion
One authored moment: the shelf's claim and boot. The booting glyph spins, the boot bar and timer advance on `requestAnimationFrame` at 4× real time until 15.6 measured seconds, the screen fill fades on (700ms) when a device powers up, and on phones the rack smooth-scrolls to the booting device. Everything else is a plain hover transition on opacity, colour or brightness. Under `prefers-reduced-motion` the boot completes instantly, scrolling is not smoothed, and global animation and transition durations collapse to 0.01ms.

## Do's and Don'ts

### Do:
- **Do** put every new block in a Surface group on the Grouped Gray ground, 14px radius, with hairline rows.
- **Do** set ids, udids, owners, flags, commands and durations in Red Hat Mono with tabular figures.
- **Do** give every device phase a distinct glyph shape and a text label; colour is the last signal, not the first.
- **Do** state measured numbers exactly as measured, with their unit and source.
- **Do** draw devices as geometry with `DeviceFrame`; show an uncreated slot as the dashed outline.
- **Do** keep text buttons as pills: Ink primary, Surface secondary.
- **Do** keep a reduced-motion path for any animated state that jumps straight to the end state.

### Don't:
- **Don't** use green for anything that is not a lease: not links, not headings, not charts, not success toasts beyond Fumadocs' mapped `success`.
- **Don't** add drop shadows or borders around groups; depth is tonal and separation is a hairline.
- **Don't** introduce a second accent hue or tinted neutrals.
- **Don't** open a page with a dark terminal hero over a grid of feature cards.
- **Don't** use screenshots or photography of devices in place of the drawn frame.
- **Don't** add a second authored animation competing with the shelf.
- **Don't** give docs chrome its own palette; map Fumadocs tokens to the hub tokens.
