import { isLeaseAlive, processAlive } from "@delacour/warden-core/liveness";
import { sameOwner } from "@delacour/warden-core/types";
import type { Driver } from "@delacour/warden-e2e/driver/driver.types";
import { ok, type Result } from "@delacour/warden-types/result";
import type { UiDevice } from "../agent-ui/device";
import { resolveOwner } from "../claim-flags";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { reportError } from "../output";

/** What `__driver-serve` reaches the outside world through; tests inject the driver and the two pipes. */
export type DriverServeDeps = {
	/** open the leased device's driver (default: the one `warden ui` uses, `uiDriver`) */
	openDriver?: (ctx: CommandContext, device: UiDevice) => Promise<Result<Driver, string>>;
	/** the request stream (default: this process's stdin) */
	input?: () => ReadableStream<Uint8Array>;
	/** where replies go (default: this process's stdout, flushed per write) */
	write?: (bytes: Uint8Array) => void;
};

const SCOPE = "__driver-serve";
/** exit codes: 1 bad arguments · 2 the lease is unknown, dead, not a device or not the caller's · 3 no driver */
const EXIT_LEASE = 2;
const EXIT_ENGINE = 3;

async function defaultOpenDriver(ctx: CommandContext, device: UiDevice): Promise<Result<Driver, string>> {
	const { uiDriver } = await import("../agent-ui/ui-driver");
	const opened = await uiDriver(ctx, device);
	return opened.success ? ok(opened.data) : { success: false, error: opened.error.message };
}

function stdoutWrite(): (bytes: Uint8Array) => void {
	const writer = Bun.stdout.writer();
	return (bytes) => {
		writer.write(bytes);
		writer.flush();
	};
}

/** The caller's live device lease `id`, or why it cannot be served. */
function leasedDevice(ctx: CommandContext, id: string): Result<UiDevice, string> {
	const lease = ctx.store().getLease(id);
	if (lease === undefined) return { success: false, error: `no lease ${id}` };
	if (!isLeaseAlive(lease, ctx.now(), processAlive)) return { success: false, error: `lease ${id} has expired` };
	if (lease.resource.kind !== "device") return { success: false, error: `lease ${id} is not a device lease` };
	if (!sameOwner(lease.owner, resolveOwner(ctx))) return { success: false, error: `lease ${id} is not yours` };
	const { id: udid, platform, name } = lease.resource;
	return ok({ udid, platform, name, lease, action: "own", source: "lease" });
}

async function serve(ctx: CommandContext, deps: DriverServeDeps, opts: { lease?: string }): Promise<number> {
	if (opts.lease === undefined) {
		reportError(ctx, SCOPE, "--lease is required");
		return 1;
	}
	const device = leasedDevice(ctx, opts.lease);
	if (!device.success) {
		reportError(ctx, SCOPE, device.error);
		return EXIT_LEASE;
	}
	const opened = await (deps.openDriver ?? defaultOpenDriver)(ctx, device.data);
	if (!opened.success) {
		reportError(ctx, SCOPE, `cannot open ${device.data.udid}: ${opened.error}`);
		return EXIT_ENGINE;
	}
	const { serveDriverStdio } = await import("@delacour/warden-e2e/driver/remote/remote-server");
	const server = serveDriverStdio({
		driver: opened.data,
		input: deps.input?.() ?? Bun.stdin.stream(),
		write: deps.write ?? stdoutWrite(),
		...(device.data.platform === "android" ? { alertIn: "android" as const } : {}),
		log: (line) => ctx.err(line),
	});
	const stop = () => void server.stop();
	process.once("SIGTERM", stop);
	process.once("SIGHUP", stop);
	await server.finished;
	process.off("SIGTERM", stop);
	process.off("SIGHUP", stop);
	await server.stop();
	return 0;
}

/**
 * `warden __driver-serve --lease <id>`: serve the caller's leased device's driver on stdin / stdout (the
 * `@delacour/warden-e2e/driver/remote` protocol) until stdin ends. Run on a host over `ssh` by a laptop's
 * `warden ui` / `warden e2e`; stdout carries only the protocol, logs go to stderr. Exit 0 ended · 1 bad arguments ·
 * 2 the lease is unknown, expired, not a device or not the caller's · 3 the driver could not be opened.
 */
export function createDriverServeCommand(deps: DriverServeDeps = {}) {
	return defineCommand({
		name: "__driver-serve",
		summary: "serve a leased device's driver on stdin/stdout for a remote warden (internal)",
		hidden: true,
		register: (cmd, ctx, done) => {
			cmd.option("--lease <id>").action(async (opts) => done(await serve(ctx, deps, opts)));
		},
	});
}

export const driverServeCommand = createDriverServeCommand();
