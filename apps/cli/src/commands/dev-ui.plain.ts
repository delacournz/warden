import { err, ok } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { note } from "../output";
import type { DevReady, DevTaskHandle, DevUi } from "./dev-ui";

/**
 * Today's `warden dev` output as a `DevUi`: Metro inherits the terminal, warden's lines go to
 * `ctx.err`. The spinner stays in `dev()` (it wraps the claim + install step), so task `ok`/`fail`
 * print nothing here; `log` is a plain `ctx.err` line. `ready` prints the `holding …` note (the
 * `--json` line is `dev()`'s own `emit`, and the TUI is never used with `--json`). Signals are
 * handled by `dev()` as before, so `onQuit` has nothing to wire.
 */
export function plainDevUi(ctx: CommandContext): DevUi {
	const handle: DevTaskHandle = {
		ok: () => {},
		fail: () => {},
		log: (line) => ctx.err(line),
	};
	return {
		ctx,
		task: () => handle,
		metro: { kind: "inherit" },
		ready: (info: DevReady) => {
			note(
				ctx,
				`warden dev: holding ${info.deviceId} + :${info.port} until Metro exits (WARDEN_UDID=${info.deviceId})`
			);
		},
		onQuit: () => {},
		setHud: (on) =>
			on ? err("no dashboard to show a HUD (--no-tui / --json): use `warden perf start`") : ok(undefined),
		hudOn: () => false,
		close: () => Promise.resolve(),
	};
}
