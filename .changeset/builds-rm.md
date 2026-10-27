---
"@delacour/warden": minor
---

- `warden builds rm <hash…>` (alias `remove`) removes cached builds by hash or a unique prefix (at least 6 characters), with their aliases, and forgets the install records at those hashes so the next `warden dev` / `warden app ensure` reinstalls on those devices. `--platform`, `--dry-run`, `--yes` and `--json` (`{ dryRun, removed, forgotInstalls }`) are supported. It asks first in a terminal, and refuses a prefix that matches several builds or a build being fetched or built right now.
