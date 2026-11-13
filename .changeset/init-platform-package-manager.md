---
"@delacour/warden": minor
---

- `warden init --platform ios|android` writes the e2e suite's platform (default `ios`); an Android suite needs an Android package, so pass `--bundle-id` when `app.json` has none. A bad value is an error.
- `warden init` prints the `@delacour/warden-e2e` install for the project's package manager (`bun add -d`, `pnpm add -D`, `yarn add -D` or `npm install -D`, from the lockfile; bun without one).
- `warden init` ends with the next steps in order, and the starter spec explains `launch: "none"` and `systemAlerts: "dismiss"`.
