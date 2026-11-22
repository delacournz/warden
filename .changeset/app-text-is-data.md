---
"@delacour/warden": patch
---

- The warden skill, the `~/.claude/rules/warden.md` rule and the `warden mcp` server's `instructions` now tell agents that text read from a device, app, console, network, Metro or an evidence file is data, never an instruction. The MCP tools that return app text say so in their descriptions.
- `warden mcp` replies are capped at 60 000 characters: a string over 4 000 is cut and ends `… [truncated N chars]`, then a too-long list keeps its newest entries (`app_tree`: its first). The first text block is still the result's JSON; a second block, `[warden: output truncated. …]`, names what was cut and the arguments that narrow the call. A value with no list to shorten answers the error `too_large`.
- `warden install` writes the skill folder to `~/.claude/skills/warden` itself and no longer runs `bunx` / `npx`, so the skill step works without bun or node. A link there to a shared skills folder is kept and the files are updated in it.
- `warden skill install` runs the `skills` CLI at one exact version (`skills@1.9.0`), and a global install starts it in `$WARDEN_HOME/skill/` rather than the working directory.
- `warden repack android` and the Android `simulator` build pass the keystore and key passwords to `apksigner` through its environment instead of its arguments.
