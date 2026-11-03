# Product

<!-- impeccable:product-schema 1 -->

## Platform

ios

## Users

- **Developers and agent builders evaluating warden**, watching a 10-25 s clip on warden.co.nz or X. They decide in seconds whether warden really drives a device: every state change must read at video size, in about a second.
- **warden's own e2e suites** (dogfood). Every showcase screen is also a spec target: stable testIDs on `accessible` views, real controls, deterministic copy.

## Product Purpose

`@delacour/warden-example` is warden's dogfood app (Expo SDK 57, Expo Router, Uniwind, Delacour UI). Its showcase screens make one device capability visible each: biometrics (`/biometrics`), network (`/network`), location (`/location`), clock (`/clock`). Success: a viewer sees a `warden ui ...` command land and the phone visibly react, and the same screen passes its e2e spec.

## Positioning

The screens show real device conditions on a real simulator, driven by warden: the real LocalAuthentication prompt, real HTTP requests shaped by warden's network proxy / dylib, real GPS fixes from `simctl location`, the app's real wall clock. No mocked state, no app-side bypass.

## Operating Context

- Recorded by `bun run demo <feature>/<clip>` (`scripts/demo/`) on a leased simulator: 9:41 status bar, dark appearance, the docs frame around the phone, the caption "real simulator · not an animation".
- Driven in specs by `@delacour/warden-e2e` (`device.network`, `device.location`, `device.clock`) in the `conditions` suite, which launches the iOS app with warden's network dylib.
- `/conditions` stays the plain screen the existing `network-*`, `location-*` and `clock-*` specs drive; the showcase screens are separate routes with their own specs.

## Capabilities and Constraints

- Network: `warden ui network set online|offline|edge|3g|4g|lte|wifi|slow|lossy`, `flap --up --down`, `fault <host-glob> 503|reset|delay:2s|blackhole`. iOS shapes only the app's own NSURLSession traffic, and only when launched with the dylib; HTTPS faults arrive as resets.
- Location: `warden ui location set|route|gpx|scenario city-run|city-bike|freeway|clear`; fixes arrive through `expo-location`.
- Clock: `warden ui clock set|advance|reset`; a large offset breaks HTTPS.
- Theme: the docs Device Hub palette via `delacour theme` (`src/styles/theme.css`), light and dark. Registry files under `src/components/ui`, `src/lib`, `src/hooks`, `src/styles` stay byte-identical except `theme.css` / `app.css`.
- Tailwind scale tokens for type and spacing; px values only where geometry is bound to an SVG or a constant.

## Brand Commitments

- Same world as warden.co.nz: Mona Sans, Martian Mono, one ink, one orange accent, lease green for success.
- The biometrics vault screen is the reference for structure and quality: one hero glyph that carries the state, a headline + one supporting line, a raw readout of the values specs assert, a timestamped event log, one primary action.

## Evidence on Hand

- `apps/docs/public/demos/biometrics/` Face ID clip (recorded on a real simulator).
- No customer quotes, benchmarks or metrics may be invented on these screens; numbers shown are measured live.

## Product Principles

1. The state is the hero: one glance tells you what the device is doing.
2. Every number on screen is measured, never animated toward a target.
3. Every visible change maps to one warden command a viewer just saw typed.
4. A spec can assert everything a video shows.

## Accessibility & Inclusion

Every view a spec or VoiceOver reads is `accessible` with a label; state is never colour-only (text carries it too); motion honours `isMotionCalm` in e2e builds.
