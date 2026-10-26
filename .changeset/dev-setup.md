---
"@delacour/warden": minor
---

- `warden dev` resolves an app whose config is code (`app.config.ts` / `.js` / `.mjs` / `.cjs`) without a bundle id in `app.json`: it runs `expo config --json --type public` in the app directory once and takes the bundle id, slug and scheme from the result, instead of stopping with "app.config.ts is dynamic". `--bundle-id` still overrides it and a `warden.config.ts` skips the call. The same applies to every command that finds the project this way (`warden app`, `warden e2e`, `warden run`).
- `warden dev` checks the request and the app before it leases a device or opens the dashboard, and a failure there is one line with the fix on the terminal. With a person at the terminal each missing piece is offered: a package the dev-client run needs (`expo-dev-client`) is added and installed through the checkout's package manager (`yarn` / `pnpm` / `bunx` / `npx` `expo install`, from the nearest lockfile), and an app read through `expo config` can get a `warden.config.ts` with the resolved ids so later starts skip the call. Without a terminal (`--json`, a pipe) the blocking issues are the error, each with its command.
- The dashboard no longer swallows a failure: when the session never comes up, or Metro dies, warden's lines are printed to the terminal after the dashboard has closed, with the session log directory.
- `warden init` names the install command for the checkout's package manager instead of always `bunx expo install`.
