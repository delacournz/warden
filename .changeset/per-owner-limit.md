---
"@delacour/warden": minor
---

- New opt-in `WARDEN_MAX_PER_OWNER=<n>` (or per platform, `ios=2,android=1`) caps how many separate device claims one owner holds at a time; unset stays unlimited. A claim over the cap waits (shown as `requester-limit` in `warden queue`) while `--wait` time remains, then fails with exit 8 `REQUESTER_LIMIT`, naming the owner's oldest lease and its `warden release <leaseId>`.
- `warden run`, `dev`, `batch` and `e2e` count as one claim however many devices (`--count`, device legs, extra workers) they take, so the cap never splits a single command.
- A malformed `WARDEN_MAX_PER_OWNER` (`lots`, `0`, `ios=`) fails the claim with a usage line before anything is leased.
