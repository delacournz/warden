import type { Driver } from "@delacour/warden-e2e/driver/driver.types";
import { err, ok, type Result } from "@delacour/warden-types/result";
import type { UiError } from "../agent-ui/output";
import type { CommandContext } from "../context";
import type { HostLease } from "./claim";
import { uploadToHost } from "./upload";

/** an install of a large build on a busy host can take minutes */
const INSTALL_TIMEOUT_MS = 10 * 60_000;

export type HostInstallDeps = {
	upload?: (ctx: CommandContext, host: string, path: string) => Promise<Result<string>>;
	connect?: (ctx: CommandContext, lease: HostLease) => Promise<Result<Driver, UiError>>;
};

/**
 * Install a local build on a host's device: send it (once per content hash) into the host's uploads, then install
 * that copy through the host's own driver. Returns the host's path of the build.
 */
export async function installOnHost(
	ctx: CommandContext,
	lease: HostLease,
	appPath: string,
	deps: HostInstallDeps = {}
): Promise<Result<string>> {
	const upload = deps.upload ?? ((c, host, path) => uploadToHost(c, host, path));
	const remote = await upload(ctx, lease.resource.host, appPath);
	if (!remote.success) return remote;
	const connect =
		deps.connect ??
		(async (c, l) => (await import("./driver")).connectHostDriver(c, l, { requestTimeoutMs: INSTALL_TIMEOUT_MS }));
	const driver = await connect(ctx, lease);
	if (!driver.success) return err(driver.error.message);
	try {
		const installed = await driver.data.app.install(remote.data);
		if (!installed.success) return err(`${lease.resource.host}: install failed: ${installed.error.message}`);
		return ok(remote.data);
	} finally {
		await driver.data.close().catch(() => undefined);
	}
}
