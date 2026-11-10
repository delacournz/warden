import type { Lease } from "@delacour/warden-core/types";
import { err, ok, type Result } from "@delacour/warden-types/result";
import { resolveOwner } from "../claim-flags";
import type { CommandContext } from "../context";
import { emit, note, reportError } from "../output";
import { openBrowser } from "../remote/browser";
import { type HostLease, hostLeases } from "./claim";
import { type HostView, serveHostView, type ViewDriver } from "./view";

/**
 * `warden view <host lease>`: the host's device in a browser tab on this Mac, frames and input over the same
 * `__driver-serve` channel `warden ui` uses (ssh or the relay). Holds until Ctrl-C or the lease ends; the lease is
 * left as it is (release it as usual).
 */

const SCOPE = "view";
const BEAT_MS = 30_000;

export type ViewHostOptions = { watch: boolean; json: boolean };

export type ViewHostDeps = {
	connect?: (ctx: CommandContext, lease: HostLease) => Promise<Result<ViewDriver & { close: () => Promise<void> }>>;
	open?: (ctx: CommandContext, url: string) => Promise<boolean>;
	/** aborting ends the view (Ctrl-C) */
	signal?: AbortSignal;
	tickMs?: number;
};

/** The caller's host lease to view when `arg` names one, or it is their only device lease of either kind. */
export function pickHostLease(ctx: CommandContext, arg: string | undefined): HostLease | undefined {
	const store = ctx.store();
	if (arg !== undefined) {
		const [byId] = hostLeases([store.getLease(arg)].filter((l): l is Lease => l !== undefined));
		return byId;
	}
	const mine = store.listLeasesByOwner(resolveOwner(ctx));
	const hosts = hostLeases(mine);
	const remotes = mine.filter((l) => l.resource.kind === "remote-device");
	const [only] = hosts;
	return only && hosts.length === 1 && remotes.length === 0 ? only : undefined;
}

/** The caller holds a hosted device lease (`claim --remote`): then a bare `warden view` is about that one. */
export function hasOwnRemoteLease(ctx: CommandContext): boolean {
	return ctx
		.store()
		.listLeasesByOwner(resolveOwner(ctx))
		.some((l) => l.resource.kind === "remote-device");
}

/**
 * When `warden view` found nothing of the caller's: the host leases in this warden home (any owner, e.g. claimed in
 * another terminal, whose shell owns them) and how to name one. Undefined when there are none.
 */
export function hostLeaseHint(ctx: CommandContext): string | undefined {
	const hosts = hostLeases(ctx.store().listLeases());
	if (hosts.length === 0) return undefined;
	const list = hosts
		.map((l) => `${l.id} (${l.resource.name} on ${l.resource.host}${l.label ? `, label ${l.label}` : ""})`)
		.join(", ");
	return `no device lease of this terminal's to pick; host leases here: ${list}. View one with: warden view <leaseId>`;
}

async function defaultConnect(
	ctx: CommandContext,
	lease: HostLease
): Promise<Result<ViewDriver & { close: () => Promise<void> }>> {
	const { connectHostDriver } = await import("./driver");
	const driver = await connectHostDriver(ctx, lease);
	return driver.success ? ok(driver.data) : err(driver.error.message);
}

/** Until `signal` aborts or the local lease is gone (released, expired, lost); beats the lease meanwhile. */
async function hold(ctx: CommandContext, lease: HostLease, deps: ViewHostDeps): Promise<"stopped" | "lease_gone"> {
	const tick = deps.tickMs ?? BEAT_MS;
	for (;;) {
		if (deps.signal?.aborted) return "stopped";
		if (ctx.store().getLease(lease.id) === undefined) return "lease_gone";
		ctx.store().heartbeat([lease.id], ctx.now());
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, tick);
			deps.signal?.addEventListener(
				"abort",
				() => {
					clearTimeout(timer);
					resolve();
				},
				{ once: true }
			);
		});
	}
}

export async function viewHost(
	ctx: CommandContext,
	lease: HostLease,
	opts: ViewHostOptions,
	deps: ViewHostDeps = {}
): Promise<number> {
	const { host, name } = lease.resource;
	const driver = await (deps.connect ?? defaultConnect)(ctx, lease);
	if (!driver.success) {
		reportError(ctx, SCOPE, driver.error);
		return 1;
	}
	let view: HostView | undefined;
	try {
		view = serveHostView({ driver: driver.data, title: `${name} · ${host} · warden`, watch: opts.watch });
		emit(
			ctx,
			opts.json,
			{ leaseId: lease.id, host, url: view.url, watch: opts.watch },
			`${name} on ${host}: ${view.url}\n(Ctrl-C to stop viewing; the lease stays yours)`
		);
		if (!opts.json) await (deps.open ?? openBrowser)(ctx, view.url);
		const why = await hold(ctx, lease, deps);
		if (why === "lease_gone") {
			reportError(ctx, SCOPE, `lease ${lease.id} ended; the view closed`);
			return 11;
		}
		if (!opts.json) note(ctx, `stopped viewing ${name}; lease ${lease.id} is still yours`);
		return 0;
	} finally {
		view?.stop();
		await driver.data.close();
	}
}
