import type { GoldenDeps } from "@warden/core/golden/ios-golden";
import { processAlive } from "@warden/core/liveness";
import type { Owner } from "@warden/core/types";
import type { CommandContext } from "./context";

export type Sleep = (ms: number) => Promise<void>;

/** Golden-sim side effects wired to the command context. */
export function goldenDeps(ctx: CommandContext, owner: Owner, sleep: Sleep = Bun.sleep): GoldenDeps {
	return {
		exec: ctx.exec,
		store: ctx.store(),
		owner,
		pid: process.pid,
		env: ctx.env,
		now: ctx.now,
		pidAlive: processAlive,
		sleep,
		log: (line) => ctx.err(`warden ${line}`),
	};
}

/** Cloning from goldens is on unless `WARDEN_GOLDEN=0`. */
export function goldenEnabled(env: Record<string, string | undefined>): boolean {
	return env.WARDEN_GOLDEN !== "0";
}
