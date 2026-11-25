import { mkdirSync } from "node:fs";
import { wardenHome } from "@delacour/warden-core/store";
import type { Driver } from "@delacour/warden-e2e/driver/driver.types";
import { ok, type Result } from "@delacour/warden-types/result";
import { type UiError, uiError } from "../agent-ui/output";
import type { CommandContext } from "../context";
import type { HostLease } from "./claim";
import { lookupHost, wardenArgv } from "./remote";
import { hostControlDir, sshArgv } from "./ssh";

/**
 * `warden ui` verbs that go through the device's driver only, so they work on a host's device: the driver runs on
 * the host (`warden __driver-serve`) and its calls cross ssh. The others run simctl / adb / Metro on this Mac.
 */
export const HOST_UI_VERBS: ReadonlySet<string> = new Set([
	"status",
	"close",
	"open",
	"snapshot",
	"find",
	"get",
	"is",
	"wait",
	"press",
	"tap",
	"fill",
	"type",
	"key",
	"scroll",
]);

const onHost = (verb: string): boolean => HOST_UI_VERBS.has(verb) || verb.startsWith("gesture ");

/** `usage` for a verb a host's device can't take yet, else undefined. */
export function hostVerbError(verb: string): UiError | undefined {
	if (onHost(verb)) return undefined;
	return uiError("usage", `warden ui ${verb} does not drive a host's device`, {
		hint: `on a host device: ${[...HOST_UI_VERBS].join(", ")}, gesture …`,
	});
}

/** `ssh … <host's warden> __driver-serve --lease <remote id>`: its own connection (a long-lived stdio channel). */
export function hostDriverArgv(ctx: CommandContext, lease: HostLease): Result<string[]> {
	const host = lookupHost(ctx, lease.resource.host);
	if (!host.success) return host;
	const home = wardenHome(ctx.env);
	return ok(
		sshArgv(host.data, wardenArgv(host.data, ["__driver-serve", "--lease", lease.resource.remoteLeaseId]), {
			home,
			control: false,
		})
	);
}

/** The driver of a host's device, served by the host's warden over ssh; closing it ends the ssh session. */
export async function connectHostDriver(
	ctx: CommandContext,
	lease: HostLease,
	opts: { requestTimeoutMs?: number } = {}
): Promise<Result<Driver, UiError>> {
	const argv = hostDriverArgv(ctx, lease);
	if (!argv.success) return { success: false, error: uiError("engine_unavailable", argv.error) };
	mkdirSync(hostControlDir(wardenHome(ctx.env)), { recursive: true, mode: 0o700 });
	const [{ connectRemoteDriver }, { stdioTransport }] = await Promise.all([
		import("@delacour/warden-e2e/driver/remote/remote-client"),
		import("@delacour/warden-e2e/driver/ios/simd-transport"),
	]);
	const client = await connectRemoteDriver({
		transport: stdioTransport({ cmd: argv.data }),
		label: lease.resource.host,
		readyTimeoutMs: 30_000,
		...(opts.requestTimeoutMs !== undefined ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
	});
	if (!client.success) {
		return { success: false, error: uiError("engine_unavailable", `${lease.resource.host}: ${client.error.message}`) };
	}
	return ok(client.data.driver());
}
