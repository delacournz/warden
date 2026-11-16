---
"@delacour/warden": minor
---

- `warden pods install` (and warden's own iOS builds) now records the files `pod install` and its `post_install` hooks delete from a committed `ios/` or `node_modules`, and deletes them again when another checkout restores that entry, so a restore leaves what a real install would.
- New `projects[].ios.pods.env` in `warden.config.ts`: env var names (`NAME_*` = a prefix) a Podfile or its `post_install` hooks read. Their values join the pods cache key, so a different value runs a real `pod install` instead of restoring one made with the old value.
- New `projects[].ios.pods.cache: false`: `warden pods install` and warden's iOS builds never restore or store pods for that project, so its `post_install` hooks run on every install. `warden pods install` reports `! pods installed, not cached: ios.pods.cache: false`.
