import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { emit, note, reportError, success, warn } from "../output";
import { createWardenApi, type WardenApi } from "../remote/api";
import { openBrowser } from "../remote/browser";
import { DEFAULT_API_URL, writeCredentials } from "../remote/credentials";
import { pollDeviceToken } from "../remote/device-login";
import { machineDepsFor, machineHash } from "../remote/machine";
import { anonApi } from "../remote/session";

type LoginOpts = { apiUrl?: string; browser?: boolean; json?: true };

/** `registered`, `none` (no machine id here, e.g. CI) or `failed` (the server refused or was unreachable). */
type MachineRegistration = "registered" | "none" | "failed";

/**
 * Record this machine's hashed id against the account, which is what unlocks the one-per-person free trial.
 * Never fatal: paid usage works without it.
 */
async function registerMachine(ctx: CommandContext, api: WardenApi): Promise<MachineRegistration> {
	const machine = await machineHash(machineDepsFor(ctx));
	if (machine.kind === "none") return "none";
	return (await api.registerMachine(machine.hash)).success ? "registered" : "failed";
}

/**
 * Device-flow login: warden-api hands out a code, the user approves it in the browser, the CLI polls for the
 * session token and saves it to `$WARDEN_HOME/auth.json`. The code and link go to stderr so `--json` stays data.
 */
async function login(ctx: CommandContext, opts: LoginOpts): Promise<number> {
	const apiUrl = (opts.apiUrl ?? ctx.env.WARDEN_API_URL ?? DEFAULT_API_URL).replace(/\/+$/, "");
	const api = anonApi(ctx, apiUrl);
	const code = await api.deviceCode();
	if (!code.success) {
		reportError(ctx, "login", `${apiUrl}: ${code.error.message}`);
		return 1;
	}
	const link = code.data.verificationUriComplete ?? code.data.verificationUri;
	ctx.err(`Your code: ${ctx.ui.color.bold(code.data.userCode)}`);
	const opened = opts.browser !== false && ctx.ui.interactive && (await openBrowser(ctx, link));
	ctx.err(opened ? `Opened ${link}` : `Open ${link} to approve this login`);

	const token = await pollDeviceToken(api, code.data, {
		now: ctx.now,
		sleep: ctx.sleep ?? ((ms) => Bun.sleep(ms)),
	});
	if (!token.success) {
		reportError(ctx, "login", token.error);
		return 1;
	}
	const authed = createWardenApi({ baseUrl: apiUrl, token: token.data, ...(ctx.fetch ? { fetch: ctx.fetch } : {}) });
	const me = await authed.me();
	if (!me.success) {
		reportError(ctx, "login", `logged in, but ${apiUrl}/v1/me failed: ${me.error.message}`);
		return 1;
	}
	const { user, organization } = me.data;
	const saved = writeCredentials(ctx.env, {
		apiUrl,
		token: token.data,
		user: { id: user.id, email: user.email },
		...(organization ? { organizationId: organization.id } : {}),
		savedAt: ctx.now(),
	});
	if (!saved.success) {
		reportError(ctx, "login", saved.error);
		return 1;
	}
	const machine = await registerMachine(ctx, authed);
	if (opts.json) {
		emit(ctx, true, { apiUrl, user, organization, machine }, "");
		return 0;
	}
	success(ctx, `logged in as ${user.email}`);
	if (machine === "failed")
		warn(ctx, "could not register this machine; the free trial unlocks once it is (run warden login again)");
	if (organization) note(ctx, `organization: ${organization.name} (${organization.slug})`);
	else note(ctx, "no organization yet: create one in the browser, then warden org use <slug>");
	return 0;
}

export const loginCommand = defineCommand({
	name: "login",
	group: "Account",
	summary: "log in to warden cloud (remote simulators) in the browser",
	register: (cmd, ctx, done) => {
		cmd
			.option("--api-url <url>", `warden-api to log in to (default: $WARDEN_API_URL or ${DEFAULT_API_URL})`)
			.option("--no-browser", "print the approval link instead of opening it")
			.option("--json", "machine-readable output")
			.action(async (opts) => done(await login(ctx, opts)));
	},
});
