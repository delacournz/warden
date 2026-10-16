import type { Exec } from "@delacour/warden-core/exec";
import type { DriverError, DriverResult, Logger } from "../driver.types";
import { driverErr } from "../errors";
import type { AdbSession } from "./adb-session";
import { dumpFileCommand, dumpStdoutArgv, dumpTtyHostArgv, shellCommand } from "./android-argv";

/**
 * Fetching a `uiautomator dump`. Images disagree on where the XML may go (on the Pixel 10 AVD
 * `dump /dev/stdout` prints only the trailer, `exec-out … dump /dev/tty` works), so three routes are
 * tried in order and the first that yields a `<hierarchy>` is remembered and tried first next time.
 */

export type DumpRoute = "stdout" | "tty" | "file";

export const DUMP_ROUTES: readonly DumpRoute[] = ["stdout", "tty", "file"];

export const DUMP_TIMEOUT_MS = 20_000;

export type DumpDeps = {
	session: AdbSession;
	exec: Exec;
	adb: string;
	serial: string;
	log?: Logger;
	/** route to try first (remembered from an earlier process) */
	initialRoute?: DumpRoute;
	/** called whenever the working route changes (including the first discovery) */
	onRoute?: (route: DumpRoute) => void;
};

export type Dumper = {
	/** raw XML plus the route that produced it; `E_AX_UNAVAILABLE` when no route yields a hierarchy */
	dump(): DriverResult<{ xml: string; route: DumpRoute }>;
	/** the route that last worked, if any */
	route(): DumpRoute | undefined;
};

export function createDumper(deps: DumpDeps): Dumper {
	let known: DumpRoute | undefined = deps.initialRoute;

	async function fetchRoute(route: DumpRoute): Promise<{ text: string } | { error: DriverError }> {
		if (route === "tty") {
			try {
				const res = await deps.exec(dumpTtyHostArgv(deps.adb, deps.serial), { timeoutMs: DUMP_TIMEOUT_MS });
				return { text: res.stdout };
			} catch (error) {
				return { error: { code: "E_IO", message: String(error), retryable: false } };
			}
		}
		const cmd = route === "stdout" ? shellCommand(dumpStdoutArgv()) : dumpFileCommand();
		const res = await deps.session.run(cmd, { timeoutMs: DUMP_TIMEOUT_MS });
		return res.success ? { text: res.data.stdout } : { error: res.error };
	}

	/** One pass over the routes; the first with a `<hierarchy>` wins. */
	async function tryRoutes(order: readonly DumpRoute[]): Promise<{ xml: string; route: DumpRoute } | Failure> {
		const failure: Failure = {};
		for (const route of order) {
			const result = await fetchRoute(route);
			if ("error" in result) {
				failure.error = result.error;
				deps.log?.(`uiautomator dump via ${route} failed: ${result.error.code}`);
			} else if (result.text.includes("<hierarchy")) {
				return { xml: result.text, route };
			} else {
				failure.output = result.text;
				deps.log?.(`uiautomator dump via ${route} returned no hierarchy`);
			}
		}
		return failure;
	}

	return {
		route: () => known,
		async dump() {
			const order = known ? [known, ...DUMP_ROUTES.filter((r) => r !== known)] : [...DUMP_ROUTES];
			const found = await tryRoutes(order);
			if ("xml" in found) {
				if (known !== found.route) deps.log?.(`uiautomator dump route: ${found.route}`);
				if (known !== found.route) deps.onRoute?.(found.route);
				known = found.route;
				return { success: true, data: found };
			}
			if (found.output === undefined && found.error) return { success: false, error: found.error };
			const output = found.output ?? "";
			return driverErr("E_AX_UNAVAILABLE", `uiautomator produced no hierarchy: ${output.trim().slice(0, 160)}`, {
				detail: { output: output.slice(0, 400) },
			});
		},
	};
}

type Failure = { output?: string; error?: DriverError };
