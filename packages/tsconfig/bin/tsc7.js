#!/usr/bin/env node
// `tsc` from TypeScript 7 (the native compiler), for `typecheck` only. Every workspace still depends on
// TypeScript 5/6 for what needs its JavaScript API (the npm declaration build, `warden affected`) and
// for editors; TypeScript 7 ships no JavaScript API. Both packages name their bin `tsc`, so this one is
// `tsc7`: two `tsc` links in one `.bin` resolve by install order. The pinned version lives in this
// package's dependencies, which every typechecked workspace depends on, so a bump changes the turbo hash
// of every `typecheck` (through the `transit` node) instead of replaying a green from the old compiler.
// The package's `exports` hide its launcher, so it is imported by path from the resolved package root.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const root = dirname(createRequire(import.meta.url).resolve("typescript7/package.json"));
await import(pathToFileURL(join(root, "lib", "tsc.js")).href);
