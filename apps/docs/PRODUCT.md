# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: developers who run several coding agents (Claude Code, Codex, others) and worktrees in parallel on one Mac, building iOS / Android / React Native apps. Their pain is collisions: two worktrees' e2e runs grabbing the same simulators, an agent tapping on the human's own Simulator.app, dev servers landing on a port someone else holds, and cold simulator boots eating minutes.

Secondary: the agents themselves, which read the docs as Markdown (`.md` twins, `/llms.txt`, `/llms-full.txt`) and follow the embedded warden skill.

The site targets a public open-source audience discovering warden, while also serving as the working reference for existing users.

## Product Purpose

`warden` is a CLI that hands out exclusive, machine-wide leases on iOS simulators, Android emulators, TCP ports and native app builds, so a resource used by one agent / worktree / human is never handed to another. Success: parallel agents and e2e runs on one machine never drive each other's devices, and new devices come up fast.

## Positioning

Coordination at the machine level, not the project level: one sqlite lease registry (`~/.warden/warden.db`, `BEGIN IMMEDIATE` as the cross-process mutex) shared by every agent session, worktree, repo, CI job and user shell on the Mac, with agent hooks that enforce it on argent tool calls. It never touches devices it didn't create or lease.

## Operating Context

- Terminal-first. Used via `warden claim`, `warden run -- <cmd>`, `warden ls`, and implicitly via Claude Code / Codex PreToolUse + SessionEnd hooks on argent MCP calls.
- Environments: macOS with Xcode (`xcrun simctl`), Android SDK (`adb`, `emulator`), Expo / EAS for app builds, Orca-managed worktrees.
- Integrates with e2e scripts through env vars (`WARDEN_UDIDS`, `WARDEN_PORT_<i>`, …).

## Capabilities and Constraints

- Device leasing (iOS sims, Android emulators), port leasing, `warden run` for e2e, golden-image cloning for fast new sims, Expo-fingerprint app build reuse (installed → cache → EAS → local build), agent hooks for Claude Code and Codex, `warden gc`, `warden doctor`, self-update.
- Only shuts down devices it created or the owner booted; foreign devices are read-only unless `--adopt`.
- Distribution today: build from source, or private GitHub releases via `gh`. Public install path is undecided — do not claim npm/Homebrew availability.
- Docs site: Fumadocs + TanStack Start + Tailwind v4 in `apps/docs`; content in `content/docs/*.mdx`; every page also served as Markdown.

## Brand Commitments

- Name is lowercase `warden`, set as code/CLI.
- Own identity, independent of the Delacour studio brand; Delacour appears at most as a credit.
- Voice: terse, factual, operational — the README's register. Measurements stated precisely.

## Evidence on Hand

- Golden-image measurements (README / SAL-GOLDEN): fresh create + first boot 146–239 s; clone of settled golden + boot 3.7 s + 11.9 s; 3 clones booted in parallel ~20 s; second boot of an existing pool device ~6.5 s.
- Real CLI help output and command surface (`apps/cli`).
- No testimonials, users, logos, stars or benchmarks beyond the above. Do not fabricate any.

## Product Principles

1. Never drive someone else's device — safety over convenience.
2. Agents are first-class readers; everything must work as plain Markdown.
3. State mechanisms and measurements, not adjectives.
4. Zero-config first; config only when a repo needs it.

## Accessibility & Inclusion

WCAG 2.2 AA for the site. Code samples must remain legible and copyable; respect reduced motion.
