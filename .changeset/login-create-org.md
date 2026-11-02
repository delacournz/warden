---
"@delacour/warden": minor
---

- `warden login` with no organization yet creates one in the terminal: it asks for a name, then a slug prefilled from it (the same slug the dashboard would suggest), checks the slug is free and makes the new organization the login's default. Esc skips it and you stay logged in.
- New `warden org create [name] [--slug <slug>]` creates an organization from the CLI. A taken slug made from the name falls back to the name plus 6 hex characters; a taken or invalid `--slug` exits 1. An account with no organization yet takes the new one.
