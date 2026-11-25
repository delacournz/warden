---
"@delacour/warden": minor
---

- `warden login` picks the organization for you: with one, it is used; with several, a terminal asks which is the default (no terminal or `--json`: the active one, else the first). The chosen org is made active, so a login without an active organization no longer ends with "no organization yet".
- Every other organization is saved as its own account named by its slug, sharing the login's session (`--account <slug>`). An account of that name belonging to another user or server is left alone with a warning. `--json` adds `profiles: [{ account, organization }]`.
- New `warden login --org <slug|id>` sets the default organization without a prompt; an organization you are not a member of exits 1 and saves nothing.
- `warden logout` keeps a session another saved account still uses instead of revoking it; `--json` adds `kept`.
