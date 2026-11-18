---
"@delacour/warden": patch
---

- `warden repack` and `warden e2e` now bundle a repack's JS without minifying it (`--minify false`), as React Native's own Hermes build does: `hermesc -O` optimises the bytecode itself. The bundler step is about 30% faster and the bytecode is the same size. Every cached repack is rebuilt once, because the bundler flags are part of its `jsKey`.
