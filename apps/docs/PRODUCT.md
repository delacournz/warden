# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary, two overlapping groups on one Mac:

1. **Agent-heavy developers** running several coding agents (Claude Code, Codex, others) across worktrees in parallel. Their pain is collisions: two agents or worktrees grabbing the same simulator, an agent tapping on the human's own Simulator.app, dev servers landing on a port someone else holds.
2. **Mobile teams with agents** building iOS / Android / React Native apps whose e2e suites run serially on one simulator and take far too long. They want a suite fanned out across many simulators, run by humans or agents, without writing their own scheduler or stepping on each other's devices.

The landing page leads with the second group's job, parallel e2e, and treats agent isolation as the mechanism that makes it safe.

Secondary: the agents themselves, which read the docs as Markdown (`.md` twins, `/llms.txt`, `/llms-full.txt`) and follow the embedded warden skill.

The site targets a public open-source audience discovering warden, while also serving as the working reference for existing users.

## Product Purpose

`warden` is a CLI that parallelises agent workflows and e2e tests on one machine. It hands out exclusive, machine-wide leases on iOS simulators, Android emulators, TCP ports and native app builds, and `warden batch` fans a job list (e2e flows, scenes) across N leased devices with one worker per device. Success: an e2e suite that ran serially finishes in a fraction of the time on the same Mac, and parallel agents and runs never drive each other's devices.

## Positioning

Parallel e2e and agent work without collisions, coordinated at the machine level, not the project level: one sqlite lease registry (`~/.warden/warden.db`, `BEGIN IMMEDIATE` as the cross-process mutex) shared by every agent session, worktree, repo, CI job and user shell on the Mac. `warden batch` adds the scheduler on top: a job queue across leased devices, a long-lived serve step (Metro), retries, a live per-device grid and recordings. Agent hooks enforce the leases on the flow runner's tool calls. It never touches devices it didn't create or lease. Tool-agnostic in public: the flow runner is configured, not named.

## Operating Context

- Terminal-first. Used via `warden batch <preset>`, `warden run -- <cmd>`, `warden claim`, `warden ls`, and implicitly via Claude Code / Codex PreToolUse + SessionEnd hooks.
- Repos declare batch presets and app-build config in `warden.config.json`.
- Environments: macOS with Xcode (`xcrun simctl`), Android SDK (`adb`, `emulator`), Expo / EAS for app builds, Orca-managed worktrees.
- Integrates with e2e scripts through env vars (`WARDEN_UDIDS`, `WARDEN_UDID`, `WARDEN_JOB`, `WARDEN_PORT_<i>`, …).

## Capabilities and Constraints

- `warden batch`: job queue over N leased devices, `{job}`/`{udid}` substitution, `--serve` + readiness probe, `--retry`, live grid TUI, `--record` (per-simulator video, asciicast, `batch.json` timeline), named presets.
- Device leasing (iOS sims, Android emulators), port leasing, `warden run` for single-process e2e, golden-image cloning for fast new sims, Expo-fingerprint app build reuse (installed → cache → EAS → local build), agent hooks for Claude Code and Codex, `warden gc`, `warden doctor`, self-update.
- Only shuts down devices it created or the owner booted; foreign devices are read-only unless `--adopt`.
- Distribution: npm package `@delacour/warden` (`npx` / `bunx` / global install) is the intended install path; publishing is being wired and not yet released, so the page must not claim it works until it is published. Build from source remains the alternative.
- Docs site: Fumadocs + TanStack Start + Tailwind v4 in `apps/docs`; content in `content/docs/*.mdx`; every page also served as Markdown.

## Brand Commitments

- Name is lowercase `warden`, set as code/CLI.
- Own identity, independent of the Delacour studio brand; Delacour appears at most as a credit and as the npm scope.
- Voice: terse, factual, operational — the README's register. Measurements stated precisely.
- Never name the underlying flow runner / simulator-control tool in public copy, code comments, commits or PRs.

## Evidence on Hand

- Parallel e2e run (salient, Oct 2026): 37 offline e2e flows of the Salient app across 5 leased iPhone 17 simulators in 3m25s wall time, 37/37 passing (one on retry), recorded as the landing-page video. The app may be named.
- Serial baseline (same 37 flows, same preset, `--count 1`, Oct 2026): 13m55s (835 s) of job time on one simulator, 36/37 passing (`qa-double-play` failed twice in the long serial run). Parallel vs serial job time: 3m25s vs 13m55s, a 4.1× speedup. Both times are the job phase after the serve step is ready; state it as "4×" or the two times, never rounded up.
- Golden-image measurements (README / SAL-GOLDEN): fresh create + first boot 146–239 s; clone of settled golden + boot 3.7 s + 11.9 s; 3 clones booted in parallel ~20 s; second boot of an existing pool device ~6.5 s.
- Real CLI help output and command surface (`apps/cli`).
- No testimonials, users, logos, stars or benchmarks beyond the above. Do not fabricate any.

## Product Principles

1. Never drive someone else's device — safety over convenience.
2. Parallel by default: the suite's wall time, not one device's, is the number that matters.
3. Agents are first-class readers; everything must work as plain Markdown.
4. State mechanisms and measurements, not adjectives.
5. Zero-config first; config only when a repo needs it.

## Accessibility & Inclusion

WCAG 2.2 AA for the site. Code samples must remain legible and copyable; respect reduced motion (the hero video rests on its poster and offers controls).
