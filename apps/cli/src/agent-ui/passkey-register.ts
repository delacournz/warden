import type { Command as Commander } from "@commander-js/extra-typings";
import type { CommandContext } from "../context";
import type { UiDeps } from "./driver";
import { withUiOptions } from "./ui-options";

/**
 * `warden ui passkey set | off | add | list | remove | clear | status`: the simulated passkey authenticator. A command
 * group like `camera`; the mode and uv are the lease's `passkeys` condition, shared with `device.passkeys` in specs.
 * One call from `commands/ui.ts`; `passkey.ts` is imported by the subcommand that runs.
 */
export function registerPasskeyGroup(
	cmd: Commander,
	ctx: CommandContext,
	done: (code: number) => void,
	deps: UiDeps
): void {
	const group = cmd
		.command("passkey")
		.description(
			"simulated passkeys: set <mode> | off | add | list | remove | clear | status (answers the app's real passkey calls)"
		);
	withUiOptions(
		group
			.command("set")
			.description(
				"turn the authenticator on and pick how it answers. iOS: live in an app launched with it, else from its next launch. Android: warden's credential provider (API 34+ emulator)"
			)
			.argument("<mode>", "auto | cancel | fail | unavailable")
			.option("--uv <uv>", "user verification: match (default) | nomatch | skip")
	).action(async (mode, opts) => {
		const { uiPasskey } = await import("./passkey");
		done(await uiPasskey(ctx, deps, "set", mode, opts));
	});
	withUiOptions(group.command("off").description("turn the authenticator off (credentials stay in the store)")).action(
		async (opts) => {
			const { uiPasskey } = await import("./passkey");
			done(await uiPasskey(ctx, deps, "off", undefined, opts));
		}
	);
	withUiOptions(
		group
			.command("add")
			.description("add a credential; prints its id. Without --key a fresh P-256 key is generated")
			.option("--rp <id>", "relying party id, a bare host like example.com")
			.option("--user-name <name>", "user name shown in the account picker")
			.option("--display-name <name>", "display name (default the user name)")
			.option("--user-handle <b64url>", "user handle, base64url (default 16 random bytes)")
			.option("--id <b64url>", "credential id, base64url (default 16 random bytes)")
			.option("--key <path>", "P-256 PKCS#8 private key, PEM or DER file, relative to the working directory")
			.option("--sign-count <n>", "starting signature counter (default 0)")
	).action(async (opts) => {
		const { uiPasskey } = await import("./passkey");
		done(await uiPasskey(ctx, deps, "add", undefined, opts));
	});
	withUiOptions(
		group
			.command("list")
			.description("the credentials in the store, newest first")
			.option("--rp <id>", "only this relying party")
			.option("--with-keys", "include each private key (test keys)")
	).action(async (opts) => {
		const { uiPasskey } = await import("./passkey");
		done(await uiPasskey(ctx, deps, "list", undefined, opts));
	});
	withUiOptions(
		group.command("remove").description("remove one credential").argument("<credentialId>", "credential id (base64url)")
	).action(async (credentialId, opts) => {
		const { uiPasskey } = await import("./passkey");
		done(await uiPasskey(ctx, deps, "remove", credentialId, opts));
	});
	withUiOptions(group.command("clear").description("remove every credential")).action(async (opts) => {
		const { uiPasskey } = await import("./passkey");
		done(await uiPasskey(ctx, deps, "clear", undefined, opts));
	});
	withUiOptions(group.command("status").description("mode, uv and credentials the authenticator has now")).action(
		async (opts) => {
			const { uiPasskey } = await import("./passkey");
			done(await uiPasskey(ctx, deps, "status", undefined, opts));
		}
	);
}
