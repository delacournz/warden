---
"@delacour/warden": minor
---

- An iOS Hermes repack no longer composes its source maps, which saved about 6 s on every `warden repack` / `warden e2e` repack. Metro's map (`main.jsbundle.packager.map`) and hermesc's (`main.jsbundle.hbc.map`) are written beside the app instead of `main.jsbundle.map`. `node node_modules/react-native/scripts/compose-source-maps.js main.jsbundle.packager.map main.jsbundle.hbc.map -o main.jsbundle.map` joins them when a stack trace needs symbolicating. A JSC repack still writes `main.jsbundle.map`.
