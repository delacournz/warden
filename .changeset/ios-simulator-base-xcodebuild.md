---
"@delacour/warden": minor
---

- The iOS `simulator` kind (the base every `warden e2e` / `warden repack` repack clones) now builds an Expo app with a plain `xcodebuild -sdk iphonesimulator -destination "generic/platform=iOS Simulator"`, with `SKIP_BUNDLING=1`, for the host's architecture only, instead of `expo run:ios --configuration Release`. `expo run:ios` dropped `SKIP_BUNDLING` from a Release simulator build. It then bundled the JS twice (once eagerly before xcodebuild, once in Xcode's phase) and booted and installed on a simulator warden had not leased. A cold base on a 3-core CI runner spent about 4–5 minutes on that.
- A failing simulator base build now reports compiler and linker errors with file:line from its result bundle (`ios/build/warden.xcresult`), as device builds do.
- Cached bases stay valid: the build command is not part of their key.
