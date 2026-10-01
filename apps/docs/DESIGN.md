---
name: warden
description: Parallel e2e and agent work on one Mac, drawn in warden's own device-hub grammar and proved by a recorded batch run.
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
    fontWeight: 400
    lineHeight: 1.625
    fontFeature: "'tnum'"
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
  hero-top: "40px"
  hero-top-sm: "48px"
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
  button-icon:
    textColor: "{colors.ink-2}"
    rounded: "{rounded.control}"
    size: "32px"
  button-icon-hover:
    backgroundColor: "{colors.fill}"
    textColor: "{colors.ink}"
  tab:
    textColor: "{colors.ink-2}"
    rounded: "{rounded.pill}"
    padding: "4px 12px"
    typography: "{typography.id}"
  tab-selected:
    backgroundColor: "{colors.fill}"
    textColor: "{colors.ink}"
  grouped-list:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.group}"
  grouped-row:
    textColor: "{colors.ink}"
    padding: "12px 16px"
  code-group:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.group}"
    padding: "20px"
    typography: "{typography.command}"
  install-step:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.group}"
    padding: "16px"
  video-frame:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.group}"
  stage:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.stage}"
    padding: "32px"
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

**Creative North Star: "The Parallel Device Hub"**

warden's site is drawn in the system-UI grammar its readers stare at all day in Xcode and Settings: a grouped gray ground, white (or near-black) inset groups, hairline separators that start after the leading glyph, and anything a machine prints set in mono. The hub's argument is now parallelism. The first thing on the page is not a drawing of a device but a real recording: one `warden batch` run fanning 37 Salient e2e flows across five leased iPhone 17 simulators in 3m25s, with the live grid underneath. The page shows the suite being split, then explains the mechanism in the same grouped rows and mono ids the CLI uses.

The world is ink and system gray. One saturated colour exists, green, and it means a lease or a pass. On the page chrome it is spent almost nowhere: the lamp in the warden mark, the selection tint, and the docs' mapped success state. Inside the hero recording it marks leased simulators' finished flows and the pass counter. Density is calm: generous space above every section, content in rounded groups, nothing decorative between them. Depth is tonal, never shadowed. The docs chrome (Fumadocs) is re-pointed at the same tokens, so reference pages sit in the same world.

The build refuses the dark terminal hero over a feature-card grid, and it refuses adjective copy: every claim on the page is a mechanism or a measurement.

**Key Characteristics:**
- Grouped gray ground with inset surface groups, light and dark.
- Hairline separators, never borders around groups.
- A real recorded batch run is the hero image; drawn geometry covers the rest (the warden mark, the 404 slot). No stock photography, no marketing screenshots.
- Onest for voice, Red Hat Mono for everything a machine prints (commands, ids, flags, durations, counts).
- One colour, green, for leased or passed. Shape and text carry state; colour only confirms it.
- Tonal layering instead of shadows.
- One authored motion moment: the hero recording.

## Colors

A system-gray neutral ladder with one green that means "leased" or "passed".

### Primary
- **Lease Green** (`lease`): the deep, text-safe green. Fumadocs' `success` colour. In dark mode it becomes system green (#30d158) with black text (`lease-ink` #000000). The hero recording uses the dark value for its pass labels and counter.
- **Lamp Green** (`lamp`): the bright status-lamp green. Lights the dot in the warden mark and favicon, and tints text selection (32% mix). In dark mode it matches Lease Green (#30d158).

### Neutral
- **Grouped Gray** (`ground`): the page ground, and the inner fill of wells inside a group (copy command, tag, chart track). Dark: #000000.
- **Group White** (`surface`): every inset group, code group, install step, video frame, stage and table. Dark: #1c1c1e.
- **System Fill** (`fill`): the selected package-manager tab, hover fill for secondary and icon controls, the active sidebar row, the inline code chip. Dark: #2c2c2e.
- **Ink** (`ink`): primary text, the hero lede, the second line of the hero headline, primary button fill, solid bars in the boot chart, the focus ring. Dark: #f5f5f7.
- **Secondary Ink** (`ink-2`): the first line of the hero headline, section ledes, row details, captions, tags, unselected tabs, the `$ ` prompt, code comments. Dark: #98989f.
- **Hairline** (`hairline`): row separators, section and footer rules, link underlines at rest, the scrollbar thumb. Dark: #38383a.

### Device Material
- **Device Body / Bezel / Screen Off** (`device-body`, `device-bezel`, `device-screen-off`): fixed dark hardware values inside the drawn `DeviceFrame` only, now used by the 404 slot. Never page colours.

### Recorded Material
The hero recording is composed from the dark tokens in both themes: Ground (#000000) behind the phones, Surface (#1c1c1e) for the rounded TUI panel, Ink and Secondary Ink for labels, green for passes and a red (#ff453a) reserved for failures. Two hues on screen are not page colours: the TUI's cyan progress bars (the CLI's own ANSI cyan, #64d2ff) and the Salient app's own interface (navy and yellow) inside each phone.

### Named Rules
**The One Lamp Rule.** Green appears only where something is leased or has passed. No links, headings, charts or decoration are green. If a new page element wants colour and it is not a lease or a pass, it is ink.

**The Recorded Material Exception.** Colour inside a recording belongs to what was recorded: the app under test and the CLI's terminal output. The video's own overlay keeps the One Lamp Rule (green only on ✓ flow labels, ✓ counts and "37/37 passed"; everything else ink or gray). The cyan TUI bars and the app's yellow are recorded material, not page colour, and the page never lifts them into its own chrome.

**The Re-pointed Chrome Rule.** Fumadocs' `--color-fd-*` tokens are mapped onto the hub palette. Docs pages never introduce their own neutrals.

## Typography

**Display Font:** Onest Variable (with ui-sans-serif, system-ui)
**Mono Font:** Red Hat Mono Variable (with ui-monospace, SF Mono, Menlo)

**Character:** Onest is a warm, slightly geometric system-UI sans that reads like a native settings screen; Red Hat Mono is the machine's voice. The split is strict: people's sentences are Onest, anything the CLI would print is mono. Stylistic sets `ss01` and `cv11` are on globally; code, kbd, samp and pre are tabular.

### Hierarchy
- **Display** (600, 2.6rem → 3.75rem → 4rem, line-height 1.02, -0.035em, balanced): the landing headline only, one sentence in two tones: "Parallelise your agent workflows" in Secondary Ink, "and e2e tests." in Ink.
- **Headline** (600, 1.875rem → 2.25rem, -0.025em, balanced): section titles, stated as a claim ("Your whole suite, split across every simulator.").
- **Lede** (400, 1.125rem, relaxed): the hero lede in Ink; section ledes in Secondary Ink. Capped at max-w-2xl.
- **Title** (500, 1rem): grouped-row titles, chart row names, install step titles, button labels.
- **Body** (400, 0.875rem): row details, notes and captions in Secondary Ink.
- **Numeral** (mono 500, 1.5rem, tabular, tight): measured values in the boot chart and the 404.
- **Command** (mono 400, 0.875rem, relaxed): shell commands, the preset code block, the video caption.
- **Id** (mono 400, 0.75rem, tabular): package-manager tabs, tags, tick labels (11px), the Markdown path in the docs toolbar.

### Named Rules
**The Machine Voice Rule.** If the CLI would print it (a command, a flag, a udid, a duration, a pass count), it is set in Red Hat Mono with tabular figures. Prose never goes mono for style.

**The Measured Number Rule.** Numbers are shown as measured ("3m25s", "37/37 passed", "146–239 s", "15.6 s", "~6.5 s"), with their unit, their source, and any playback speed-up stated ("shown at 5× speed"). Nothing is rounded up and no speedup is claimed without a baseline.

## Layout

A single centred column, max width 1152px, with a 16px side gutter (24px from `sm`). The hero starts close under the nav (40px, 48px from `sm`); every later section has 112px (144px from `sm`) above it. Inside a section the title block (max-w-2xl) and its content are 32px apart. Paired content uses a two-column grid from `lg` with 24px gaps (list left, code right, the right column slightly wider at 1.1fr), and every grid child carries `min-w-0` so mono lines never force overflow.

The first viewport: the two-tone headline (max-w-4xl), then a row that splits the lede (left) and a 26rem install block (right) from `lg`, stacking on phones. The install block is the package-manager tabs over a copy command, with a one-line note that the npm release is pending and a link to build from source. Below, the full-width recorded batch video in a surface group, with a mono caption row: the command on the left, the measured run on the right, wrapping on phones.

The story then runs: what a batch does (grouped list) beside how a repo declares a preset (code group plus the copy command); device speed (boot chart stage); lease rules and refusals (two grouped lists); agent hooks (grouped list beside a `warden run` code group); install (three steps, 1.5fr / 1fr / 1fr from `lg`) and the primary pill. The footer is one hairline-topped row of links with the credit pushed to the end from `sm`.

## Elevation & Depth

Flat. There are no drop shadows anywhere; code blocks explicitly remove Fumadocs' shadow. Depth is tonal: ground → surface group → ground-coloured well inside the group. Separation inside a group is a 1px hairline.

### Named Rules
**The Tonal Nest Rule.** Groups sit on the ground; wells sit in groups and take the ground colour back. Never nest a surface in a surface, never add a shadow to lift something. A ground-coloured well placed directly on the ground (the hero and preset copy commands) reads as a bare command line with a copy button, which is intended.

## Shapes

Continuous, system-like rounding in a small set: 6px for chips (tags, inline code, chart bars and tracks), 8px for icon buttons, 12px for wells (copy command), 14px (`--radius-group`) for every grouped list, code group, install step, table, docs code block and the video frame, 22px for the boot chart stage, and full pills for every text button and tab. Groups clip their contents (`overflow: hidden`) so hairline rows and the video meet the curve cleanly.

The drawn phone (`DeviceFrame`, 120×250, 24px body radius, 17px screen radius, pill island) survives as the 404's dashed uncreated slot. The warden mark reduces it to a rounded device outline plus one lit lamp circle.

## Components

### Buttons
Quiet, rounded, system pills.
- **Shape:** full pill.
- **Primary:** Ink fill, Surface text, 10px 20px, medium 14px ("Read the install guide", "Read the docs"). Hover drops opacity to 0.85.
- **Secondary:** Surface fill, Ink text on the ground (404 only). Hover moves to System Fill.
- **Icon (copy):** 32px square, 8px radius, Secondary Ink; hover System Fill and Ink. Swaps to a check for 1.6s after copying.
- **Focus:** global 2px Ink outline, 2px offset, 4px radius.

### Install Command
The package-manager tabs over a copy command: npm (default), bun, pnpm, yarn installing `@delacour/warden` globally.
- **Tabs:** small mono pills (4px 12px). Selected is Ink on System Fill; the rest are Secondary Ink, turning Ink on hover.
- **Behaviour:** ARIA tabs pattern; left/right arrows move and select; the panel is the copy command for the chosen manager. The choice is remembered per browser and falls back to npm if storage fails.
- **Where:** the hero install block and install step 1. On the hero it always carries the "npm release pending" note until the package is published.

### Copy Command
A Grouped Gray well (12px) holding `$ command` in mono with a non-selectable gray prompt and the copy icon button. Wraps anywhere on phones, scrolls on one line from `sm`. The command is the label, so it is never truncated.

### Grouped List
The hub's one container, used for what a batch does, lease rules, refusals and agent hooks.
- **Corner Style:** 14px, clipped. **Background:** Surface. **Border / Shadow:** none.
- **Row:** 16px start inset, 18px Lucide glyph in Ink, title (medium) over detail (small, Secondary Ink), optional trailing tag, 12px vertical padding.
- **Separator:** a hairline under each row except the last, starting after the leading glyph.
- **Batch list:** five rows in the batch's own order (Lease → Serve → Queue → Retry → Record), each trailing the flag or placeholder that drives it (`--count`, `--serve`, `{job}`, `--retry`, `--record`).

### Tag
Mono id in Secondary Ink on a Grouped Gray chip (6px, 2px 8px). A row's trailing command, flag or placeholder.

### Code Group
A 14px Surface group, 20px padding, mono 0.875rem relaxed in Ink, scrolling horizontally. Comments and the `$ ` prompt are Secondary Ink. The preset block opens with a `// warden.config.json` comment and shows the real `batches` entry; the `warden run` block wraps on phones and keeps one line from `sm`. Each is paired with a copy command or a small Secondary Ink note beneath.

### Install Step
A 14px Surface group, 16px padding: a mono Secondary Ink step number beside a medium title, then its command.

### Boot Chart
A 22px Surface stage of four measured rows on one 0–240 s axis. Tracks are Grouped Gray, 28px tall, 6px radius; measured time is a solid Ink bar, run-to-run spread is Secondary Ink at 40%. Values are right-aligned mono numerals. A hairline-topped caption carries the legend and the measurement source. No colour.

### Code and Tables (docs)
Code blocks are Surface groups with a 1px hairline and no shadow. Tables become grouped lists: one 14px Surface group, hairline rows, a small medium Secondary Ink header. Inline code sits in a System Fill chip (6px, 0.88em). Prose links are Ink with a 1px Secondary Ink underline offset 3px, darkening on hover.

### Navigation
Fumadocs' home and docs layouts, re-tokened. The nav title is the warden mark plus lowercase `warden` in semibold. The active sidebar entry is an Ink label (weight 550) on a System Fill row. The docs toolbar under each description holds copy-as-Markdown, view options, and the page's Markdown path in mono ids at the right, above a hairline.

### Demo Video (signature)
The recorded `warden batch` run, composed outside the site from per-simulator recordings and the terminal cast: five phones tiled across the top with a mono header ("warden batch ios · 5 sims · 37 flows", elapsed time, pass counter), each phone labelled with its simulator name and its current or last flow (✓ in green when passed), and the live TUI grid in a rounded panel underneath. On the page it sits edge to edge in a 14px Surface group (clipped, no padding), followed by a mono caption: `warden batch salient-e2e` in Ink on the left, the measured run in Secondary Ink on the right ("37 Salient e2e flows · 5 iPhone 17 simulators · 3m25s · 37/37 passed · shown at 5× speed"). The poster is the final frame, all flows passed. It has an accessible label describing the run.

### Not Found
The missing page is an uncreated device slot: the dashed empty `DeviceFrame` with `404` and "not created" in mono inside it, a headline, a lede, and the primary/secondary pill pair.

### Device Shelf (retained, unused)
The interactive claim/boot shelf, its green Claim and gray Release pills, and its spec wells remain in the repo but are not on any page. Treat them as unused: don't reintroduce a Claim control or a second hero figure without redesigning the first viewport around it.

### Motion
One authored moment: the hero recording. It autoplays muted, inline and looped, and loads metadata only until it plays. Under `prefers-reduced-motion` (and on the server, before hydration decides) it does not autoplay: it rests on its poster and offers native controls. Everything else is a plain hover transition on opacity or colour, plus the copy button's 1.6s check. Globally, reduced motion collapses animation and transition durations to 0.01ms.

## Do's and Don'ts

### Do:
- **Do** put every new block in a Surface group on the Grouped Gray ground, 14px radius, with hairline rows.
- **Do** set commands, flags, ids, counts and durations in Red Hat Mono with tabular figures.
- **Do** prove a claim with a recording or a measurement, and caption it with the exact command and measured run, including any playback speed-up.
- **Do** state measured numbers exactly as measured, with their unit and source.
- **Do** keep text buttons and tabs as pills: Ink primary, Surface secondary, System Fill for the selected tab.
- **Do** give every autoplaying or animated element a reduced-motion rest state (a poster with controls, or the end state).
- **Do** show install as a copyable command with a package-manager choice, and say plainly when a release is not yet published.

### Don't:
- **Don't** use green on the page for anything that is not a lease or a pass: not links, not headings, not charts, not decoration.
- **Don't** lift colours from recorded material (the TUI's cyan, the app's own palette) into page chrome.
- **Don't** add drop shadows or borders around groups; depth is tonal and separation is a hairline.
- **Don't** introduce a second accent hue or tinted neutrals.
- **Don't** open a page with a dark terminal hero over a grid of feature cards, or with adjective copy.
- **Don't** add a second authored animation competing with the hero recording.
- **Don't** give docs chrome its own palette; map Fumadocs tokens to the hub tokens.
