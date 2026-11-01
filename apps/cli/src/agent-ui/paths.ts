import { join } from "node:path";
import { uiPaths } from "@delacour/warden-sdk/ops/paths";
import { storeLocator } from "@delacour/warden-store/store";
import type { CommandContext } from "../context";

export class CliUiPaths {
	/** `$WARDEN_HOME/ui`: one dir per device, holding what `warden ui` remembers between invocations. */
	uiRoot(ctx: Pick<CommandContext, "env">): string {
		return uiPaths.uiRoot(storeLocator.wardenHome(ctx.env));
	}

	/** `$WARDEN_HOME/ui/<udid>`: everything `warden ui` remembers about one device between invocations. */
	uiDir(ctx: Pick<CommandContext, "env">, udid: string): string {
		return uiPaths.uiDir(storeLocator.wardenHome(ctx.env), udid);
	}

	/** `$WARDEN_HOME/simd`: the resident `warden-simd` helpers' sockets and logs. */
	simdDir(host: Pick<CommandContext, "env">): string {
		return join(storeLocator.wardenHome(host.env), "simd");
	}

	/** `$WARDEN_HOME/ui/<udid>/recording.json`: the journal of the recording in progress (`warden ui record`). */
	recordingFile(ctx: Pick<CommandContext, "env">, udid: string): string {
		return uiPaths.recordingFile(storeLocator.wardenHome(ctx.env), udid);
	}

	/** `$WARDEN_HOME/ios-runner`: the resident `warden __ios-runner-host` processes' sockets (`<udid>.sock`) and logs. */
	iosRunnerDir(host: Pick<CommandContext, "env">): string {
		return join(storeLocator.wardenHome(host.env), "ios-runner");
	}

	/** `$WARDEN_HOME/android-host`: the resident `warden __android-host` processes' sockets and logs. */
	androidHostDir(host: Pick<CommandContext, "env">): string {
		return join(storeLocator.wardenHome(host.env), "android-host");
	}
}

export const cliUiPaths = new CliUiPaths();
