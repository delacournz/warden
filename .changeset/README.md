# Changesets

A changeset records a user-facing change to what warden ships and becomes its CHANGELOG line. Run `bun changeset` in a PR that changes `@delacour/warden`, `@delacour/warden-e2e` or `@delacour/warden-sdk`, and pick `@delacour/warden` only: `@delacour/warden-e2e` and `@delacour/warden-sdk` follow in lock-step. Docs-only and internal-only PRs need none. Never edit `version` by hand. See the [contributing docs](../apps/docs/content/docs/contributing.mdx).
