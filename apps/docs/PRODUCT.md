# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: **developers building iOS / Android / React Native (Expo) apps with coding agents** (Claude Code, Codex, Cursor, Copilot, Gemini CLI, OpenCode, Windsurf and others), often several agents across worktrees in parallel on one Mac. Their jobs, in the order they meet them:

1. **Let the agent see and drive the app.** The agent needs a simulator it owns, a way to read the screen and tap/type, and proof its change works, without touching the human's own Simulator.app or another agent's device.
2. **Keep what the agent verified as an e2e test.** What the agent just checked by hand becomes a `*.e2e.ts` spec that keeps passing, on the same driver and the same testIDs.
3. **Run the suite fast.** The suite fans out across many leased simulators instead of running serially on one, for humans, agents and CI alike.

Secondary: the agents themselves, which read the docs as Markdown (`.md` twins, `/llms.txt`, `/llms-full.txt`) and follow the embedded warden skill.

The site serves a public open-source audience discovering warden and is the working reference for existing users.

## Product Purpose

`warden` is an open-source CLI plus e2e framework that closes the loop for coding agents on mobile: an agent claims a simulator or emulator, drives the app with `warden ui`, saves what it verified as a spec written with `@delacour/warden-e2e`, and `warden e2e` runs the suite across N leased devices in parallel. Underneath, every device, port and app build on the Mac is leased machine-wide, so parallel agents and runs never collide.

Success: an agent proves its own UI change on a real simulator in the same session, the proof stays as a test, and the suite finishes in a fraction of the serial time on the same Mac.

## Positioning

Tagline: **"Every agent gets its own simulator."** Lead with isolation for parallel agents across worktrees (devices, ports, builds), then what the agent does on that device; testing is one capability, not the headline.

Agent device control and an e2e test framework in one tool, on one shared driver, made parallel-safe by machine-level leasing. One sqlite lease registry (`~/.warden/warden.db`, `BEGIN IMMEDIATE` as the cross-process mutex) is shared by every agent session, worktree, repo, CI job and user shell on the Mac. `warden ui` and the spec runner use the same driver, so `warden ui record` … `export` turns an exploration into a spec. It never touches devices it didn't create or lease.

## Operating Context

- Terminal-first. Core loop: `warden claim` → `warden ui open/snapshot -i/press/fill/wait` → write `e2e/<name>.e2e.ts` with the same selectors → `warden e2e <suite>`. Also `warden dev` (dev client + own Metro port per worktree), `warden init` (scaffold an Expo app for warden), `warden affected` (flows a diff needs), `warden run` / `warden batch` (devices + ports for any script), `warden ls`, `warden capacity` / `queue`.
- Agent integration: `warden install` wires the embedded skill (via the `skills` CLI, any supported agent) and a SessionEnd cleanup hook (Claude Code, Codex).
- Repos declare projects, e2e suites and batch presets in `warden.config.ts` (`defineConfig`).
- Specs: `test("…", async ({ app, device, screen }) => { await expect(screen.getByTestId("x")).toBeVisible(); })`, run by `bun test --preload @delacour/warden-e2e/preload`; evidence under the batch dir (`failure.png`, `screen-at-failure.txt`, `trace.jsonl`, `results.jsonl`, `e2e-report.json`).
- Environments: macOS with Xcode (`xcrun simctl`), Android SDK (`adb`, `emulator`), Expo / EAS for app builds, GitHub Actions (install action), Orca-managed worktrees.

## Capabilities and Constraints

- `warden ui`: agent CLI over the spec driver: snapshot as `@eN` refs, selectors (`id= label= text= role= value=`), press/fill/scroll/gesture, wait/is/get, devtools; checks the lease on every call.
- `@delacour/warden-e2e`: TypeScript spec API (test/expect over `bun test`), iOS + Android driver, fixtures, devtools, failure artifacts.
- `warden e2e` / `affected`: suites in config, affected-spec selection from the git diff via the import graph, dev-client suites with a warden-owned Metro, multiple device legs, retries/passes, report.
- Leasing: iOS sims, Android emulators, TCP ports; capacity-aware boot queue by host RAM/CPU and priority; golden-image cloning for fast new sims; Expo-fingerprint app build reuse (installed → cache → EAS → local build); `gc`, `doctor`, self-update, tab completion.
- Only shuts down devices it created or the owner booted; foreign devices are read-only unless `--adopt`.
- Distribution: published on npm. `npm i -g @delacour/warden && warden install` (or `bunx` / `npx @delacour/warden install`); `@delacour/warden-e2e` as a dev dependency at the same version. macOS for iOS; Linux binary exists; no Windows.
- Repo is public: github.com/delacournz/warden. MIT.
- Docs site: Fumadocs + TanStack Start + Tailwind v4 in `apps/docs`; content in `content/docs/**/*.mdx`; every page also served as Markdown.

## Brand Commitments

- Name is lowercase `warden`, set as code/CLI.
- Own identity, independent of the Delacour studio brand; Delacour appears at most as a credit and as the npm scope.
- Voice: short declarative headlines with a hook, one plain explanatory sentence under each; the agent is the actor ("your agent claims a simulator…"); verb-first capability lists; mechanism first, then the claim; candid about limits and experimental features; exact nouns and numbers over adjectives; coding agents addressed as a first-class audience ("For coding agents").
- warden's own runner and driver are named freely. Competitors are named only in comparison/benchmark material, factually.

## Evidence on Hand

- Parallel e2e run (salient, Oct 2026): 37 offline e2e specs of the Salient app across 5 leased iPhone 17 simulators in 3m25s wall time, 37/37 passing (one on retry), recorded as `public/demo/*` video. Serial baseline on one simulator: 13m55s, 36/37. 4.1× (say "4×" or the two times, never rounded up). The app may be named.
- Framework benchmark (`content/docs/bench/data/ios-2026-10-25.json`, `packages/e2e-bench`): same 8 parity tests, same build, one fresh simulator per framework on EAS Workflows `macos-large`, no LLM. **Decision (2026-10-24): plan a landing section naming competitors with these ratios, but do not build it yet; bench stays in docs.**
- Golden-image measurements: fresh create + first boot 146–239 s; clone of settled golden + boot 3.7 s + 11.9 s; 3 clones in parallel ~20 s; second boot of a pool device ~6.5 s.
- Real CLI help output and command surface (`apps/cli`), the skill (`skills/warden/`).
- Agent support is real for: any agent the `skills` CLI installs into (skill), Claude Code and Codex (skill + SessionEnd hook). Agent logos for a "Works with" strip must be the agents' own marks, not redrawn.
- No testimonials, users, company logos, stars or blog. Do not fabricate any.

## Product Principles

1. Never drive someone else's device — safety over convenience.
2. Close the loop: the agent verifies its own change on a real device, and the verification stays as a test.
3. Parallel by default: the suite's wall time, not one device's, is the number that matters.
4. Agents are first-class readers; everything must work as plain Markdown.
5. State mechanisms and measurements, not adjectives. Zero-config first.

## Accessibility & Inclusion

WCAG 2.2 AA for the site. Code samples legible and copyable; respect reduced motion (the hero video rests on its poster and offers controls).
