---
"@delacour/warden": patch
---

- The npm `warden` command works after a CI cache restores it as a copy instead of a symlink (EAS Workflows' `eas/save_cache` stores files, not links): it finds `@delacour/warden-<platform>` under `<prefix>/lib/node_modules/@delacour/warden` instead of failing with `@delacour/warden-<platform> is not installed`.
