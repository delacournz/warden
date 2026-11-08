---
"@delacour/warden": minor
---

- A local native build nobody streams (`warden e2e`, `warden ui open`, CI) now says why it is building (`no cached ios build for <hash>: building it from source…`) and logs `still building ios (6m 0s): <last build line>` every minute, so a 15-20 minute cold build on CI no longer looks hung.
- The whole output of a green native build is now kept in `~/.warden/logs/build-<platform>-<hash>.log` too, not only a failed one's.
- `warden ci cache --json` adds a `ccache` group (`~/.warden/ccache`, keyed by the native fingerprint, with `restoreKeys` to fall back to the newest older cache on a miss).
- The e2e GitHub action, on a native build cache miss: prints a `native build cache miss` notice, installs `ccache` and restores / saves the compiler cache (new `compiler-cache` input, default `true`), and prints each native build log in a collapsed group with ccache's stats.
