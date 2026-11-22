---
"@delacour/warden": patch
---

- warden's own `typecheck` runs on TypeScript 7, the native compiler (about 3x faster on CI). Nothing in the `warden` binary or `@delacour/warden-e2e` changes: TypeScript 5 still builds the published type declarations.
